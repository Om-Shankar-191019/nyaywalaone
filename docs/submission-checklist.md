# Submission checklist (plan section 17)

Every box below is ticked only when there is an artefact a stranger can open. The
evidence column names that artefact; nothing here is ticked because the code
"looks done".

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Working app at a public URL, both roles usable | **Blocked: needs your Vercel + Neon accounts** | `docs/vercel.md` is the walkthrough; `/api/health/ready` is the one call that proves a deployment |
| 2 | GitHub repo with README, install guide, `.gitignore`, no secrets in history | **Ready** | `README.md` (Quick start, env table), `.gitignore`, `git log -p` grep in section 3 below |
| 3 | At least two example rule sets, editable in the UI and stored as files | **Done** | `docs/rule-sets/default.json`, `docs/rule-sets/llm-assisted.json`; the Rule set tab renders both |
| 4 | Sample submissions graded, JSON and text reports committed | **Done** | `docs/samples/add.report.json`, `docs/samples/add.report.txt` |
| 5 | Golden corpus and the 270-run result table | **Done** | `backend/tests/golden/`, `docs/samples/golden-corpus.csv`, `docs/reproducibility.md` |
| 6 | Report with objective, design, analyzers, complexity method, coordination, reproducibility, results, 4 usefulness + 4 limitations with a wrong-verdict case each | **Done** | `docs/report.md` |
| 7 | Workload distribution and timeline in the report | **Done** | `docs/report.md` section 9, `docs/task-board.md` |
| 8 | 15-20 minute video, unlisted, link verified | **Blocked: recording is yours to do** | `docs/report.md` section 10 is the shot list |
| 9 | Weekly evaluation artefacts (four demo notes) | **Done** | `docs/demo-1.md`, `docs/demo-2.md`, `docs/demo-3.md`, `docs/demo-4.md` |
| 10 | `docs/decisions.md` with the ADRs that defend the stack | **Done** | six ADRs, each with the rejected alternative |

## What is still yours

1. **Deploy** — Vercel project, the env table in `CREDENTIALS-NEEDED.md` section 8,
   `npm run db:deploy` against the production direct URL, then one full flow on a
   phone hotspot. This cannot be done from inside the repo: it needs your accounts.
2. **Record the video** — the shot list and timings are in `docs/report.md`.
3. **Tag the release** — `git tag v1.0.0` after the deploy succeeds.

## 1. Commands that prove the local claim

```bash
cd backend
npm test                 # unit + integration
npm run golden           # 270 runs, identical hashes
node scripts/verify-report.js <evaluationId>
npm run load-check -- --count=8

cd ../e2e
npm test                 # two role journeys, theme, accessibility
```

## 2. Secrets that must never be in the repo

`DATABASE_URL`, `DIRECT_URL`, `ACCESS_TOKEN_SECRET`, `ONLINECOMPILER_API_KEY`,
`JUDGE0_API_KEY`, `GROQ_API_KEY`, `CRON_SECRET`. Only `backend/.env.example` is
tracked, with empty values.

## 3. Proving no secret reached git history

```bash
git log -p | grep -nE "postgresql://[a-z]+:[^@]+@|sk-[A-Za-z0-9]{10,}|gsk_[A-Za-z0-9]{10,}" | head
git ls-files | grep -E "^\.env$|/\.env$|\.env\." | grep -v example
```

Both must print nothing. The second one is the check that `.env` itself was never
committed, which `.gitignore` alone cannot prove.

## 4. Fresh-clone test (plan Day 28)

```bash
git clone <repo> /tmp/nyaywala-fresh && cd /tmp/nyaywala-fresh
cd backend && cp .env.example .env      # fill the four required values
npm install && npx prisma migrate deploy && npm run db:seed
npm start
# second terminal
cd frontend && npm install && npm run dev
```

Then grade one submission from the browser. If a step needs a sentence that is
not in the README, the README is wrong, not the reader.
