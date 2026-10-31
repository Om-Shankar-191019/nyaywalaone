# Execution notes — Day 6 spike, measured

Everything below was measured from this machine on **30 October 2026** against
`https://ce.judge0.com` and `https://wandbox.org`. Raw output: `docs/execution-metrics.json`.
Reproduce with `cd backend && npm run exec:taxonomy` (costs ~8 provider calls).

---

## Environment

| Item | Value |
|---|---|
| Provider | Judge0 CE **1.14.0** (`/about`) |
| Language | `language_id: 103` — C (GCC) |
| Compiler | **GCC 14.1.0** |
| `__STDC_VERSION__` | `201112` (C11) |
| Pointer width | 64-bit |
| Toolchain fingerprint hash | `09bfd26a4055585371a2e4a6b26df6141dca4fdacade6203b0c481718de435a4` |
| Compiler options used | `-Wall -Wextra -std=c11` |
| Limits | cpu 1 s, wall 5 s, memory 64 MB, max processes 30, network off |

The fingerprint is captured by a six-line C probe on first use each UTC day
(`src/execution/toolchain.js`), stored in `toolchain_fingerprints`, and is intended to travel with
every report. When the provider silently upgrades gcc, the hash changes and old grades stay
explainable.

---

## Failure taxonomy, as actually reported

| Case | `status.code` | id | CPU | Peak memory | Round trip |
|---|---|---|---|---|---|
| hello world | `ACCEPTED` | 3 | 2 ms | 1 524 KB | 1 895 ms |
| missing semicolon | `COMPILATION_ERROR` | 6 | 0 ms | — | 1 840 ms |
| `while(1){}` | `TIME_LIMIT_EXCEEDED` | 5 | 1 088 ms | 1 480 KB | 3 135 ms |
| null dereference | `RUNTIME_ERROR_NZEC` | **11** | 2 ms | 1 072 KB | 1 846 ms |
| `1/0` (volatile zero) | `RUNTIME_ERROR_NZEC` | **11** | 2 ms | 1 552 KB | 1 828 ms |
| `while(1) fork()` | `RUNTIME_ERROR_OTHER` | 12 | 117 ms | 65 536 KB | 1 826 ms |
| `malloc(128MB)` + touch | `RUNTIME_ERROR_NZEC` | 11 | 36 ms | 65 536 KB | 2 434 ms |
| ASan heap overflow | `RUNTIME_ERROR_NZEC` | 11 | 31 ms | 10 592 KB | 1 835 ms |

### What the numbers say

1. **Compile diagnostics are usable.** The compile error came back as
   `main.c:2:28: error: expected ';' before 'return'`, with the source line and caret — enough for
   a `syntax` metric to count errors and warnings per file without guessing.
2. **TLE is enforced, not hoped for.** 1 088 ms of CPU against a 1 000 ms limit, killed by the
   provider in 3.1 s wall time. An infinite loop cannot hang a request.
3. **Signals are collapsed into NZEC (11).** This host does **not** return 7 (SIGSEGV) or 9
   (SIGFPE). The shell that launched the binary still says what happened in `stderr`:

   ```text
   run.sh: line 1:     3 Segmentation fault      (core dumped) ./a.out
   run.sh: line 1:     3 Floating point exception(core dumped) ./a.out
   run.sh: line 1:     3 Killed                  ./a.out
   ```

   `classifyRuntimeDetail()` maps those strings to `SIGSEGV` / `SIGFPE` / `SIGKILL` as a
   **detail** on the status. `status.code` stays exactly what the provider returned, and no
   score reads the detail — parsing prose is how a grading system breaks silently.
4. **The process limit works.** A fork bomb terminated in 117 ms with status 12 and 64 MB touched.
   It cost one call, not a hung host.
5. **The memory limit works.** A 128 MB allocation against a 64 MB limit ends as `Killed`, again
   at exactly 65 536 KB. `Killed` in stderr plus a memory reading at the limit is a reliable MLE
   signal without inventing a new status code.
6. **`wait=true` is honoured here.** All round trips are ~1.8 s and every response already had a
   terminal status. The adapter still polls with backoff when a response is pending, because the
   flag is documented as disabled on some hosts, and a demo must not depend on it.

---

## The sanitizer finding — this contradicts the plan, so it is written down

The four-week plan predicted that AddressSanitizer would die at startup on a hosted sandbox,
because ASan reserves a huge virtual address range while `memory_limit` is an address-space
limit. It was still worth one run to confirm:

```
compiler_options: "-Wall -Wextra -std=c11 -fsanitize=address -g"
memory_limit: 65536
```

**It worked.** stderr came back with a real diagnosis:

```text
==3==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x502000000018 ...
WRITE of size 1 at 0x502000000018 thread T0
    #0 0x5555555551a7 in main /box/main.c:2
```

using 10 592 KB, in 31 ms of CPU, inside the same 64 MB limit.

**Consequence for Week 2.** `sanitizer_run` should be re-evaluated as a **graded** metric rather
than evidence-only:

- It costs one extra execution per submission (roughly doubling the provider budget).
- It changes the binary, so it must be a separate run from the correctness tests.
- It can still fail on a different provider or after a provider upgrade — so the analyzer keeps
  `status: "unavailable"` and the rule set's `on_unavailable` policy decides between
  renormalising and scoring zero.
- A clean ASan run is **not** proof of memory safety (it only sees executed paths). The static
  `memory_audit` stays, and the report should say which one produced which finding.

This is exactly the kind of correction the report should contain: the spike was designed to
falsify an assumption, and it did.

---

## Wandbox fallback

| Item | Value |
|---|---|
| Endpoint | `POST https://wandbox.org/api/compile.json`, no key |
| Compiler | `gcc-head-c` — **the `-c` suffix matters**; plain `gcc-head` is C++ |
| Result | `ACCEPTED`, stdout `5`, 4 163 ms round trip |
| Limits | **None.** No CPU cap, no memory cap, no process cap |
| Timing data | **None reported** |

So Wandbox is a liveness fallback, not an equivalent provider: a report produced with it must
record `provider: "wandbox"` and the absence of timing, and any metric that depends on resource
limits must degrade to `unavailable` rather than infer a pass. Verified working, not
recommended for marking.

---

## Budget and quota

The public instance publishes no quota, and the plan's rule is to assume there is none.

- Every call — including a failed one — increments `provider_usage` for the current **UTC day**.
- `assertWithinBudget()` runs **before** the call and returns
  `429 PROVIDER_BUDGET_EXCEEDED` with `{ used, budget }` when `JUDGE0_DAILY_BUDGET` is spent.
- Default budget: **200 calls/day**. A Week 2 evaluation costs one compile plus one run per test
  case, so a 5-test assignment is ~6 calls; 200 is roughly 30 evaluations.
- `GET /api/meta/usage` exposes the counter. After the demo and the spike it read **2/200**.
- A `429` from the provider itself is mapped to `PROVIDER_RATE_LIMITED` (not a 500), so the UI can
  say "wait a minute" instead of "something broke".

If the budget becomes tight during the demo, lower `JUDGE0_DAILY_BUDGET` rather than removing the
guard: the guard is what turns exhaustion into a clear message.

---

## Operational rules carried into Week 2

1. **Never send secrets or student identifiers** to the provider. Source, stdin and flags only.
2. **Cache by content.** Compile and per-test results key on
   `sha256(source + flags + stdin)`; `execution_cache` lands on Day 8.
3. **Two runs per metric family** at most (correctness, sanitizer). The coordinator must respect
   the budget when it fans out over test cases.
4. **Record the provider and the fingerprint in every evaluation.** A report that cannot name its
   toolchain is not reproducible.
5. **A provider switch is an env change**, but it is not a silent one: reports keep the provider
   name they were produced with.

---

## For the report

> Execution was verified against Judge0 CE 1.14.0 (GCC 14.1.0, C11, 64-bit) on 30 October 2026.
> A one-second CPU limit produced a `Time Limit Exceeded` after 1.088 s of CPU and 3.1 s of wall
> time; a fork bomb was terminated in 117 ms; a 128 MB allocation against a 64 MB limit was killed
> at exactly 65 536 KB. Signals were reported as network errors (`NZEC`, id 11) rather than
> distinct `SIGSEGV`/`SIGFPE` codes, so the toolchain records the signal as a secondary detail
> derived from stderr and never scores it. AddressSanitizer, contrary to the initial assumption,
> ran successfully inside the same limits and produced a genuine heap-buffer-overflow report,
> which moves it from "evidence only" to a candidate graded metric in Week 2. Median round-trip
> latency was 1.85 s per submission, which is why calls are capped by a daily budget guard and
> results are cached by content.
