import * as fs from 'fs/promises';

/**
 * Minimal reader/writer for GTA IMG archives (VER2, the format San Andreas and
 * SA-MP 0.3.DL use for gta3.img / samp.img).
 *
 * Indexing and single-entry extraction are the main use: model previews need to
 * pull one .dff/.txd out of a multi-gigabyte archive. The index is read on its
 * own (header + 32 bytes per entry), so scanning a stock 900 MB gta3.img costs
 * ~500 KB and a few milliseconds instead of reading the whole archive.
 *
 * writeImgEntry replaces one existing entry: in place when the new file fits
 * the already allocated sectors, otherwise at the end of the archive. Nothing
 * else in the archive is ever touched and no entry is ever removed — the
 * directory keeps its size and entry order.
 *
 * Layout (VER2), verified against a stock GTA: SA gta3.img:
 *   char[4]   "VER2"
 *   int32     number of entries
 *   entry[32] { int32 sector; int32 sectors; char[24] name }
 * Data starts at sector * 2048 and `sectors` counts whole 2048-byte sectors, so
 * the stored byte length is not exact — callers read the block and let the
 * self-describing RenderWare chunk size decide where the file really ends.
 */

interface ImgEntry {
  name: string;
  /** Slot in the directory table (8 + index * 32), so an entry can be rewritten. */
  index: number;
  sector: number;
  /** Size field as stored (whole sectors in the standard format). */
  size: number;
  /** Bytes to read for this entry. */
  byteLength: number;
}

export interface ImgArchive {
  file: string;
  bytes: number;
  version: number;
  entries: ImgEntry[];
  /** Entries actually recorded (a truncated index still resolves names on demand). */
  listed: number;
  error?: string;
}

const IMG_SECTOR = 2048;
const IMG_ENTRY_SIZE = 32;

/** Reads just the header + directory of an .img archive. */
export async function readImgIndex(file: string, limit = 0): Promise<ImgArchive> {
  const archive: ImgArchive = { file, bytes: 0, version: 0, entries: [], listed: 0 };
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    archive.bytes = stat.size;
    const header = Buffer.alloc(8);
    const headerRead = await handle.read(header, 0, 8, 0);
    if (headerRead.bytesRead < 8) {
      archive.error = 'file is too small to be an IMG archive';
      return archive;
    }
    if (header.toString('latin1', 0, 4) !== 'VER2') {
      archive.version = 1;
      archive.error = 'only VER2 IMG archives are supported (GTA III/VC VER1 archives need their .dir file)';
      return archive;
    }
    archive.version = 2;
    const count = header.readUInt32LE(4);
    if (count <= 0 || count > 2_000_000) {
      archive.error = `implausible entry count (${count})`;
      return archive;
    }
    const wanted = limit > 0 ? Math.min(count, limit) : count;
    const table = Buffer.alloc(wanted * IMG_ENTRY_SIZE);
    await handle.read(table, 0, table.length, 8);
    for (let i = 0; i < wanted; i++) {
      const offset = i * IMG_ENTRY_SIZE;
      const sector = table.readUInt32LE(offset);
      const size = table.readUInt32LE(offset + 4);
      const raw = table.subarray(offset + 8, offset + 32);
      const zero = raw.indexOf(0);
      const name = raw.subarray(0, zero >= 0 ? zero : raw.length).toString('latin1').trim();
      if (!name) continue;
      const start = sector * IMG_SECTOR;
      const bySectors = size * IMG_SECTOR;
      // The size field counts whole 2048-byte sectors, but the last entry of an
      // archive is usually not padded out to a full sector (and some editors
      // even store a byte length here), so a run that would pass the end of the
      // file is clamped to what the file actually holds. The extracted block is
      // trimmed to its own RenderWare chunk size afterwards either way.
      const byteLength = start >= stat.size ? 0 : Math.min(bySectors > 0 ? bySectors : size, stat.size - start);
      archive.entries.push({ index: i, name, sector, size, byteLength });
    }
    archive.listed = wanted;
  } catch (error: any) {
    archive.error = error.message;
  } finally {
    await handle?.close().catch(() => {});
  }
  return archive;
}

/**
 * Extracts one entry. The block is read whole (RenderWare files are
 * self-describing, so trailing padding is harmless) but a couple of trailing
 * sectors are dropped first — the block can be several MB larger than the file
 * when `size` counts sectors.
 */
export async function readImgEntry(file: string, entry: ImgEntry): Promise<Buffer | null> {
  if (entry.byteLength <= 0) return null;
  const offset = entry.sector * IMG_SECTOR;
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (offset >= stat.size) return null;
    const length = Math.min(entry.byteLength, stat.size - offset);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    return trimRenderWareBlock(buffer);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Cuts a read block down to the length its own root chunk declares (payload
 * size + 12), rejecting obviously bogus sizes.
 */
function trimRenderWareBlock(buffer: Buffer): Buffer {
  if (buffer.length < 12) return buffer;
  const declared = buffer.readUInt32LE(4) + 12;
  if (declared >= 12 && declared <= buffer.length) return buffer.subarray(0, declared);
  return buffer;
}

export interface ImgWriteResult {
  file: string;
  entry: string;
  bytes: number;
  sectors: number;
  /** Sectors the entry owned before this write. */
  previousSectors: number;
  sector: number;
  /** In place when the new data fit the allocated sectors, appended otherwise. */
  mode: 'in-place' | 'appended';
  /** Bytes left unused at the end of the allocated run (in-place writes). */
  slack: number;
}

/**
 * Replaces the data of an existing entry. In-place while the new file fits the
 * sectors the entry already owns (the rest of the run is left as slack, which
 * every RenderWare reader skips because the chunk sizes say where the file
 * ends); otherwise the data is appended at the end of the archive and only the
 * entry's 32-byte directory slot is updated — existing data is never moved or
 * overwritten.
 */
export async function writeImgEntry(file: string, entry: ImgEntry, data: Buffer): Promise<ImgWriteResult> {
  if (data.length === 0) throw new Error('refusing to write an empty entry into an IMG archive');
  const sectors = Math.ceil(data.length / IMG_SECTOR);
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(file, 'r+');
    const stat = await handle.stat();
    const allocated = Math.min(entry.byteLength, stat.size - entry.sector * IMG_SECTOR);
    const fits = entry.byteLength >= data.length
      && entry.sector * IMG_SECTOR + entry.byteLength <= stat.size;
    const mode: ImgWriteResult['mode'] = fits ? 'in-place' : 'appended';
    let sector = entry.sector;
    let slack = 0;

    if (fits) {
      await handle.write(data, 0, data.length, entry.sector * IMG_SECTOR);
      slack = allocated - data.length;
    } else {
      sector = Math.ceil(stat.size / IMG_SECTOR);
      const padding = sector * IMG_SECTOR - stat.size;
      if (padding > 0) await handle.write(Buffer.alloc(padding), 0, padding, stat.size);
      await handle.write(data, 0, data.length, sector * IMG_SECTOR);
    }

    const slot = Buffer.alloc(8);
    slot.writeInt32LE(sector, 0);
    slot.writeInt32LE(sectors, 4);
    await handle.write(slot, 0, 8, 8 + entry.index * IMG_ENTRY_SIZE);

    entry.sector = sector;
    entry.size = sectors;
    entry.byteLength = sectors * IMG_SECTOR;
    return { file, entry: entry.name, bytes: data.length, sectors, previousSectors: Math.round(allocated / IMG_SECTOR), sector, mode, slack };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Case-insensitive lookup inside an archive index (the extension is optional). */
export function findImgEntry(archive: ImgArchive, name: string): ImgEntry | null {
  const wanted = name.toLowerCase().replace(/\\/g, '/').split('/').pop() || name.toLowerCase();
  const wantedBase = wanted.replace(/\.[a-z0-9]+$/, '');
  const hasExtension = wanted !== wantedBase;
  const matches = (entry: ImgEntry): boolean => {
    const entryName = entry.name.toLowerCase().replace(/\\/g, '/').split('/').pop() || entry.name.toLowerCase();
    if (entryName === wanted) return true;
    if (hasExtension) return false; // "infernus.txd" must not match "infernus.dff"
    return entryName.replace(/\.[a-z0-9]+$/, '') === wantedBase;
  };
  for (const entry of archive.entries) {
    if (matches(entry)) return entry;
  }
  return null;
}
