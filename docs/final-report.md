# Nyaywala — Final Project Report

**Rule-driven, reproducible grading for C programming assignments**

| Name | Roll number | Ownership |
|---|---|---|
| Ishan Mudghal | 2611A148 | Backend pipeline, validation, data model |
| Sayan Pal | 2611CS24 | Execution layer, analyzer pipeline |
| Ankit Sinha | 2611A102 | Provider verification, testing, reproducibility |
| Om Shankar | 2611A153 | Frontend surfaces, reports, delivery |

Repository: this project (`nyaywalaone`). Run instructions: [`README.md`](../README.md). Deeper
technical record: [`docs/report.md`](report.md).

---

## 1. Project Overview and Objective

Marking a C programming assignment by hand has three problems: the rubric lives in a tutor's
head, the mark cannot be re-derived by anyone else, and the feedback costs more time than the
mark. Nyaywala makes all three explicit.

An instructor publishes a rubric as **data** — an ordered list of weighted metrics with
parameters, versioned and frozen by hash. A student uploads a `.c` file. The platform compiles
and runs it in a remote sandbox, applies the rubric, and returns a report that explains every
mark: the failing input, the expected output, the evidence behind each metric, and the hash
that proves the run.

The claim the project is built around is narrow and checkable:

> The same submission, graded under the same rubric on the same toolchain, always produces the
> same grade — and a third party can recompute that grade without access to the grading
> infrastructure.

Everything else in the system (the queue, the instructor workspace, similarity review, the
student report) exists to make that claim usable for a whole cohort.

**Final state: complete.** All planned modules are implemented and verified; two items remain
outside the codebase — a public deployment and the recorded demonstration — and are listed as
such in section 8 rather than claimed.

---

## 2. Technical Architecture

| Layer | Choice | Why |
|---|---|---|
| Frontend | React 19, Vite 6, Tailwind 4, TanStack Query | Role-separated SPA; the report is data-heavy and client-rendered; no SSR requirement |
| API | Express 4, Zod at every boundary | Small surface (~60 routes), no framework conventions needed |
| Data | PostgreSQL (Neon) + Prisma 7 via the `pg` driver adapter | The shape is relational (courses → assignments → tests → evaluations → metrics) and SQL constraints are part of correctness |
| Transport | `tcp` (5432) or `https` (Neon serverless driver over 443), chosen by `DATABASE_TRANSPORT`, with an automatic boot-time fallback | Campus and hostel networks block one route or the other; the application should not care which |
| Execution | Provider abstraction: onlinecompiler.io (gcc 15), Judge0, Wandbox | The sandbox is a dependency, not a platform; the fingerprint of whichever answered is recorded |
| Analysis | tree-sitter C, MinHash similarity, optional Groq review (advisory only) | Static analysis is free and deterministic; the LLM is never allowed to move a mark |
| Jobs | Postgres queue with `FOR UPDATE SKIP LOCKED` + a drain endpoint/cron | The database already exists; a broker would be a second system to keep alive |

**Request path for one submission**

1. Upload gates: extension, size, control characters, late policy, per-student daily ceiling.
2. `POST /api/submissions` writes `Submission` + `Evaluation` (`QUEUED`) and a content-addressed
   `evaluation_key`; the response returns immediately with an id to poll.
3. The queue claims the row, compiles it (the compile gate), runs the assignment's test cases,
   then the static analyzers in bounded parallel.
4. Scoring is integer hundredths — `round(Σ score × weight × 100)`, clamped 0–10000 — so no
   float ever reaches the database.
5. The report renders, its hash is stored, and the student's page stops polling a named stage
   (`queued → compiling → testing → analyzing → done | failed`).

---

## 3. Module Status

| Module | Status | Where it lives |
|---|---|---|
| Accounts, roles, sessions, courses, join codes | Complete | `backend/src/auth/`, `backend/src/routes/` |
| Instructor workspace (assignments, test cases, rule sets) | Complete | `frontend/src/pages/instructor/` |
| Rule model: weights sum to 1.00, versioned publish, canonical hash | Complete | `backend/src/grading/rules.js`, `docs/rules-reference.md` |
| Grading coordinator, compile gate, ten analyzers | Complete | `backend/src/grading/` |
| Execution providers + failure taxonomy | Complete | `backend/src/execution/`, `docs/execution-notes.md` |
| Report renderer, hashes, recomputation (`verify-report`) | Complete | `backend/src/report/`, `backend/scripts/verify-report.js` |
| Queue, retries, stale-claim recovery, budget accounting | Complete | `backend/src/services/queue.js`, `docs/cost.md` |
| Student experience: submit, live stages, actionable report | Complete | `frontend/src/pages/student/` |
| Cohort view, filters, exports, similarity review | Complete | `frontend/src/pages/instructor/` |
| Determinism harness (18 submissions × 3 rule sets × 5 repeats) | Complete | `backend/tests/golden/`, `docs/samples/golden-corpus.csv` |
| Test suites, E2E, CI workflow | Complete | `backend/tests/`, `e2e/`, `.github/workflows/ci.yml` |
| Public deployment, recorded demo | Outstanding (see §8) | `docs/vercel.md` |

---

## 4. Work Completed

### 4.1 Frontend

- A themed application shell with role-aware navigation, light and dark themes, and responsive
  layouts down to 360 px.
- Landing, sign-in, registration, and a dashboard per role that answers "what needs doing now".
- Submission flow with a real editor, named grading stages instead of an indefinite spinner,
  and inline validation for the file gates.
- A report page that leads with the mark, then the failing case, then per-metric evidence and
  the hash, with release rules respected (a student cannot see an unreleased grade).
- Instructor surfaces: assignments, test cases, a rules editor generated from each analyzer's
  `paramsSchema`, cohort filters and CSV export, and similarity review.
- Product copy and labels written in terms of the product rather than the development schedule;
  no build-internal markers appear anywhere in the UI.

### 4.2 Backend and data

- Prisma 7 (Rust-free) with a driver adapter, two migrations, and a seed that prints its own
  demo credentials.
- ~60 routes with Zod validation, one error envelope, and a readiness endpoint that names the
  failing dependency rather than returning a bare 503.
- Auth with bcrypt cost 12, constant-time failure paths, refresh-token rotation with reuse
  detection, and role checks enforced server-side.
- A queue that survives crashes: an atomic claim, a 15-minute stale-claim window, three
  attempts, then `FAILED` with the reason recorded.
- Budget accounting per provider and per UTC day, plus a per-student daily submission ceiling,
  so a cohort cannot exhaust the sandbox key unattended.

### 4.3 Grading and execution

- Ten analyzers, each producing its own evidence; compile-gate ordering so one syntax error does
  not cost ten metrics.
- `on_unavailable` policy (`renormalize` or `zero`) chosen by the instructor, never a silent
  fallback.
- Provider abstraction verified against a live sandbox, with the failure taxonomy exercised
  (compile error, TLE, segfault, SIGFPE, fork bomb, MLE, ASan) and recorded in
  `docs/execution-notes.md`.
- A cost model measured, not estimated: `docs/cost.md` shows three graded submissions and the
  call count each produced.

### 4.4 Reproducibility and operations

- `npm run golden` replays 90 cells × 5 repeats and fails on any hash drift.
- `npm run verify-report <id>` recomputes a stored grade with no sandbox call.
- CI runs unit, integration and the golden summary on every push that touches grading.
- `npm run db:check` walks environment → DNS → port reachability → login → schema → data and
  prints the fix for the first failing step, without ever printing a password. It now also
  probes the WebSocket upgrade that the HTTPS transport needs, because "TLS on 443 works" and
  "the driver can connect" are different facts.
- The API records unhandled rejections and uncaught exceptions and keeps serving, so a dropped
  database socket is one logged error instead of a dead process behind the Vite proxy.

---

## 5. Verification and Results

| Check | Command | Result |
|---|---|---|
| Unit tests | `npm run test:unit` | 47 pass, 0 fail |
| Integration tests (real database) | `npm run test:integration` | 29 pass, 0 fail |
| Full suite | `npm test` | 76 pass, 0 fail, 0 cancelled |
| Determinism harness | `npm run golden` | 270 / 270 runs match their baseline grade and hash |
| Report recomputation | `npm run verify-report <id>` | `PASS: the report recomputes to the stored hash.` |
| E2E (2 role journeys, 2 themes, 3 accessibility/responsive) | `cd e2e && npm test` | 8 pass, 0 fail |
| Production build | `cd frontend && npm run build` | succeeds |
| Database path | `cd backend && npm run db:check` | all checks OK |

The determinism result is the one that matters: 270 sandbox runs of 18 submissions under 3 rule
sets produced identical grades and identical report hashes on every repeat. Details and the full
table: [`docs/reproducibility.md`](reproducibility.md) and
[`docs/samples/golden-corpus.csv`](samples/golden-corpus.csv).

---

## 6. Team Work Allocation

| Member | Primary responsibility | Delivered |
|---|---|---|
| Ishan Mudghal (2611A148) | Backend pipeline and validation | Route layer and error envelope, submission gates, report assembly, hashing and `verify-report`, security checklist |
| Sayan Pal (2611CS24) | Execution and analyzer pipeline | Provider seam and adapters, compile gate, ten analyzers, similarity, queue drain and retries |
| Ankit Sinha (2611A102) | Provider verification and testing | Live sandbox verification, failure taxonomy, unit/integration suites, golden harness, CI workflow |
| Om Shankar (2611A153) | Frontend and delivery | Application shell, student and instructor surfaces, report design, demo scripts, README and run guides |

Work overlapped deliberately at the seams (rule model, scoring, report contract); each seam was
reviewed by the member who did not write it.

---

## 7. Setup and Access

The full procedure is in [`README.md`](../README.md) (Linux/WSL, then Windows). The short form:

```bash
cd backend && npm install
cp .env.example .env      # DATABASE_URL, DIRECT_URL, ACCESS_TOKEN_SECRET
npm run db:check          # names the failing layer if anything is wrong
npm run db:deploy && npm run db:seed
npm run dev               # API on :3001
```

```bash
cd frontend && npm install && npm run dev    # app on :5173, /api proxied to :3001
```

Demo data from the seed: instructor `prof@example.edu`, students `student1..8@example.edu`,
password `Passw0rd-Demo-2026`, course **CS 101 - Programming in C**, join code `ADDC2026`.

---

## 8. Risk Assessment

| Risk | Likelihood | Impact | Mitigation in place |
|---|---|---|---|
| Campus/hostel network blocks outbound 5432 or the WebSocket upgrade on 443 | High | App cannot reach the database | `DATABASE_TRANSPORT` selects the route, `db:check` names the blocked layer, and boot falls back to the other transport automatically |
| Sandbox provider outage, quota exhaustion, or a changed API | Medium | Execution metrics become `unavailable` | Provider seam with two fallbacks, per-day budget accounting, `unavailable` instead of a guessed grade, `on_unavailable` policy in the rubric |
| Grading changes silently alter an old grade | Medium | Marks become indefensible | Rubric hash + toolchain fingerprint per evaluation; 270-run golden harness fails the build on drift |
| Process death mid-grade | Medium | A submission stalls | Atomic claims, stale-claim recovery after 15 minutes, three attempts, terminal `FAILED` with a reason |
| Unreleased marks visible to students | Low | Fairness complaint | Release rules enforced in the API, not only in the UI |
| LLM review drifting a mark | Low | Non-reproducible grade | `llm_review` is advisory and weighted `0.00` by default |

**Outstanding, outside the codebase**

- **Public deployment** — `docs/vercel.md` documents the deploy and the failures that occur
  doing it; no production URL is claimed here.
- **Recorded demonstration** — the demo scripts (`docs/demo-1.md` … `demo-4.md`) exist and were
  followed; the recording itself is not part of the repository.

---

## 9. Known Limitations and Future Scope

- **Order of growth is estimated, not measured.** The metric reports `mode: "static"` from loop
  nesting and recursion; an empirical timing curve needs an input-size contract the problem model
  does not have. The report says so instead of printing a fabricated table.
- **One language.** The analyzer set is written for C; the rule model is language-agnostic but
  the analyzers are not.
- **Similarity is corpus-relative.** MinHash over 7-token shingles catches close copies, not
  translated or restructured ones.
- **Single-cohort scale.** Measured at cohort size with a sandbox budget; no claim beyond that.
- **Demo-only extras.** Seeded accounts and the join code are local conveniences, not a product
  feature.
- Natural next steps: an instructor-facing weight simulator (preview a rubric against past
  submissions), a second language behind the same analyzer interface, and a hosted queue worker
  separate from the API process.

---

## 10. Conclusion

Nyaywala meets its stated objective. A rubric is data, versioned and hashed; a grade is
reproducible and re-derivable by a third party; and the feedback explains itself. The system
handles the failure modes that actually appear in a lab course — a blocked port, a sandbox
outage, a process that dies mid-grade, a student who submits the same file twice — as named,
recorded outcomes rather than silent exceptions.

Every claim in section 5 was produced by a command in this repository. The two items that are
not finished are stated as unfinished rather than deferred silently.
