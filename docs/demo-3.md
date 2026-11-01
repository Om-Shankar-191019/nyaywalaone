# Demo 3 - the product surface (Week 3)

**Under eight minutes. Lead with the requirement: the rubric is data, and the
product closes the loop for both roles.**

## Before you start

Two browser profiles: instructor `prof@example.edu`, student
`student1@example.edu` (password `Passw0rd-Demo-2026`). The student has at least
one released submission; if not, release it in the cohort table first.

## The script

| # | Do this | Say this | Artefact to point at |
|---|---|---|---|
| 1 | As the instructor, open the assignment, **Rule set** tab | "This is the rubric. Metrics, thresholds and weights, edited here - no code change, no redeploy." | the metric cards with weights |
| 2 | Change `structure.max_cyclomatic` from 8 to 6, watch the weight total | "The total is enforced: publishing is blocked unless it is exactly 1.00." | the live total |
| 3 | Press publish | "It shows a diff against the active version before it freezes, and stores `rules_hash`." | the publish diff, v1 → v2 |
| 4 | Re-grade the cohort row | "A regrade keeps lineage: the previous evaluation is still there with its own hash." | the new grade and the reason |
| 5 | Switch to the student profile, reload the report | "The student sees the new weighting, the failing case, and a report they can act on - in either theme, on a phone." | the report at 360 px |
| 6 | As the instructor, **Similarity** tab, scan the cohort | "A flagged pair is a reason to look, never an accusation. Reviewing one records who looked and changes no grade." | similarity + review note |

## What must be true when you finish

- [ ] Publishing v2 changes the version, the hash and the grade, with a reason.
- [ ] The student view reflects the change without a redeploy.
- [ ] Reviewing a similarity match leaves `grade_hundredths` untouched.
- [ ] Both pages are readable at 360 px and in both themes.

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| publish is blocked with a weight error | the weights do not sum to 1.00 | the message names the metric; fix or use the raw JSON tab |
| the student sees "not released yet" | the grade was never released | **Release** in the cohort table |
| the diff view is empty | the draft equals the active version | change one threshold first |
| no similarity pairs | the cohort has one submission | submit a second, or lower the threshold |
