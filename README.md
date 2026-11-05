# Nyaywala

Rule-driven, reproducible grading for C programming assignments. An instructor publishes a
rubric as data; a student uploads a `.c` file; the platform compiles and runs it in a remote
sandbox, applies the weighted rules, and returns a report that explains every mark and carries
the hash that proves the run.

- Web app: React 19 + Vite 6 + Tailwind 4, `http://localhost:5173`
- API: Express 4, `http://localhost:3001` (`/api` is proxied by Vite in development)
- Data: PostgreSQL on Neon, through Prisma 7 and the `pg` driver adapter
- Execution: onlinecompiler.io (gcc 15), with Judge0 and Wandbox behind the same seam

No Docker and no local C toolchain: the compiler is remote.

**Contents:** [1. Linux / WSL](#1-run-on-linux--wsl) · [2. Windows](#2-run-on-windows) ·
[3. How the project works](#3-workflow-of-the-project) ·
[4. What must be in place](#4-what-must-be-in-place) ·
[5. When it does not start](#5-when-it-does-not-start) · [6. Layout and docs](#6-project-layout)

---

## 1. Run on Linux / WSL

### Before you start

| Need | Why |
|---|---|
| Node.js **20 or newer** (22 works) and npm | `backend/package.json` sets `engines.node >= 20`; the tests use `node --test` |
| git | to clone the repository |
| A Neon project (free tier is enough) | the database |
| An onlinecompiler.io API key | compiling and running submissions |

Node from `nvm` is the least surprising choice:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# reopen the shell, then
nvm install 22 && nvm use 22 && node -v
```

On WSL, keep the repository in the Linux filesystem (`~/nyaywalaone`), not under `/mnt/c/...`:
file watching and `npm install` are both several times slower across the Windows mount.

### Steps

```bash
# 0. enter the project
cd ~/nyaywalaone

# 1. backend dependencies (postinstall runs `prisma generate`)
cd backend
npm install

# 2. environment
cp .env.example .env
```

Open `backend/.env` and fill in the three required values (section 4), then:

```bash
# 3. prove the database path before starting anything else
npm run db:check

# 4. schema and demo data (uses DIRECT_URL for the migration)
npm run db:deploy
npm run db:seed          # prints the demo accounts and the course join code

# 5. the API
npm run dev              # http://localhost:3001, restarts on file changes
```

Leave that terminal running and open a second one:

```bash
cd ~/nyaywalaone/frontend
npm install
npm run dev              # http://localhost:5173
```

Open `http://localhost:5173`. WSL 2 forwards loopback, so the browser on Windows reaches it at
the same address.

`npm run db:check` is the step to trust: it walks environment → DNS → port reachability → login
→ schema → data, prints the fix for the first thing that fails, and never prints a password, so
its output is safe to paste anywhere. If it says port 5432 is blocked while 443 answers, set
`DATABASE_TRANSPORT=https` in `backend/.env` — Neon's driver then speaks Postgres over TLS on
443. (The API also falls back to the other transport on its own at boot; the setting just makes
the choice explicit and returns `db:check` to all-green.)

### Optional: a separate database for the test suite

`npm test` truncates every table between tests, so it must never point at your demo data.

```bash
npm run db:setup-test                                  # creates nyaywala_test
DIRECT_URL="<the test database's direct URL>" npm run db:deploy
```

Put that URL in `TEST_DIRECT_URL` (and the pooled one in `TEST_DATABASE_URL`) in `.env`
afterwards.

---

## 2. Run on Windows

Everything in section 1 applies; the differences are the shell and the installer.

### Before you start

1. Install **Node.js 20 LTS or newer** from <https://nodejs.org> (the `.msi`, "Add to PATH").
2. Use **PowerShell** (or Git Bash — both work; the commands below show both where they differ).
3. Keep the project on a normal local drive (`E:\working\nyaywalaone`). A folder synced by
   OneDrive can make `npm install` fail with `EPERM`.

```powershell
node -v      # v20.x or v22.x
npm -v
```

### Steps

```powershell
# 0. enter the project
cd E:\working\nyaywalaone\backend

# 1. dependencies
npm install

# 2. environment
Copy-Item .env.example .env        # PowerShell
# cp .env.example .env             # Git Bash

notepad .env                        # fill in the three required values (section 4)

# 3. database path
npm run db:check
npm run db:deploy
npm run db:seed

# 4. the API
npm run dev                         # http://localhost:3001
```

Second window:

```powershell
cd E:\working\nyaywalaone\frontend
npm install
npm run dev                         # http://localhost:5173
```

Notes that save time on Windows:

- **Firewall prompt.** The first `npm run dev` asks whether Node may accept connections. Allow
  it on private networks; declining silently blocks `http://localhost:5173`.
- **A port already in use.** `netstat -ano | findstr :3001` shows the owner's PID, then
  `taskkill /PID <pid> /F`. If something permanent owns 3001, set `PORT=3002` in `backend/.env`
  and `VITE_API_PROXY_TARGET=http://localhost:3002` for the frontend.
- **Line endings.** A `.env` written by Notepad is normalised on load (BOM and trailing `\r`
  are stripped), so `DATABASE_URL` does not fail validation because of CRLF.
- **Do not share `node_modules`** between Windows and WSL. Install once per platform.
- **Long paths.** If `npm install` reports `ENAMETOOLONG`, enable long paths
  (`git config --system core.longpaths true`) or move the project closer to the drive root.

---

## 3. Workflow of the project

### 3.1 What happens to one submission

```
instructor publishes a rule set        student uploads main.c
            │                                   │
            ▼                                   ▼
   rules are JSON, weights              POST /api/submissions
   sum to 1.00, frozen by hash          gates: .c extension · size · control
            │                           characters · late policy · daily ceiling
            │                                   │
            └──────────────┬────────────────────┘
                           ▼
              Submission + Evaluation (QUEUED)
              evaluation_key = hash(rules, source, tests, toolchain)
                           │
                           ▼            response returns immediately with an id
                 queue claim (FOR UPDATE SKIP LOCKED)
                           │
                           ▼
        compile gate ──► test cases ──► ten analyzers (bounded parallel)
                           │
                           ▼
        score = round(Σ metric × weight × 100)   (integer hundredths)
                           │
                           ▼
        report rendered ──► report_hash stored ──► SUCCEEDED / PARTIAL / FAILED
                           │
                           ▼
        the student's page polls named stages: queued → compiling → testing
                                               → analyzing → done | failed
```

Three properties are deliberate:

- **The response never waits for the compiler.** Grading runs after the upload is acknowledged,
  so the UI shows named progress instead of a hanging request.
- **A dead process loses nothing.** Rows are claimed atomically; a `RUNNING` row whose claim is
  older than 15 minutes is eligible again, and after three attempts it becomes `FAILED` with the
  reason recorded rather than spinning forever.
- **A grade is reproducible.** Rubric hash, toolchain fingerprint and source hash are stored on
  the evaluation; `npm run verify-report <evaluationId>` recomputes the grade and compares the
  hash with no sandbox call.

### 3.2 What an instructor does

1. Sign in, create a course (students join with a join code) and an assignment.
2. Add test cases (input, expected output, points).
3. Build a rule set in the browser: pick metrics, set weights (the editor refuses to publish
   unless they sum to exactly 1.00), tune parameters. Publishing is versioned and hashed; v(n)
   is immutable, so an old grade can always be explained by the rubric that produced it.
4. Grade the cohort: submissions are queued and drained unattended within the sandbox budget,
   or the batch/cohort view is used to re-grade after re-publishing.
5. Review similarity flags, release grades (students see nothing before release), export CSV.

### 3.3 Developer workflow

| Task | Command |
|---|---|
| API with restart-on-change | `cd backend && npm run dev` |
| Frontend with HMR | `cd frontend && npm run dev` |
| Unit tests (no database needed) | `cd backend && npm run test:unit` |
| Integration tests (real database) | `cd backend && npm run test:integration` |
| Both suites | `cd backend && npm test` |
| Determinism harness (270 sandbox runs) | `cd backend && npm run golden` |
| Recompute a stored grade | `cd backend && npm run verify-report <evaluationId>` |
| Production build of the SPA | `cd frontend && npm run build` |
| End-to-end journeys | `cd e2e && npm test` |

Vite proxies `/api` to `http://localhost:3001`. To point the frontend at an API elsewhere:
`VITE_API_PROXY_TARGET=http://host:3001 npm run dev`.

---

## 4. What must be in place

### 4.1 `backend/.env`

Copy `backend/.env.example` and fill it in; every line is documented there. The minimum:

| Variable | Required | Value |
|---|---|---|
| `DATABASE_URL` | yes | Neon **pooled** string (`...-pooler...`, `sslmode=require`). Runtime queries use it |
| `DIRECT_URL` | yes | Neon **direct** string (no `-pooler`). Migrations use it; pgbouncer cannot run them |
| `ACCESS_TOKEN_SECRET` | yes | 32+ characters. `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `APP_ORIGIN` | yes | Browser origin of the app, `http://localhost:5173` locally. Cookies are scoped to it |
| `ONLINECOMPILER_API_KEY` | for grading | From <https://www.onlinecompiler.io>. Without it, execution metrics report `unavailable` |
| `PORT` | no | Default `3001` |
| `DATABASE_TRANSPORT` | no | `tcp` (default) or `https` when the network blocks 5432 |

Optional and explained in `.env.example`: `EXECUTION_PROVIDER` (`onlinecompiler`/`judge0`/`wandbox`),
`EXEC_DAILY_BUDGET`, `GRADING_CONCURRENCY`, `GROQ_API_KEY` (advisory review only), `CRON_SECRET`
(for `POST /api/internal/drain`), `TEST_DATABASE_URL` / `TEST_DIRECT_URL`, and
`INSTRUCTOR_SIGNUP_CODE`.

`CREDENTIALS-NEEDED.md` at the project root lists where each value comes from, and
`docs/cost.md` explains the sandbox budget.

### 4.2 Demo accounts

Created by `npm run db:seed` (idempotent; password override: `SEED_PASSWORD=...`).

| Role | Email | Password |
|---|---|---|
| Instructor | `prof@example.edu` | `Passw0rd-Demo-2026` |
| Students | `student1..8@example.edu` | `Passw0rd-Demo-2026` |

Course **CS 101 - Programming in C**, join code **`ADDC2026`**.

### 4.3 Ports and runtime

| Port | Process |
|---|---|
| 5173 | frontend (Vite) |
| 3001 | API (Express) |

Node 20+, a reachable PostgreSQL, and outbound HTTPS to the execution provider. No Docker, no
local compiler, no build step for the backend.

---

### Optional: the language-model checks

Four checks use a free language-model API: written feedback built from the
metrics, a readability rubric (naming, formatting, comments, structure, error
handling), copy-paste signals for AI or tutorial code, and compile-error recovery
that can award capped marks when the logic is right but the file does not compile.
They are weight 0 in the shipped rule sets and never move a mark on their own;
the recovery credit is reported separately. See [docs/llm.md](docs/llm.md).

```bash
cd backend
npm run llm:check     # which provider answers from this machine; one tiny call each
```

Only one key is needed, and every provider below is free:

| Provider | Env var | Where to get a key |
|---|---|---|
| Groq | `GROQ_API_KEY` | https://console.groq.com/keys |
| Google Gemini | `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| OpenRouter | `OPENROUTER_API_KEY` | https://openrouter.ai/keys (`:free` models) |
| Cerebras | `CEREBRAS_API_KEY` | https://cloud.cerebras.ai |
| Mistral | `MISTRAL_API_KEY` | https://console.mistral.ai/api-keys |

Without a key everything still works: the checks show as *not run* and the grade
is unaffected. If an assignment was published before these checks existed, run
`npm run rules:upgrade -- --apply` to publish a new rule-set version that adds
them (weights are untouched).

## 5. When it does not start

**`[vite] cannot reach the API at http://localhost:3001 (ECONNRESET)`**

The frontend is fine; the API is not running, or it died. Check the API terminal first.

```bash
curl -i http://localhost:3001/api/health        # 200 means the API is up
cd backend && npm run dev                       # start it
```

The API now logs unhandled rejections and uncaught exceptions and **keeps serving** instead of
exiting, so one failed database socket no longer takes every request with it. If it still stops,
the log line beginning `[fatal]` names the real error. If the API starts but authenticated routes
answer `503 DB_UNAVAILABLE`, the database path is the problem — run `npm run db:check`.

**`npm run db:check` — what each failing line means**

| Line | Meaning | Fix |
|---|---|---|
| `FAIL DATABASE_URL ... placeholder` | `.env` copied but not filled in | paste both Neon strings |
| `FAIL DIRECT_URL is the same host` | pooled string used for migrations | use the direct (non-`-pooler`) string |
| `FAIL DNS` | wrong host, paused project, VPN | wake the project in the Neon console |
| `FAIL TCP 5432` with `443` OK | the network drops outbound Postgres | `DATABASE_TRANSPORT=https` in `backend/.env` |
| `FAIL TCP 443` with `5432` OK | the network drops the HTTPS route | remove `DATABASE_TRANSPORT=https` (back to `tcp`) |
| `NOTE WS 443 ... dropped` | TLS works but the WebSocket upgrade does not, so the `https` transport cannot work | use `tcp` on this network, or another network |
| `FAIL LOGIN ... password authentication failed` | credential rotated | re-copy both strings from Neon |
| `FAIL SCHEMA missing table(s)` | migrations never ran | `npm run db:deploy && npm run db:seed` |

A failing `LOGIN` used to read *"the driver returned an error with no message"*; it now prints the
underlying cause chain, and the `WS 443` line above it says whether the network blocked the
WebSocket the `https` transport needs.

**Other frequent ones**

| Symptom | Cause | Fix |
|---|---|---|
| `401` right after signing in on another port/host | `APP_ORIGIN` does not match the browser origin | set `APP_ORIGIN` to the exact origin you open |
| `429` while grading | sandbox daily budget spent | raise `EXEC_DAILY_BUDGET`, or wait for 00:00 UTC |
| Execution metrics all `unavailable` | no provider key, or the provider is down | `ONLINECOMPILER_API_KEY`; `GET /api/health/ready` names the failing check |
| `npm test` hangs or wipes your demo data | suite is pointed at the dev database | set `TEST_DATABASE_URL` / `TEST_DIRECT_URL` (section 1) |
| A submission stays on `queued` | the process died after acknowledging it | start the API again; the drain re-claims it, or `POST /api/internal/drain` with `CRON_SECRET` |

---

## 6. Project layout

```
backend/        Express API, Prisma schema and migrations, grading engine,
                analyzers, execution providers, scripts (db:check, golden,
                verify-report, load-check), tests
frontend/       React SPA: public pages, student surfaces, instructor workspace
e2e/            Playwright journeys (instructor, student, themes, a11y)
docs/           reference material - see below
```

| Doc | Contents |
|---|---|
| [`docs/final-report.md`](docs/final-report.md) | final project report: architecture, module status, results, risks |
| [`docs/report.md`](docs/report.md) | the long technical report |
| [`docs/linux-wsl.md`](docs/linux-wsl.md) | Linux/WSL setup in depth and the database failure taxonomy |
| [`docs/api.md`](docs/api.md) | every route, with the error envelope |
| [`docs/rules-reference.md`](docs/rules-reference.md) | every analyzer and parameter |
| [`docs/reproducibility.md`](docs/reproducibility.md) | the golden corpus and how to re-derive a grade |
| [`docs/cost.md`](docs/cost.md) | measured sandbox calls and the budget rules |
| [`docs/execution-notes.md`](docs/execution-notes.md) | provider behaviour and the failure taxonomy |
| [`docs/decisions.md`](docs/decisions.md) | why the architecture looks like this |
| [`docs/security.md`](docs/security.md) | the security checklist, each row run and verified |
| [`docs/vercel.md`](docs/vercel.md) | deploying, and the failures that happen doing it |
| [`docs/demo-1.md`](docs/demo-1.md) … [`demo-4.md`](docs/demo-4.md) | demonstration scripts |
