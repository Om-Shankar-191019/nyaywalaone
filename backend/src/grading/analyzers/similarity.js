import { z } from 'zod';
import { sha256Hex } from '../canonical.js';
import { clamp01, round3 } from '../score.js';

export const paramsSchema = z
  .object({
    corpus: z.enum(['assignment', 'assignment+archive']).default('assignment'),
    flag_threshold: z.number().min(0.5).max(1).default(0.85),
    shingle_size: z.number().int().min(3).max(20).default(7),
    num_perm: z.number().int().min(32).max(512).default(128),
    seed: z.number().int().min(0).max(1_000_000).default(42),
  })
  .strict();

const KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern',
  'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'restrict', 'return', 'short', 'signed',
  'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while',
]);

/**
 * Identifiers become ID, literals become LIT, comments and whitespace vanish.
 * What is left is the shape of the program, which is what copy-paste preserves.
 */
export function normaliseTokens(source) {
  const cleaned = String(source)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  const raw = cleaned.match(/[A-Za-z_]\w*|\d+(?:\.\d+)?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]/g) ?? [];
  return raw.map((token) => {
    if (/^[A-Za-z_]/.test(token)) return KEYWORDS.has(token) ? token : 'ID';
    if (/^\d/.test(token) || /^["']/.test(token)) return 'LIT';
    return token;
  });
}

export function shingles(tokens, size) {
  if (tokens.length < size) return tokens.length ? [tokens.join('\u0001')] : [];
  const out = [];
  for (let index = 0; index + size <= tokens.length; index += 1) {
    out.push(tokens.slice(index, index + size).join('\u0001'));
  }
  return out;
}

/** FNV-1a, 32-bit. Deterministic across platforms, which is the only requirement. */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const mulberry32 = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const PRIME = 0x7fffffff;

/** MinHash signature with fixed permutations derived from the rule set's seed. */
export function minhashSignature(text, { shingleSize = 7, numPerm = 128, seed = 42 } = {}) {
  const hashes = shingles(normaliseTokens(text), shingleSize).map(fnv1a);
  if (!hashes.length) return new Array(numPerm).fill(0);

  const random = mulberry32(seed);
  const permutations = Array.from({ length: numPerm }, () => ({
    a: 1 + Math.floor(random() * (PRIME - 1)),
    b: Math.floor(random() * PRIME),
  }));

  return permutations.map(({ a, b }) => {
    let minimum = Infinity;
    for (const hash of hashes) {
      const value = (Math.imul(a, hash) + b) % PRIME;
      if (value < minimum) minimum = value;
    }
    return minimum;
  });
}

export function jaccardEstimate(a, b) {
  if (!a.length || a.length !== b.length) return 0;
  let same = 0;
  for (let index = 0; index < a.length; index += 1) if (a[index] === b[index]) same += 1;
  return same / a.length;
}

/**
 * Originality, compared against peers and an optional archive.
 *
 * Both guard rails from the plan are here: the flag is "review recommended",
 * never "plagiarised", and the evidence includes ids and a score so a human can
 * decide in seconds. Identical files are reported separately because that is a
 * fact, not a judgement.
 */
export const similarityAnalyzer = {
  name: 'similarity_flag',
  supports: ['source'],
  paramsSchema,

  async run(ctx, params) {
    const peers = (ctx.corpus ?? []).filter((item) => item.id !== ctx.submissionId && item.source);
    if (!peers.length) {
      return {
        score: 1,
        status: 'partial',
        evidence: { reason: 'no_peer_submissions', compared: 0, threshold: params.flag_threshold },
        feedback: 'No other submissions exist yet, so originality could not be compared. Full credit is provisional.',
      };
    }

    // A stored signature is reusable only when the parameters that produced it
    // match the ones this rule set asks for; a 7-shingle and a 10-shingle
    // signature are not comparable, and pretending otherwise would invent a
    // similarity score that means nothing.
    const key = `s${params.shingle_size}-p${params.num_perm}-k${params.seed}`;
    const signatureFor = (item) => {
      const stored = item.signature;
      if (Array.isArray(stored) && stored.length === params.num_perm && item.signatureParams?.key === key) return stored;
      return minhashSignature(item.source, params);
    };

    const signature = minhashSignature(ctx.source, params);
    const comparisons = peers.map((peer) => {
      const similarity = peer.sourceHash && peer.sourceHash === ctx.sourceHash
        ? 1
        : jaccardEstimate(signature, signatureFor(peer));
      return {
        submissionId: peer.id,
        studentId: peer.studentId ?? null,
        similarity: Math.round(similarity * 1000) / 1000,
        identical: Boolean(peer.sourceHash && peer.sourceHash === ctx.sourceHash),
        sample: shingles(normaliseTokens(ctx.source), params.shingle_size)[0]?.slice(0, 120) ?? null,
      };
    });

    comparisons.sort((a, b) => b.similarity - a.similarity || String(a.submissionId).localeCompare(String(b.submissionId)));
    const top = comparisons.slice(0, 3);
    const max = top[0]?.similarity ?? 0;
    const identical = comparisons.some((item) => item.identical);
    const flagged = max >= params.flag_threshold || identical;

    // Original work keeps full marks; above 50% the score slides to zero at 100%.
    const score = identical ? 0 : clamp01(1 - Math.max(0, max - 0.5) / 0.5);

    return {
      score: round3(score),
      status: 'ok',
      evidence: {
        compared: comparisons.length,
        method: `minhash-${params.num_perm}`,
        shingle_size: params.shingle_size,
        threshold: params.flag_threshold,
        max_similarity: max,
        top_matches: top,
        flag: flagged ? 'review_recommended' : 'none',
        identical_copy: identical,
        note: 'A flag is a reason to look, not a finding of misconduct. Identical canonical solutions also score high.',
      },
      feedback: identical
        ? 'This file is byte-identical to another submission. Review recommended.'
        : flagged
          ? `Similarity ${Math.round(max * 100)}% with another submission. Review recommended, not a conclusion.`
          : `Most similar submission: ${Math.round(max * 100)}%. Below the ${Math.round(params.flag_threshold * 100)}% review threshold.`,
    };
  },
};

export const similaritySourceHash = (source) => sha256Hex(source);
