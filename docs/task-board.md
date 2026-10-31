# Week 1 task board

One card per day, acceptance criterion from the plan, and the evidence that closes it.
Owners: **M1** platform/backend, **M2** engine, **M3** frontend, **M4** QA/docs.

| Day | Card | Owner | Done when | Status |
|---|---|---|---|---|
| 1 | Baseline, ADRs, env matrix | M1 | Both apps start from a clean clone; `docs/decisions.md` merged | **Done** |
| 2 | Postgres, schema v1, seeds | M1 | `/api/health` returns `db: "ok"`; seed runs twice without duplicate-key errors | **Done** |
| 3 | Auth core | M1 + M4 | Five auth tests pass; a replayed refresh token returns 401 | **Done** |
| 4 | RBAC and courses | M1 + M2 | The RBAC matrix is fully covered by tests | **Done** |
| 5 | Frontend shell, auth state, dark mode | M3 | Theme survives a hard reload with no flash; a student cannot reach `/instructor` by URL | **Done** |
| 6 | Execution provider spike | M2 | `/api/exec/smoke` returns compile output, stdout and timing; an infinite loop returns TLE within 5 s | **Done** |
| 7 | Demo 1 and buffer | all | The demo runs twice in a row with no manual database edits | **Ready** |

---

## Day 1 — baseline and decisions

- [x] Repo starts from the README alone (no hidden setup).
- [x] Six ADRs in `docs/decisions.md`, each with the rejected options.
- [x] `backend/.env.example` and `frontend/.env.example` freeze the env matrix.
- [x] `src/config.js` validates env with Zod and dies at boot with a readable message.
- [x] PR template asks for a screenshot or curl output.
- [x] Branch rules written down (protected `main`, one reviewer, one branch per card).

**Evidence:** the server refuses to start with `ACCESS_TOKEN_SECRET` shorter than 32 characters,
naming the variable and the generator command.

## Day 2 — Postgres, schema, seeds

- [x] `prisma/schema.prisma`: `users`, `refresh_tokens`, `courses`, `enrollments`, `assignments`,
      `provider_usage`, `toolchain_fingerprints`.
- [x] Migration `20261030105023_init` committed.
- [x] Pooled `DATABASE_URL` + direct `DIRECT_URL` (migrations cannot run through pgbouncer).
- [x] `src/db.js` holds one client at module scope, to survive warm invocations.
- [x] Seed is idempotent: upserts by email and join code.
- [x] Health route performs a real `SELECT 1`, not a cached flag.

**Evidence:** seed run twice, `# pass 42` integration suite on a truncated database.

## Day 3 — auth core

- [x] `POST /auth/register` with Zod validation; duplicate → `409 EMAIL_TAKEN`.
- [x] `POST /auth/login`: bcrypt cost 12, constant-time failure path (`burnPasswordTime`),
      generic message for both wrong password and unknown account.
- [x] Access JWT 15 min, refresh token 256-bit stored as SHA-256, 7 days, path-scoped cookie.
- [x] `POST /auth/refresh` rotates atomically; reuse revokes every session and returns 401.
- [x] `POST /auth/logout` revokes and clears; `GET /auth/me` returns user, role, enrolments.
- [x] Login/register limited to 5/min per IP+email with `Retry-After`.

**Evidence:** `tests/integration/auth.test.js` — including the replay case asserting
`revokedAt IS NULL` count is 0.

## Day 4 — RBAC and courses

- [x] `requireAuth` re-reads the user from the database (role never trusted from the token).
- [x] `requireRole`, `requireCourseOwner`, `requireEnrolled`, `requireCourseMember`.
- [x] Malformed UUIDs are 404, not a Prisma error.
- [x] Courses: create with an 8-char code (no I/O/0/1), list, join, roster.
- [x] Assignments: create, list, read, patch — membership checked on the parent course.
- [x] Origin check on every mutating request; CORS locked to configured origins; Helmet on.

**Evidence:** `tests/integration/rbac.test.js` covers every row of the matrix in
`docs/decisions.md`.

## Day 5 — frontend shell, auth state, dark mode

- [x] React Router 7 route groups; `RequireAuth` remembers the intended path.
- [x] `RequireRole` renders a "wrong role" page instead of a redirect loop.
- [x] `AuthProvider` reads the session from `/auth/me`; a 401 triggers exactly one refresh
      (single-flight in `api/client.js`, so three parallel 401s rotate once).
- [x] Tailwind v4 `@custom-variant dark`; `ThemeProvider` with `system | light | dark`.
- [x] Inline script in `index.html` sets the class before first paint (no flash).
- [x] `aria-pressed` + a label that names the current theme.
- [x] Shell: skip link, sidebar + mobile nav, role badge, user menu, focus rings.
- [x] Shared empty / loading / error states, used from the first page.
- [x] Dashboards lazy-loaded so CodeMirror never ships to a student's phone
      (main chunk 131 KB gzip, instructor chunk 176 KB).

**Evidence:** theme set to light, hard reload, `document.documentElement` has no `dark` class and
the body background is unchanged; a student visiting `/instructor` sees the wrong-role page.

## Day 6 — execution provider spike

- [x] `provider.js` seam with `judge0` and `wandbox`, chosen by `EXECUTION_PROVIDER`.
- [x] Judge0: `language_id 103`, `compiler_options`, cpu/wall/memory/process limits, no network.
- [x] `wait=true` plus mandatory polling with backoff when a response is pending.
- [x] Status taxonomy mapped by numeric id; human-readable descriptions never parsed.
- [x] Failure taxonomy exercised: compile error, TLE, segfault, SIGFPE, fork bomb, MLE, ASan.
- [x] tree-sitter C grammar loads; functions/ifs/cyclomatic/nesting from a real parse tree.
- [x] Budget guard table + `429` path + `GET /meta/usage`.
- [x] Toolchain fingerprint captured and cached per UTC day.
- [x] `docs/execution-notes.md` with measured latency, the status map and the sanitizer finding.

**Evidence:** `docs/execution-metrics.json`; `npm run exec:smoke` printed
`ACCEPTED`, stdout `-2147483648`, 2 ms CPU, AST `functions=2 ifs=1 cyclomaticMax=2`,
budget `2/200`.

## Day 7 — demo and buffer

- [x] `docs/demo-1.md` with the two-profile script and a failure table.
- [x] Seed provides every account the demo needs; no manual SQL.
- [x] Known limitations written down instead of discovered in the viva.

**Remaining for you:** run the demo twice, then tag `v0.1.0-foundation`:

```bash
git init && git add . && git commit -m "Week 1: platform foundation"
git tag v0.1.0-foundation
```

---

## Carried into Week 2 (logged, not forgotten)

1. `sanitizer_run` promoted from evidence-only to a candidate graded metric — ASan worked
   (see `docs/execution-notes.md`).
2. `execution_cache` by `sha256(source + flags + stdin)` before the coordinator fans out.
3. Roster submission counts, which need the `submissions` table (Day 8).
4. `/internal/drain` + `CRON_SECRET` + the cron entry in `vercel.json`.
5. Replace the in-memory rate limiter with a Postgres-backed counter if the app is ever public.
