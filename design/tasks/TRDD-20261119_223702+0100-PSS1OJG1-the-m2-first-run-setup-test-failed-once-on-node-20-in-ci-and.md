---
trdd-id: PSS1OJG1
title: The M2 first-run setup test failed once on node 20 in CI and passed on the next run with no change to its code path
column: todo
status: tasked
created: 2026-11-19T22:37:02+0100
updated: 2026-11-19T22:39:53+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T22:37:02+0100
---

# The M2 first-run setup test failed once on node 20 in CI and passed on the next run with no change to its code path

## Approval log

- 2026-11-19T22:37:02+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Problem

- CI run 44604988809 (f9d5dc47), job build-and-test (20): the (M2) test in src/test/autoSetup.test.ts failed at out/test/test/autoSetup.test.js:1232 with 'control: the full setup ran under the switch: agentlenspro: first-run setup failed — run agentlenspro setup to see why' (free.skills false: the real first-run setup failed in the control run). Saved log: reports_dev/HSPUF5XH/20261119-ci-fix2/job-node20-full.log lines 6356-6371.
- CI run 44613423007 (4aee03be), same job: M2 passed in 30657 ms; node 22 passed in both runs. The commits between them sorted a bodies listing (no setup path) and changed only the failure notice text, so the cause is not fixed, only not reproduced. The test passes locally on node 20.20.2 (33 s).

## Next action

- On the next red M2: the notice now names the failing setup step ('first-run setup failed at <step>: <detail>', c92d5bdc), so read that step from the assertion message and start from there. Until then the cause is unknown; candidates not checked: a setup step racing the runner's load, a free-port race, node-20-specific timing. Not a 2.34.0 release blocker: one failure in two runs, and CI on the release HEAD is green.
