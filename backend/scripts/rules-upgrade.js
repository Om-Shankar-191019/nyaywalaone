#!/usr/bin/env node
/**
 * Give existing assignments the four advisory language-model checks.
 *
 *   npm run rules:upgrade          # dry run, prints what would change
 *   npm run rules:upgrade -- --apply
 *
 * New assignments get these metrics from `defaultRules()`. Assignments that were
 * published before this release keep their frozen rule set - correctly, because
 * a stored report points at the rules it was graded with - so they need a new
 * *version* rather than an edit. That is what this does: copy the current rules,
 * append the metrics that are missing (weight 0, so the grade cannot move),
 * validate, then publish as version n+1.
 *
 * It never mutates an existing row and never touches weights.
 */
import 'dotenv/config';

const { prisma } = await import('../src/db.js');
const { resolveRules } = await import('../src/grading/rules.js');
const { rulesHash } = await import('../src/grading/canonical.js');

const apply = process.argv.includes('--apply');

const ADVISORY = [
  { name: 'feedback_llm', analyzer: 'llm_feedback', weight: 0, params: {} },
  { name: 'style_llm', analyzer: 'llm_style_review', weight: 0, params: { strictness: 'normal' } },
  { name: 'integrity_llm', analyzer: 'llm_plagiarism', weight: 0, params: {} },
  { name: 'compile_recovery_llm', analyzer: 'llm_compile_recovery', weight: 0, params: { max_credit: 0.4 } },
];

const has = (rules, analyzer) => (rules.metrics ?? []).some((metric) => metric.analyzer === analyzer);

const assignments = await prisma.assignment.findMany({
  where: { activeRuleSetId: { not: null } },
  include: {
    activeRuleSet: true,
    course: { select: { id: true, name: true, instructorId: true } },
  },
  orderBy: { createdAt: 'asc' },
});

let changed = 0;
let skipped = 0;

for (const assignment of assignments) {
  const ruleset = assignment.activeRuleSet;
  if (!ruleset) continue;

  const raw = ruleset.rules;
  const missing = ADVISORY.filter((metric) => !has(raw, metric.analyzer));
  if (!missing.length) {
    skipped += 1;
    continue;
  }

  const next = { ...raw, metrics: [...raw.metrics, ...missing] };
  const { rules, errors } = resolveRules(next);
  if (errors.length) {
    console.error(`  SKIP ${assignment.title}: ${errors[0].path} ${errors[0].message}`);
    continue;
  }

  const hash = rulesHash(rules);
  console.log(
    `${apply ? 'UPGRADE' : 'would upgrade'}  ${assignment.course.name} / ${assignment.title}: v${ruleset.version} → v${ruleset.version + 1} (+${missing.length} advisory metrics)`,
  );
  changed += 1;

  if (!apply) continue;

  const created = await prisma.ruleSet.create({
    data: {
      assignmentId: assignment.id,
      version: ruleset.version + 1,
      rules,
      rulesHash: hash,
      isPublished: true,
      publishedAt: new Date(),
      createdById: assignment.course.instructorId,
    },
  });

  await prisma.assignment.update({
    where: { id: assignment.id },
    data: { activeRuleSetId: created.id, publishedAt: new Date() },
  });
}

console.log(`\n${changed} assignment(s) ${apply ? 'upgraded' : 'would be upgraded'}, ${skipped} already current.`);
if (!apply && changed) console.log('Re-run with --apply to publish the new versions.');
await prisma.$disconnect();
