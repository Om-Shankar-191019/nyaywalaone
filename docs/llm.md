# Language-model review

Nyaywala uses a language model for four things. None of them can change a mark
on its own, and all of them are optional: with no API key the grader still
produces a complete report and every model metric is reported as `unavailable`
(called `not run` in the UI) rather than as a zero.

| # | Analyzer | What it does | Weight in the shipped rule sets |
|---|---|---|---|
| 1 | `llm_feedback` | Writes the paragraph a student actually reads, from the marks that were already awarded | 0.00 |
| 2 | `llm_style_review` | Rubric review of readability: naming, formatting and style, comments, structure, error handling | 0.00 |
| 3 | `llm_plagiarism` | Copy-paste signals: does this look generated, or pasted from a tutorial or the internet | 0.00 |
| 4 | `llm_compile_recovery` | Explains compiler errors, judges whether the logic is sound, and can recover capped marks | 0.00 (awards its own credit) |

`llm_review` (advisory readability prose) still exists for rule sets that already
name it.

## Why it used to show `error`

The default model was `llama-3.3-70b-versatile`. Groq retired it for new keys, so
every call returned

```
404 {"error":{"code":"model_not_found","message":"The model ... does not exist or you do not have access to it."}}
```

and the analyzer reported `status: error`, which the report rendered as a red
badge on every submission. The model was never the only problem: a hard-coded
name and a single provider will always rot.

Now:

* the model is **optional** in every analyzer's parameters;
* `backend/src/grading/llm/client.js` walks **models then providers**;
* `404 model_not_found` means "try the next model", not "the feature is broken";
* a failed call is `unavailable`, with the provider's message kept in evidence;
* `npm run llm:check` prints exactly which provider and model answer from this
  machine.

## Free providers

Every provider below has a free tier and speaks the OpenAI
`/chat/completions` shape, so one client serves all of them. Only one key is
needed.

| Provider | Env var | Default model | Free tier | Key |
|---|---|---|---|---|
| Groq | `GROQ_API_KEY` | `openai/gpt-oss-20b` | generous, no card | <https://console.groq.com/keys> |
| Google Gemini | `GEMINI_API_KEY` | `gemini-2.5-flash` | free tier, no card | <https://aistudio.google.com/apikey> |
| OpenRouter | `OPENROUTER_API_KEY` | `meta-llama/llama-3.3-70b-instruct:free` | `:free` models, no card | <https://openrouter.ai/keys> |
| Cerebras | `CEREBRAS_API_KEY` | `llama-3.3-70b` | free tier | <https://cloud.cerebras.ai> |
| Mistral | `MISTRAL_API_KEY` | `mistral-small-latest` | free tier | <https://console.mistral.ai/api-keys> |

Order is `LLM_PROVIDER_ORDER` (default `groq,gemini,openrouter,cerebras,mistral`).
A provider without a key is skipped silently. `GROQ_MODEL`, `GEMINI_MODEL`,
`OPENROUTER_MODEL`, `CEREBRAS_MODEL` and `MISTRAL_MODEL` each override the first
model tried; the built-in list is still used as fallback.

```bash
cd backend
npm run llm:check          # probes every configured provider, one tiny call each
```

Nothing is paid for, and no request is made at build or boot time — only when a
submission is graded and the rule set asks for an LLM metric.

## What each check returns

### 1. Feedback (`llm_feedback`)

Runs **after** the deterministic metrics, because its value is joining them up:
"your tests pass but 91% of identifiers are one letter" is a sentence no single
analyzer can write. Returns `summary`, `strengths`, `improvements`, `next_steps`.
The prompt contains the metric digest, never the student's name or email.

### 2. Readability (`llm_style_review`)

Scores five criteria out of 10 — naming, formatting, comments, structure, error
handling — with one sentence of justification each, plus up to four concrete
issues. `strictness` (`light` / `normal` / `strict`) changes the standard.
The measured metric `style_analysis` still runs and still does the counting.

### 3. Originality (`llm_plagiarism`)

Two independent parts:

* **Deterministic signals**, always available, no key needed: markdown fences
  left in the file, assistant phrasing ("here is the corrected code", "I hope
  this helps"), textbook comments ("function to add two numbers"), smart quotes
  from a word processor, mixed `snake_case`/`camelCase` in one small file,
  unfilled template placeholders, machine-uniform layout.
* **A model's reading** of voice and style, asked for separately as
  "looks generated" and "looks copied from a public source", each 0–1 with a
  reason and a confidence.

They combine 40/60 and are reported against the peer-corpus similarity that
`similarity_flag` already computed. The verdict is `likely_original`,
`inconclusive`, `review_recommended` or `strong_signal` — never "plagiarised".
No live web search is performed: there is no free, reliable search API, and a
search hit is not proof either. Adding one is a small change in
`llm-originality.js` if you later supply a key for a free search tier (Brave
Search, Serper and Tavily all have small free tiers).

### 4. Compile-error recovery (`llm_compile_recovery`)

When a program does not compile, every weighted metric is `unavailable` and the
grade is 0 — correct, but unhelpful when the only problem is a missing semicolon.
This analyzer reads the source and the compiler output, then returns:

* each compiler error explained in plain language;
* whether the intended logic looks sound, with a confidence;
* a corrected program that compiles (shown to the student, never stored as their
  submission).

The coordinator turns the confidence into marks:

```
recovery_marks = confidence × max_credit      (max_credit defaults to 0.40)
```

They are added to the grade, reported separately as `recovery.awarded_hundredths`,
and a limitation entry says the marks came from a reading of the code rather than
from a test run. A compile error therefore still costs at least 60% of the grade
by default, and no marks are awarded when the logic is judged incomplete.

## Configuration

```ini
LLM_ENABLED=true                 # master switch; false = every LLM metric is `unavailable`
LLM_PROVIDER_ORDER=groq,gemini,openrouter,cerebras,mistral
LLM_TIMEOUT_MS=20000
GROQ_API_KEY=
GROQ_MODEL=openai/gpt-oss-20b
```

`llm:check` exits 0 when at least one provider answers. It prints only the last
four characters of a key.

## Determinism and privacy

* temperature 0, a seed where the provider honours one, and a response cache
  keyed by the exact prompt in `llm_cache`, so a re-grade of the same submission
  returns the same prose.
* at most two requests in flight, so four analyzers never arrive at a free tier
  as a burst.
* the whole `llm` block and the recovery explanation are **excluded from the
  report hash**: model prose is advice, not evidence. Only the recovered marks
  enter the hash, through the grade.
* the source code is sent to the configured provider. Do not enable the LLM
  checks for code that may not leave the institution; `LLM_ENABLED=false` (or a
  rule set without LLM metrics) keeps everything local.

## Adding the metrics to existing assignments

`defaultRules()` includes the four metrics for every new assignment. Assignments
published earlier keep their frozen rule set, so:

```bash
cd backend
npm run rules:upgrade            # dry run
npm run rules:upgrade -- --apply # publish version n+1 with the advisory metrics
```

Weights are never changed; the new metrics are weight 0, so no stored grade moves.
