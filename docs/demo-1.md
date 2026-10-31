# Demo 1 — Day 7 script

Goal: show that the platform foundation is real, in eight minutes, without touching the database
by hand. Run it once alone before running it in front of anyone.

**Before the demo**

```bash
cd backend && npm start                 # terminal 1
cd frontend && npm run dev              # terminal 2
npm --prefix backend test               # once, earlier: # pass 42, # fail 0
```

Use two browser profiles (or one normal + one private window). Keep the API log visible in
terminal 1 — the `POST /api/exec/smoke -> 200` line is part of the demo.

---

## The script

### 1. Instructor signs up, creates a course (2 min)

1. Open `/register` in profile A. Fill in a name, an email of your own, a 10+ character password,
   select **Instructor**, and paste the signup code from `backend/.env`
   (`INSTRUCTOR_SIGNUP_CODE`).
2. You land on `/instructor`. Create a course named e.g. *CS 102 - Pointers*.
3. The card shows the course with an **8-character join code**. Click the copy button.

*Say:* "Instructor accounts are gated by a code, and the role is decided server-side. A student
cannot create a course even if they call the API directly."

### 2. Student joins in a second profile (2 min)

1. Profile B: `/register` → **Student** (no code requested) → you land on `/student`.
2. Paste the join code → **Join course**. The course appears in *Enrolled courses*.
3. Reload the page: the course is still there, which means it is in Postgres, not in state.

*Say:* "Joining is idempotent, join codes are case-insensitive, and students never receive the
join code back in the course list."

### 3. Role boundaries (1 min)

1. Still in profile B, type `/instructor` in the address bar.
2. You get *"This area is for instructors"* with a link back to your dashboard — an explanation,
   not a redirect loop and not a blank page.
3. In the API log, note the `GET /api/auth/me -> 200` on boot: the session comes from an
   `httpOnly` cookie the page cannot read.

*Say:* "Routes are guarded on the client for UX and on the server for truth. A student asking for
another student's data gets 404, so ids cannot be enumerated."

### 4. Dark mode (1 min)

1. Click the theme button in the header: `system → light → dark`.
2. Hard-reload (Ctrl+Shift+R). The theme is unchanged **and** there is no white flash — the class
   is applied by an inline script before the first paint.
3. Open DevTools → the `localStorage` key is `ag-theme`, and `<html>` carries `class="dark"` and
   `style="color-scheme: dark"`.

*Say:* "Three states, not two: system respects the OS and keeps following it, light and dark are
explicit choices that survive a reload."

### 5. The execution sandbox (2 min)

1. Back in profile A (`/instructor`), scroll to **Execution sandbox**.
2. Leave the sample `add.c` and the stdin `2147483647 1`, press **Compile & run**.
3. Expect, within ~3 s:

   | Field | Value |
   |---|---|
   | Status | `ACCEPTED` |
   | stdout | `-2147483648` |
   | CPU / memory | ~2 ms / ~1 MB |
   | AST | functions 2, ifs 1, cyclomatic max 2, main 8 lines |
   | Budget | `n / 200 calls today (UTC)` |

   `-2147483648` is the interesting part: `INT_MAX + 1` overflows a signed int. That is the first
   Week 2 conversation — the program "works" and the answer is still wrong.
4. Edit the source to `while(1){}` and run again → `TIME LIMIT EXCEEDED` in ~3 s, not a hung
   request.

*Say:* "The API does not compile anything; Vercel has no toolchain. Every run goes through one
provider seam with real CPU, wall, memory and process limits, is counted against a daily budget,
and is parsed with tree-sitter so Week 2 can grade structure without regex."

### 6. Close (30 s)

Run `cd backend && npm run exec:smoke` in the terminal and let it print the status, stdout, AST
and budget line. It is the same path, without a browser.

---

## What to test (short version)

| # | Check | Expected |
|---|---|---|
| 1 | `curl localhost:3001/api/health` | `{"data":{"status":"ok","db":"ok",...}}` |
| 2 | `cd backend && npm test` | `# pass 42`, `# fail 0` |
| 3 | Register duplicate email | `409 EMAIL_TAKEN` |
| 4 | Login with a wrong password | `401` and the same message as an unknown email |
| 5 | Student opens `/instructor` | *"This area is for instructors"* |
| 6 | Theme → reload | Choice persists, no flash |
| 7 | Student joins the seeded course with `ADDC2026` | Course appears, survives reload |
| 8 | Instructor `/exec/smoke` with `while(1){}` | `TIME_LIMIT_EXCEEDED` within ~5 s |
| 9 | Refresh-token replay (`curl` with an old `ag_rt`) | `401`, all sessions revoked |
| 10 | `POST /api/courses` with `Origin: https://evil.example` | `403 CSRF_ORIGIN` |

Items 3–5, 8–10 are already covered by the automated suite; 1, 2, 6 and 7 are the ones worth
doing by hand before the demo.

---

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `503 DB_UNAVAILABLE` on `/health` | Neon branch asleep or wrong URL | Wake it in the console; check `DATABASE_URL` |
| Login succeeds, then every request is 401 | `APP_ORIGIN` does not match the browser origin, or you are on `http://` in production | Set `APP_ORIGIN` to the exact origin |
| `PROVIDER_RATE_LIMITED` (429) | Public Judge0 instance is throttling | Wait a minute, or switch `EXECUTION_PROVIDER=wandbox` |
| `PROVIDER_BUDGET_EXCEEDED` | Daily budget spent | Raise `JUDGE0_DAILY_BUDGET`, or wait for 00:00 UTC |
| Sandbox shows 403 | Signed in as a student | Switch to the instructor profile |
| Seed prints no accounts | Seed already ran (upsert) | It is idempotent; the accounts exist, the password is `SEED_PASSWORD` |
