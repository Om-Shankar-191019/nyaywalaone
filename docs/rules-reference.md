# Rule set and analyzer reference

A rule set is data, not code. It is a JSON document stored in `rule_sets.rules`,
validated by Zod at publish time (`src/grading/rules.js`) and frozen by hash into
every evaluation, so a report always says which rubric produced it.

```json
{
  "schema_version": "1.0",
  "problem": "sum_two_integers",
  "limits": { "time_limit_s": 1, "memory_limit_mb": 64, "max_processes": 30 },
  "on_unavailable": "renormalize",
  "metrics": [
    { "name": "correctness", "analyzer": "io_tests", "weight": 0.25, "params": { } }
  ]
}
```

**Weights must sum to exactly 1.00** and the editor refuses to publish otherwise.
`on_unavailable` decides what a metric that could not run costs:

| Value | Meaning |
|---|---|
| `renormalize` | the unavailable metric's weight is redistributed over the ones that did run, so missing evidence neither helps nor hurts |
| `zero` | the weight stays where it is, so missing evidence costs the student marks |

The grade is an integer number of hundredths, `round(Σ score × weight × 100)`,
clamped to 0–10000.

---

## `io_tests` — correctness

Runs every test case attached to the assignment and compares output after
trailing-whitespace and CRLF normalisation (internal whitespace is preserved).

| Param | Default | Meaning |
|---|---|---|
| `testset` | `"assignment"` | label recorded in the evidence |
| `partial_credit` | `true` | score = passed/total; otherwise all-or-nothing |
| `max_stored_output` | `4096` | characters of input/output kept in evidence |

Score: `passed / total`. A compile error makes the metric `unavailable`, not
zero. A test that exceeds the time limit is recorded as `time_limit_exceeded`,
and if every test times out the evaluation sets `suspected_infinite_loop`.

Provider calls: 1 per test case.

---

## `compiler_warnings` — syntax

Compiles once with the rule set's flags and counts diagnostics.

| Param | Default | Meaning |
|---|---|---|
| `flags` | `"-Wall -Wextra -std=c11"` | requested flags; ignored by providers with fixed flags |
| `warnings_as_errors` | `false` | any warning scores 0 |
| `penalty_per_warning` | `0.1` | subtracted per warning |

Score: `max(0, 1 − warnings × penalty)`, or `0` if `warnings_as_errors` and there
is at least one warning. On a provider with `compilerFlags: false` the metric
records `provider_has_no_compiler_flags` and the report gains a limitation.

Provider calls: 0 (reuses the compile gate).

---

## `static_analysis` — structure

Parses the source with tree-sitter and scores three components.

| Param | Default | Meaning |
|---|---|---|
| `max_cyclomatic` | `8` | cyclomatic complexity per function |
| `max_function_length` | `40` | lines |
| `max_nesting` | `4` | brace depth |
| `scoring` | `"linear"` | `linear` decays linearly past the limit, `step` halves per violation |
| `min_score` | `0` | floor |

`components = mean(decay(cyclomatic), decay(length), decay(nesting))`;
`score = max(min_score, components)`.

Provider calls: 0.

---

## `function_split` — modularity

| Param | Default | Meaning |
|---|---|---|
| `min_functions` | `2` | including `main` |
| `expect_helpers` | `true` | whether a helper is required for full marks |
| `max_main_lines` | `25` | `main` beyond this decays |

`score = 0.4 × count + 0.2 × helper + 0.4 × main`, each component in 0–1.

Provider calls: 0.

---

## `edge_case_runner` — logical behaviour

Generates inputs the assignment's own tests may not cover and runs the student's
program against them.

| Param | Default | Meaning |
|---|---|---|
| `cases` | `["zero","negatives","int_overflow","whitespace"]` | which generators to use |
| `no_oracle_cap` | `0.5` | cap when no reference solution exists |
| `dedupe_tests` | `true` | skip a generated case identical to an assignment test |
| `max_cases` | `20` | hard ceiling |

When a reference solution exists, each generated input is run against it to
produce the expected output (the oracle). Without one, crashes are still
detected but the score is capped at `no_oracle_cap` and the report gains
`no_oracle`.

Provider calls: 1 per generated case, plus 1 oracle run per distinct input
(cached across the cohort).

---

## `complexity_estimator` — complexity class

Static estimate of the order of growth from loop nesting and recursion.

| Param | Default | Meaning |
|---|---|---|
| `required` | `"O(1)"` | target class from `ORDER_CLASSES` |
| `sizes` | `[1,10,100]` | recorded in evidence |
| `mode` | `"static"` | only `static` is implemented |
| `timing_evidence` | `false` | records that timing was skipped, and why |

`score = max(0, 1 − 0.25 × (levels_over_required))`. One level over costs 0.25.

Provider calls: 0. Timing evidence is deliberately not fabricated: a real curve
needs a size-parameterised input contract the rule set does not have.

---

## `memory_audit` — memory safety

| Param | Default | Meaning |
|---|---|---|
| `check_leaks` | `true` | `malloc` without a matching `free` |
| `check_unchecked_alloc` | `true` | allocation result used without a NULL check |
| `banned_functions` | `["gets","strcpy","sprintf"]` | each costs `penalty.banned_function` |
| `sanitizer_run` | `false` | run under `-fsanitize=address`; costs a provider call and fails on providers that reject the flag |
| `asan_penalty` | `0.5` | subtracted if ASan reports an error |
| `penalty.*` | `0.25 / 0.2 / 0.1 / 0.3` | banned function / leak / unchecked alloc / double free |

Score starts at 1 and subtracts each finding, floored at 0.

Provider calls: 0, or 1 when `sanitizer_run` is on.

---

## `style_analysis` — readability

| Param | Default | Meaning |
|---|---|---|
| `min_name_length` | `3` | average identifier length |
| `min_comment_ratio` | `0.03` | comment lines / total lines |
| `max_line_length` | `100` | long-line decay |

Weighted blend of identifier length, comment ratio and line length, clamped to
0–1. Cosmetic by design: it is a small-weight metric, not a gate.

Provider calls: 0.

---

## `similarity_flag` — originality

MinHash over normalised 7-token shingles, compared with every other submission
in the corpus.

| Param | Default | Meaning |
|---|---|---|
| `corpus` | `"assignment"` | or `assignment+archive` (previous assignments in the same course) |
| `flag_threshold` | `0.85` | above this, a pair is flagged |
| `shingle_size` | `7` | tokens per shingle |
| `num_perm` | `128` | signature length |
| `seed` | `42` | permutation seed |

`score = 1` below 0.5 similarity, decaying linearly to `0` at 1.0; an exact
source match scores 0. A flag is advisory: it creates a review row for the
instructor and never changes the grade by itself — `PATCH /similarity/:matchId/review`
records a decision and an audit entry.

Provider calls: 0.

---

## `llm_review` — advisory prose

| Param | Default | Meaning |
|---|---|---|
| `model` | unset | Optional model id; the client picks one the account has |
| `temperature` | `0` | |
| `seed` | `42` | Forwarded to providers that honour a seed |
| `strictness` | `"normal"` | `light` / `normal` / `strict` |
| `advisory_only` | `true` | weight should be 0 |
| `max_source_chars` | `6000` | source truncation |

Without a key this metric reports `unavailable` (shown as *not run*) and the
report gains `llm_unavailable`. A provider failure is never `error`: a retired
model name used to turn every report red, so the client now walks a chain of
models and providers and reports `unavailable` when none answers. Because it
has weight 0, it cannot change a grade, and its free text is excluded from the
report hash (see [reproducibility.md](reproducibility.md)).

Provider calls: 0 sandbox calls; 1 HTTP call.

---

## `llm_feedback` — the paragraph a student reads

| Param | Default | Meaning |
|---|---|---|
| `model` | unset | Optional override |
| `temperature` | `0` | |
| `max_metrics` | `14` | metrics included in the digest |
| `max_source_chars` | `6000` | source truncation |

Runs **after** the deterministic metrics (`needsMetrics`), because it joins them
up. Returns `summary`, `strengths`, `improvements`, `next_steps` in evidence and
uses the summary as its feedback line. `score` is always 0: advice never moves a
mark. 1 HTTP call, sequential after the first pass.

---

## `llm_style_review` — readability rubric

| Param | Default | Meaning |
|---|---|---|
| `model` | unset | Optional override |
| `strictness` | `"normal"` | `light` / `normal` / `strict` |
| `max_source_chars` | `6000` | source truncation |

Scores naming, formatting, comments, structure and error handling out of 10 with
a sentence each, plus up to four concrete issues. `score = overall / 10`.
`runsWithoutBinary: true`, so it still reviews a file that does not compile.
Advisory (weight 0) in both shipped rule sets; an instructor may weight it.
1 HTTP call.

---

## `llm_plagiarism` — AI / internet copy signals

| Param | Default | Meaning |
|---|---|---|
| `review_threshold` | `0.6` | combined likelihood that triggers `review_recommended` |
| `max_source_chars` | `6000` | source truncation |

Two parts. Deterministic, key-free signals (`markdown_fence`, `assistant_prose`,
`tutorial_comments`, `smart_punctuation`, `mixed_naming`, `placeholder`, …) always
run; the model's separate judgement of "looks generated" and "looks copied" is
discounted 15% and combined with `max`, so either kind of evidence can flag and
neither can suppress the other. Verdicts: `likely_original`, `inconclusive`,
`review_recommended`, `strong_signal` — never a finding of misconduct. No live
web search is performed (`web_lookup: not_configured`). Status is `partial` when
only the heuristics ran. `runsWithoutBinary: true`. 1 HTTP call.

---

## `llm_compile_recovery` — marks for a program that never ran

| Param | Default | Meaning |
|---|---|---|
| `max_credit` | `0.40` | ceiling on recovered marks (0.05–0.60) |
| `require_logic_correct` | `true` | no credit unless the logic looks sound |
| `show_corrected_source` | `true` | include a compiling version in the report |
| `max_source_chars` | `6000` | source truncation |

Runs only when the program did not compile (`onCompileFailure`). Explains each
compiler error, judges the intended logic, and returns a confidence. The
coordinator awards `confidence × max_credit` hundredths and reports them as
`grade.recovery_hundredths` plus a `recovery` block. Weight is 0: the credit is
added directly, so a compile error still costs at least 60% by default. 1 HTTP
call. The recovered marks are the only model output that can reach the report
hash.

---

## Adding an analyzer

1. Create `src/grading/analyzers/<name>.js` exporting `{ name, supports, paramsSchema, run }`.
2. Register it in `src/grading/registry.js`.
3. Add its version to `ANALYZER_VERSIONS` in `src/grading/versions.js` — this
   changes `toolchain_hash`, so old reports stay explainable.
4. Add a unit test with a fixed source and an asserted score.
5. Document it in this file. The rules editor builds its form from
   `paramsSchema`, so the UI needs no change.
