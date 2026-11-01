# Execution cost, quota and throughput

The sandbox is the only part of this system that costs money, rate limit or
someone else's patience. Everything here is arithmetic you can check against
`backend/src/execution/compile.js` and the analyzers in
`backend/src/grading/analyzers/`.

## 1. Calls per evaluation

One evaluation is one *grading run*. It is not one provider call: the compiler
double as the runner, so every program execution is a call.

| Step | Calls | Notes |
|---|---|---|
| Compile gate | 1 | `runCached({ kind: 'compile' })`; decides whether anything else runs |
| `io_tests` | 3 | one per assignment test case (`manifest.json` has three) |
| `edge_case_runner` | 4 + 4 | four generated cases; each needs the student's run plus the reference run that produces the oracle |
| `memory_audit` | 0 | `sanitizer_run: false` by default; static checks only |
| `complexity_estimator` | 0 | `mode: "static"`; timing evidence is a documented no-op |
| `static_analysis`, `function_split`, `style_analysis`, `similarity_flag` | 0 | pure analysis of the source text |
| `llm_review` | 0 | one Groq call, not a sandbox call; weight 0 and advisory |

**Cold: 12 calls. Warm reference: 8 calls.** The four oracle runs compile the
*reference solution*, which is identical for every student in a cohort, so they
land in the execution cache after the first submission. From the second
submission onward the figure is 8.

The cache key is `(kind, source_hash, stdin, compiler options, limits)`. Two
students who submit the same file cost one compile and three test runs, not two
of each; changing the rule set's limits changes the key, so a re-weighted rule
set with the same limits stays warm.

## 2. Daily budget

`EXEC_DAILY_BUDGET` (default **200**) counts *provider calls*, not evaluations,
and resets at 00:00 UTC. A call is counted after it is attempted, so a failed
run still costs quota.

| Budget | Roughly |
|---|---|
| 200 (default) | 25 cold submissions, or ~12 students with two attempts each |
| 600 | one 60-student cohort, one attempt each, plus retries |
| 2000 | a 200-student cohort with regrades |

The guard is checked before a grading run starts (`assertWithinBudget`) and
throws `429 PROVIDER_BUDGET_EXCEEDED`, which the coordinator records as
`failedReason: budget_exhausted`. Grading resumes after midnight UTC.

## 3. Per-student cap

`EXEC_USER_DAILY_SUBMISSIONS` (default **40**) is a separate ceiling counted in
submissions per UTC day, checked in `createSubmissionRecord`. It survives a
process restart, which the in-memory hourly limiter does not, and it exists so a
single account cannot drain the whole class budget: 40 × 8 = 320 calls, more
than the entire default daily budget, which is why both limits are needed.

## 4. Concurrency

| Knob | Default | What it controls |
|---|---|---|
| `GRADING_CONCURRENCY` | 3 | analyzers running at once inside one evaluation |
| `EXEC_MAX_INFLIGHT` | 4 | provider calls in flight for the whole process |
| provider `maxConcurrentRuns` | 2 (onlinecompiler), 4 (Judge0) | what the sandbox accepts |

The effective width is `min(EXEC_MAX_INFLIGHT, provider ceiling)`, enforced by a
per-provider semaphore in `src/execution/concurrency.js`. Every caller - HTTP
submit, cron drain, bulk grade, scripts - goes through it, so the number is a
property of the process rather than of each code path.

A `429` from the provider is retried up to three times with 1 s / 2 s / 4 s
backoff. Without that, a burst turns into a report full of `unavailable`
metrics, which reads like the student's code failed.

## 5. Throughput

The provider accepts **30 runs per minute**. That is the ceiling, not our
concurrency setting:

```
8 calls / submission  ÷  30 calls / minute  =  3.75 submissions / minute
60 submissions                              =  16 minutes minimum
```

A 60-student cohort therefore takes about 16 minutes of wall clock on the free
tier even with every core available. This is the number to quote; a faster
`drain` does not beat the provider's own rate limit.

## 6. Measured

Produced by `node scripts/load-check.js --count=60` (see
`docs/samples/load-check.json` for the machine-readable result):

<!-- MEASURED:BEGIN -->
| Metric | Value |
|---|---|
| Submissions | 3 (budget-bounded: the plan's 60 needs ~480 calls against a 200/day cap) |
| Wall time (drain only) | 41.1 s |
| Per submission | 13.7 s at concurrency 1 |
| Provider calls | 0 |
| Predicted calls | 24 |
| Cache hit rate | 100% (57 hits, 0 misses) |
| Outcome | 3 succeeded, 0 partial, 0 failed, 0 requeued |
| Enqueue cost | 82 s per submission (three submissions, 246 s) |

Three findings from the run, each one a correction rather than a number:

1. **The variant comment does not defeat the cache.** The harness appends
   `/* load-check variant N */` so every submission is a distinct source, but
   source normalisation strips comments before hashing, so all three submissions
   hit the same cached executions. Consequence: this measures *queue throughput*,
   not cold provider cost. The eight-calls-per-cold-submission figure is a model,
   not a measurement from this run, and is labelled as such wherever it is used.
2. **The provider rate-limits at concurrency 4.** The first attempt drained with
   `PROVIDER_RATE_LIMITED` on twelve rows, which the queue correctly returned to
   `QUEUED` with their attempt budget intact. The clean run used concurrency 1.
   The recommendation below is therefore `limit=5, concurrency=1` on a one-minute
   cron, not 2.
3. **A queue bug this check found.** `runEvaluation` skipped any row whose status
   was `RUNNING`, but the queue claim stamps `RUNNING` *before* grading, so every
   drained row was skipped and stranded in `RUNNING` forever. Fixed in
   `src/grading/coordinator.js` (only terminal rows are skipped), with
   `scripts/requeue-stuck.js` to recover rows stranded by an older build. Before
   the fix this check reported `0 calls, 0 outcomes, 6 s`; the script now refuses
   to record a run that grades nothing.
<!-- MEASURED:END -->

## 7. What this means operationally

- Set `EXEC_DAILY_BUDGET` to `8 × students × expected attempts × 1.2` and no
  more; the ceiling is the only thing between a runaway loop and a suspended
  API key.
- Drain with `limit=5, concurrency=2` on a one-minute cron. Claiming more than
  four rows per tick only moves them from `QUEUED` to `RUNNING` and then waits
  on the same 30/min limit.
- One compile per distinct file is a real saving on a cohort where students
  share a skeleton: identical submissions cost nothing after the first.
- Regrading after a rule change is *not* free: the rules hash changes the
  evaluation key but the execution cache is keyed on limits and compiler
  options, so identical limits stay warm and a stricter `time_limit_s` re-runs.
