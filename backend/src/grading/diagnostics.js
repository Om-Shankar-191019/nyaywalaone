/**
 * Parse gcc diagnostics from `compile_output`.
 *
 * Shape we depend on:
 *   main.c:8:5: error: 'x' undeclared (first use in this function)
 *   main.c:8:5: warning: unused variable 'y' [-Wunused-variable]
 *
 * The `[-Wflag]` suffix is the stable identifier; the prose is not, so it is
 * kept for the student and never branched on.
 */
const DIAGNOSTIC = /^(.*?):(\d+):(\d+):\s+(fatal error|error|warning|note):\s+(.*)$/;
const FLAG = /\[(-W[^\]]+)\]$/;

export function parseGccOutput(compileOutput = '') {
  const errors = [];
  const warnings = [];
  const notes = [];
  const byCode = {};

  for (const line of String(compileOutput).split('\n')) {
    const match = DIAGNOSTIC.exec(line.trim());
    if (!match) continue;

    const [, file, lineNumber, column, severity, rest] = match;
    const flag = FLAG.exec(rest);
    const diagnostic = {
      file,
      line: Number(lineNumber),
      column: Number(column),
      severity,
      message: rest.replace(FLAG, '').trim(),
      code: flag ? flag[1] : null,
    };

    if (severity === 'warning') {
      warnings.push(diagnostic);
      const code = diagnostic.code ?? 'warning';
      byCode[code] = (byCode[code] ?? 0) + 1;
    } else if (severity === 'note') {
      notes.push(diagnostic);
    } else {
      errors.push(diagnostic);
    }
  }

  return { errors, warnings, notes, byCode };
}

/** A one-line, student-readable description of the first diagnostic. */
export function firstDiagnosticSummary(parsed) {
  const first = parsed.errors[0] ?? parsed.warnings[0];
  if (!first) return null;
  return `${first.file}:${first.line}:${first.column} ${first.severity}: ${first.message}`;
}
