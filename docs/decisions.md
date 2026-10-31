# Architecture decisions

Day 1 deliverable. Six decisions, each with the option we rejected and the cost we accepted.
Everything here was re-checked on Day 6 against a real provider; the "post-spike revisions"
section at the end records what measurement changed.

Status: **accepted for Week 1**. Authors: M1 (platform) with M2 (engine) for ADR-001/002.

---

## ADR-001 — Compile and run C on Judge0 CE, behind a provider seam

**Context.** Vercel serverless functions run JavaScript. There is no `gcc`, no writable
persistent filesystem, and no way to spawn a long-lived sandboxed process. Student C code must
be compiled somewhere else, and the assignment forbids Docker.

**Decision.** Judge0 CE at `https://ce.judge0.com`, `language_id: 103` (C, GCC 14.1.0), reached
through one module: `backend/src/execution/provider.js`. A second implementation (Wandbox)
exists behind `EXECUTION_PROVIDER` so the choice is an environment variable, not a rewrite.

**Why.**

- `compiler_options` is spliced into the gcc command line, so `-Wall -Wextra -std=c11` reach the
  compiler and their diagnostics come back in `compile_output`. That is the `syntax` metric.
- It exposes real limits: `cpu_time_limit`, `wall_time_limit`, `memory_limit`,
  `max_processes_and_or_threads`, `enable_network`. Without those, "infinite loop" is a hung
  request instead of a grade.
- One submission is one HTTP call. No queue infrastructure to build in Week 1.

**Rejected.**

| Option | Why not |
|---|---|
| Piston (`emkc.org`) | Public instance became whitelist-only on 15 Feb 2026 and explicitly excludes university projects. More importantly it has **no compile-flag field**, so the syntax metric could not exist. |
| Own runner on a VPS | Full control and real ASan/valgrind, but it costs a host, ops time, and a security review we cannot do in four weeks. Kept as Appendix A of the plan, not built. |
| Docker on Vercel | Not supported, and excluded by the assignment. |
| Client-side WASM compiler | Cannot enforce memory or process limits, and the student controls the runtime. |

**Cost accepted.** The public host has no SLA and an unknown quota. Mitigations: the budget
guard (`provider_usage` + `429`), polling instead of trusting `wait=true`, and a fallback
provider. Latency is ~1.8 s per call, measured.

### Amendment (Week 3) — the default provider is onlinecompiler.io

**Trigger.** Judge0's keyed plans (both RapidAPI and the hosted CE) require a credit card, which
the team cannot provide. The public `ce.judge0.com` instance works but has no SLA and one shared
quota — not something a marked submission should depend on.

**Decision.** `EXECUTION_PROVIDER=onlinecompiler` by default, backed by
`https://api.onlinecompiler.io` with `gcc-15` and a free API key. Judge0 and Wandbox stay
implemented behind the same seam; `JUDGE0_API_KEY` is still read as the fallback name for the
new key so an existing `.env` needed no edit.

**What changed honestly.** This provider takes no compiler flags and enforces no CPU, memory or
process limits. Rather than pretend otherwise:

- each provider now declares `capabilities`, and `clampLimitsFor()` records per-limit
  `*_limit_enforced` flags on every run;
- the report's *Limitations* block is generated from that record (and a versioned
  `grading/limitations.json`), so a report produced without enforced limits says so;
- `ONLINECOMPILER_TIMEOUT_SECONDS` aborts before the provider's 30 s ceiling, so a wedged run is
  a timeout we own;
- the compile-error path is decided from the compiler's own exit code and diagnostics, not from
  scraping stdout (a program that prints `error:` is still `ACCEPTED` — unit-tested).

**Consequence for marks.** Any metric that depends on resource behaviour (`memory_audit`
findings that need a real MLE, TLE-driven signals) is weaker on this provider. The rule sets in
`docs/rule-sets/` do not weight those, and the report states the limitation. Judge0 remains the
provider to switch to if CPU/memory enforcement is needed for a live marking run.

---

## ADR-002 — tree-sitter compiled to WASM for static analysis

**Decision.** `web-tree-sitter` 0.24.7 with the C grammar from `tree-sitter-wasms`
(`out/tree-sitter-c.wasm`), loaded once per process by `src/analysis/loader.js`.

**Why.** The structure, modularity, complexity and memory analyzers need real nodes: function
boundaries, nesting depth, `if`/`for`/`while`/`case` counts, `&&`/`||` operators, `?:`. Regex
cannot tell a `for` inside a string literal from a loop, and it cannot compute nesting depth.

**Why WASM rather than native bindings.** Native `tree-sitter` needs node-gyp and a C++
toolchain at install time, which is fragile on Windows and unavailable on Vercel's build image
for runtime dependencies. A `.wasm` grammar is a single portable file with no build step.

**Cost accepted.** The grammar's ABI must match the runtime. The working pairing is recorded
here so a future upgrade is not a guess:

```
web-tree-sitter 0.24.7  +  node_modules/tree-sitter-wasms/out/tree-sitter-c.wasm
```

If a future `web-tree-sitter` rejects that file, rebuild the grammar with
`tree-sitter build --wasm` and update this line. `loadCParser()` returns
`{ ok: false, reason }` instead of throwing, so a broken grammar degrades the metric to
"unavailable" rather than crashing a report.

---

## ADR-003 — PostgreSQL on Neon, with separate pooled and direct URLs

**Decision.** Postgres 16/17 on Neon, Prisma 6, migrations committed to `prisma/migrations/`.
`DATABASE_URL` is the **pooled** string used at runtime; `DIRECT_URL` is the direct string used
by `prisma migrate`.

**Why Neon.** It is the managed Postgres the plan budgeted for: a free tier, a real connection
pooler (pgbouncer) for serverless, branchable databases for tests, and standard Postgres with no
proprietary query layer, so nothing has to be rewritten if it moves.

**Why the split.** A serverless function opens a connection per instance and closes it when the
instance is frozen. Against a direct Postgres connection string that exhausts `max_connections`
during a class demo. The pooler fixes that. But pgbouncer in transaction mode cannot run
migrations (advisory locks, prepared statements), so migrations take the direct URL. Getting this
backwards produces "works locally, fails on the first deploy", which is why both variables are
required at boot rather than defaulted.

**Schema rules.** UUID primary keys, `timestamptz` for every timestamp, JSONB only for shapes
that are genuinely open (rules, evidence — Week 2). Everything joined or filtered is a column.
Membership lives in `enrollments` because membership **is** the authorisation boundary.

---

## ADR-004 — Our own JWT + rotating refresh cookies instead of a hosted auth service

**Decision.** `POST /auth/login` issues:

- an **access JWT** (HS256, 15 min) in an `httpOnly` cookie scoped to `/`, carrying `sub` and
  `role`;
- a **refresh token** (256-bit random) in an `httpOnly` cookie scoped to `/api/auth`, stored in
  `refresh_tokens` only as a SHA-256 hash, 7-day expiry, rotated on every use.

Reuse of a revoked refresh token revokes every live session for that user and clears the cookies.

**Why not Clerk/Auth0/Supabase Auth.** Two roles, one course, one institution: the hosted
services add a vendor, a callback URL per environment, and a pricing cliff for something that is
~200 lines here. More importantly, the assignment is about the grading engine; an opaque auth
provider makes the authorisation story harder to explain in the report, not easier.

**Why cookies rather than `Authorization: Bearer` in localStorage.** `httpOnly` means an XSS bug
cannot exfiltrate the session, and `SameSite=Lax` plus the Origin check covers CSRF for
cookie-authenticated writes. The cost is that the API must be same-origin in production, which
the Vercel rewrite already provides.

**Cost accepted.** An in-memory sliding-window limiter (5/min per IP+email) is per warm instance,
so a cold start resets it and horizontal scaling multiplies the allowance. That is honest and
documented; the fix is one table and one query, deferred until there is a real threat model.

---

## ADR-005 — Complexity is graded from the AST, not from wall-clock timing

**Decision.** The `complexity` metric infers an order class from loop bounds and recursion in the
parse tree. Timings are recorded as **evidence only** and never multiplied by a weight.

**Why.** Timing a program at n = 1, 10, 100 on a shared runner is noise: a constant-time program
and an O(n) program can both finish inside 1 ms, and the same program can be 3× slower on a busy
host. A grade that changes when the host is busy is not a grade. The AST answer is deterministic:
loop bound independent of input → O(1); bound derived from input → one factor of n per nesting
level; recursion without memoisation → at least O(n), exponential with two recursive calls;
halving/doubling → O(log n).

**Cost accepted.** Static inference can be wrong (a hidden `strlen` inside a loop is O(n²) that
the AST calls O(n)). The report shows the inferred class **and** the measurement, labelled as
corroboration, so a reader can see the disagreement instead of trusting a single number.

---

## ADR-006 — The LLM is advisory and cached, never on the scoring path

**Decision.** `llm_review` is optional, runs at temperature 0 with a fixed seed, and its response
is cached by prompt hash. It contributes feedback text and nothing else. If no key is
configured, the metric reports `unavailable` and the remaining weights are renormalised
according to the rule set's `on_unavailable` policy.

**Why.** The assignment requires reproducible grades. A model call is the least reproducible
thing in the system: provider-side model updates change outputs with no version bump we control.
Keeping it off the score preserves "same submission, same mark" while still allowing useful
prose for the student.

**Cost accepted.** Less impressive-sounding feedback. Worth it: a grade that cannot be defended
two weeks later is worse than plainer text.

---

## Post-spike revisions (Day 6, measured — supersedes assumptions above)

These are corrections, not opinions. Raw data: `docs/execution-metrics.json`.

1. **Signals collapse to NZEC.** On `ce.judge0.com` 1.14.0, a null dereference and an integer
   division by zero both return status **11 (NZEC)**, not 7 (SIGSEGV) / 9 (SIGFPE) as the plan
   assumed. The signal survives in `stderr` (`Segmentation fault`, `Floating point exception`), so
   `classifyRuntimeDetail()` exposes it as a **detail** while `status.code` stays exactly what the
   provider said. No score depends on the detail.
2. **AddressSanitizer works here.** The plan predicted ASan would die at startup under the
   address-space limit. Measured: with `-fsanitize=address -g` and `memory_limit: 65536`, the
   program ran, ASan reported a real `heap-buffer-overflow` in stderr, and the run used 10.6 MB.
   **Week 2 should therefore treat `sanitizer_run` as a candidate graded metric** (with a
   fallback when the provider or flags change), not as evidence-only. Budget one extra call per
   submission for it.
3. **`wait=true` works, and polling is still implemented.** Round trips were ~1.8 s, so `wait`
   was honoured. The adapter still polls when a response comes back pending, because some hosts
   disable the flag.
4. **Wandbox's C compiler is `gcc-head-c`.** Plain `gcc-head` is C++ and compiles `.cc` with
   `cc1plus`, which silently changes the language. The default is now `gcc-head-c`; verified
   `ACCEPTED` in 4.2 s.
5. **Budget guard is load-bearing.** ~1.8 s and unknown quota per call means an unbounded grading
   loop can exhaust the public instance mid-demo. Calls are counted per UTC day and refused with
   `429 PROVIDER_BUDGET_EXCEEDED` before they are attempted.

---

## RBAC matrix

Every row is asserted by `backend/tests/integration/rbac.test.js` unless marked *manual*.

| Action | Anonymous | Student (enrolled) | Student (not enrolled) | Instructor (owner) | Instructor (other) |
|---|---|---|---|---|---|
| `GET /health` | 200 | 200 | 200 | 200 | 200 |
| `GET /auth/me` | 401 | 200 (self) | 200 (self) | 200 (self) | 200 (self) |
| `POST /courses` | 401 | 403 | 403 | 201 | 201 (own) |
| `GET /courses` | 401 | 200 (enrolled only) | 200 (empty) | 200 (owned only) | 200 (own only) |
| `POST /courses/join` | 401 | 200 (valid code) | 404 (bad code) | 403 | 403 |
| `GET /courses/:id` | 401 | 200 (enrolled) | 404 | 200 | 404 |
| `GET /courses/:id/roster` | 401 | 403 | 403 | 200 | **404** |
| `POST /courses/:id/assignments` | 401 | 403 | 403 | 201 | 404 |
| `GET /assignments/:id` | 401 | 200 (enrolled) | **404** | 200 | 404 |
| `PATCH /assignments/:id` | 401 | 403 | 403 | 200 | 404 |
| `POST /exec/smoke` | 401 | 403 | 403 | 200 (budget-guarded) | 200 (own) |
| Any mutating request, foreign `Origin` | 403 `CSRF_ORIGIN` | 403 | 403 | 403 | 403 |

Rules that make the matrix work:

- **404, not 403, for foreign resources.** An instructor asking for another instructor's roster
  learns nothing about whether that id exists.
- **Role comes from the database on every request**, not from the token, so a role change is
  effective immediately.
- **Malformed ids are 404**, never a Prisma error.

---

## Branch and review rules

- `main` is protected: no force pushes, no direct commits, one approving review.
- One branch per day-card: `week1/day-04-rbac`.
- PR template asks for "screenshot or curl output" — a PR that cannot show the behaviour is not
  ready. `.github/pull_request_template.md`.
- Commits that change scoring logic bump `grader_version` (Week 2). Until then, any change to
  `src/execution/` requires a line in `docs/execution-notes.md`.
- Secrets never enter the repository. `backend/.env` is ignored; `backend/.env.example` is the
  contract, and `src/config.js` fails at boot when it is violated.
