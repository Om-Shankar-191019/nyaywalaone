import { AppError } from './http.js';

/**
 * Request-shape guard (Day 21).
 *
 * `express.json({ limit: '256kb' })` bounds the bytes; it says nothing about the
 * shape. A 200 KB body of `{"a":{"a":{"a":...}}}` is cheap to send and expensive
 * to walk, and every validator downstream would recurse through it. Rejecting
 * absurd depth and absurd array lengths up front keeps that cost constant.
 *
 * The numbers are well above anything a real client sends: the deepest payload
 * in this app is a rule set (rules -> metrics[] -> params{}), which is four
 * levels, and the longest array is a metric list of about a dozen entries.
 */
export const MAX_DEPTH = 8;
export const MAX_ARRAY_LENGTH = 200;

export function violatesShape(value, depth = 0) {
  if (depth > MAX_DEPTH) return `nesting deeper than ${MAX_DEPTH} levels`;
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) return `an array longer than ${MAX_ARRAY_LENGTH} items`;
    for (const item of value) {
      const problem = violatesShape(item, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const problem = violatesShape(item, depth + 1);
      if (problem) return problem;
    }
  }
  return null;
}

export function jsonShapeGuard(req, res, next) {
  if (!req.body || typeof req.body !== 'object') return next();
  const problem = violatesShape(req.body);
  if (problem) {
    return next(new AppError(400, 'BODY_TOO_COMPLEX', `The request body contains ${problem}.`));
  }
  return next();
}

/**
 * A submission must be text. A NUL byte is the cheapest reliable signal that it
 * is not, and the extension is not evidence of anything.
 */
export const looksBinary = (text) => {
  const value = String(text ?? '');
  if (value.includes('\u0000')) return true;
  // Count control characters that never appear in C source, excluding tab, LF, CR.
  let odd = 0;
  for (let index = 0; index < value.length && index < 8192; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 9 || (code > 13 && code < 32)) odd += 1;
  }
  return odd > 0 && odd / Math.min(value.length, 8192) > 0.01;
};
