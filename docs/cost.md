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
| Submissions | pending |
| Wall time | pending |
| Per submission | pending |
| Provider calls | pending |
| Predicted calls | pending |
| Cache hit rate | pending |
| Outcome | pending |
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
