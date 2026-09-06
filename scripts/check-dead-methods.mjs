#!/usr/bin/env node
/**
 * Dead-code pass: flags class methods (PawnManager, SampClient, SampProtocol)
 * that are never referenced anywhere in src/.
 *
 * Catches the regression pattern where a method survives after its MCP tool is
 * removed (fixScriptEncoding, transformScript, ...): tsc's noUnusedLocals only
 * sees private members and locals, and public methods are "reachable" from the
 * type system's point of view, so nothing else complains.
 *
 * Run: node scripts/check-dead-methods.mjs  (or `npm run deadcode`)
 * Exits non-zero when dead methods are found.
 *
 * Known limitation: occurrences inside string/template literals count as usage,
 * so a method name that appears only inside a string would not be flagged.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const srcDir = path.join(import.meta.dirname, '..', 'src');
const files = (await readdir(srcDir)).filter((f) => f.endsWith('.ts'));

const contents = new Map();
for (const f of files) {
  contents.set(f, await readFile(path.join(srcDir, f), 'utf8'));
}

/**
 * Strip line/block comments without being fooled by comment-like text (block
 * comment markers, double slashes) appearing inside string or template
 * literals — the codebase contains both, e.g. studyProject tests
 * startsWith('/*') and moduleSkeleton builds code snippets with double-slash
 * lines inside template strings. Strings are kept intact so their text never
 * counts as a false reference.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const append = (s) => { out += s; };
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
    } else if (c === '"' || c === "'") {
      const q = c;
      append(c); i++;
      while (i < n) {
        if (src[i] === '\\') { append(src[i] + (src[i + 1] ?? '')); i += 2; continue; }
        append(src[i]);
        if (src[i] === q) { i++; break; }
        i++;
      }
    } else if (c === '`') {
      append(c); i++;
      let depth = 0;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') { append(ch + (src[i + 1] ?? '')); i += 2; continue; }
        if (ch === '$' && src[i + 1] === '{') { append('${'); depth++; i += 2; continue; }
        if (ch === '}' && depth > 0) { depth--; append(ch); i++; continue; }
        if (ch === '`' && depth === 0) { append(ch); i++; break; }
        append(ch); i++;
      }
    } else {
      append(c); i++;
    }
  }
  return out;
}

const corpus = stripComments([...contents.values()].join('\n'));

const SKIP = new Set([
  'async', 'await', 'break', 'case', 'catch', 'const', 'continue', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'interface', 'let', 'new',
  'of', 'return', 'static', 'switch', 'this', 'throw', 'try', 'typeof', 'var',
  'void', 'while', 'yield', 'constructor',
]);

// Method declarations live at 4-space indent: `    async name(...)` /
// `    static name(...)` / `    private async name<T>(...)`.
const declRe = /^ {4}(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)(?:<[^>]*>)?\s*\(/;

const dead = [];
for (const [file, raw] of contents) {
  if (file === 'index.ts') continue; // no class declarations; only referenced here
  const code = stripComments(raw);
  for (const line of code.split(/\r?\n/)) {
    const m = declRe.exec(line);
    if (!m || SKIP.has(m[1])) continue;
    const name = m[1];
    const occurrences = corpus.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0;
    // Occurrences === 1 means only the declaration itself exists anywhere.
    if (occurrences === 1) {
      dead.push(`  ${file}: ${name}(...) — never referenced (declared at: ${line.trim()})`);
    }
  }
}

if (dead.length > 0) {
  console.error(`\nDead class methods found (${dead.length}):`);
  for (const d of dead) console.error(d);
  console.error('\nRemove them or wire them to an MCP tool in src/index.ts.\n');
  process.exit(1);
}
console.log('check-dead-methods: no unreferenced class methods.');
