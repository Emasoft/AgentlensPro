---
trdd-id: 4LR2GTV2
title: Six mocha failures in serverCalibration and serverEndpoints predate the revive backoff
column: todo
status: tasked
created: 2026-09-25T06:12:29+0200
updated: 2026-09-25T06:12:29+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-25T06:12:29+0200
---

# Six mocha failures in serverCalibration and serverEndpoints predate the revive backoff

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-25T06:11:57+0200

Baseline check for the revive-backoff followup batch (TRDD-JJLI6GEH): the same 6 mocha tests fail identically at d5c90dfd (before the backoff commits c35e9db9 and a291075d) and at a291075d (after them) -- pre-existing, not a regression introduced by the backoff work. Ran `npx tsc -p tsconfig.test.json` then `npx mocha --no-config --require src/test/setup.js --ui tdd out/test/test/serverCalibration.test.js out/test/test/serverEndpoints.test.js` against a git-archive export of each commit (AGENTLENS_ALCORE pointed at the real alcore binary, since the export has no bin-native/). Failure names identical at both commits:
1. standalone server -- P5 window auto-calibration (real boot, real ingest path) > a rate-limit StopFailure through the ingest path writes observed capacity to burn-config.json
2. standalone server -- P5 window auto-calibration (real boot, real ingest path) > a second replay with LOWER consumption does not lower the observed capacity
3. standalone server -- P5 window auto-calibration (real boot, real ingest path) > a natural 5h window rollover does not calibrate
4. standalone server -- P5 window auto-calibration (real boot, real ingest path) > a non-rate-limit StopFailure does not calibrate
5. standalone server -- P5 window auto-calibration (real boot, real ingest path) > user-configured capacity is never overwritten by a later stall
6. standalone server -- hook/gate/burn endpoints (real boot) > SendMessage in the cold-resume window: a DEAD target denies, unknown liveness only warns (P6)

Measured at both commits (d5c90dfd and a291075d): 11 passing, 6 failing, same names, same AssertionError/ENOENT messages (only the random tmp-dir component of the path differs). Evidence: reports/JJLI6GEH/20260925_061945+0200-followup-batch.md.

Next action: root-cause and fix these 6 failures, or confirm they are environment-only (e.g. an ordering/cleanup issue between the two spec files) and document why they are expected to fail under this invocation shape.

## Approval log

- 2026-09-25T06:12:29+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
