import { createHash } from 'node:crypto';

/** Hex SHA-256 of a UTF-8 string. */
export const sha256Hex = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Source normalisation for `source_hash`: CRLF and CR become LF, and the file
 * keeps exactly one trailing newline. Nothing inside string literals is
 * trimmed, because that would change the program.
 */
export function normalizeSource(source) {
  const unified = String(source).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return `${unified.replace(/\n+$/, '')}\n`;
}

export const sourceHash = (source) => sha256Hex(normalizeSource(source));

/**
 * Stable JSON for hashing. Same idea as canonicalize() but for values that are
 * already plain JSON and where throwing on a number is not helpful.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
