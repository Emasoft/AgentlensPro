---
trdd-id: 3LKN70Y4
title: Six mocha failures from the load-113 whole-suite run need re-running alone to classify
column: superseded
created: 2026-09-06T02:11:03+0200
updated: 2026-09-24T08:57:21+0200
current-owner: main-session
task-type: bugfix
priority: medium
min-approval-requirement: none
scope: project
project-id: agentlenspro
related: [B7DSTJLS, 82ADFE5D]
relevant-files: [src/test/serverCalibration.test.ts, src/test/cacheBreakTimeline.test.ts]
labels: [tests, flake-or-regression]
superseded-by: [CS2W7E77]
---

# Six mocha failures from the load-113 whole-suite run need re-running alone to classify

The `npx mocha out/test/test/cacheBreakTimeline.test.js` launched for TRDD-B7DSTJLS at 21:45 ran the
WHOLE compiled suite (the mocharc spec globs plus the named file) for 46 min while two cargo
release builds and an isolated alcore ran beside it (load average 113–115). Result:
2,653 passing / 7 failing / 11 pending (`reports_dev/b7dstjls-whole-file-20260905_214506+0200.txt`,
`MOCHA_EXIT=7`). One failure has its own card (TRDD-82ADFE5D). The other six:

| # | test | error |
|---|---|---|
| 1 | `cacheBreakTimeline — buildCauseCostPeakReport (cross-session cause cost-peak)` | `Timeout of 120000ms exceeded` — B7DSTJLS's own file |
| 3–7 | `standalone server — P5 window auto-calibration` (`serverCalibration.test.ts`), five tests | one symptom: the spawned server ingested nothing — `store holds 0 span(s) across 0 segment(s)` (#3), so calibration never wrote `burn-config.json`, producing four downstream `ENOENT … <test HOME>/.agentlens/burn-config.json` (#4–7) |

The five `serverCalibration` rows are not five independent defects — #4–7 are consequences of the
one empty-ingest symptom in #3. That symptom is consistent with the spawned server not finishing
boot inside the test's wait window under load 113, or a port/pidfile collision (INFERRED — the
test's ports are not known from this run). None of this is classified yet: a 120 s timeout and a
server that never ingested a span are exactly what a saturated machine produces, AND exactly what a
regression in the served binary produces. The run cannot tell them apart.

## NEXT ACTION

At load < 5: `npx mocha out/test/test/serverCalibration.test.js` alone, then
`npx mocha out/test/test/cacheBreakTimeline.test.js --grep buildCauseCostPeakReport` alone, each
captured to a file with `MOCHA_EXIT`. Green ⇒ record "load artefact" here and close. Red ⇒ read the
failure in full, open one bugfix card per distinct cause (the four ENOENTs + one assertion are one
cause, not four), and note whether `serverCalibration` spawns the TS server or alcore (its empty
ingest would then be a calibration regression in that binary).
B7DSTJLS's NEXT ACTION (whole-file run) is satisfied only by the second re-run.

## Acceptance

- [ ] Each of the six is classified as load artefact or regression from a low-load solo run,
      with the capture path.
- [ ] Regressions have their own cards; artefacts are recorded here and this card closes.

## Notes and lessons learned

## Approval log

- 2026-09-06T02:11:03+0200 — Authored into `todo` (Tier 0) from the measured run.
- 2026-09-24T08:57:21+0200 — SUPERSEDED by main-session. Fully absorbed by TRDD-CS2W7E77 (P5 rows) and TRDD-82ADFE5D (rustSummarize timeout row, created together in commit a781ce0d); its one distinguishing fact (3-vs-6 run-order question) already tracked as B7DSTJLS's open acceptance box 3 (reports/board-triage/20260924_085116+0200-cluster-test-hygiene.md).
