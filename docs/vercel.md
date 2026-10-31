# Deploying to Vercel — and the failures that actually happen

The repository deploys as **one Vercel project with two services** (`vercel.json`):

```
https://<project>.vercel.app
├── /api/*   -> backend service   (Express, entrypoint index.js)
└── /*       -> frontend service  (Vite build, SPA)
```

Because both are served from the same public host, the browser's `Origin` is that host, the API
call is same-origin, and cookies are first-party. Nothing needs a CORS exception or a
`SameSite=None` cookie.

---

## 1. Before the first deploy

1. **Database.** Create a Neon project and copy both connection strings (pooled and direct).
   Run the migrations against the production direct URL once:
   ```bash
   cd backend
   DIRECT_URL="postgresql://…direct…" npx prisma migrate deploy
   ```
   There is no build-time migration step, so a deploy without this fails on the first request
   with `P2021: table does not exist`.
2. **Environment variables** (Vercel → Project → Settings → Environment Variables, for the
   backend service — Vercel does **not** read `backend/.env`):

   | Variable | Value | Required |
   |---|---|---|
   | `DATABASE_URL` | Neon pooled string | yes |
   | `DIRECT_URL` | Neon direct string | yes |
   | `ACCESS_TOKEN_SECRET` | 48 random bytes, base64url — **different from local** | yes |
   | `ONLINECOMPILER_API_KEY` | key from onlinecompiler.io | yes (the default provider is keyed) |
   | `APP_ORIGIN` | `https://<project>.vercel.app` or your domain | yes |
   | `NODE_ENV` | `production` (Vercel sets this) | — |
   | `EXECUTION_PROVIDER` | `onlinecompiler` (default) | — |
   | `ONLINECOMPILER_COMPILER` | `gcc-15` | — |
   | `EXEC_DAILY_BUDGET` | `200`, or lower for a demo | — |
   | `EXEC_USER_DAILY_SUBMISSIONS` | `40` (per-student ceiling) | — |
   | `EXEC_MAX_INFLIGHT` | `4` (provider calls in flight) | — |
   | `CRON_SECRET` | 24+ random characters — enables the queue drain | yes, for cron |
   | `INSTRUCTOR_SIGNUP_CODE` | your phrase | recommended |
   | `EXEC_SMOKE_ENABLED` | `false` | recommended |
   | `GROQ_API_KEY` | optional, for `llm_review` | no |

   Generate the secret in a terminal, never in the browser:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```
3. **Redeploy** after adding variables. Changing an env var does not restart already-running
   functions by itself.

---

## 2. "Requests from https://… are not allowed" on registration

This is the failure people hit first, and it has nothing to do with the password rules. The API
rejects a mutating request (`POST`, `PATCH`, …) whose `Origin` header is not one it recognises:

```json
{ "error": { "code": "CSRF_ORIGIN", "message": "Requests from https://my-app-git-main-me.vercel.app are not allowed" } }
```

**Cause.** `APP_ORIGIN` was still `http://localhost:5173` (the value copied from the local
`.env`), so every browser POST from the deployed host looked foreign.

**Fix.** Two layers, and the second one is why this rarely comes back:

1. Set `APP_ORIGIN` to the exact deployed origin — scheme, host, no trailing slash — and
   redeploy. Preview deployments change host on every push, so put those in
   `EXTRA_ALLOWED_ORIGINS` (comma separated) if you keep a stable preview domain.
2. **Same-origin is accepted automatically.** `src/lib/origin.js` now allows an `Origin` that
   equals the host the request arrived on (read from `x-forwarded-host` / `x-forwarded-proto`
   behind Vercel's proxy). A production domain, a preview subdomain and a custom domain all
   work with no environment edit, while a cross-site page still fails: its `Origin` is
   `https://evil.example` and our host is ours.

That is the correct CSRF rule, not a bypass — a browser only attaches our cookies when the
request really goes to our host, and `SameSite=Lax` is the second layer.

**Verify it in one command** (replace with your host):

```bash
curl -s -X POST https://<project>.vercel.app/api/auth/register \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://<project>.vercel.app' \
  -d '{"fullName":"Test","email":"t1@example.edu","password":"Correct-Horse-42","role":"student"}' \
  -w '\nHTTP %{http_code}\n'
```

`201` means the origin, the database and the schema are all fine. A `403 CSRF_ORIGIN` with your
own host in the message means a stale deployment is still serving — redeploy. A `409 EMAIL_TAKEN`
means registration works and the email already exists.

If the API is on a **different** host from the page (a separate Vercel project, or
`api.example.com`), then same-origin does not apply: set `VITE_API_BASE_URL` on the frontend to
the API origin and add the page's origin to `EXTRA_ALLOWED_ORIGINS` on the backend.

---

## 3. Other failures, in the order they occur

| Symptom | Cause | Fix |
|---|---|---|
| Build fails, "No entrypoint found" | the service `root` does not contain `index.js` | keep `backend` and `frontend` as the service roots |
| `500` on every API call, log shows `Invalid environment configuration` | a required variable is missing or malformed; the message names it | set it and redeploy |
| `503 DB_UNAVAILABLE` | wrong connection string, or the Neon branch is suspended | use the pooled string for `DATABASE_URL`; wake the branch |
| `P1001`/`P2021` on first request | migrations never ran | `npx prisma migrate deploy` with the direct URL |
| Logged in, then immediately logged out | `Secure` cookies over plain `http://` | always use the `https://` URL |
| `429 RATE_LIMITED` while clicking around | login/register limit is 5/min per IP+email, and Vercel's egress shares IPs | wait a minute, or raise the limit in `src/routes/auth.js` |
| Grading times out at 10 s | Hobby plan function ceiling | `backend/vercel.json` already requests `maxDuration: 60`; check it is applied |
| `503 PROVIDER_UNAVAILABLE` during a submission | onlinecompiler.io rejected the key or is rate-limiting | check `ONLINECOMPILER_API_KEY`; the response `details.provider` names the provider |
| `/api/exec/smoke` returns 404 | `EXEC_SMOKE_ENABLED=false` in production — by design | leave it off in production; use it locally |
| `/api/internal/drain` returns 404 | `CRON_SECRET` is empty — by design | set it and send `X-Cron-Secret` or `Authorization: Bearer` |
| `500 INTERNAL_ERROR` on the first submit, log says `Unknown argument 'stage'` | the committed Prisma client is older than `schema.prisma` | `cd backend && npx prisma generate`, commit the regenerated client; `postinstall` now does it on every deploy |
| Every submission stays `queued` | nothing is draining the queue: no cron, or `CRON_SECRET` missing | confirm the cron line in `vercel.json` and that `/api/internal/drain` answers 200 with the secret |

---

## 4. After the deploy, prove it works

```bash
# 1. liveness + a real database round trip
curl -s https://<project>.vercel.app/api/health
#    {"data":{"status":"ok","db":"ok",...}}

# 2. registration (section 2 above) -> 201

# 3. sign in, then read your own session
curl -s -c jar.txt -X POST https://<project>.vercel.app/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"t1@example.edu","password":"Correct-Horse-42"}'
curl -s -b jar.txt https://<project>.vercel.app/api/auth/me
```

Then, in the browser: register → join the course with its code → submit a `.c` file → wait for the
report. That path exercises the origin check, the session cookies, the provider key and the
grading coordinator in one go.

---

## 5. The queue in production (Day 23)

A submission answers `202` and is graded off the request path. That is right for
the student and wrong for reliability unless something picks the row up when the
process dies. Two mechanisms do it:

1. **The in-process kick.** `setImmediate(scheduleGrading)` runs immediately
   after the response. On a long-lived server this is the normal path.
2. **The drain.** `POST`/`GET /api/internal/drain` claims the oldest `QUEUED`
   row with

   ```sql
   UPDATE "evaluations" ... WHERE id = (
     SELECT id FROM "evaluations" WHERE status = 'QUEUED'
     ORDER BY COALESCE(claimed_at, started_at)
     LIMIT 1 FOR UPDATE SKIP LOCKED
   ) RETURNING id;
   ```

   Postgres arbitrates the claim, so two overlapping invocations - a cron tick
   racing a live submission, or two cron ticks racing each other - cannot grade
   the same row twice. A `RUNNING` row whose `claimed_at` is older than 15
   minutes is claimable again, which is how a crashed worker is recovered. After
   three attempts the row becomes `FAILED` with `retries_exhausted: …`, so the
   cohort view shows a failure instead of a spinner.

`vercel.json` schedules it every minute. Vercel Cron authenticates with
`Authorization: Bearer $CRON_SECRET`, which the route accepts alongside
`X-Cron-Secret`.

**Plan limits matter here.** Per-minute schedules are a Pro feature; Hobby
deployments only get daily crons. On Hobby, either:

- point an external scheduler (GitHub Actions, cron-job.org) at
  `/api/internal/drain?limit=2` every minute with the header, or
- accept that grading is driven by the in-process kick and that a crashed run is
  picked up the next day.

Keep the per-tick `limit` at 1-2 on Vercel: a function has 60 seconds, and two
graded submissions is already ~16 provider calls.

Check it without a browser:

```bash
curl -s -X POST https://<project>.vercel.app/api/internal/drain \
  -H "X-Cron-Secret: $CRON_SECRET" -H 'Content-Type: application/json' \
  -d '{"limit":1}'
# {"data":{"claimed":1,"succeeded":1,...}}      (or claimed:0 when idle)

curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<project>.vercel.app/api/internal/drain
# 404  - the route does not exist without the secret
```

---

## 6. Rollback

The database is the only thing that cannot be rolled back by clicking a button,
so the rule is: **migrations are written to be backward compatible for one
release.** Adding a nullable column or a defaulted one (as
`20261031120000_week4_queue` does) is safe for the previous build, which simply
ignores it.

To roll back:

1. Vercel → Deployments → the previous deployment → **Promote to Production**.
2. Do **not** run `prisma migrate down` — Prisma does not generate down
   migrations for this project, and dropping `stage`/`claimed_at` would break
   the build you just restored.
3. If the rollback crosses a breaking migration, restore the Neon branch to the
   pre-deploy point-in-time instead of reversing SQL by hand.

Pin the last known-good deployment id in the release notes
(`RELEASE-NOTES.md`) so "which one was working?" is a lookup, not a memory test.
