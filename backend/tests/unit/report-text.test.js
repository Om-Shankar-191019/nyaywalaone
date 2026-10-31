import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderReportText } from '../../src/grading/coordinator.js';
import { reportFixture } from '../fixtures/report-view.js';

const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = join(here, '..', 'golden', 'report-text.txt');

/**
 * Day 20: the text report is a deliverable in its own right - it is what a
 * student downloads and what an instructor attaches to a case. A golden file
 * makes any layout change visible in review instead of discovered after a
 * submission deadline.
 *
 * To accept an intentional change: `UPDATE_GOLDEN=1 npm test`.
 */
describe('text report', () => {
  const rendered = renderReportText(reportFixture);

  it('matches the golden file', () => {
    if (process.env.UPDATE_GOLDEN === '1') {
      writeFileSync(goldenPath, rendered, 'utf8');
      return;
    }
    const golden = readFileSync(goldenPath, 'utf8');
    assert.equal(rendered, golden, 'The text report changed. Re-run with UPDATE_GOLDEN=1 if that was intended.');
  });

  it('is deterministic: two renders of the same report are identical', () => {
    assert.equal(renderReportText(reportFixture), rendered);
  });

  it('prints the grade, the usefulness block and every limitation', () => {
    assert.match(rendered, /GRADE\s+87\.14 \/ 100/);
    assert.match(rendered, /Usefulness and limitations/);
    for (const limitation of reportFixture.report.limitations) {
      assert.ok(rendered.includes(limitation), `Missing limitation: ${limitation.slice(0, 40)}...`);
    }
  });

  it('keeps every metric on its own row, in rule-set order', () => {
    const names = reportFixture.report.metrics.map((metric) => metric.name);
    const positions = names.map((name) => rendered.indexOf(name));
    assert.ok(positions.every((position) => position > -1));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'Metrics are out of order');
  });

  it('names the unavailable metric instead of printing a silent zero', () => {
    assert.match(rendered, /readability_llm/);
    assert.match(rendered, /unavailable/);
  });
});
