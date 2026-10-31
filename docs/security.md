# Security checklist — Day 21

Every row names the control, the command that checks it, and what this deployment
actually does. A tick means the command was run and passed on 31 October 2026.

Run the whole suite from `backend/` and `frontend/` respectively.

## Transport and headers

| Control | Where | Check | Status |
|---|---|---|---|
| Security headers | `helmet()` in [app.js](../backend/app.js) | `curl -sI http://localhost:3001/api/health \| grep -i -E 'x-content-type\|strict-transport\|x-frame'` | ✅ present |
| CORS allowlist (no `*`) | `config.allowedOrigins` | `curl -sI -H 'Origin: https://evil.example' http://localhost:3001/api/health \| grep -i access-control-allow-origin` → no header | ✅ absent |
| `X-Powered-By` removed | `app.disable('x-powered-by')` | `curl -sI http://localhost:3001/api/health \| grep -i x-powered-by` → empty | ✅ |
| Body size ceiling | `express.json({ limit: '256kb' })` | `curl -s -X POST -H 'Content-Type: application/json' --data-binary @big.json …` → `413` | ✅ |
| Absurd nesting rejected | `jsonShapeGuard` in [guards.js](../backend/src/lib/guards.js) | `npm run test:unit -- --test-name-pattern 'request shape'` | ✅ |

## Authentication and sessions

| Control | Where | Check | Status |
|---|---|---|---|
| Access token 15 min, refresh 7 days | `src/auth/jwt.js` | inspect `exp` of a decoded token | ✅ |
| Refresh token stored as SHA-256, path-scoped, `HttpOnly` | `src/auth/cookies.js` | DevTools → Application → Cookies | ✅ |
| Refresh reuse revokes every session | `src/auth/sessions.js` | `npm test -- tests/integration/auth.test.js` | ✅ |
| bcrypt cost 12, constant-time failure path | `src/auth/password.js` | `grep -n 'cost\|burnPasswordTime' src/auth/password.js` | ✅ |
| Login/register limited to 5/min | `src/routes/auth.js` | `for i in $(seq 6); do curl -s -o /dev/null -w '%{http_code} ' -X POST … ; done` → `401 … 429` | ✅ |
| Role is re-read from the database, never trusted from the token | `requireAuth` in `src/auth/middleware.js` | `tests/integration/rbac.test.js` | ✅ |

## Authorisation

| Control | Where | Check | Status |
|---|---|---|---|
| Every instructor route checks course ownership | `requireCourseOwner` | `tests/integration/rbac.test.js` covers each row of the matrix | ✅ |
| A student asking for another student's submission gets `404`, not `403` | `loadSubmissionForViewer` | manual: two accounts, swap the id | ✅ |
| Grades hidden until released | `canSeeReport` | manual: student view before and after release | ✅ |

## Cost and abuse controls

| Control | Where | Check | Status |
|---|---|---|---|
| Per-user submission limit, 10/hour | `submissionLimiter` in `src/routes/submissions.js` | `for i in $(seq 11); do … ; done` → last is `429` | ✅ |
| Daily sandbox budget, `429` before the call | `assertWithinBudget` in `src/execution/budget.js` | `curl /api/meta/usage` after exceeding `EXEC_DAILY_BUDGET` | ✅ |
| Source capped at 64 KB, one file, `.c` only | `createSubmissionRecord` | upload a 70 KB file → `400` | ✅ |
| Binary uploads rejected | `looksBinary` | upload a PNG renamed to `x.c` → `400` | ✅ |
| Queue drain requires a shared secret, 404s when unset | `POST /api/internal/drain` | `curl -X POST …/drain` with no header → `404` | ✅ |

## Secrets

| Control | Where | Check | Status |
|---|---|---|---|
| `.env` is git-ignored | [.gitignore](../.gitignore) | `git check-ignore -v backend/.env` | ✅ |
| No secret reaches the browser bundle | build output | `grep -rlo 'ONLINECOMPILER_API_KEY\|JUDGE0_API_KEY\|GROQ_API_KEY\|ACCESS_TOKEN_SECRET\|DATABASE_URL' frontend/dist/` → no match | ✅ |
| No token-shaped strings in the bundle | build output | `grep -rhoE '(gsk_\|sk-[A-Za-z0-9]{20,})' frontend/dist/` → no match | ✅ |
| Secrets are only read from the environment | `src/config.js` | `grep -rn 'process.env' src/` → only `config.js` and `sanitiseEnv` | ✅ |

## Dependencies

```
npm audit --omit=dev
```

**Result: 1 high advisory, in `zod` (< 4.6.6), "memory exhaustion while validating
oversized constrained collections".**

Not fixed by a patch bump: the only available fix is `zod@4`, a major version with
breaking changes to the schema API used throughout `src/grading/rules.js`. That
upgrade is tracked as Week 4 work rather than rushed at the end of Week 3.

Why the residual risk is accepted for now:

- the advisory needs an attacker-controlled *collection* with constraints, parsed
  in one call;
- every request body is capped at 256 KB by `express.json`, and `jsonShapeGuard`
  additionally rejects arrays over 200 items and nesting over 8 levels before any
  Zod schema sees the body;
- the largest constrained collection any schema accepts is the metric list in a
  rule set, which only an instructor can send.

Re-check with `npm audit --omit=dev` after the Week 4 upgrade.

## Known gaps, written down rather than discovered in the viva

1. **Rate limiters are per-process.** On Vercel each warm instance has its own
   `Map`; a cold start resets it. Blunts credential stuffing, does not stop a
   distributed attempt. ADR-004.
2. **No CSRF token.** Mutations are protected by the `Origin` check and by
   `SameSite` cookies rather than a token. Adequate for an allowlisted origin,
   weaker than a double-submit token.
3. **The similarity flag is advisory.** Nothing is auto-penalised, and the review
   note is the only record of a human decision.
4. **Wandbox has no limits and no timings.** A report produced with
   `EXECUTION_PROVIDER=wandbox` is not equivalent to one produced with
   onlinecompiler.io, and says so in `report.toolchain.provider`.
