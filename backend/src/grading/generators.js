/**
 * Boundary inputs, generated deterministically.
 *
 * These are inputs, not answers. The expected output comes from the
 * instructor's reference program (see oracle.js); generating an input is easy,
 * knowing the right answer is the hard part, and pretending otherwise is how
 * "generate counter-examples" turns into a random number generator.
 */
const BUILDERS = {
  zero: () => ['0 0\n'],
  negatives: () => ['-5 -7\n', '-100 1\n'],
  int_overflow: () => ['2147483647 1\n', '-2147483648 -1\n'],
  whitespace: () => ['  12\t34  \n', '\n\n7   8\n'],
  empty: () => [''],
  long_line: () => [`${'9 '.repeat(5000)}0\n`],
  boundary: () => ['0 1\n', '-1 0\n', '1 -1\n'],
};

const NOTES = {
  int_overflow: 'Signed overflow is undefined behaviour in C; the reference result is what this compiler produces.',
  whitespace: 'Leading, trailing and repeated whitespace must not change the answer.',
  empty: 'An empty input should be handled without crashing.',
  long_line: 'A 10,000-character line must not overflow a fixed buffer.',
  zero: 'Zero is a boundary for division and sign handling.',
  negatives: 'Negative operands exercise sign handling.',
  boundary: 'Values immediately around zero.',
};

export function generateCases(caseNames = []) {
  const cases = [];
  for (const name of caseNames) {
    const builder = BUILDERS[name];
    if (!builder) continue;
    builder().forEach((stdin, index) => {
      cases.push({ case: name, label: `${name}${builder().length > 1 ? `-${index + 1}` : ''}`, stdin, note: NOTES[name] ?? '' });
    });
  }
  return cases;
}

export const SUPPORTED_CASES = Object.keys(BUILDERS);
