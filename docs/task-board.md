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

# Week 3 task board

Days 15-21. Same rule as Week 1: a card is done when the acceptance criterion was met on a
real run, not when the code compiled.

| Day | Card | Done when | Status |
|---|---|---|---|
| 15 | Submission flow | A student sees `queued → running → graded` without a refresh; a second click cannot create a second run | **Done** |
| 16 | Report page | A graded submission renders every metric, the diff, and downloads; printing it yields one clean sheet | **Done** |
| 17 | Rules editor | Weights that do not sum to 1.00 block publish; the diff names every change from the active version | **Done** |
| 18 | Cohort and roster | Filter, paginate, export CSV; the roster counts each student's submissions in one query | **Done** |
| 19 | Similarity | A batch scan stores pairs; reviewing one records who looked and when, and changes no grade | **Done** |
| 20 | Style, LLM, limitations | A report states what the grader could *not* do, and the text report is byte-identical on replay | **Done** |
| 21 | Hardening | Every row of `docs/security.md` was run, not asserted | **Done** |

---

## Day 15 — the submission flow

- [x] `POST /assignments/:id/submissions` returns `202` with an evaluation id; the page polls
      `GET /submissions/:id` with backoff and stops on a terminal status.
- [x] Submit is disabled while a run is in flight, so a double click cannot spend provider quota.
- [x] Client-side validation mirrors the server: `.c` only, 64 KB, not empty, no NUL bytes.
- [x] The chosen file is previewed (name, size, first lines) before it is sent.
- [x] Server errors land in the form, with the field named, not in an alert.

**Evidence:** submitting the two-integer sum from the browser reached `graded` without a reload;
pasting binary content was refused before the request left the page.

## Day 16 — the report a student actually reads

- [x] Grade, per-metric contribution (integer hundredths), and the rule-set version that produced it.
- [x] Source vs reference diff, side by side, scrollable, with the changed lines marked.
- [x] `.txt` and `.json` download, print stylesheet that drops the chrome.
- [x] `report_hash` shown and copyable — that is the reproducibility claim made checkable.
- [x] Released/withheld state: a student sees the report only once the instructor releases it.
- [x] Headings, table semantics, focus order and colour contrast checked by keyboard.

**Evidence:** `tests/unit/report-text.test.js` replays a stored view through the text renderer and
compares it to `tests/golden/report-text.txt` byte for byte (`UPDATE_GOLDEN=1 npm test` accepts an
intentional change).

## Day 17 — the rules editor

- [x] Fields are generated from each analyzer's Zod schema, so the editor cannot drift from the engine.
- [x] Live weight total with the sum in hundredths; publishing is blocked until it is exactly 1.00.
- [x] Publish shows a diff against the active version (added, removed, reweighted) before it freezes.
- [x] Bulk paste of test cases as `input|||expected`, with a per-line error for a bad row.
- [x] Publishing bumps the version and stores `rules_hash`; old evaluations keep their version.

**Evidence:** `tests/unit/week3.test.js` covers `zodToSchema`, weight validation and the diff;
the second example rule set (`docs/rule-sets/llm-assisted.json`) gives `llm_review` weight 0.10.

## Day 18 — cohort, roster, activity

- [x] Cohort table: status filter, student search, sort by grade, pagination.
- [x] `GET /assignments/:id/export.csv` streams the same rows the table shows.
- [x] Roster includes per-student submission counts via one grouped query, not N+1.
- [x] Activity feed records publish, regrade, release and review, so a changed mark has a cause.

**Evidence:** `GET /courses/:id/roster` and `/assignments/:id/activity` return in one query each;
CSV download opens in a spreadsheet with the same filters applied.

## Day 19 — similarity review

- [x] `POST /assignments/:id/similarity/scan` compares every pair once and stores new matches
      with the method name (`minhash-128`) and the matched span.
- [x] `PATCH /similarity/:matchId/review` records `reviewedAt`, `reviewedBy`, an optional note,
      and writes an audit row — it can reopen a match too.
- [x] Reviewing **never** changes a grade; a flag is a prompt for a human.
- [x] Instructor UI lists pairs by similarity with both attempts and a review action.

**Evidence:** scanning the seeded cohort created pairs; reviewing one wrote the audit row and
left `grade_hundredths` untouched.

## Day 20 — style, LLM, and the limitations file

- [x] `style` analyzer: naming, magic numbers, function length, comment ratio — evidence, not marks.
- [x] `llm_review` uses the Groq key when present and reports `unavailable` when not; the rule
      set's `on_unavailable` policy decides the cost.
- [x] Every limitation lives in one versioned `grading/limitations.json`, stamped into the report
      as `limitations_version`.
- [x] Text and JSON reports are rendered from one view object, so they cannot disagree.

**Evidence:** the report on a provider that cannot enforce limits says so under *Limitations*;
the golden snapshot test fails if that wording changes silently.

## Day 21 — hardening

- [x] `jsonShapeGuard`: depth ≤ 8, arrays ≤ 200, before any validator walks the body.
- [x] Upload guard: NUL/control-character detection rejects binary dressed as `.c`.
- [x] Rate limits: login/register 5/min per IP+email, submissions 10/hour per account;
      `Retry-After` on refusal.
- [x] Origin check accepts same-origin (deployed hosts) and refuses cross-site, including through
      proxy headers — the fix for `Requests from … are not allowed` on Vercel.
- [x] `docs/security.md`: every control with the command that proves it.

**Evidence:** `npm test` → `# pass 76, # fail 0`; every row of `docs/security.md` was executed on
31 Oct 2026.

## Cross-cutting — Linux and WSL

- [x] `.env` files are read through `sanitiseEnv()`, so a BOM or CRLF from a Windows editor no
      longer produces `"https://x\r" is not a URL`.
- [x] `.gitattributes` pins `*.sh`/`*.env` to LF, so a checkout on Windows does not break a script.
- [x] Vite dev server binds explicitly and proxies `/api`, so WSL and the Windows browser agree
      on one origin (cookies stay first-party).
- [x] No script depends on a Windows path separator or a `cmd` builtin.
- [x] `docs/linux-wsl.md` records the platform differences that matter.

---

## Carried into Week 4

1. **Batch queue** — `POST /internal/drain` is written but unarmed (`CRON_SECRET` empty, no cron
   entry). Grading is synchronous per submission today; a cohort of 200 needs the queue.
2. **Distributed rate limiting** — the limiter is per warm instance, so Vercel's instance count
   multiplies the effective limit.
3. **CI** — tests run locally only; nothing gates a merge yet.
4. **Cohort analytics** — per-metric averages and per-question difficulty need the aggregate
   queries the Week 3 filters already imply.

---

## Carried into Week 2 (logged, not forgotten)

1. `sanitizer_run` promoted from evidence-only to a candidate graded metric — ASan worked
   (see `docs/execution-notes.md`).
2. `execution_cache` by `sha256(source + flags + stdin)` before the coordinator fans out.
3. Roster submission counts, which need the `submissions` table (Day 8).
4. `/internal/drain` + `CRON_SECRET` + the cron entry in `vercel.json`.
5. Replace the in-memory rate limiter with a Postgres-backed counter if the app is ever public.

---

# Week 4 task board

Days 22–28 have their own board: [week4-task-board.md](week4-task-board.md).

Carried into Week 4 from Week 3, and where each one landed:

| Carried item | Outcome |
|---|---|
| Batch queue and cron drain | Done — `services/queue.js` (`FOR UPDATE SKIP LOCKED`, stale-claim reclaim, `MAX_ATTEMPTS=3`), `POST /internal/drain`, `POST /assignments/:id/grade-all`, `GET .../grading-progress` |
| Distributed rate limiting | Not done, deliberately — one process grades, so a per-provider semaphore is the correct scope; `docs/decisions.md` records why a Redis limiter would be a second system for no benefit at this size |
| CI | Done — `.github/workflows/ci.yml` runs unit + integration + the golden grid summary |
| Cohort analytics | Partial — `GET /assignments/:id/grading-progress` and the CSV export cover the operational questions; per-metric distribution charts are not in this build |
