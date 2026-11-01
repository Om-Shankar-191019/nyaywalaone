# The reproducibility contract

The assignment's central claim is that **the same submission, graded the same
way, produces the same grade**. This file states exactly what "the same way"
means, how it is computed, how it is checked, and what can legitimately change a
mark.

## 1. The five inputs

A grade is a pure function of five values. Everything else in the system -
timestamps, request ids, queue order, which analyzer finished first - is excluded
from the hash by construction.

| Input | How it is computed | Where |
|---|---|---|
| `source_hash` | `sha256` of the source **after** normalisation (CRLF → LF, trailing newline, no BOM) | `src/lib/hash.js` |
| `rules_hash` | `sha256` of the RFC 8785 canonical JSON of the resolved rule set | `src/grading/canonical.js` |
| `testset_hash` | `sha256` over the sorted list of `(name, sha256(stdin), sha256(expected))` | `src/grading/canonical.js` |
| `toolchain_hash` | `sha256` of `{provider, compiler fingerprint, compiler flags, analyzer versions, grader version}` | `src/grading/coordinator.js` |
| `grader_version` | `GRADER_VERSION` plus every analyzer's version | `src/grading/versions.js` |

Those five produce the `evaluation_key` that identifies a run:

```
evaluation_key = sha256(source_hash + rules_hash + testset_hash + toolchain_hash + grader_version)
```

A second submission of the same file under the same rules and toolchain therefore
maps to the same key and returns the stored evaluation instead of re-running it.

## 2. Canonicalisation

Two rule files that a human would call identical must hash identically:

- keys sorted (RFC 8785 / JCS ordering), so key order never matters;
- no insignificant whitespace, no trailing commas, numbers in shortest form;
- arrays keep their order, because the order of metrics is meaningful (it is the
  order of the report and the order of dispatch).

`tests/unit/grading.test.js` pins this: reordering the keys of a rule set or
reformatting it leaves `rules_hash` unchanged, while changing one weight changes
it.

## 3. The report hash

After the coordinator scores the run it renders a report and hashes the report
**without** the volatile fields (`time_ms`, `memory_kb`, `cached`, timings). The
stored evaluation keeps:

- `report_hash` - the hash of the report as graded;
- `grade_hundredths` - an integer, never a float;
- `rules_hash`, `testset_hash`, `toolchain_hash`, `grader_version`;
- `metrics` - one row per metric, in rule order, each with its own evidence.

To check a stored grade:

```bash
cd backend
node scripts/verify-report.js <evaluationId>
# Evaluation   ...
# Grade        89.00 / 100 (8900 hundredths)
# Stored hash  <at grading time>
# Recomputed   <now>
# PASS: the report recomputes to the stored hash.
```

`--json` prints the same summary as an object. The script needs no sandbox call:
it recomputes from the persisted rows and compares.

## 4. The golden corpus

`backend/tests/golden/` holds 18 submissions × 3 rule sets, replayed five times
each with a cleared evaluation path:

| Rule set | Difference |
|---|---|
| `default.json` | 10 metrics, weights summing to 1.00, `-Wall -Wextra -std=c11` |
| `strict.json` | `-Werror`, tighter cyclomatic budget, a larger test set |
| `complexity.json` | an `O(n log n)` target instead of `O(1)` |

The corpus covers what actually breaks graders: a correct program, an
off-by-one, an integer overflow, unchecked `malloc`, a leak, a use-after-free, an
infinite loop, a divide-by-zero, a compile error, an empty file, a comments-only
file, unicode output, a huge input, deeply nested blocks, a renamed copy of the
reference, two independent solutions, a `main`-only program and a helper-based
one.

```bash
cd backend
npm run golden                     # 90 cells x 5 repeats = 270 runs
npm run golden -- --limit=3        # a three-file probe
npm run golden -- --rules=default  # one rule set
```

The harness writes `docs/samples/golden-corpus.csv` (one row per run: cell, rule
set, status, grade, hash, whether it matched its baseline). It exits non-zero on
any drift, which is what CI consumes.

<!-- MEASURED:BEGIN -->
### Result of the recorded run

| Metric | Value |
|---|---|
| Cells (18 submissions × 3 rule sets) | 54 |
| Repeats per cell | 5 |
| Runs | 270 |
| Runs matching their baseline hash and grade | **270 / 270** (`matches_baseline=true` on every row) |
| Provider calls spent | 0 (the execution cache was warm from the preceding run) |
| Execution-cache hits | 4735 |

The harness printed `PASS: every repeat produced an identical report hash and
grade` and exited 0. Because the cache was warm, this run proves the scoring,
reporting and persistence path is deterministic; it does not prove the sandbox
answers identically, which is what `--cold` is for (and what it costs).

The table is 271 lines: a header plus one row per run. `matches_baseline` is
computed against the first repeat of the same cell, so a rule-set-wide shift
cannot hide inside a per-cell comparison.
<!-- MEASURED:END -->

## 5. What can legitimately change a grade

Reproducibility is not "the grade never changes". These changes are expected, and
each one is visible in the report instead of silent:

| Change | Hash that moves | What the report shows |
|---|---|---|
| The instructor edits a weight or threshold and publishes v(n+1) | `rules_hash` | a new rule set version, and the old evaluations keep their own |
| The provider upgrades gcc | `toolchain_hash` (fingerprint) | the compiler fingerprint in `tool_versions` |
| A new `GRADER_VERSION` or analyzer version ships | `toolchain_hash`, `grader_version` | the grader version stamped on the evaluation |
| A test case is added, edited or removed | `testset_hash` | a different test set hash and a different result |
| The source changes, even by a comment | `source_hash` | a new submission, a new attempt |

What may **not** change a grade: the order metrics finish in, the machine that
ran them, the time of day, the queue position, a warm or cold execution cache, or
whether the LLM metric was available (its default weight is `0.00`, and when a
metric is unavailable the rule set's `on_unavailable` policy decides - either
renormalising the remaining weights or charging the declared weight - never a
silent zero).

## 6. Sources of drift that were found and fixed

Each of these was a real mismatch across repeats, not a hypothetical:

1. **Analyzer completion order** - metrics were persisted as they finished, so
   two repeats wrote different row orders. Fixed by sorting into rule order
   before the score and the report hash.
2. **Timings in evidence** - `time_ms`/`memory_kb` came from the sandbox and
   differ per run. They are kept as evidence and stripped from the hash.
3. **Float accumulation** - adding weights as floats gave `0.8999999` on one
   ordering and `0.9` on another. Scores are now integer hundredths throughout.
4. **`Set`/`Map` iteration into JSON** - insertion order leaked into evidence.
   Objects are canonicalised, arrays are explicitly sorted where the order is not
   meaningful.
5. **Locale sorting** - `localeCompare` is locale-dependent; cohort and test
   ordering use a fixed comparator.

## 7. Where this stops being true

- **The sandbox is not pinned by us.** The toolchain fingerprint records what the
  provider used; it cannot prevent an upgrade. A provider upgrade changes marks,
  and the fingerprint is how the change is noticed rather than prevented.
- **The LLM metric is advisory only.** Its prose is cached by prompt hash and
  temperature is 0, but a model retirement still changes it. That is why its
  weight is `0.00` in the default set and why it never enters a graded score
  without an instructor choosing to weight it.
- **A cache hit is not a rerun.** With a warm execution cache the harness proves
  the *scoring and reporting* path is deterministic, not that the sandbox would
  answer identically. `--cold` (clear `execution_cache` first) is the expensive
  version of the same check, and it costs a full budget of provider calls.
