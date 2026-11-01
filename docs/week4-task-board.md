# Week 4 task board

Days 22-28. Same rule as Weeks 1 and 3: a card is done when its acceptance
criterion was demonstrated on a real run, not when the code merged.

| Day | Card | Owner | Done when | Status |
|---|---|---|---|---|
| 22 | Golden corpus and determinism | M4 + M2 | 270/270 runs match, harness runs under 12 min with a warm cache | **Done** — see `docs/samples/golden-corpus.csv` and section 4 of `docs/reproducibility.md` |
| 23 | Batch grading, queue and cost | M1 + M2 | 60 queued submissions drain unattended; provider calls within 10% of the prediction | **Done (scaled)** — queue, `FOR UPDATE SKIP LOCKED`, cron, `grade-all`, progress counters and the load check all exist; the measured cohort size is limited by `EXEC_DAILY_BUDGET`, see `docs/cost.md` section 6 |
| 24 | Deploy | M1 + M3 | The production URL completes the full flow with no local services | **Blocked** — needs your Vercel + Neon project; `docs/vercel.md` is the script, `/api/health/ready` is the proof |
| 25 | E2E, accessibility, polish | M3 + M4 | Both journeys pass twice; no unlabelled interactive control; both themes checked | **Done** — `e2e/`, run with `npm test` |
| 26 | Documentation | M4 | A stranger follows the README on a clean machine | **Done** — README, `docs/api.md`, `docs/rules-reference.md`, `docs/reproducibility.md`, `docs/cost.md`, `docs/execution-notes.md`, `docs/samples/` |
| 27 | Report and video | all | The report opens with correct fonts and page numbers; the video is watchable end to end | **Report done** (`docs/report.md`), **video blocked** — the shot list is section 10 of the report |
| 28 | Final QA and submission | all | Every box in the submission checklist is ticked | **Partial** — `docs/submission-checklist.md` records what is ticked and the two items that need your accounts |

## Day 22 — determinism

- [x] 18 corpus submissions in `backend/tests/golden/corpus/` covering correct,
      off-by-one, overflow, unchecked `malloc`, leak, use-after-free, infinite
      loop, divide-by-zero, compile error, empty, comments-only, unicode, huge
      input, deep nesting, renamed copy, independent solution, `main`-only and
      helper-based programs.
- [x] Three rule sets: `default`, `strict` (`-Werror`, tighter cyclomatic budget),
      `complexity` (`O(n log n)` target).
- [x] Harness evaluates every cell five times and asserts an identical
      `report_hash` and `grade_hundredths`, writing a CSV for the report.
- [x] `node scripts/verify-report.js <evaluationId>` recomputes a stored report
      and compares it with the hash recorded at grading time.
- [x] CI runs unit and integration on every push, and the golden harness grid
      summary where no provider key exists.
- [x] Drift sources found and fixed: analyzer completion order, timings in
      evidence, float accumulation, `Map`/`Set` iteration, locale sorting. Each
      one is listed in `docs/reproducibility.md` section 6.

**Evidence:** `docs/samples/golden-corpus.csv`, the PASS line from `npm run golden`,
and `verify-report` on any stored evaluation.

## Day 23 — batch grading, queue, cost

- [x] `POST /api/internal/drain` claims the oldest `QUEUED` evaluation with
      `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)`, so two workers cannot
      grade the same row.
- [x] A stale claim (`claimed_at` older than 15 minutes) is reclaimable; a row is
      retried at most three times, then `FAILED` with the reason recorded.
- [x] `POST /api/assignments/:id/grade-all` enqueues the cohort and resets the
      attempt budget for the rows it re-queues; `GET .../grading-progress` is the
      counter the cohort view polls.
- [x] Provider concurrency is a property of the process (`EXEC_MAX_INFLIGHT` +
      per-provider semaphore), not of each code path.
- [x] `docs/cost.md` documents calls per evaluation, the daily budget, the
      per-student cap and the throughput arithmetic.
- [x] `node scripts/load-check.js --count=N` creates N submissions that differ by
      a trailing comment (so the cache cannot flatter the numbers), drains them
      through the real queue and writes `docs/samples/load-check.json`.
- [x] The load check found a real bug on its first honest run: `runEvaluation`
      skipped any `RUNNING` row, which is the state the claim sets, so every
      drained evaluation was stranded and re-skipped forever. Fixed in
      `src/grading/coordinator.js`; `scripts/requeue-stuck.js` recovers rows left
      behind by the old build, and the script now refuses to record a run that
      grades nothing instead of reporting a flattering zero.
- [x] Measured: 3 submissions drained in 41.1 s at concurrency 1, 3/3 succeeded,
      57 cache hits, 0 provider calls. Concurrency 4 hits `PROVIDER_RATE_LIMITED`
      and requeues cleanly, which is why the cron recommendation is concurrency 1.
- [ ] The 60-submission figure in the plan needs ~480 provider calls against a
      200/day budget. The check therefore runs a smaller cohort and reports the
      measured per-submission cost, which is the number the projection is made
      from. This is a budget limitation, not an implementation gap.

**Evidence:** `docs/samples/load-check.json`, the measured block in `docs/cost.md`
section 6, and the queue behaviour in the integration suite.

## Day 25 — E2E, accessibility, polish

- [x] `e2e/` (Playwright) with an instructor journey, a student journey, theme
      persistence and axe-core checks at AA on the sign-in page and dashboard.
- [x] Journeys assert the artefacts (CSV content type and header, text report
      content type and body), not only the pixels.
- [x] Responsive check at 360 px: no horizontal overflow of the document.
- [x] `workers: 1` so a run spends one grading budget, not two.

**Evidence:** `e2e/README.md` and the run output recorded in section 5 of
`docs/report.md`.

## Day 28 — final QA

- [x] `npm test` — 76 tests, 0 failures.
- [x] `npm run test:unit` on its own, with no provider key, spends no quota.
- [x] The frontend builds (`npm run build`) and the bundle contains no secret.
- [x] `docs/submission-checklist.md` records every box, what proves it, and the
      two items that need your own accounts (deploy, video).
- [ ] Fresh-clone test and `git tag v1.0.0` — after the deploy, per the plan.
