#!/usr/bin/env node
/**
 * DXT encoder quality benchmark: `quality: 'high'` (seeded cluster fit with
 * least-squares endpoint refinement — the squish-style encoder) against
 * `quality: 'fast'` (the single range fit this build shipped first), plus a
 * brute-effort reference encoder that searches much harder than either.
 *
 * Every image is written into a real dictionary, parsed back by the reader and
 * decoded, then scored:
 *
 *   colour PSNR = 10*log10(255^2 / MSE)  over the pixels the source keeps opaque
 *                (a 1-bit-alpha format decoding a transparent pixel to black says
 *                nothing about colour quality),
 *   alpha PSNR  = the same over every pixel's alpha,
 *   alpha class = the share of pixels whose "transparent vs opaque" decision
 *                (alpha < 128) matches the source — the metric DXT1 lives by.
 *
 * The reference encoder enumerates every endpoint pair its block's own pixels
 * imply, least-squares-refines the best ones for six rounds and keeps the lowest
 * error, i.e. it shows the ceiling this class of encoder can reach: the smaller
 * the gap to it, the less the production seeds and early exit cost.
 *
 * Images: gradient / photo-ish noise / hard-edged UI sprite / alpha mask (always),
 * plus real textures decoded from the game's own dictionaries when present.
 * Run: node scripts/txd-dxt-quality.mjs   (after `npm run build`)
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { buildTxdBuffer } from '../dist/txd-write.js';
import { decodeTxdTexture, decodeTxdTextureAt, dxtAlphaTable, dxtColorTable, parseTxd } from '../dist/txd.js';

const FORMATS = ['DXT1', 'DXT3', 'DXT5'];
const OPAQUE = 128;
const MAX_REAL_SIZE = 128;
const MAX_REAL_IMAGES = 2;

let passed = 0;
const failures = [];
function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label + (detail ? ` — ${detail}` : ''));
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Recursive file walk. `fs.promises.glob` would be shorter but needs Node 22; CI runs Node 20. */
async function findFiles(dir, extension, found = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found; // no game assets on this machine
  }
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await findFiles(full, extension, found);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) found.push(full);
  }
  return found;
}

/** Deterministic 32-bit LCG so the "photo" images are the same on every machine. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function blank(size) {
  return { width: size, height: size, rgba: Buffer.alloc(size * size * 4) };
}

/** Smooth colour gradient plus a smooth alpha ramp (an alpha ramp DXT1 cannot hold). */
function gradientImage(size = 64) {
  const image = blank(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      image.rgba[o] = Math.round((x / (size - 1)) * 255);
      image.rgba[o + 1] = Math.round((y / (size - 1)) * 255);
      image.rgba[o + 2] = Math.round(((x + y) / (2 * (size - 1))) * 200) + 20;
      image.rgba[o + 3] = Math.min(255, 40 + Math.round((x / (size - 1)) * 215));
    }
  }
  return image;
}

/** Photo-ish: smooth blobs plus grain, where a bad endpoint fit costs the most. */
function photoImage(size = 64) {
  const image = blank(size);
  const rand = random(0x5eed1234);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const blob = Math.sin(x / 9) * Math.cos(y / 7) * 60 + Math.sin((x + y) / 4) * 30;
      const grain = (rand() - 0.5) * 70;
      const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
      image.rgba[o] = clamp(120 + blob + grain);
      image.rgba[o + 1] = clamp(90 + blob * 0.7 - grain * 0.6);
      image.rgba[o + 2] = clamp(70 - blob * 0.4 + grain * 0.8);
      image.rgba[o + 3] = clamp(200 + grain);
    }
  }
  return image;
}

/** Hard-edged UI sprite: flat colours, sharp borders and 1-bit alpha, like a textdraw texture. */
function spriteImage(size = 64) {
  const image = blank(size);
  const palette = [[20, 40, 90], [230, 210, 60], [240, 240, 240], [180, 30, 30]];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const [r, g, b] = palette[(Math.floor(x / 8) % 2 === 0 ? Math.floor(y / 16) : Math.floor(y / 16) + 2) % 4];
      image.rgba[o] = r;
      image.rgba[o + 1] = g;
      image.rgba[o + 2] = b;
      image.rgba[o + 3] = x < 4 || y < 4 ? 0 : 255;
    }
  }
  return image;
}

/** Binary alpha mask over a gradient: the case 1-bit and 8-value alpha differ on. */
function maskImage(size = 64) {
  const image = blank(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const cx = x - size / 2;
      const cy = y - size / 2;
      image.rgba[o] = Math.min(255, 60 + x * 2);
      image.rgba[o + 1] = Math.max(0, 200 - y * 2);
      image.rgba[o + 2] = 140;
      image.rgba[o + 3] = cx * cx + cy * cy < size * size * 0.17 ? 255 : (x % 8 < 4 ? 0 : 96);
    }
  }
  return image;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const MSE_MAX = 255 * 255;
const psnrOfMse = (mse) => (mse === 0 ? Infinity : 10 * Math.log10(MSE_MAX / mse));

/** Colour PSNR over opaque source pixels, alpha PSNR and alpha-class agreement over all. */
function measure(source, decoded) {
  let colourError = 0;
  let colourPixels = 0;
  let alphaError = 0;
  let alphaMatches = 0;
  const pixels = source.rgba.length / 4;
  for (let i = 0; i < source.rgba.length; i += 4) {
    if (source.rgba[i + 3] >= OPAQUE) {
      for (let c = 0; c < 3; c++) colourError += (source.rgba[i + c] - decoded.rgba[i + c]) ** 2;
      colourPixels++;
    }
    const alpha = decoded.rgba[i + 3];
    alphaError += (source.rgba[i + 3] - alpha) ** 2;
    if (source.rgba[i + 3] < OPAQUE === alpha < OPAQUE) alphaMatches++;
  }
  return {
    colour: colourPixels ? psnrOfMse(colourError / (3 * colourPixels)) : null,
    alpha: psnrOfMse(alphaError / pixels),
    classAgreement: alphaMatches / pixels,
  };
}

function hasBinaryAlpha(image) {
  for (let i = 3; i < image.rgba.length; i += 4) {
    if (image.rgba[i] !== 0 && image.rgba[i] !== 255) return false;
  }
  return true;
}

const delta = (fast, high) => {
  if (fast === high) return 0;
  if (fast === null || high === null) return 0;
  if (!Number.isFinite(fast)) return -Infinity;
  if (!Number.isFinite(high)) return Infinity;
  return high - fast;
};
const show = (value) => (value === null ? '  n/a' : Number.isFinite(value) ? value.toFixed(2) : '  inf');
const signed = (value) => (Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}` : value > 0 ? '+inf' : '-inf');

// ---------------------------------------------------------------------------
// Brute-effort reference encoder (same tables as the decoder, far more search)
// ---------------------------------------------------------------------------

const expand5 = (value) => (value << 3) | (value >> 2);
const expand6 = (value) => (value << 2) | (value >> 4);
const quantBits = (value, bits) => Math.min((1 << bits) - 1, Math.max(0, Math.round((value * ((1 << bits) - 1)) / 255)));
const quant565 = (rgb) => (quantBits(rgb[0], 5) << 11) | (quantBits(rgb[1], 6) << 5) | quantBits(rgb[2], 5);

const FOUR_SLOTS = [[1, 0], [0, 1], [2 / 3, 1 / 3], [1 / 3, 2 / 3]];
const THREE_SLOTS = [[1, 0], [0, 1], [1 / 2, 1 / 2]];
const ALPHA8_SLOTS = [[1, 0], [0, 1]].concat([1, 2, 3, 4, 5, 6].map((step) => [(7 - step) / 7, step / 7]));
const ALPHA6_SLOTS = [[1, 0], [0, 1]].concat([1, 2, 3, 4].map((step) => [(5 - step) / 5, step / 5]), [[0, 0], [0, 0]]);

/** The 16 pixels of one 4x4 block, repeating the edge pixel outside the image. */
function blockPixels(image, bx, by) {
  const block = [];
  for (let y = 0; y < 4; y++) {
    const sy = Math.min(image.height - 1, by * 4 + y);
    for (let x = 0; x < 4; x++) {
      const s = (sy * image.width + Math.min(image.width - 1, bx * 4 + x)) * 4;
      block.push(image.rgba[s], image.rgba[s + 1], image.rgba[s + 2], image.rgba[s + 3]);
    }
  }
  return block;
}

function orderPair(a, b, fourColours) {
  return (fourColours ? a < b : a > b) ? [b, a] : [a, b];
}

function colourTable(c0, c1, fourColours) {
  return dxtColorTable(c0, c1, fourColours);
}

function colourError(keep, block, c0, c1, fourColours) {
  const table = colourTable(c0, c1, fourColours);
  const last = fourColours && c0 !== c1 ? 3 : 2;
  let error = 0;
  for (const i of keep) {
    let best = Infinity;
    for (let k = 0; k <= last; k++) {
      const entry = table[k];
      const distance = (entry[0] - block[i * 4]) ** 2 + (entry[1] - block[i * 4 + 1]) ** 2 + (entry[2] - block[i * 4 + 2]) ** 2;
      if (distance < best) best = distance;
    }
    error += best;
  }
  return error;
}

function assignColour(keep, block, c0, c1, fourColours) {
  const table = colourTable(c0, c1, fourColours);
  const last = fourColours && c0 !== c1 ? 3 : 2;
  const codes = new Array(16).fill(0);
  for (const i of keep) {
    let best = 0;
    let bestDistance = Infinity;
    for (let k = 0; k <= last; k++) {
      const entry = table[k];
      const distance = (entry[0] - block[i * 4]) ** 2 + (entry[1] - block[i * 4 + 1]) ** 2 + (entry[2] - block[i * 4 + 2]) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = k;
      }
    }
    codes[i] = best;
  }
  return codes;
}

/** Least-squares (end0, end1) for a known pixel → palette-slot assignment. */
function fitColour(keep, codes, block, slots) {
  const counts = new Array(slots.length).fill(0);
  const sums = slots.map(() => [0, 0, 0]);
  for (const i of keep) {
    const slot = codes[i];
    counts[slot]++;
    for (let c = 0; c < 3; c++) sums[slot][c] += block[i * 4 + c];
  }
  const end0 = [0, 0, 0];
  const end1 = [0, 0, 0];
  let fitted = false;
  for (let c = 0; c < 3; c++) {
    let s00 = 0, s01 = 0, s11 = 0, r0 = 0, r1 = 0;
    for (let slot = 0; slot < slots.length; slot++) {
      const count = counts[slot];
      if (!count) continue;
      const [a, b] = slots[slot];
      const sum = sums[slot][c];
      s00 += count * a * a;
      s01 += count * a * b;
      s11 += count * b * b;
      r0 += a * sum;
      r1 += b * sum;
    }
    const det = s00 * s11 - s01 * s01;
    if (Math.abs(det) < 1e-9) continue;
    end0[c] = (s11 * r0 - s01 * r1) / det;
    end1[c] = (s00 * r1 - s01 * r0) / det;
    fitted = true;
  }
  return fitted ? { end0, end1 } : null;
}

/** Refines one colour block: assign, least-squares fit, repeat; keeps the best pair seen. */
function refineColour(keep, block, seed, fourColours, rounds) {
  let [c0, c1] = orderPair(quant565(seed[0]), quant565(seed[1]), fourColours);
  let best = { c0, c1, error: colourError(keep, block, c0, c1, fourColours) };
  const slots = fourColours ? FOUR_SLOTS : THREE_SLOTS;
  for (let round = 0; round < rounds; round++) {
    if (best.error === 0) break;
    const codes = assignColour(keep, block, c0, c1, fourColours);
    const fit = fitColour(keep, codes, block, slots);
    if (!fit) break;
    const clamp = (value) => Math.max(0, Math.min(255, value));
    const [n0, n1] = orderPair(
      quant565([clamp(fit.end0[0]), clamp(fit.end0[1]), clamp(fit.end0[2])]),
      quant565([clamp(fit.end1[0]), clamp(fit.end1[1]), clamp(fit.end1[2])]),
      fourColours,
    );
    if (n0 === c0 && n1 === c1) break;
    c0 = n0;
    c1 = n1;
    const error = colourError(keep, block, c0, c1, fourColours);
    if (error < best.error) best = { c0, c1, error };
  }
  return best;
}

/** Brute-effort colour block: every endpoint pair the block's own pixels imply, refined. */
function referenceColourBlock(block, fourColours) {
  const keep = [];
  for (let i = 0; i < 16; i++) {
    if (fourColours || block[i * 4 + 3] >= OPAQUE) keep.push(i);
  }
  if (!keep.length) keep.push(0);

  const values = [...new Set(keep.map((i) => quant565([block[i * 4], block[i * 4 + 1], block[i * 4 + 2]])))];
  const scored = [];
  for (const c0 of values) {
    for (const c1 of values) {
      const [a, b] = orderPair(c0, c1, fourColours);
      scored.push({ seed: [[(a >> 11) & 0x1f, (a >> 5) & 0x3f, a & 0x1f], [(b >> 11) & 0x1f, (b >> 5) & 0x3f, b & 0x1f]], pair: [a, b], error: colourError(keep, block, a, b, fourColours) });
    }
  }
  scored.sort((left, right) => left.error - right.error);
  let best = { c0: scored[0].pair[0], c1: scored[0].pair[1], error: scored[0].error };
  for (const candidate of scored.slice(0, 8)) {
    // Refine from the pair itself (expand5/6 back to RGB) so the fit starts at the candidate.
    const seed = candidate.pair.map((value) => [expand5((value >> 11) & 0x1f), expand6((value >> 5) & 0x3f), expand5(value & 0x1f)]);
    const refined = refineColour(keep, block, seed, fourColours, 6);
    if (refined.error < best.error) best = refined;
  }
  return { ...best, keep, fourColours };
}

function alphaError(alphas, a0, a1) {
  const table = dxtAlphaTable(a0, a1);
  let error = 0;
  for (let i = 0; i < 16; i++) {
    let best = Infinity;
    for (let k = 0; k < 8; k++) {
      const distance = (table[k] - alphas[i]) ** 2;
      if (distance < best) best = distance;
    }
    error += best;
  }
  return error;
}

function assignAlpha(alphas, a0, a1) {
  const table = dxtAlphaTable(a0, a1);
  return alphas.map((alpha) => {
    let best = 0;
    let bestDistance = Infinity;
    for (let k = 0; k < 8; k++) {
      const distance = Math.abs(table[k] - alpha);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = k;
      }
    }
    return best;
  });
}

function fitAlpha(codes, alphas, slots) {
  const counts = new Array(slots.length).fill(0);
  const sums = new Array(slots.length).fill(0);
  codes.forEach((slot, pixel) => {
    counts[slot]++;
    sums[slot] += alphas[pixel];
  });
  let s00 = 0, s01 = 0, s11 = 0, r0 = 0, r1 = 0;
  for (let slot = 0; slot < slots.length; slot++) {
    const count = counts[slot];
    if (!count) continue;
    const [a, b] = slots[slot];
    s00 += count * a * a;
    s01 += count * a * b;
    s11 += count * b * b;
    r0 += a * sums[slot];
    r1 += b * sums[slot];
  }
  const det = s00 * s11 - s01 * s01;
  if (Math.abs(det) < 1e-9) return null;
  return [(s11 * r0 - s01 * r1) / det, (s00 * r1 - s01 * r0) / det];
}

/** Brute-effort alpha block: candidate endpoint pairs from the block's alphas, refined. */
function referenceAlphaBlock(block) {
  const alphas = [];
  for (let i = 0; i < 16; i++) alphas.push(block[i * 4 + 3]);
  const grid = [0, 85, 170, 255];
  const values = [...new Set([...alphas, ...grid])];
  const scored = [];
  for (const a0 of values) {
    for (const a1 of values) {
      scored.push({ pair: [a0, a1], error: alphaError(alphas, a0, a1) });
    }
  }
  scored.sort((left, right) => left.error - right.error);
  let best = { pair: scored[0].pair, error: scored[0].error, codes: assignAlpha(alphas, ...scored[0].pair) };
  for (const candidate of scored.slice(0, 6)) {
    let [a0, a1] = candidate.pair;
    let current = { pair: [a0, a1], error: candidate.error };
    for (let round = 0; round < 6; round++) {
      if (current.error === 0) break;
      const codes = assignAlpha(alphas, a0, a1);
      const fit = fitAlpha(codes, alphas, a0 > a1 ? ALPHA8_SLOTS : ALPHA6_SLOTS);
      if (!fit) break;
      const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
      const [n0, n1] = [clamp(fit[0]), clamp(fit[1])];
      if (n0 === a0 && n1 === a1) break;
      a0 = n0;
      a1 = n1;
      const error = alphaError(alphas, a0, a1);
      if (error < current.error) current = { pair: [a0, a1], error };
    }
    if (current.error < best.error) best = { ...current, codes: assignAlpha(alphas, ...current.pair) };
  }
  return best;
}

/** Decodes a block list the way the game does, so the reference can be PSNR-scored. */
function referenceDecode(image, format) {
  const rgba = Buffer.alloc(image.width * image.height * 4);
  const blocksX = Math.max(1, (image.width + 3) >> 2);
  const blocksY = Math.max(1, (image.height + 3) >> 2);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const block = blockPixels(image, bx, by);
      const hasTransparent = format === 'DXT1' && block.some((_, i) => i % 4 === 3 && block[i] < OPAQUE);
      const colours = referenceColourBlock(block, !hasTransparent);
      const table = colourTable(colours.c0, colours.c1, colours.fourColours);
      const last = colours.fourColours && colours.c0 !== colours.c1 ? 3 : 2;
      const codes = assignColour(colours.keep, block, colours.c0, colours.c1, colours.fourColours);
      const alphaBlock = format === 'DXT5' ? referenceAlphaBlock(block) : null;
      const alphaTable = alphaBlock ? dxtAlphaTable(alphaBlock.pair[0], alphaBlock.pair[1]) : null;
      for (let y = 0; y < 4; y++) {
        const py = by * 4 + y;
        if (py >= image.height) break;
        for (let x = 0; x < 4; x++) {
          const px = bx * 4 + x;
          if (px >= image.width) break;
          const i = y * 4 + x;
          const o = (py * image.width + px) * 4;
          const transparent = hasTransparent && block[i * 4 + 3] < OPAQUE;
          const code = transparent ? 3 : Math.min(codes[i], last);
          const entry = table[code];
          rgba[o] = entry[0];
          rgba[o + 1] = entry[1];
          rgba[o + 2] = entry[2];
          rgba[o + 3] = format === 'DXT1'
            ? (transparent ? 0 : 255)
            : format === 'DXT3' ? quantBits(block[i * 4 + 3], 4) * 17
              : alphaTable[alphaBlock.codes[i]];
        }
      }
    }
  }
  return { width: image.width, height: image.height, rgba };
}

// ---------------------------------------------------------------------------

/** Encodes one image into a real dictionary and decodes it back through the reader. */
function roundTrip(image, format, quality) {
  const buffer = buildTxdBuffer({
    textures: [{ name: 'bench', format, levels: [{ ...image }], filterMode: 0x1102, quality }],
    deviceId: 2,
  });
  const dict = parseTxd(buffer, `${format}.txd`);
  if (dict.textures.length !== 1 || !dict.textures[0].decodable) {
    throw new Error(`${format}/${quality} did not parse back: ${dict.textures[0]?.decodeError ?? 'no texture'}`);
  }
  const decoded = decodeTxdTexture(buffer, 'bench');
  if (!decoded) throw new Error(`${format}/${quality} did not decode`);
  return { decoded, bytes: buffer.length };
}

function decimate(image, maxSize) {
  const factor = Math.ceil(Math.max(image.width, image.height) / maxSize);
  if (factor <= 1) return image;
  const width = Math.max(1, Math.floor(image.width / factor));
  const height = Math.max(1, Math.floor(image.height / factor));
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * factor * image.width + x * factor) * 4;
      image.rgba.copy(rgba, (y * width + x) * 4, s, s + 4);
    }
  }
  return { width, height, rgba };
}

function deviation(image) {
  let sum = 0;
  let sumSquares = 0;
  const pixels = image.rgba.length / 4;
  for (let i = 0; i < image.rgba.length; i += 4) {
    const value = (image.rgba[i] + image.rgba[i + 1] + image.rgba[i + 2]) / 3;
    sum += value;
    sumSquares += value * value;
  }
  return Math.sqrt(Math.max(0, sumSquares / pixels - (sum / pixels) ** 2));
}

/** Real dictionaries hold the textures the game itself compressed — good test material. */
async function realImages() {
  const sampleRoot = process.env.SAMP_TXD_SAMPLE_DIR || 'D:/GTASAN Muntiplayer';
  const files = await findFiles(sampleRoot, '.txd');
  const images = [];
  for (const file of files.sort()) {
    if (images.length >= MAX_REAL_IMAGES) break;
    const buffer = await readFile(file).catch(() => null);
    if (!buffer) continue;
    const dict = parseTxd(buffer, file);
    if (dict.error || !dict.textures.length) continue;
    for (let index = 0; index < dict.textures.length && images.length < MAX_REAL_IMAGES; index++) {
      const meta = dict.textures[index];
      if (!meta.decodable || !FORMATS.includes(meta.format) || meta.width < 32 || meta.height < 32) continue;
      const full = decodeTxdTextureAt(buffer, index);
      if (!full) continue;
      const image = decimate(full, MAX_REAL_SIZE);
      if (deviation(image) < 4) continue; // blank/one-colour textures prove nothing
      images.push([`${path.basename(file)}:${meta.name}`, image, meta.format]);
    }
  }
  return images;
}

async function main() {
  const started = Date.now();
  console.log('DXT encoder quality: high (cluster fit + least-squares refine) vs fast (single range fit)');
  console.log('colour PSNR is measured over opaque source pixels (alpha < 128 = transparent)\n');

  const cases = [
    ['gradient', gradientImage()],
    ['photo-noise', photoImage()],
    ['ui-sprite', spriteImage()],
    ['alpha-mask', maskImage()],
    ...(await realImages()),
  ];

  const colourGains = [];
  const alphaGains = [];
  const referenceGaps = [];
  const alphaReferenceGaps = [];
  let worstColourGain = Infinity;
  let worstColourCase = '';
  let worstReferenceGap = 0;
  let worstReferenceCase = '';

  for (const [label, image, sourceFormat] of cases) {
    const binary = hasBinaryAlpha(image);
    console.log(`${label} (${image.width}x${image.height}${sourceFormat ? `, stored as ${sourceFormat}` : ''}${binary ? ', binary alpha' : ''})`);
    for (const format of FORMATS) {
      let fast;
      let high;
      try {
        fast = roundTrip(image, format, 'fast');
        high = roundTrip(image, format, 'high');
      } catch (error) {
        check(`${label}/${format}: encodes and decodes back`, false, error.message);
        continue;
      }
      const fastStats = measure(image, fast.decoded);
      const highStats = measure(image, high.decoded);
      const colourGain = delta(fastStats.colour, highStats.colour);
      const alphaGain = delta(fastStats.alpha, highStats.alpha);

      // The reference encoder only runs on the synthetic images: on real ones the
      // reader round trip is the interesting part and the search would dominate.
      let reference = null;
      if (!sourceFormat) {
        reference = measure(image, referenceDecode(image, format));
      }
      const referenceGap = reference && reference.colour !== null && highStats.colour !== null && Number.isFinite(highStats.colour) && Number.isFinite(reference.colour)
        ? reference.colour - highStats.colour : 0;
      const alphaReferenceGap = reference && Number.isFinite(highStats.alpha) && Number.isFinite(reference.alpha)
        ? reference.alpha - highStats.alpha : 0;

      colourGains.push(colourGain);
      alphaGains.push(alphaGain);
      if (!sourceFormat) referenceGaps.push(referenceGap);
      if (!sourceFormat) alphaReferenceGaps.push(alphaReferenceGap);
      if (colourGain < worstColourGain) {
        worstColourGain = colourGain;
        worstColourCase = `${label}/${format}`;
      }
      if (referenceGap > worstReferenceGap) {
        worstReferenceGap = referenceGap;
        worstReferenceCase = `${label}/${format}`;
      }

      const colourLine = `  ${format.padEnd(5)} C ${show(fastStats.colour)} → ${show(highStats.colour)} (${signed(colourGain)})`
        + (reference ? ` | ref ${show(reference.colour)} (${signed(referenceGap)})` : '')
        + `   A ${show(fastStats.alpha)} → ${show(highStats.alpha)} (${signed(alphaGain)})`
        + (reference ? ` | ref ${show(reference.alpha)} (${signed(alphaReferenceGap)})` : '')
        + `   class ${(highStats.classAgreement * 100).toFixed(1)}%  ${high.bytes} B`;
      console.log(colourLine);

      check(`${label}/${format}: both qualities write the same layout`, fast.bytes === high.bytes, `${fast.bytes} vs ${high.bytes}`);
      check(`${label}/${format}: high is never worse than fast`,
        colourGain >= -0.05 && alphaGain >= -0.05,
        `colour ${signed(colourGain)} dB, alpha ${signed(alphaGain)} dB`);
      if (reference) {
        // Sanity check on the benchmark itself: searching harder must not score worse.
        check(`${label}/${format}: the reference encoder is at least as good as high`,
          referenceGap >= -0.05 && alphaReferenceGap >= -0.05,
          `colour ${signed(-referenceGap)} dB, alpha ${signed(-alphaReferenceGap)} dB`);
        check(`${label}/${format}: high is within 0.5 dB of the brute-effort reference`,
          referenceGap <= 0.5 && alphaReferenceGap <= 0.5,
          `colour ${referenceGap.toFixed(2)} dB, alpha ${alphaReferenceGap.toFixed(2)} dB`);
      }
      if (binary) {
        check(`${label}/${format}: the transparent/opaque decision matches the source`,
          highStats.classAgreement >= 0.99, `${(highStats.classAgreement * 100).toFixed(1)}%`);
      }
    }
    console.log('');
  }

  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const realCases = cases.length - 4;
  console.log(`colour PSNR gain of high over fast: mean ${signed(mean(colourGains))} dB, best ${signed(Math.max(...colourGains))} dB, worst ${signed(worstColourGain)} dB (${worstColourCase})`);
  console.log(`alpha  PSNR gain of high over fast: mean ${signed(mean(alphaGains))} dB`);
  console.log(`distance to the brute-effort reference: mean ${mean(referenceGaps).toFixed(2)} dB, worst ${worstReferenceGap.toFixed(2)} dB (${worstReferenceCase})`);
  console.log(`alpha distance to the reference: mean ${mean(alphaReferenceGaps).toFixed(2)} dB`);
  console.log(`${cases.length} cases (${cases.length - realCases} synthetic${realCases ? `, ${realCases} real dictionary texture(s)` : ''}) in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

  check('the high encoder is never worse anywhere', worstColourGain >= -0.05, `worst ${signed(worstColourGain)} dB at ${worstColourCase}`);
  check('the high encoder is a real improvement, not a no-op', mean(colourGains) > 0.2, `mean ${signed(mean(colourGains))} dB`);
  check('the high encoder never loses alpha quality', mean(alphaGains) >= -0.05, `mean ${signed(mean(alphaGains))} dB`);
  check('the high encoder is within 0.5 dB of the brute-effort reference',
    worstReferenceGap <= 0.5, `worst ${worstReferenceGap.toFixed(2)} dB at ${worstReferenceCase}`);
  check('every format decoded back for every image', colourGains.length === FORMATS.length * cases.length, `${colourGains.length} results`);

  console.log('');
  console.log(`txd-dxt-quality: ${passed} checks passed${failures.length ? `, ${failures.length} failed` : ''}`);
  if (failures.length) {
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
