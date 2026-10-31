# What I need from you (and exactly where it goes)

Weeks 1 and 2 are built and tested: accounts, courses, the execution sandbox, and the whole
grading engine (submissions, versioned rule sets, the coordinator, every analyzer, the hashed
evaluation key). Some of it cannot be created from inside this project because it belongs to
your accounts: the Postgres database, a signing secret, an optional LLM key, and optionally a
keyed sandbox plan. This file lists each one, where to get it, and the exact line to paste it
into.

**Nothing in this repo contains a real secret.** `backend/.env` is gitignored; only
`backend/.env.example` is committed.

---

## 1. The three-line summary

| # | What | Required? | Where you get it | Where it goes |
|---|---|---|---|---|
| 1 | `DATABASE_URL` (pooled) + `DIRECT_URL` (direct) | **Yes** — the app will not boot without them | [Neon](https://console.neon.tech) → your project → **Connect** → *Connection string* (choose "Pooled" then "Direct") | `backend/.env` lines 7–8, and Vercel env vars |
| 2 | `ACCESS_TOKEN_SECRET` | **Yes** — 32+ random characters | You generate it with the command below; no signup | `backend/.env`: `ACCESS_TOKEN_SECRET=""` |
| 3 | `JUDGE0_API_KEY` + `JUDGE0_API_HOST` | No — only if the free public sandbox rate-limits you | [RapidAPI Judge0 CE](https://rapidapi.com/judge0-official/api/judge0-ce) | `backend/.env`: `JUDGE0_API_KEY=`, `JUDGE0_API_HOST=` |
| 4 | `GROQ_API_KEY` | No — only for the optional `llm_review` metric | [Groq](https://console.groq.com/keys) | `backend/.env`: `GROQ_API_KEY=` |
| 5 | `CRON_SECRET` | No — only for the queue drain endpoint | You generate it (any random string) | `backend/.env`: `CRON_SECRET=` |

Optional extras, each explained below: `INSTRUCTOR_SIGNUP_CODE` (you choose) and
`APP_ORIGIN` (your deployed URL).

---

## 2. Postgres on Neon — the one thing you must do

The assignment requires Postgres, and Vercel functions cannot host one. Neon's free tier is
enough for a class project.

1. Sign in at <https://console.neon.tech> and **Create project**. Region: the one closest to
   your Vercel region. Postgres version 16 or 17, both fine.
2. Open **Connect** (or *Connection details*) and copy **two** strings:
   - **Pooled connection** — the host contains `-pooler`. This is `DATABASE_URL`.
   - **Direct connection** — no `-pooler`. This is `DIRECT_URL`.
3. In `backend/.env`, replace these two lines:

   ```dotenv
   DATABASE_URL="postgresql://user:password@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require"
   DIRECT_URL="postgresql://user:password@ep-xxx.region.aws.neon.tech/neondb?sslmode=require"
   ```

   Keep the `?sslmode=require`. If your password contains `@`, `#` or `/`, percent-encode it
   (for example `@` becomes `%40`).

4. Create the schema and the demo data:

   ```bash
   cd backend
   npx prisma migrate deploy     # applies prisma/migrations/*_init
   npm run db:seed               # prints the demo credentials once
   ```

**Why two URLs.** Prisma queries go through the pooler, which is what survives serverless
concurrency. Migrations cannot run through pgbouncer, so `prisma migrate` uses `DIRECT_URL`.
Using the pooled string for migrations is the most common "it worked locally" failure on Neon.

**Test database — already set up on this machine.** `npm test` TRUNCATES every table between
tests, so it must point at a throwaway database. A separate `nyaywala_test` database on the
same Neon project is created by `node scripts/setup-test-db.js`, migrated with
`npx prisma migrate deploy`, and referenced by `TEST_DATABASE_URL` / `TEST_DIRECT_URL` in
`backend/.env`. Re-running the script is idempotent. If you leave those two empty, tests fall
back to `DATABASE_URL` — convenient, but they will wipe the seed.

---

## 3. `ACCESS_TOKEN_SECRET` — generate, do not invent

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Paste the output into `backend/.env`:

```dotenv
ACCESS_TOKEN_SECRET="the-output-of-the-command-above"
```

It must be at least 32 characters; the server refuses to boot otherwise, with a message
naming this variable. Use a **different** value in production. Rotating it invalidates every
access token immediately (refresh tokens in the database survive, so users are not logged out).

---

## 4. The instructor signup code — you choose it

Registration allows `role: "instructor"` only when the submitted code matches
`INSTRUCTOR_SIGNUP_CODE`. Set your own phrase:

```dotenv
INSTRUCTOR_SIGNUP_CODE="whatever-you-tell-your-teammates"
```

Leave it empty to allow open instructor signup (not recommended for a public deployment).
The seeded instructor account ignores this code — it already exists.

---

## 5. Judge0 — nothing needed for the demo, a key only if you get throttled

`EXECUTION_PROVIDER=judge0` with `JUDGE0_BASE_URL=https://ce.judge0.com` needs **no
credentials**. It was verified from this machine on 30 Oct 2026: Judge0 CE 1.14.0, GCC 14.1.0,
~1.8 s per call.

If the public host starts returning `429` or times out (it has no SLA), you have two options:

**Option A — keyed Judge0 on RapidAPI (keeps the same code path)**

1. Subscribe at <https://rapidapi.com/judge0-official/api/judge0-ce> (free tier available).
2. Copy the two values RapidAPI shows in its code snippet into `backend/.env`:

   ```dotenv
   JUDGE0_API_KEY="your-x-rapidapi-key"
   JUDGE0_API_HOST="judge0-ce.p.rapidapi.com"
   JUDGE0_BASE_URL="https://judge0-ce.p.rapidapi.com"
   ```

   The adapter sends them as `X-RapidAPI-Key` / `X-RapidAPI-Host` automatically.

**Option B — switch to the Wandbox fallback (no account)**

```dotenv
EXECUTION_PROVIDER=wandbox
WANDBOX_COMPILER=gcc-head-c
```

Verified working (`ACCEPTED`, ~4.2 s). Read `docs/execution-notes.md` first: Wandbox has no
CPU, memory or process limits and reports no timing, so a report produced with it must say so.

---

## 6. `APP_ORIGIN` — local now, your Vercel URL later

```dotenv
# local development
APP_ORIGIN=http://localhost:5173
```

After you deploy, set it to the deployed frontend origin and make sure the backend sees the
same value in Vercel (see section 8). This drives the cookie scope, the CORS allow-list and the
CSRF origin check — three things that break quietly if it is wrong.

---

## 7. Optional: `GROQ_API_KEY` — the LLM metric

Week 2's `llm_review` analyzer is the only consumer. Without a key the metric comes back
`unavailable`, the rule set's `on_unavailable` policy decides what that costs, and the
evaluation still succeeds — so **you can demo the whole product with no LLM key at all**.

To enable it:

1. Sign in at <https://console.groq.com/> and create a key under **API Keys**.
2. Paste it into `backend/.env`:

   ```dotenv
   GROQ_API_KEY="gsk_..."
   GROQ_MODEL=llama-3.3-70b-versatile
   ```

Responses are cached by prompt hash (`llm_cache`), temperature is 0 with seed 42, and the
default rule set weights this metric at `0.00` — a second example rule set gives it `0.10` to
demonstrate the trade-off.

## 7b. Optional: `CRON_SECRET` — the queue drain

`POST /api/internal/drain` exists now (Week 2). While `CRON_SECRET` is empty it returns **404**
on purpose. To use it, set any random string in `backend/.env` and send it as the
`X-Cron-Secret` header. No cron entry is configured in `vercel.json` yet — that arrives with
the batch-queue work in Week 4.

---

## 8. When you deploy to Vercel

Vercel does not read `backend/.env`. Add the same variables in
**Project → Settings → Environment Variables** for the **backend** service:

| Variable | Production value |
|---|---|
| `DATABASE_URL` | Neon pooled string |
| `DIRECT_URL` | Neon direct string |
| `ACCESS_TOKEN_SECRET` | a **fresh** secret, different from local |
| `APP_ORIGIN` | `https://<your-project>.vercel.app` (or your domain) |
| `INSTRUCTOR_SIGNUP_CODE` | your chosen phrase |
| `EXECUTION_PROVIDER` | `judge0` |
| `JUDGE0_DAILY_BUDGET` | `200` (or lower for a demo) |
| `EXEC_SMOKE_ENABLED` | `false` — the smoke route should not be public in production |

Notes that matter:

- Set `NODE_ENV=production` (Vercel does this for you). Cookies then get `Secure`, so the site
  **must** be served over HTTPS — Vercel already is. `http://` previews on a custom domain will
  appear to "log in and immediately log out"; that is the `Secure` flag doing its job.
- Run `npx prisma migrate deploy` against the production `DIRECT_URL` **before** the first
  request. There is no migration step in the build.
- `backend/vercel.json` sets `maxDuration: 60` for the function. Grading calls can take a few
  seconds; the default 10 s is the usual cause of "randomly failing" runs on Hobby.

---

## 9. What you do **not** need

- **No Docker.** Nothing in this project uses a container.
- **No local C compiler.** Compilation happens at the provider; your machine and Vercel never
  run `gcc`.
- **No SMTP, OAuth provider, S3 bucket or payment account.** Weeks 1–2 need none of them.
- **No `.env` in git.** It is ignored, and only the example file is tracked.

---

## 10. If you already have local Postgres

This machine has PostgreSQL 17 running on **port 5433** with a password I do not know, so I
verified against a throwaway cluster instead. If you know that password:

```dotenv
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@127.0.0.1:5433/nyaywala?sslmode=disable"
DIRECT_URL="postgresql://postgres:YOUR_PASSWORD@127.0.0.1:5433/nyaywala?sslmode=disable"
```

Then `createdb -p 5433 -U postgres nyaywala` and `npx prisma migrate deploy && npm run db:seed`.
Use Neon for the deployed version either way — Vercel cannot reach your laptop.

---

## 11. Prove the setup in four commands

From `backend/`, after section 2 and 3:

```bash
npm run db:deploy                 # 1. schema exists (2 Week 2 migrations)
npm run db:seed                   # 2. prints demo accounts + join code
npm test                          # 3. expect: # pass 52, # fail 0, # cancelled 0
npm start                         # 4. then, in another terminal:
                                  #    curl -s localhost:3001/api/health
                                  #    -> {"data":{"status":"ok","db":"ok",...}}
```

If step 4 prints `503 DB_UNAVAILABLE`, the connection string is wrong or the branch is asleep —
that is the honest failure, not a crash. If the server exits immediately, read the message: it
names the missing variable.
