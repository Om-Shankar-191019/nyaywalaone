# Nyaywala — Weeks 1–4

Rule-driven, reproducible grading for C programming assignments. This repository holds the
**Week 1–4 deliverables** of the four-week plan: accounts, roles, courses, a themed
shell, a proven execution sandbox, the grading engine (submissions, versioned rule sets, the
coordinator, every analyzer, a hashed evaluation key), and the Week 3 product surfaces — the
report a student actually reads, the rules editor an instructor actually uses, cohort filters
and exports, similarity review, and the hardening pass.

> The project was previously called *AutoGrader*. It is **Nyaywala** everywhere now — the
> name, the balance-scale mark on the landing page, the theme key, the package names and the
> Prisma client global.

Stack: **React 19 + Vite 6 + Tailwind 4** frontend, **Express 4** API, **PostgreSQL 16/17 +
Prisma 7** (Rust-free client via the `pg` driver adapter; the connection string lives in
`prisma.config.ts`, **not** in `schema.prisma`), and **onlinecompiler.io** for compilation and
execution (Judge0 and Wandbox remain as alternative providers behind one seam), no Docker.

Runs the same on **Windows, Linux and WSL** — see [docs/linux-wsl.md](docs/linux-wsl.md).

---

## Quick start

```bash
# 1. one-time: database (see CREDENTIALS-NEEDED.md for the two Neon strings)
cd backend
cp .env.example .env          # then fill DATABASE_URL, DIRECT_URL, ACCESS_TOKEN_SECRET
npx prisma migrate deploy     # applies both migrations (init + week2 grading engine)
npm run db:seed               # prints demo accounts and the course join code

# 2. one-time: dedicated test database (npm test truncates tables - never point it at dev data)
node scripts/setup-test-db.js
DIRECT_URL="$TEST_DIRECT_URL" npx prisma migrate deploy

# 3. API
npm start                     # http://localhost:3001

# 4. web app (second terminal)
cd ../frontend
npm install
npm run dev                   # http://localhost:5173, /api is proxied to :3001
```

Demo accounts created by the seed (local only):

| Role | Email | Password |
|---|---|---|
| Instructor | `prof@example.edu` | `Passw0rd-Demo-2026` |
| Students | `student1..8@example.edu` | `Passw0rd-Demo-2026` |

Course **CS 101 - Programming in C**, join code **`ADDC2026`**. Override the seeded password
with `SEED_PASSWORD=...` before running the seed.

Everything that needs your own account or key — and the exact line to paste it into — is in
**[CREDENTIALS-NEEDED.md](CREDENTIALS-NEEDED.md)**.

---

## What is working

| Day | Deliverable | Evidence |
|---|---|---|
| 1 | Baseline audit, six ADRs, env matrix, Zod boot check, PR template | `docs/decisions.md`, `backend/src/config.js` |
| 2 | Prisma schema v1, migration, idempotent seed, DB-ping health route | `GET /api/health` returns `db: "ok"` |
| 3 | Register / login / refresh rotation / logout / me, rate limiting | replayed refresh token returns `401` (tested) |
| 4 | RBAC guards, courses, join codes, assignment skeleton, origin check | RBAC matrix in `docs/decisions.md`, tested |
| 5 | App shell, auth state, route guards, dark / light / system theme | toggle survives a hard reload, verified |
| 6 | Execution providers (now onlinecompiler.io first), status taxonomy, budget guard, tree-sitter, toolchain fingerprint | `docs/execution-notes.md`, measured on real runs |
| 7 | Demo script, task board, tag-ready build | `docs/demo-1.md` |
| 8 | Schema v2 (assignments, test cases, rule sets, submissions, evaluations, metric results, caches), RFC 8785 canonicalisation, `rules_hash` / `testset_hash`, publish guard | `grading/canonical.js` + `tests/unit/grading.test.js` |
| 9 | Submission endpoint (`.c`, 64 KB, normalised), attempt numbering, `evaluation_key` dedupe, status machine, `202` + poll | `routes/submissions.js`, `services/submission-service.js` |
| 10 | `io_tests` correctness analyzer, provider status mapping, per-run execution cache, compile-failure gate | `grading/analyzers/io-tests.js` |
| 11 | C metrics (per-function NLOC, cyclomatic, nesting, file-level stats), `static_analysis`, `function_split` | `analysis/c-metrics.js`, analyzers of the same name |
| 12 | Edge-case generators (overflow, whitespace, boundary, …), oracle with caching, `no_oracle_cap` | `grading/generators.js`, `grading/oracle.js` |
| 13 | Memory audit (possible leaks, banned calls, fixed buffers) and complexity estimator (`O(1)` … `O(2^n)`) | `analysis/c-patterns.js`, `analysis/complexity.js` |
| 14 | Coordinator (gate, ordered dispatch, `on_unavailable`, integer contributions, `report_hash`), JSON + text reports, regrade with lineage | `grading/coordinator.js`, `GET /submissions/:id/report(.txt)` |
| 15 | Submission flow: `202` + polling with backoff, client-side validation, upload preview, submit disabled while a run is in flight | `pages/student/Assignment.jsx`, `lib/validation.js` |
| 16 | Report page: metric breakdown, source/reference diff, `.txt`/`.json` download, print stylesheet, copyable `report_hash`, a11y pass | `pages/student/Report.jsx` |
| 17 | Rules editor: schema-driven metric fields, live weight total with publish guard, publish diff against the active version, bulk paste of test cases | `pages/instructor/Assignment.jsx` |
| 18 | Cohort table: filters, pagination, CSV export, roster with per-student activity, audit/activity feed | `GET /assignments/:id/submissions`, `/export.csv`, `/activity`, `/courses/:id/roster` |
| 19 | Similarity: batch scan, pair review with acknowledge/flag, archived matches, instructor UI | `POST /assignments/:id/similarity/scan`, `PATCH /similarity/:matchId/review` |
| 20 | `style` + `llm_review` analyzers, versioned limitations file inside the report, golden text-report snapshots | `grading/analyzers/style.js`, `tests/fixtures/report-view.js` |
| 21 | Hardening: request-shape guard, binary/oversize upload checks, per-route rate limits, origin fix for deployed hosts, `docs/security.md` | `src/lib/guards.js`, `docs/security.md` |
| 22 | Golden corpus (18 submissions × 3 rule sets × 5 repeats), verify CLI, drift fixes, CI | `tests/golden/`, `scripts/golden.js`, `scripts/verify-report.js`, `docs/reproducibility.md` |
| 23 | Batch queue, cron drain, `grade-all`, progress counters, cost model, load check | `services/queue.js`, `docs/cost.md`, `scripts/load-check.js` |
| 24 | Deployment runbook, readiness route, rollback notes | `docs/vercel.md`, `GET /api/health/ready` |
| 25 | Playwright role journeys, theme persistence, axe-core and 360 px checks | `e2e/` |
| 26 | README, API reference, rules reference, reproducibility and cost docs, sample reports | `docs/` |
| 27 | Report content: results, usefulness and limitations, workload split, video shot list | `docs/report.md` |
| 28 | Submission checklist, final QA, week-4 task board | `docs/submission-checklist.md`, `docs/week4-task-board.md` |

**Exit criterion met:** the same submission evaluated twice returns the same `report_hash`
and the same grade; `npm test` reports `# pass 76, # fail 0, # cancelled 0`; the golden
corpus produced one hash per cell across 270 runs (`docs/samples/golden-corpus.csv`).

Two things in the plan cannot be produced from inside the repo and are recorded as blocked
rather than claimed: the **public deployment** (needs your Vercel and Neon accounts —
`docs/vercel.md` is the runbook) and the **15–20 minute video** (`docs/report.md` section 10
is the shot list). `docs/submission-checklist.md` lists everything else with its evidence.

---

## Layout

```text
├── frontend/                 React + Vite + Tailwind 4
│   ├── index.html            inline theme script (no flash before paint)
│   └── src/
│       ├── api/client.js     envelope-aware fetch, single-flight 401 refresh
│       ├── auth/             AuthProvider (session from /auth/me, never localStorage)
│       ├── theme/            ThemeProvider (system | light | dark), key: nyaywala-theme
│       ├── components/       AppShell, BrandMark (balance scale), RouteGuards, CodeEditor, ui
│       └── pages/            public/, student/ (Course, Assignment, Report), instructor/
├── backend/
│   ├── index.js              listens locally, exports the app for Vercel
│   ├── app.js                middleware order, routes, error envelope
│   ├── prisma.config.ts      Prisma 7: datasource URL for migrations (schema has none)
│   ├── prisma/               schema, migrations, seed
│   ├── scripts/              setup-test-db, exec-taxonomy, smoke
│   ├── src/
│   │   ├── config.js         Zod env validation, fails at boot
│   │   ├── db.js             Prisma 7 client + pg adapter singleton
│   │   ├── auth/             password, jwt, cookies, sessions, middleware, rbac
│   │   ├── routes/           auth, courses, assignments, submissions, exec, system
│   │   ├── services/         submission-service (upload -> evaluation -> dedupe)
│   │   ├── grading/          coordinator, rules, canonical, score, registry, versions,
│   │   │                     generators, oracle, diagnostics + analyzers/
│   │   ├── analysis/         C metrics, c-patterns, complexity, loader
│   │   ├── execution/        provider seam, onlinecompiler, judge0, wandbox, status, limits,
│   │   │                     budget, toolchain
│   │   └── lib/              http envelope, hash, rate limit, origin, guards, logger
│   └── tests/                unit + integration (node:test, supertest), golden report fixtures
├── docs/                     decisions, execution-notes, demo-1, task-board, security,
│                             linux-wsl, vercel, rule-sets/
├── CREDENTIALS-NEEDED.md     every secret, where to get it, where it goes
├── vercel.json               services + rewrites
└── .gitignore
```

---

## API (implemented now)

All routes are under `/api`. Every response is `{ data }` or `{ error: { code, message, details? } }`.

| Method | Path | Who | Purpose |
|---|---|---|---|
| `POST` | `/auth/register` | public | Create account; instructor needs the signup code |
| `POST` | `/auth/login` | public | Sets access (15 min) + refresh (7 d) cookies; 5/min per IP+email |
| `POST` | `/auth/refresh` | cookie | Rotate; reuse revokes every session for that user |
| `POST` | `/auth/logout` | cookie | Revoke + clear |
| `GET` | `/auth/me` | any signed-in | User, role, enrolments, courses taught |
| `GET` / `POST` | `/courses` | signed-in | Instructor: owned + counts / create (returns an 8-char join code) |
| `POST` | `/courses/join` | student | Case-insensitive code, idempotent |
| `GET` | `/courses/:id` · `/courses/:id/roster` | member / owner | Course, students in the course |
| `GET` / `POST` | `/courses/:courseId/assignments` | member / owner | List / create assignment skeleton |
| `GET` / `PATCH` | `/assignments/:id` | member / owner | Read / edit |
| `GET` | `/assignments/:id/rules` | member | Active rule set + versions |
| `POST` | `/assignments/:id/rules/publish` | owner | Validate weights/analyzers, freeze, store `rules_hash` |
| `POST` | `/assignments/:id/publish` | owner | Publish the assignment (needs tests + a published rule set + an oracle) |
| `GET` / `POST` | `/assignments/:id/tests` | member / owner | List / add test case |
| `PATCH` / `DELETE` | `/assignments/:id/tests/:testId` | owner | Edit / remove a test case |
| `POST` | `/assignments/:id/submissions` | student | Submit `.c` source → `202` + evaluation id (deduped by `evaluation_key`) |
| `GET` | `/assignments/:id/submissions` | member | Cohort table (owner sees grades early) |
| `GET` | `/submissions/:id` | member | Submission + latest evaluation status |
| `GET` | `/submissions/:id/report` · `/report.txt` | member | JSON report / text report (release-gated for students) |
| `POST` | `/submissions/:id/regrade` | owner | Re-run under the same rules; new evaluation keeps lineage |
| `PATCH` | `/submissions/:id/release` | owner | Release or hide grades |
| `GET` | `/assignments/:id/export.csv` | owner | Cohort CSV export |
| `GET` | `/assignments/:id/similarity` | owner | Similarity matches for the assignment |
| `POST` | `/assignments/:id/similarity/scan` | owner | Batch scan: compare every submission pair, store new matches |
| `PATCH` | `/similarity/:matchId/review` | owner | Record the human decision on a flagged pair |
| `GET` | `/assignments/:id/activity` | member | Audit feed: publishes, regrades, releases, reviews |
| `POST` | `/exec/smoke` | instructor | Compile & run C now (dev route, budget-guarded) |
| `GET` | `/meta/toolchain` · `/meta/usage` | signed-in | Compiler fingerprint / provider calls used today |
| `POST` | `/internal/drain` | `X-Cron-Secret` | Queue drain; **404** while `CRON_SECRET` is empty |
| `GET` | `/health` | public | Liveness + real DB round trip |

Authorisation is enforced twice: `requireRole` at the route, then a resource check
(`requireCourseOwner`, `requireEnrolled`) that returns **404** — not 403 — so ids cannot be
enumerated. The role is re-read from the database on every request, so it is never taken from
the token or the client.

---

## Grading engine (Week 2)

A submission becomes a report through one deterministic pipeline:

```
source ──sha256──> source_hash ─┐
rules ──RFC 8785──> rules_hash ─┤
tests ──sorted────> testset_hash├──> evaluation_key (unique) ──> Evaluation row
toolchain ────────> toolchain_hash ┘         │
grader_version ──────────────────────────────┘        │
                                                      ▼
   gate (compile? infinite loop?) ──> analyzers in rule order, concurrency ≤ 4
                                                      │
   per-metric score × weight ──> integer contributions + total
                                                      │
                                    report_hash + grade_hundredths (persisted)
```

- **Reproducible:** the same four inputs always produce the same `evaluation_key`, so a
  repeat submission returns the stored evaluation instead of re-running; the same inputs
  always produce the same `report_hash`.
- **Versioned:** `GRADER_VERSION` and per-analyzer versions (`grading/versions.js`) are
  hashed in, so a scoring change is visible in the report instead of silently altering old marks.
- **Honest when it degrades:** compile failure short-circuits to a partial report, a suspected
  infinite loop skips execution analyzers, and a missing LLM key makes `llm_review`
  `unavailable` under the rule set's `on_unavailable` policy — never a silent zero.

---

## Theme

`system | light | dark`, stored in `localStorage` under `nyaywala-theme`. The class on `<html>` is set
by a small inline script in `index.html` **before the first paint**, which is what prevents the
white flash on reload. `color-scheme` follows the choice so scrollbars and form controls match.

The palette is deliberately **not blue or violet**: brass (primary action), pine/teal
(secondary evidence) and olive (pass) on warm paper, mixed as a brand gradient and as
per-metric tones rather than one flat hue.

---

## Execution layer

The API never compiles C itself — Vercel has no toolchain. `src/execution/provider.js` is the
only seam, chosen by `EXECUTION_PROVIDER`:

- **onlinecompiler.io** (`api.onlinecompiler.io`, `gcc-15`) is the default. It needs an API key
  and no credit card, and answers in one synchronous call with compile output, stdout, stderr
  and an exit code. It has no per-request CPU/memory/process limits, so `resolveLimits` records
  the limits as *requested but not enforced* and the report says so rather than implying an
  isolation it did not get.
- **Judge0 CE** (`ce.judge0.com`, `language_id: 103`) stays available and is the only provider
  that enforces CPU/wall/memory/process limits. `JUDGE0_API_KEY` from an older `.env` is read as
  the onlinecompiler key, so the swap needed no edit to an existing file.
- **Wandbox** is a keyless last resort behind `EXECUTION_PROVIDER=wandbox`. It has no resource
  limits and no timing data, so its results are labelled differently.
- A **budget guard** counts calls per UTC day in `provider_usage` (`EXEC_DAILY_BUDGET`) and
  returns `429` before the sandbox is exhausted. The counter is shared by all three providers.

Measured on 31 Oct 2026 against onlinecompiler.io: a compile-and-run of the two-integer sum
returns `ACCEPTED` with stdout `5\n` in about 2 s wall clock, and a compile error comes back as
a `COMPILATION_ERROR` with the gcc diagnostics intact. Judge0 numbers from 30 Oct 2026 are kept
in [docs/execution-notes.md](docs/execution-notes.md) for comparison.

---

## Tests

```bash
cd backend
npm test              # unit + integration (76 tests)
npm run test:unit     # no database needed
```

Integration tests need `TEST_DATABASE_URL` / `TEST_DIRECT_URL` because they **truncate every
table** between tests — that is why `scripts/setup-test-db.js` exists (it creates a dedicated
`nyaywala_test` database). Expected output: `# pass 76, # fail 0, # cancelled 0`.

Coverage: auth happy paths, duplicate email, wrong password, expired access token, refresh
rotation and replay rejection, logout, login rate limiting, RBAC (student cannot create a course,
instructor cannot read another roster, outsiders get 404), join-code behaviour, origin check
(including a deployed host and a foreign origin), health — plus the units: canonicalisation and
key-order invariance, `rules_hash` / `testset_hash` / `evaluation_key`, weight validation,
scoring and contribution rounding, the status map, source normalisation/hashing, the rate
limiter, the request-shape guard and binary detection, provider capability clamping, the
onlinecompiler exit-code mapping, the rules-editor helpers (weight totals, publish diff, bulk
paste) and the golden text report — replayed byte-for-byte from a fixture.

---

## Deploy

`vercel.json` declares two services with `/api/*` rewritten to the backend and everything else to
the frontend. Before the first deployment:

1. Add every variable from `backend/.env.example` to the Vercel project (backend service).
2. Set `APP_ORIGIN` to the deployed origin and `EXEC_SMOKE_ENABLED=false`.
3. Run `npx prisma migrate deploy` against the production direct URL.

Section 8 of [CREDENTIALS-NEEDED.md](CREDENTIALS-NEEDED.md) has the variable table, and
[docs/vercel.md](docs/vercel.md) covers the deployment itself — including the
**"Requests from https://… are not allowed"** failure on registration, which is a same-origin
check rather than a broken account form.

---

## Documentation

- [CREDENTIALS-NEEDED.md](CREDENTIALS-NEEDED.md) — every secret, where to get it, where it goes
- [docs/decisions.md](docs/decisions.md) — six ADRs, the RBAC matrix, branch rules
- [docs/execution-notes.md](docs/execution-notes.md) — measured latency, status map, sanitizer finding
- [docs/demo-1.md](docs/demo-1.md) — the Day 7 demo script and what to test
- [docs/task-board.md](docs/task-board.md) — Day 1–21 cards with acceptance criteria
- [docs/security.md](docs/security.md) — Day 21 checklist, each row with the command that proves it
- [docs/linux-wsl.md](docs/linux-wsl.md) — running on Windows, WSL and Linux
- [docs/vercel.md](docs/vercel.md) — deploy steps and the failures that actually happen
- [docs/rule-sets/](docs/rule-sets/) — the default rule set and the LLM-weighted example
- [docs/reproducibility.md](docs/reproducibility.md) — the five inputs, the golden corpus, what may change a grade
- [docs/cost.md](docs/cost.md) — calls per evaluation, budget, throughput, measured load check
- [docs/api.md](docs/api.md) — every route, generated from the router
- [docs/rules-reference.md](docs/rules-reference.md) — each analyzer, its params and its score formula
- [docs/report.md](docs/report.md) — the report: results, usefulness, limitations, workload split
- [docs/demo-2.md](docs/demo-2.md) · [demo-3](docs/demo-3.md) · [demo-4](docs/demo-4.md) — the weekly demo scripts
- [e2e/](e2e/README.md) — the two Playwright role journeys and the accessibility pass
- [docs/submission-checklist.md](docs/submission-checklist.md) — section 17, with the evidence for each box

---

## Known limitations (stated, not hidden)

- The login rate limiter is in-memory per warm serverless instance. It blunts a script; it is not
  a distributed counter. Documented in ADR-004.
- `POST /exec/smoke` runs arbitrary C for instructors. It is disabled in production unless
  explicitly enabled, and the budget guard caps the damage, but it is a development tool.
- onlinecompiler.io enforces neither CPU nor memory limits; it is a synchronous call with a
  30 s ceiling we abort before. Limits are recorded as *requested, not enforced*, and any metric
  that depends on resource behaviour says so instead of pretending. Judge0 is the provider that
  can enforce them.
- Wandbox cannot enforce CPU or memory limits, so it must not be used for marks that depend on
  resource behaviour.
- `POST /api/internal/drain` stays 404 until you set `CRON_SECRET`; no cron entry exists yet —
  the batch queue is Week 4.
- The `llm_review` metric needs a `GROQ_API_KEY`; without one it reports `unavailable`. The
  default rule set weights it `0.00`, so the grade does not depend on it.
- Similarity is a best-effort originality signal (token shingles + structural features), not
  proof of plagiarism. A flagged pair is a reason to look, and the review note is what a human
  decided.
- Rate limiting is still per warm instance: on Vercel each instance counts separately, so the
  effective limit is `max × instances`. A Postgres counter is the Week 4 replacement.
