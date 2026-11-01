# Demo 4 - reproducibility, deployment, deliverables (Week 4)

**Under eight minutes. Lead with the claim the whole project rests on: the same
input gives the same grade, and here is the evidence.**

## Before you start

```bash
cd backend && npm start            # API + database
cd frontend && npm run dev         # web app
```

Have the deployed URL, the golden-corpus CSV and the report PDF open in tabs
before you start, so no minute is spent hunting for a file.

## The script

| # | Do this | Say this | Artefact to point at |
|---|---|---|---|
| 1 | Open the deployed URL, sign in as both roles, submit one submission | "Same code, no local services: the API, the database and the sandbox are all remote." | the public URL and the graded report |
| 2 | Show `docs/samples/golden-corpus.csv` | "18 submissions, three rule sets, five repeats: 270 runs, one hash per cell." | the table, the `matches_baseline` column |
| 3 | Run `node scripts/verify-report.js <evaluationId>` | "Anyone can check a stored grade without a sandbox call: it recomputes and compares." | `PASS: the report recomputes to the stored hash.` |
| 4 | Show the CI run | "Unit, integration and the golden harness are gated on every push that touches grading." | the green workflow |
| 5 | Show the queue: **Grade all** in the cohort table | "Batch grading is a queue claimed with `FOR UPDATE SKIP LOCKED`, drained by cron one row at a time, at the provider's rate." | the progress counters moving |
| 6 | Open the report and the video | "Report and video are the deliverables: the same numbers you just saw, written down." | the PDF and the YouTube link |

## The numbers to quote (fill from your own run)

| Claim | Where it comes from |
|---|---|
| 270/270 identical hashes | `docs/samples/golden-corpus.csv` |
| provider calls per cold submission | `docs/cost.md` |
| drain wall time for a cohort | `docs/samples/load-check.json` |
| test suite: 76 tests, 0 failures | `npm test` |
| E2E: two role journeys | `e2e/` |

## What must be true when you finish

- [ ] The deployed URL completes the full flow with no local service running.
- [ ] Every golden cell produced the same hash on every repeat.
- [ ] `verify-report` reports PASS on a stored evaluation.
- [ ] The demo runs twice in a row with no manual database edits.

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| the deployed app 503s with `DB_SCHEMA_OUT_OF_DATE` | migrations were not applied | `npm run db:deploy` against the production direct URL |
| login works then immediately logs out | `Secure` cookies over plain HTTP | use the HTTPS URL |
| the golden CSV shows a DRIFT row | a grading change is non-deterministic | that is the harness doing its job: fix before shipping |
| cron never drains | `CRON_SECRET` unset, so the route 404s | set it and redeploy |
