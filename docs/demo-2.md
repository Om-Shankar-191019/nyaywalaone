# Demo 2 - the grading engine (Week 2)

**Under eight minutes. Lead with the requirement it proves: five analyzers, a
weighted score from a file the instructor owns, one reproducible grade.**

## Before you start

```bash
cd backend && npm start          # API + database
cd frontend && npm run dev       # web app
```

Signed in as `student1@example.edu` (password `Passw0rd-Demo-2026`), course
`CS 101 - Programming in C`, join code `ADDC2026`, assignment *Sum of two
integers* (published, rule set v1, three test cases and a reference solution).

## The script

| # | Do this | Say this | Artefact to point at |
|---|---|---|---|
| 1 | Open the assignment, paste `backend/tests/golden/corpus/01-correct.c`, press **Submit and grade** | "The run is queued, then compiled, then tested - the student watches named stages, not a spinner." | the stage tracker |
| 2 | Wait for **Report ready**, open the report | "Ten metrics, weighted by a file the instructor owns. Each one carries its own evidence." | the metric table |
| 3 | Scroll to the failing/generated cases | "For a wrong answer we show the input, the expected output and what was produced - not just a number." | the case panel |
| 4 | Press **JSON** and walk the envelope | "`rules_hash`, `testset_hash`, `toolchain_hash`, `grader_version`, `report_hash` - the grade is a function of these five, and nothing else." | the JSON download |
| 5 | Submit the same file again | "Same evaluation key, so the stored report is returned instead of re-run. Same hash, same grade." | two identical `report_hash` values |
| 6 | Submit `07-infinite-loop.c` from the corpus | "The gate catches it: `suspected_infinite_loop`, execution analyzers are skipped, the report says so instead of pretending." | the flag and the partial report |

## What must be true when you finish

- [ ] A submission reaches `graded` without a manual refresh.
- [ ] The report shows a metric-by-metric breakdown with integer contributions.
- [ ] Two runs of the same file print the same `report_hash`.
- [ ] The infinite-loop submission produces a report, not a hang or a 500.

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `PROVIDER_BUDGET_EXCEEDED` (429) | the day's sandbox calls are spent | raise `EXEC_DAILY_BUDGET`, or wait for 00:00 UTC |
| every execution metric is `unavailable` | the sandbox key is wrong or empty | `GET /api/health/ready` names the failing check |
| the report says *limits not enforced* | the provider cannot enforce them | that is the honest answer; see `docs/execution-notes.md` |
| grading stays `queued` | the API restarted mid-run | `POST /api/internal/drain` with `X-Cron-Secret`, or re-submit |
