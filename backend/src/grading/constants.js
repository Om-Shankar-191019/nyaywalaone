/**
 * Leaf constants. They live here rather than in `rules.js` because the rule
 * validator imports the analyzer registry, and the analyzers import these
 * values - putting them in rules.js would make that cycle a TDZ crash.
 */
export const ORDER_CLASSES = ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)', 'O(n^2)', 'O(n^3)', 'O(2^n)', 'unknown'];

export const EDGE_CASES = ['zero', 'negatives', 'int_overflow', 'whitespace', 'empty', 'long_line', 'boundary'];
