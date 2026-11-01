# Nyaywala — rule-driven, reproducible grading for C assignments

**Course project report.** Code: this repository. Deployed app: see section 13.
Recording: section 10.

---

## 1. Objective

Marking a programming assignment has three problems that are usually solved by
hand: a rubric that lives in a tutor's head, a mark nobody can re-derive, and
feedback that costs more time than the mark. Nyaywala is a web application that
makes all three explicit.

The claim under test is narrow and checkable: **the same submission, graded under
the same rubric on the same toolchain, always produces the same grade, and that
grade can be recomputed by a third party without access to the grading
infrastructure.** Everything else in the system — the queue, the UI, the
similarity review — exists to make that claim usable at cohort scale.

What exists:

- an instructor workspace where the rubric is data (JSON), edited in the browser,
  versioned and frozen by hash on publish;
- ten analyzers behind a weighted model, each producing its own evidence;
- a student experience that turns the result into an actionable report;
- a batch queue that grades a cohort unattended within a sandbox call budget;
- a reproducible-corpus harness that fails the build when a grade drifts.

---

## 2. Architecture

| Layer | Choice | Why |
|---|---|---|
| Frontend | React 19, Vite 6, Tailwind 4, TanStack Query | role-separated SPA; no SSR requirement; the report is data-heavy and client-rendered |
| API | Express 4, Zod validation at every boundary | small surface, 60 routes, no need for a framework's conventions |
| Data | PostgreSQL (Neon) + Prisma 7 with the `pg` adapter | relational shape (courses → assignments → tests → evaluations → metrics); SQL constraints are part of correctness here |
| Execution | provider abstraction: onlinecompiler (gcc 15), Judge0, Wandbox | the sandbox is a dependency, not a platform; the fingerprint of whichever answered is recorded |
| Analysis | tree-sitter C, MinHash similarity, optional Groq LLM (advisory) | static analysis is free and deterministic; the LLM is never allowed to move a mark |
| Job running | Postgres queue with `FOR UPDATE SKIP LOCKED` + cron drain | the database already exists; a broker would be a second system to keep alive for ~100 jobs/day |

The request path for a submission is: upload (hashing, size and type gates) →
`POST /submissions` creates an `Evaluation` row and its `evaluation_key` → the
queue claims it → compile gate → test cases → static analyzers (in parallel,
bounded) → score → report render → `report_hash` stored → the student's page
polls a stage endpoint.

---

## 3. The rule model

A rule set is a JSON document: `schema_version`, `problem`, `limits`,
`on_unavailable`, and an ordered list of `{ name, analyzer, weight, params }`.

Three properties make it a rubric rather than a config file:

1. **Weights must sum to exactly 1.00.** The editor computes the total live and
   refuses to publish otherwise; the API enforces the same check with Zod, so a
   `curl` cannot bypass the UI.
2. **Publishing is versioned and hashed.** v(n) is immutable; the hash of the
   canonical JSON is stored on every evaluation, and the report names it.
3. **The score is integer hundredths.** `round(Σ score × weight × 100)`, clamped
   to 0–10000. No float ever reaches the database, so no two orderings of the
   same sum can disagree.

`on_unavailable` decides what a metric that could not run costs: `renormalize`
redistributes its weight over the metrics that did run, `zero` charges it. This is
a policy the instructor chooses, not a silent fallback — a missing analyzer must
never quietly be worth full marks or zero marks without the rubric saying so.

---

## 4. The ten analyzers

| Metric | What it measures | Score | Sandbox calls |
|---|---|---|---|
| `correctness` (`io_tests`) | the assignment's test cases, whitespace-normalised | `passed / total` | 1 per case |
| `syntax` (`compiler_warnings`) | diagnostics from the rule set's flags | `max(0, 1 − warnings × penalty)` | 0 (compile gate) |
| `structure` (`static_analysis`) | cyclomatic complexity, function length, nesting | mean of three linear decays | 0 |
| `modularity` (`function_split`) | helper functions, `main` length | `0.4·count + 0.2·helper + 0.4·main` | 0 |
| `logic` (`edge_case_runner`) | generated inputs vs a reference solution (oracle) | pass ratio, capped without an oracle | 1 per case |
| `complexity` (`complexity_estimator`) | order of growth from loop nesting and recursion | `max(0, 1 − 0.25 × levels over target)` | 0 |
| `memory` (`memory_audit`) | leaks, unchecked `malloc`, banned functions, optional ASan | 1 minus weighted findings | 0, or 1 with ASan |
| `readability` (`style_analysis`) | identifier length, comments, line length | weighted blend | 0 |
| `originality` (`similarity_flag`) | MinHash over 7-token shingles vs the corpus | 1 below 0.5 similarity → 0 at 1.0 | 0 |
| `llm_review` | advisory prose on the source | never weighted by default (`0.00`) | 0 sandbox, 1 HTTP |

`docs/rules-reference.md` documents every parameter with its default, and the
rules editor builds its form from each analyzer's `paramsSchema` — adding an
analyzer needs no UI change.

---

## 5. Complexity measurement, honestly

Two different things are called "complexity" here and they are kept apart:

- **Cyclomatic complexity** (`structure`): measured statically from the control
  flow graph via tree-sitter, per function. This is a real measurement.
- **Order of growth** (`complexity_estimator`): estimated statically from loop
  nesting depth and recursion. This is an *estimate*, and the rule set's
  `timing_evidence` flag exists to record why a timing curve was not produced: a
  real empirical curve needs an input-size parameter in the problem contract,
  which the model does not have. The metric says `mode: "static"` in its evidence
  instead of printing a fabricated table.

The default rule set requires `O(1)` for the sum problem, so a solution that
sorts its input loses 0.25 per level over — visible in the report as a named
metric, not as a mysterious deduction.

---

## 6. Coordination and gating

Order is a correctness property, not an implementation detail:

1. **Compile gate first.** A compile error makes `correctness` and every
   execution metric `unavailable` (not zero — no evidence), so a student is not
   punished ten times for one syntax error.
2. **Flags gate execution order.** If the source trips a definitional flag
   (infinite loop, `gets`, banned function), the analyzers that would run it are
   skipped and the report says which and why.
3. **Parallel static analysis.** The tree-sitter metrics run concurrently, then
   results are sorted into rule order before scoring — this is one of the five
   drift sources that had to be fixed (see `docs/reproducibility.md` §6).
4. **Budget.** Every provider call goes through a per-provider semaphore and a
   daily counter (`EXEC_DAILY_BUDGET`). Exhaustion returns a named error
   (`PROVIDER_BUDGET_EXCEEDED`), not a silent zero.
5. **Idempotence.** The `evaluation_key` dedupes a repeated submission onto the
   stored evaluation; the attempt counter is separate, so a student can resubmit
   and still be told "same grade, same hash".

---

## 7. Reproducibility

A grade is a function of five values and nothing else: `source_hash`,
`rules_hash`, `testset_hash`, `toolchain_hash`, `grader_version`. Their
combination identifies the run. Volatile values (timings, memory, cache hits,
analyzer completion order) are kept as evidence and excluded from the report
hash.

Two artefacts make this checkable by someone who does not trust the app:

```bash
cd backend
node scripts/verify-report.js <evaluationId>   # recomputes from stored rows
npm run golden                                 # 270 runs, asserts identical hashes
```

`verify-report` needs no sandbox call and no network beyond the database. The
golden harness replays 18 corpus submissions against 3 rule sets, 5 times each,
and exits non-zero on any drift. Both are gated in CI.

---

## 8. Results

### 8.1 Test suites

| Suite | Result |
|---|---|
| `npm run test:unit` | 47 pass, 0 fail |
| `npm run test:integration` (real database) | 29 pass, 0 fail |
| `npm test` (both) | 76 pass, 0 fail, 0 cancelled |
| Playwright E2E (2 role journeys, 2 theme, 3 accessibility/responsive) | 8 pass, 0 fail (1.1 min) |

<!-- MEASURED:GOLDEN:BEGIN -->
### 8.2 The golden corpus

| Measure | Value |
|---|---|
| Cells (18 submissions × 3 rule sets) | 54 |
| Repeats per cell | 5 |
| Runs | 270 |
| Runs matching their baseline grade and hash | **270 / 270** |
| Provider calls spent | 0 (warm execution cache) |
| Execution-cache hits | 4735 |

The grades in the first repeat, which every later repeat had to reproduce:
`01-correct` 89.00, `03-overflow` 85.03, `04-unchecked-malloc` 83.08,
`05-leak` 83.08, `06-use-after-free` 62.87, `07-infinite-loop` 64.68,
`08-divide-by-zero` 60.23, `09-compile-error` 0.00 (`PARTIAL`: no evidence, not a
zero that pretends to be a mark), `10-empty` 0.00 (`PARTIAL`), `15-renamed-copy`
90.23, `16-independent-solution` 85.43, `18-helper-based` 91.98.

Full table: `docs/samples/golden-corpus.csv`.
<!-- MEASURED:GOLDEN:END -->

<!-- MEASURED:COST:BEGIN -->
### 8.3 Cost and throughput

| Measure | Value |
|---|---|
| Cohort drained in the load check | 3 submissions (budget-bounded, not the plan's 60) |
| Wall time, drain start to last graded | 41.1 s (13.7 s per submission, concurrency 1) |
| Provider calls spent | 0 |
| Execution-cache hits | 57 (100%) |
| Outcome | 3 succeeded, 0 partial, 0 failed, 0 requeued |
| Provider calls per cold submission | 8 (model, `docs/cost.md` §3) — **not measured cold in this run** |

The load check found three things worth more than its wall time. The appended
variant comment does not defeat the cache (comments are stripped before hashing),
so it measures queue throughput rather than provider cost. Concurrency 4 hits the
provider's rate limit and requeues cleanly; concurrency 1 drains without a retry.
And it exposed a real queue bug: `runEvaluation` skipped rows already marked
`RUNNING`, which is exactly the state the claim sets, so every drained evaluation
was stranded in `RUNNING` and re-skipped on the next tick. The fix is one
condition in `src/grading/coordinator.js`; `scripts/requeue-stuck.js` recovers
rows stranded by the older build. A batch queue that silently grades nothing is
precisely the failure this test was for.

Model: `docs/cost.md`. Raw run: `docs/samples/load-check.json`.
<!-- MEASURED:COST:END -->

---

## 9. Workload distribution and timeline

Four members, four weeks. The split follows the seam between "what a grade means"
and "how it is delivered", and every week ended with a demo a non-author could
run.

| Week | Focus | M1 (platform) | M2 (grading) | M3 (frontend) | M4 (QA/docs) |
|---|---|---|---|---|---|
| 1 | Foundations | schema, auth, roles, seed | evaluation model, hashing | shell, theme, login | test harness, README |
| 2 | Grading engine | provider abstraction, budget, stage endpoint | compile gate, 10 analyzers, scoring | editor, upload, stage tracker | analyzer unit tests, cost model |
| 3 | Product surface | rule-set API, versioning, regrade | similarity, review, release | rule editor, cohort table, similarity UI | E2E skeleton, security review |
| 4 | Reproducibility & delivery | queue, cron drain, deploy runbook | golden corpus, verify CLI, drift fixes | batch UI, accessibility, theming | report, docs, checklist |

Artefacts per week: `docs/demo-1.md` … `docs/demo-4.md`. The board with acceptance
criteria per day is `docs/task-board.md` and `docs/week4-task-board.md`.

---

## 10. Video shot list (15–20 minutes)

| Time | Shot |
|---|---|
| 0:00–1:30 | The problem, the claim (§1), the two roles. |
| 1:30–3:30 | Student submits a correct file. Stage tracker. Report. |
| 3:30–5:30 | The rubric in the browser: weights, publish, hash. Change a threshold, regrade, show the diff. |
| 5:30–7:30 | A wrong submission: failing case with input/expected/actual. |
| 7:30–9:30 | A pathological one: infinite loop or overflow — the gate, the partial report, the honest limitation. |
| 9:30–11:30 | `verify-report` on a stored grade; the five inputs; the drift table. |
| 11:30–13:00 | Golden corpus CSV; CI run. |
| 13:00–14:30 | Batch: **Grade all**, progress counters, queue depth. |
| 14:30–16:00 | Deployed URL, both roles, phone viewport. |
| 16:00–18:00 | Usefulness and limitations (§11, §12), what I would do next. |

---

## 11. What the tool is genuinely useful for

1. **Making the rubric contestable.** A student who disagrees with a mark can
   read `rules_hash`, open the exact rule set version, and see the arithmetic per
   metric. In the corpus, `13-deep-nesting.c` loses a predictable 0.30 for
   structure and nothing else — a conversation about a number instead of a grade.
2. **Catching what a human marker skims.** The corpus contains an uninitialised
   variable that produces the right output for the sample input
   (`05-unchecked-malloc.c`) and a leak that never matters for small inputs
   (`04-leak.c`). Both pass `correctness` and still lose memory marks with the
   allocation named. A marker reading output alone would pass them.
3. **Batch regrading without re-marking by hand.** When a rubric changes, the
   cohort is requeued and every grade is recomputed from stored sources. The
   queue drains inside a call budget rather than at the provider's rate limit
   error.
4. **Evidence for an appeal.** The text report is a self-contained document:
   rule set, test results, per-metric evidence, toolchain fingerprint and hash.
   It is the artefact a student actually needs, and it comes out of the same rows
   the grade came from.

## 12. Where it is wrong, and how

Each limitation below has a concrete case in the corpus where the tool gives a
verdict a human would disagree with. They are stated as failures, not as "future
work".

1. **Wrong verdict: a correct program marked down for style.**
   `01-correct.c` uses `a`, `b` and `sum` as identifiers. `style_analysis`
   penalises the average identifier length against `min_name_length: 3`, so a
   program that is entirely correct, safe and readable loses readability marks
   for using short names. Style is weighted `0.05`, which keeps the damage small
   but does not make it right: `min_name_length` is a proxy that a human would
   not apply mechanically.

2. **Wrong verdict: a memory-safe program flagged for an allocation it frees.**
   `03-overflow.c` and `02-off-by-one.c` are flagged by pattern, not by proof, so
   a `malloc` whose result is checked through an intermediate variable reads as
   unchecked. `memory_audit` is a static heuristic; `sanitizer_run: true` is the
   only way to get a real verdict, and it costs a provider call and fails on
   providers that reject `-fsanitize=address`.

3. **Wrong verdict: an `O(n log n)` solution judged for `O(1)`.**
   `16-independent-solution.c` solves the problem by reading and sorting, which
   is worse than required and loses complexity marks even though every test
   passes. That is defensible for a rubric that asks for `O(1)`, but the estimate
   comes from loop nesting, so a single loop calling a library `qsort` looks
   cheaper than it is — the metric cannot see into the library.

4. **Wrong verdict: plagiarism flagged between two honest solutions.**
   The similarity metric is MinHash over token shingles. `15-renamed-copy.c` is a
   genuine copy and is flagged correctly, but two students who both follow the
   same lecture skeleton will also exceed `flag_threshold: 0.85` on a small
   program. The system is built so this cannot change a mark — a flag creates a
   review row, and `PATCH /similarity/:matchId/review` records a human decision —
   but the false positive costs an instructor's attention, and on a 20-line
   program the signal is weak.

A fifth, structural limitation belongs here rather than in a footnote: **the
sandbox is a third-party dependency.** A compiler upgrade changes marks, and the
`toolchain_hash` is how that is noticed after the fact rather than prevented.

---

## 13. Running it

```bash
cd backend && cp .env.example .env       # DATABASE_URL, DIRECT_URL, ACCESS_TOKEN_SECRET
npm install && npx prisma migrate deploy && npm run db:seed && npm start
cd ../frontend && npm install && npm run dev      # http://127.0.0.1:5173
```

Seeded accounts: `prof@example.edu` and `student1..8@example.edu`, password
`Passw0rd-Demo-2026`; course `CS 101 - Programming in C`, join code `ADDC2026`.

Deployment: `docs/vercel.md`. Readiness: `GET /api/health/ready` — one call that
answers "is this deployment actually able to grade".

## 14. Future work

- **Empirical complexity**: a problem contract with an input-size parameter, so
  the complexity metric can measure a curve instead of estimating it.
- **Incremental grading**: reuse per-test results when only the rule set's static
  weights change, cutting a regrade to the static analyzers.
- **Rubric diffing**: show a cohort what a rubric change did to their marks,
  per metric, before it is published.
- **Provider hedging**: run the same submission against two providers and treat a
  grade disagreement as a signal about the toolchain, not about the student.
