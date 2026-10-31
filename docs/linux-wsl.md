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

## 3. Environment

```bash
cp backend/.env.example backend/.env
```

Fill in `DATABASE_URL`, `DIRECT_URL`, `ACCESS_TOKEN_SECRET`, `APP_ORIGIN` and
`ONLINECOMPILER_API_KEY`. See [credentials.md](credentials.md) for where each one
comes from.

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
