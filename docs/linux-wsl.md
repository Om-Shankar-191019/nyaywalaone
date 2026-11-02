# Running Nyaywala on Linux and WSL

The app is plain Node.js — no native compilation, no Docker, no Windows-only
path. This page covers the handful of places where a Linux or WSL machine behaves
differently, and what to do about each.

Developed on Node 22 / npm 9.6 under Windows 11 + Git Bash; the notes below are the
Linux and WSL2 (Ubuntu) differences that were handled in the code, so a copy on
those systems starts without the usual line-ending and proxy detours.

---

## 1. Prerequisites

```bash
node --version   # v20 or newer; v22 is what the project is developed on
npm --version
```

Nothing else. C code is compiled **by the sandbox**, not on your machine, so
`gcc` is not a prerequisite for grading — only for running the optional taxonomy
script against a local compiler.

## 2. Install

```bash
cd backend  && npm ci
cd ../frontend && npm ci
```

`npm ci` respects the committed lockfile; use it rather than `npm install` so you
get the versions the reports were produced with.

The Prisma client is generated from the schema, not committed to the registry:

```bash
cd backend
npx prisma generate
```

`npm ci` already runs that as a `postinstall` step, so the command above only
matters if you installed with `--ignore-scripts` or changed `schema.prisma`.
On Linux the generator is the same JavaScript client (Prisma 7 has no Rust
engine to download), so nothing platform-specific is fetched.

## 3. Environment

```bash
cp backend/.env.example backend/.env
```

Fill in `DATABASE_URL`, `DIRECT_URL`, `ACCESS_TOKEN_SECRET`, `APP_ORIGIN` and
`ONLINECOMPILER_API_KEY`. See [credentials.md](credentials.md) for where each one
comes from.

Then prove the two database strings before starting anything else:

```bash
cd backend
npm run db:check
```

It walks environment, URL shape, DNS, TCP, authentication and schema, prints one
line per step, names the fix for the first thing that fails, and never prints a
password - so its output is safe to paste into a chat or an issue.

Two rules it enforces, because swapping them is the most common fresh-clone bug:
`DATABASE_URL` is the **`-pooler`** host (runtime queries), `DIRECT_URL` is the
**direct** host (migrations; pgbouncer cannot run them).

### Line endings — the one that actually bites

A `.env` file saved with Windows line endings ends in `\r`. Zod then reports
`"https://api.onlinecompiler.io\r" is not a URL`, which reads like a typo and is
not one. Two defences are in place:

- `src/config.js` strips a trailing CR, stray whitespace and a UTF-8 BOM from
  every environment value before validation (`sanitiseEnv`);
- [.gitattributes](../.gitattributes) normalises `.env*` to LF on commit.

If you still see a value arrive with junk, check it yourself:

```bash
awk '/\r$/{n++} END{print n+0 " CRLF lines"}' backend/.env   # want 0
```

## 4. Database

```bash
cd backend
npm run db:deploy        # apply migrations (uses DIRECT_URL)
npm run db:seed          # idempotent demo accounts
npm run db:setup-test    # creates nyaywala_test for the integration suite
```

`db:setup-test` is deliberately separate: the integration suite **truncates every
table**, so it must never point at the database holding real work.

## 5. Run

Two terminals:

```bash
cd backend  && npm run dev     # http://localhost:3001
cd frontend && npm run dev     # http://localhost:5173
```

### WSL specifics

- **Backend inside WSL, browser on Windows** — works as-is. WSL2 forwards
  `localhost`, so `http://localhost:5173` opens from Edge or Chrome.
- **Backend on Windows, frontend inside WSL** — point the dev proxy at the other
  side of the boundary:
  ```bash
  VITE_API_PROXY_TARGET=http://$(hostname).local:3001 npm run dev
  ```
  or use the Windows host IP from `cat /etc/resolv.conf`.
- **Reaching the dev server from a phone** — bind beyond loopback:
  ```bash
  VITE_HOST=0.0.0.0 npm run dev
  ```
  Both variables are read in [vite.config.js](../frontend/vite.config.js) and
  default to the safe loopback values.

### Firewall note

`EACCES` or `EADDRINUSE` on `npm run dev` usually means the port is taken, not a
permission problem — the app only ever binds above 1024. Find the culprit with
`ss -ltnp | grep 3001` (Linux) or `netstat -ano | findstr :3001` (Windows).

## 6. Verify the sandbox credential

Before grading anything, prove the key works from this machine:

```bash
cd backend && npm run exec:check
```

Expected output ends with `All cases behaved as expected.` The four cases are
accepted, compile error, segfault and timeout. It prints the API's answers and
never the key, so the output is safe to paste into a ticket.

## 7. Tests

```bash
cd backend
npm run test:unit          # no database needed
npm run test:integration   # needs TEST_DATABASE_URL
npm test                   # both, sequentially
```

`npm test` passes a quoted glob to Node's own test runner (Node 20+ expands it),
so it behaves the same under bash and cmd.exe.

To accept an intentional change to the text report:

```bash
UPDATE_GOLDEN=1 npm test
```

## 8. What is *not* platform-specific, and why

| Thing | Why it works everywhere |
|---|---|
| Code execution | HTTP calls to onlinecompiler.io — no local compiler, no local sandbox |
| File paths | all derived from `import.meta.url`, never string-concatenated |
| Scripts | JavaScript only; no `.sh`, `.bat` or PowerShell anywhere in the repo |
| Time zones | budgets and quotas are computed in UTC on both sides |
| Line endings | normalised by `.gitattributes`, tolerated by `sanitiseEnv` |
| Database | a connection string; `sslmode=require` works identically |

## 9. Known WSL annoyances

1. **Cold `npm ci` is slow** on a `/mnt/c` checkout — the 9p filesystem makes
   `node_modules` writes expensive. Cloning into the Linux filesystem
   (`~/projects/...`) is several times faster.
2. **File watching** across `/mnt/c` can miss changes. `npm run dev` uses
   `node --watch`, and Vite uses chokidar; both work, but a change occasionally
   needs a manual refresh. Again: keep the checkout on the Linux side.
3. **`CRLF` in a file created on Windows** and then read by a Linux tool. Node
   does not care; `awk` and `grep` do. If a test fails with a stray `^M`, run the
   `awk` check from §3.

---

## 10. Two errors every fresh Linux clone hits, and what they mean

### 10.1 `POST /api/auth/login -> 500` with a blank Prisma message

```
prisma:error
Invalid `prisma.user.findUnique()` invocation:

[error] a707611f-... PrismaClientKnownRequestError:
Invalid `prisma.user.findUnique()` invocation:

    at .../src/routes/auth.js:85:18
[2026-11-02T17:49:00.078Z] INFO POST /api/auth/login -> 500 343ms
```

Nothing above the arrow is the bug: there is no bug in the login route. Prisma 7
reaches Postgres through a driver adapter, and when the *connection* fails it
raises a `PrismaClientKnownRequestError` whose message is empty because the real
cause lives in `meta`/`cause`. An `.env` file can be present and still be the
problem - it may hold the `.env.example` placeholder host, the direct URL where
the pooled one belongs, or a password that was rotated after the file was saved.

Diagnose, in this order:

```bash
cd backend
npm run db:check            # names the layer: env / URL / DNS / TCP / login / schema
```

| `db:check` says | Cause | Fix |
|---|---|---|
| `FAIL DATABASE_URL` placeholder | `.env` was copied but not filled in | paste the Neon strings again |
| `FAIL DNS` / `FAIL TCP` | wrong host, paused Neon project, VPN or firewall | wake the project in the Neon console |
| `FAIL LOGIN ... password authentication failed` | credential rotated | re-copy both strings |
| `FAIL SCHEMA missing table(s)` | migrations never ran | `npm run db:deploy && npm run db:seed` |

Why it looked intermittent: a Neon free project **suspends when idle**, and the
first query after a suspend can fail while the compute wakes. The API now retries
one connection-level failure before giving up, and answers `503 DB_UNAVAILABLE`
with a request id instead of an opaque 500. The real cause is logged as
`[error:db] <request-id> ...`, so the id shown in the browser reaches the line
that explains it.

### 10.2 `[vite] http proxy error: /api/exec/smoke  Error: read ECONNRESET`

```
11:18:04 pm [vite] http proxy error: /api/exec/smoke
Error: read ECONNRESET
    at TCP.onStreamRead (node:internal/stream_base_commons:216:20)
```

`ECONNRESET` means the dev proxy opened a socket to `localhost:3001` and the API
closed it without answering. Signing in does not call that route - only the
instructor **Sandbox** card does - so this is a leftover request (a compile that
was still running) meeting a backend that was not there:

1. the API process had exited. A dropped database connection with no `error`
   listener is an unhandled event, and Node exits; `node --watch` restarts it on
   the next file change, which is why "it works the second time";
2. `/api/exec/smoke` takes 10-20 s (a real call to onlinecompiler.io), so any
   restart during it cuts the request mid-flight.

What changed in the code: the pg pool now has an `error` listener and one retry,
so a lost connection no longer kills the API; and the dev proxy prints one line
with the target and the backend command, then answers the browser with a JSON
`502 API_UNREACHABLE` instead of dying silently.

If you still see it, the backend is simply not up:

```bash
cd backend && npm run db:check && npm run dev     # expect: Nyaywala API on http://localhost:3001
```

then press **Compile & run** again. When the API runs on the Windows side of WSL,
point the proxy at it instead of fighting the boundary:

```bash
VITE_API_PROXY_TARGET=http://$(hostname).local:3001 npm run dev
```

### 10.3 `[ETIMEDOUT]` / `503 DB_UNAVAILABLE` on one request, fine on the next

```
[error:prisma] 93f37860-... [ETIMEDOUT] Invalid `prisma.user.findUnique()` invocation:
[2026-11-02T19:27:02.236Z] INFO POST /api/courses/join -> 503 832ms
```

`ETIMEDOUT` is the socket, not the SQL: the connection to the pooled host never
completed, so no query ran and nothing is wrong with the route or the data. It
is intermittent because the connection is re-established constantly - one
connection per idle gap, each paying DNS + TCP + TLS to a Neon region half a
world away, over WSL2's NAT.

Why the gaps turn into failures: the pool used to close idle connections after
30 s. Sign in, read a page, think for a minute, join a course - that join paid
for a brand-new handshake, and on a WSL2 link one of those handshakes lands on
a resolver or NAT mapping that has gone stale, which is the `ETIMEDOUT`. The
same reason made `npm run db:seed` fail on a cold clone with the blank
`Invalid prisma.user.upsert() invocation:` message.

What the code does now:

- connections stay open for **ten minutes** of idle time and use TCP keepalive,
  so an ordinary pause does not force a reconnect;
- a connect that fails *before* the statement is sent is retried **three times**
  with backoff (250 ms, 500 ms) on both `pool.query` and `pool.connect`, so one
  bad handshake is not a 503 and cannot duplicate a write;
- the first connection is opened at boot (`[db] pool warm after 1 attempt(s)`),
  so nobody's sign-in pays for it;
- the seed uses the same pool and prints the real cause instead of a blank line.

If `ETIMEDOUT` keeps happening, it is the path to Neon, not the app:

```bash
cd backend
npm run db:check          # DNS and TCP lines name the failing step
```

- `FAIL DNS` with `ETIMEDOUT`/`EAI_AGAIN`: WSL2's resolver. Add
  `[network]\ngenerateResolvConf = false` to `/etc/wsl.conf`, write
  `nameserver 1.1.1.1` into `/etc/resolv.conf`, then `wsl --shutdown` from Windows
  and reopen.
- `OK DNS`, `FAIL TCP`: a VPN, campus firewall or proxy is dropping 5432. Try
  another network, or move the database closer (pick the Neon region nearest
  you and re-create the project there - the URL changes with it).
- both `OK` but requests still stall for seconds: you are far from the region.
  Latency to the pooler is the whole cost of the first query; a closer region
  fixes it, and everything in the app is a single round trip away from being fast.
- `FAIL SCHEMA` after a successful login: `npm run db:deploy && npm run db:seed`.
