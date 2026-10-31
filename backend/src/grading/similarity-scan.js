import { prisma } from '../db.js';
import { jaccardEstimate, minhashSignature } from './analyzers/similarity.js';

/**
 * Batch originality scan (Day 19).
 *
 * The per-submission analyzer compares one file against its peers on every
 * grade. That is fine for one student and wasteful for a cohort: a twelve-person
 * assignment re-tokenises the same eleven files twelve times per regrade. This
 * module computes each MinHash signature once, stores it on the submission, and
 * then compares integers.
 *
 * Nothing here decides anything. It writes `similarity_matches` rows and hands
 * the instructor a ranked list - a flag is a prompt to look, never a finding.
 */

export const DEFAULT_SCAN_PARAMS = Object.freeze({
  shingle_size: 7,
  num_perm: 128,
  seed: 42,
  flag_threshold: 0.85,
});

/** Pairs below this are noise on a small cohort; storing them only hides the real ones. */
const PERSIST_FLOOR = 0.5;

const paramsKey = (params) => `s${params.shingle_size}-p${params.num_perm}-k${params.seed}`;

/**
 * Reuse a stored signature when it was produced by the same parameters.
 *
 * The parameters travel with the signature because a 7-shingle signature and a
 * 10-shingle signature are not comparable - comparing them would produce a
 * number that looks like a similarity and means nothing.
 */
export async function ensureSignature(submission, params = DEFAULT_SCAN_PARAMS) {
  const stored = submission.signature;
  const storedParams = submission.signatureParams;

  if (Array.isArray(stored) && stored.length === params.num_perm && storedParams?.key === paramsKey(params)) {
    return stored;
  }

  const signature = minhashSignature(submission.source, params);
  // Best effort: a read-only replica or a test transaction must not fail the
  // scan just because the cache could not be written.
  await prisma.submission
    .update({
      where: { id: submission.id },
      data: { signature, signatureParams: { ...params, key: paramsKey(params) } },
    })
    .catch(() => {});

  return signature;
}

/**
 * Compare every submission against every other one, once.
 *
 * `submissionA < submissionB` in the primary key means a pair is stored once no
 * matter which side is graded first, so a rescan updates rather than duplicates.
 */
export async function scanAssignment(assignmentId, overrides = {}) {
  const params = { ...DEFAULT_SCAN_PARAMS, ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) };

  const submissions = await prisma.submission.findMany({
    where: { assignmentId },
    select: {
      id: true,
      studentId: true,
      attempt: true,
      source: true,
      sourceHash: true,
      signature: true,
      signatureParams: true,
      student: { select: { fullName: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (submissions.length < 2) {
    return { compared: 0, pairs: 0, stored: 0, flagged: 0, submissions: submissions.length, params };
  }

  const signatures = new Map();
  for (const submission of submissions) {
    signatures.set(submission.id, await ensureSignature(submission, params));
  }

  const pairs = [];
  for (let i = 0; i < submissions.length; i += 1) {
    for (let j = i + 1; j < submissions.length; j += 1) {
      const left = submissions[i];
      const right = submissions[j];
      if (left.studentId === right.studentId) continue; // own attempts are not plagiarism

      const identical = left.sourceHash && left.sourceHash === right.sourceHash;
      const similarity = identical ? 1 : jaccardEstimate(signatures.get(left.id), signatures.get(right.id));
      if (similarity < PERSIST_FLOOR) continue;

      const [a, b] = [left.id, right.id].sort();
      pairs.push({
        a,
        b,
        similarity: Math.round(similarity * 1000) / 1000,
        identical: Boolean(identical),
        students: [left.student?.fullName ?? null, right.student?.fullName ?? null],
        attempts: [left.attempt, right.attempt],
      });
    }
  }

  let stored = 0;
  for (const pair of pairs) {
    await prisma.similarityMatch
      .upsert({
        where: { submissionA_submissionB_method: { submissionA: pair.a, submissionB: pair.b, method: `minhash-${params.num_perm}` } },
        create: {
          assignmentId,
          submissionA: pair.a,
          submissionB: pair.b,
          similarity: pair.similarity,
          method: `minhash-${params.num_perm}`,
          matchedSpan: { identical: pair.identical, shingle_size: params.shingle_size },
        },
        update: { similarity: pair.similarity },
      })
      .catch(() => {});
    stored += 1;
  }

  return {
    submissions: submissions.length,
    compared: (submissions.length * (submissions.length - 1)) / 2,
    pairs: pairs.length,
    stored,
    flagged: pairs.filter((pair) => pair.similarity >= params.flag_threshold).length,
    params,
  };
}

/**
 * Record a human decision next to a flag.
 *
 * `reviewed: false` re-opens it, which matters because a reviewed pair is
 * usually just two students who solved the same small problem the same way.
 */
export async function reviewMatch(matchId, { reviewed, note, reviewerId }) {
  return prisma.similarityMatch.update({
    where: { id: matchId },
    data: {
      reviewedAt: reviewed ? new Date() : null,
      reviewedBy: reviewed ? reviewerId : null,
      reviewNote: reviewed ? String(note ?? '').slice(0, 500) || null : null,
    },
  });
}
