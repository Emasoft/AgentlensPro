---
trdd-id: Q4ZMJD88
title: gen-seismicrun-expected.mjs output is not deterministic
column: todo
status: tasked
created: 2026-09-25T00:09:14+0200
updated: 2026-09-25T00:09:18+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-25T00:09:14+0200
---

# gen-seismicrun-expected.mjs output is not deterministic

Two back-to-back runs with no source change swap which synthetic session id (aaaaaaaa.../bbbbbbbb...) gets which cost and model values (54 diff lines, content not timestamps). This is despite the generator's header saying nothing depends on when it runs.

Suspected cause: an unstable iteration order or a tied ORDER BY, in the generator or src/burnSeismic.ts. Until fixed, the fixture cannot be safely regenerated and committed.

Evidence: reports/cc-alignment/20260924_234354+0200-I9b2-main-verify.md, Step 1b.

## Approval log

- 2026-09-25T00:09:14+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## STATE

Next action: find the unstable sort/iteration (tied ORDER BY or Map/object iteration order) in the generator or src/burnSeismic.ts that assigns synthetic session ids, make it deterministic (stable tiebreak), then regenerate and diff the fixture to confirm it stabilizes across two runs. — 2026-09-25
