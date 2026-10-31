import { createHash, randomBytes } from 'node:crypto';

/** Hex SHA-256 of a UTF-8 string. */
export const sha256Hex = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/** URL-safe random token. 32 bytes = 256 bits, as the plan requires. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/**
 * Source normalisation for `source_hash`: CRLF and CR become LF, and the file
 * keeps exactly one trailing newline. Nothing inside string literals is
 * trimmed, because that would change the program.
 */
export function normalizeSource(source) {
  const unified = String(source).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return `${unified.replace(/\n+$/, '')}\n`;
}

/** The hash a submission's identity is built from (used from Week 2 onwards). */
export const sourceHash = (source) => sha256Hex(normalizeSource(source));
