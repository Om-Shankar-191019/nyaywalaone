import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';

/** Mirrors `config.maxSourceBytes` on the server, which stays authoritative. */
export const MAX_SOURCE_BYTES = 64 * 1024;
export const MAX_FILENAME = 120;

/**
 * The same checks the API will make, run first so a student with a 70 KB file
 * finds out before watching a spinner. The server repeats them: this is a
 * courtesy, not a control.
 */
export function validateSubmission({ filename, source }) {
  const problems = [];
  const name = String(filename ?? '').trim();
  const text = String(source ?? '');
  const bytes = new TextEncoder().encode(text).length;

  if (!name) problems.push('Give the file a name.');
  else if (name.length > MAX_FILENAME) problems.push(`The file name must be at most ${MAX_FILENAME} characters.`);
  else if (!/\.c$/i.test(name)) problems.push('The file name must end in .c - this assignment is graded as C.');

  if (!text.trim()) problems.push('The file is empty.');
  else if (text.includes('\u0000')) problems.push('The file contains a null byte, so it is not a text source file.');
  else if (bytes > MAX_SOURCE_BYTES) {
    problems.push(`The file is ${(bytes / 1024).toFixed(1)} KB; the limit is ${MAX_SOURCE_BYTES / 1024} KB.`);
  }

  return { problems, bytes, ok: problems.length === 0 };
}

export const STAGE_ORDER = ['queued', 'compiling', 'testing', 'analyzing'];

export const STAGE_LABEL = {
  queued: 'Queued',
  compiling: 'Compiling',
  testing: 'Running tests',
  analyzing: 'Analysing',
  done: 'Finished',
  failed: 'Failed',
};

export const STAGE_DETAIL = {
  queued: 'Waiting for a grading worker.',
  compiling: 'The sandbox is compiling your file.',
  testing: 'Running your tests and edge cases.',
  analyzing: 'Checking structure, memory, readability and originality.',
  done: 'Your report is ready.',
  failed: 'Grading stopped before producing a report.',
};

const FIRST_DELAY_MS = 1500;
const MAX_DELAY_MS = 5000;
/** After this long we say "still grading" - but we never stop asking. */
const SLOW_AFTER_MS = 25_000;
const BACKOFF = 1.35;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One kick per submission at a time. The request either grades the row or is
 * refused in a single query, but a graded run takes a few seconds, so piling
 * kicks on every tick would only queue work behind the one already running.
 */
const kicksInFlight = new Set();

/**
 * The poll is also the worker's alarm clock.
 *
 * On Vercel the response ends the invocation, so the server-side kick that
 * starts grading right after a submit is a best effort - and the per-minute
 * cron that used to cover the rest is a Pro-only plan feature. This asks the API
 * to claim and grade the row while the student is watching it. The claim is
 * atomic, so a second tab, the submit-time kick or the daily drain winning the
 * race is a cheap no-op rather than a second grade.
 */
function kickGrading(submissionId) {
  if (kicksInFlight.has(submissionId)) return;
  kicksInFlight.add(submissionId);
  api
    .post(`/submissions/${submissionId}/grade`)
    .catch(() => {})
    .finally(() => kicksInFlight.delete(submissionId));
}

/**
 * Polls one submission until its evaluation reaches a terminal state.
 *
 * Three rules from the plan are enforced here rather than in the component:
 *  - the delay starts at 1.5 s and backs off to 5 s, so a fast grade still feels
 *    immediate without hammering the API;
 *  - it never gives up. After 25 s it says "still grading" and keeps asking,
 *    because a message you cannot get past is worse than a spinner that ends;
 *  - `cancel()` sets a flag that every await re-checks, so no request outlives
 *    the component or a cancelled submit.
 */
export function useGradingPoll() {
  const [state, setState] = useState({
    running: false,
    submissionId: null,
    status: null,
    stage: null,
    elapsedMs: 0,
    slow: false,
    timedOut: false,
    data: null,
    error: null,
  });

  const control = useRef({ cancelled: true });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      control.current.cancelled = true;
    };
  }, []);

  const apply = useCallback((patch) => {
    if (mounted.current) setState((previous) => ({ ...previous, ...patch }));
  }, []);

  const cancel = useCallback(() => {
    control.current.cancelled = true;
    apply({ running: false });
  }, [apply]);

  const run = useCallback(
    async (submissionId) => {
      // One poll at a time: a second "check again" must not leave the first loop
      // running, or the two loops apply their state out of order.
      control.current.cancelled = true;
      const token = { cancelled: false };
      control.current = token;
      const startedAt = Date.now();
      let delay = FIRST_DELAY_MS;

      apply({
        running: true,
        submissionId,
        status: 'QUEUED',
        stage: 'queued',
        elapsedMs: 0,
        slow: false,
        timedOut: false,
        error: null,
      });

      // Before the first wait: the grade starts now, not after a round trip.
      kickGrading(submissionId);

      while (!token.cancelled) {
        await sleep(delay);
        if (token.cancelled) return;

        try {
          const data = await api.get(`/submissions/${submissionId}`);
          if (token.cancelled) return;

          const evaluation = data?.submission?.evaluation ?? null;
          const status = evaluation?.status ?? 'QUEUED';
          const stage = evaluation?.stage ?? 'queued';
          const elapsedMs = Date.now() - startedAt;
          const finished = ['SUCCEEDED', 'PARTIAL', 'FAILED'].includes(status);
          const slow = elapsedMs >= SLOW_AFTER_MS;

          apply({ data, status, stage, elapsedMs, running: !finished, slow, timedOut: slow && !finished });

          if (finished) {
            token.cancelled = true;
            return;
          }

          // Still moving: nudge the queue again. If a run is already in flight
          // the server says so at once, so this costs one small request.
          kickGrading(submissionId);

          // Keep asking. A grade is a compile, a handful of analyzers and a few
          // model calls; a fixed deadline only produced a message the student
          // could not get past.
          delay = Math.min(MAX_DELAY_MS, Math.round(delay * BACKOFF));
        } catch (error) {
          if (token.cancelled) return;
          // A 401 was already retried by the client; anything else ends the poll
          // rather than looping on a broken endpoint.
          token.cancelled = true;
          apply({ running: false, error });
          return;
        }
      }
    },
    [apply],
  );

  const refresh = useCallback(() => {
    if (!state.submissionId) return;
    run(state.submissionId);
  }, [run, state.submissionId]);

  return { ...state, start: run, cancel, refresh };
}
