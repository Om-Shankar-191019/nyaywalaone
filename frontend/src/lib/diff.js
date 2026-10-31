/**
 * Character-level diff for a single expected/actual pair.
 *
 * Deliberately small: the inputs are the output of a first-year C program, so a
 * few kilobytes is the realistic ceiling. Above the cap the function gives up
 * and returns one "changed" block - a slow page is worse than a coarse diff.
 */
const MAX_CHARS = 4000;

/**
 * Longest common subsequence over characters, as an edit script.
 * Returns [{ type: 'same' | 'del' | 'ins', text }].
 */
export function diffChars(expected, actual) {
  const left = String(expected ?? '');
  const right = String(actual ?? '');

  if (left === right) return left ? [{ type: 'same', text: left }] : [];
  if (left.length > MAX_CHARS || right.length > MAX_CHARS) {
    return [
      ...(left ? [{ type: 'del', text: left }] : []),
      ...(right ? [{ type: 'ins', text: right }] : []),
    ];
  }

  const rows = left.length + 1;
  const cols = right.length + 1;
  // Int32 table of LCS lengths. `(left.length+1) * (right.length+1) * 4` bytes is
  // 64 MB at the cap above, so the cap is what makes this safe in a browser tab.
  const table = new Int32Array(rows * cols);
  const at = (row, col) => row * cols + col;

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      table[at(row, col)] =
        left[row - 1] === right[col - 1]
          ? table[at(row - 1, col - 1)] + 1
          : Math.max(table[at(row - 1, col)], table[at(row, col - 1)]);
    }
  }

  const script = [];
  let row = left.length;
  let col = right.length;
  while (row > 0 || col > 0) {
    if (row > 0 && col > 0 && left[row - 1] === right[col - 1]) {
      script.push({ type: 'same', text: left[row - 1] });
      row -= 1;
      col -= 1;
    } else if (col > 0 && (row === 0 || table[at(row, col - 1)] >= table[at(row - 1, col)])) {
      script.push({ type: 'ins', text: right[col - 1] });
      col -= 1;
    } else {
      script.push({ type: 'del', text: left[row - 1] });
      row -= 1;
    }
  }

  script.reverse();
  return mergeRuns(script);
}

/** Adjacent segments of the same type read better as one span. */
function mergeRuns(script) {
  const merged = [];
  for (const segment of script) {
    const last = merged[merged.length - 1];
    if (last && last.type === segment.type) last.text += segment.text;
    else merged.push({ ...segment });
  }
  return merged;
}

/**
 * A one-line summary that survives being read aloud by a screen reader, so the
 * diff is not conveyed by colour alone.
 */
export function diffSummary(segments) {
  const removed = segments.filter((s) => s.type === 'del').reduce((sum, s) => sum + s.text.length, 0);
  const added = segments.filter((s) => s.type === 'ins').reduce((sum, s) => sum + s.text.length, 0);
  if (!removed && !added) return 'The output matches the expected output exactly.';
  const parts = [];
  if (removed) parts.push(`${removed} character${removed === 1 ? '' : 's'} unexpected or missing`);
  if (added) parts.push(`${added} character${added === 1 ? '' : 's'} different from the expected output`);
  return parts.join(', ');
}

/** `\n` and spaces are invisible; show them instead of silently confusing people. */
export const visibleWhitespace = (text) => String(text ?? '').replace(/\n/g, '↵\n').replace(/\t/g, '→\t');
