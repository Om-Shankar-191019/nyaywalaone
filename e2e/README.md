# End-to-end journeys (Day 25)

Two real browsers journeys plus a theme and accessibility pass, driven by
Playwright against a **running stack**. They are not started by Playwright,
because the browser is only useful once the database, the API and the sandbox key
are all up.

## What is proved

| Spec | Proves |
|---|---|
| `tests/instructor.spec.js` | An instructor reaches the instructor area, sees the rule set that produced the cohort's marks, sees the batch queue and progress counters, exports the cohort CSV, and reaches similarity review. A student typed into `/instructor` is turned away. |
| `tests/student.spec.js` | A student uploads a real `.c` file, submits, watches grading finish, opens the report, sees the grade, the metric table and the `report_hash`, and downloads the text report. |
| `tests/theme-and-a11y.spec.js` | Light and dark survive a hard reload (the inline `index.html` script), the sign-in page and student dashboard have no critical axe-core violations, and the app does not overflow a 360 px viewport. |

## Run it

```bash
# 1. a seeded database, API and web app (two terminals)
cd backend  && npm start          # http://localhost:3001
cd frontend && npm run dev        # http://127.0.0.1:5173

# 2. once
cd e2e && npm install && npx playwright install chromium

# 3. run
cd e2e && npm test
```

Against a deployed preview:

```bash
cd e2e
E2E_BASE_URL=https://your-app.vercel.app \
E2E_INSTRUCTOR_EMAIL=prof@example.edu E2E_INSTRUCTOR_PASSWORD=... \
E2E_STUDENT_EMAIL=student1@example.edu E2E_STUDENT_PASSWORD=... \
npm test
```

The defaults are the seeded demo accounts (`prof@example.edu`,
`student1@example.edu`, password `Passw0rd-Demo-2026`). They are demo
credentials, not secrets, and they only exist in a seeded database.

## Why some assertions are API-shaped

The journeys assert the *file* the browser receives (CSV content type and header
row, text report content type and body) instead of only what is on screen. A page
that renders a link to a broken export is a passing screenshot and a failing
feature.

## Costs

The student journey submits one file, which spends a handful of sandbox calls
(see `docs/cost.md`). Nothing else in the suite touches the provider, so a run
costs about the same as one grading run. `workers: 1` is deliberate: two journeys
grading at once would double the call count for no extra coverage.
