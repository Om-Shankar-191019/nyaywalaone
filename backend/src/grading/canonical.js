import { createHash } from 'node:crypto';
import { sha256Hex, normalizeSource } from './canonical-utils.js';

export { sha256Hex, normalizeSource };

/**
 * RFC 8785 (JCS) canonical JSON, in the subset this project uses: objects with
 * string keys, arrays, strings, booleans, null and finite numbers.
 *
 * The point is that `rules_hash` must not change because a JSONB column
 * reordered its keys or a pretty-printer added whitespace. Key order and
 * formatting are not part of a rule set's meaning.
 */
export function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalise a non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : canonicalize(item))).join(',')}]`;
  if (typeof value === 'object') {
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new TypeError(`Cannot canonicalise value of type ${typeof value}`);
}

export const hashObject = (value) => sha256Hex(canonicalize(value));

/** `rules_hash`: the fully resolved rule set, defaults included. */
export const rulesHash = (rules) => hashObject(rules);

/** Normalisation for comparison, not for storage: the source stays as written. */
export const normalizeOutput = (value) =>
  String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n+$/g, '');

/**
 * `testset_hash`: sorted `(name, sha256(stdin), sha256(expected))`.
 * Order-independent, content-bound: renaming a test changes the hash, adding a
 * test changes it, reordering the rows does not.
 */
export function testsetHash(tests) {
  const rows = (tests ?? [])
    .map((test) => ({
      name: String(test.name),
      stdin: sha256Hex(normalizeSource(test.stdin ?? '')),
      expected: sha256Hex(normalizeOutput(test.expectedStdout ?? '')),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return hashObject(rows);
}

/**
 * The five inputs from section 5.1. Deliberately joined with `:` so a
 * concatenation ambiguity cannot produce the same key from different inputs.
 */
export function evaluationKey({ sourceHash, rulesHash: rules, testsetHash: tests, toolchainHash, graderVersion }) {
  return sha256Hex([sourceHash, rules, tests, toolchainHash, graderVersion].join(':'));
}

/**
 * Report identity. `timing` is excluded by construction because wall-clock
 * numbers differ between identical runs; that is exactly the flakiness the
 * contract is meant to keep out of a grade.
 */
export const reportHash = (view) => hashObject(stripVolatile(view));

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'timing' || key === 'durationMs') continue;
      out[key] = stripVolatile(item);
    }
    return out;
  }
  return value;
}
