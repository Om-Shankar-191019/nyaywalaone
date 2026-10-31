#!/usr/bin/env node
/**
 * Day 22: verify one stored report.
 *
 *   node scripts/verify-report.js <evaluationId> [--json]
 *
 * Recomputes the report from the persisted rows and compares the hash with the
 * one stored at grading time. This is the answer to "can I check a grade I do
 * not trust?" - it needs no provider call and changes nothing.
 */
import 'dotenv/config';

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const asJson = process.argv.includes('--json');

if (args.length !== 1) {
  console.error('Usage: node scripts/verify-report.js <evaluationId> [--json]');
  process.exit(2);
}

const { prisma } = await import('../src/db.js');
const { reportForEvaluation } = await import('../src/grading/coordinator.js');

const evaluationId = args[0];

try {
  const report = await reportForEvaluation(evaluationId);
  const summary = {
    evaluation_id: evaluationId,
    stored_hash: report.storedHash,
    recomputed_hash: report.hash,
    verified: report.verified,
    grade_hundredths: report.json.grade.hundredths,
    grade_percent: report.json.grade.percent,
    status: report.json.evaluation.status,
    rule_set_version: report.json.rule_set.version,
    metrics: report.json.metrics.length,
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Evaluation   ${summary.evaluation_id}`);
    console.log(`Status       ${summary.status}   rule set v${summary.rule_set_version}   ${summary.metrics} metrics`);
    console.log(`Grade        ${summary.grade_percent} / 100 (${summary.grade_hundredths} hundredths)`);
    console.log(`Stored hash  ${summary.stored_hash ?? '(none)'}`);
    console.log(`Recomputed   ${summary.recomputed_hash}`);
    console.log(summary.verified ? 'PASS: the report recomputes to the stored hash.' : 'FAIL: the recomputed report does not match the stored hash.');
  }

  await prisma.$disconnect();
  process.exitCode = summary.verified ? 0 : 1;
} catch (error) {
  console.error(`Could not verify ${evaluationId}: ${error?.message ?? error}`);
  await prisma.$disconnect().catch(() => {});
  process.exitCode = 1;
}
