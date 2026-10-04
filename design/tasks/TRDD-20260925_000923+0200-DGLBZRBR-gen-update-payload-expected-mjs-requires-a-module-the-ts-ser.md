---
trdd-id: DGLBZRBR
title: gen-update-payload-expected.mjs requires a module the TS server retirement removed
column: backburner
status: tasked
created: 2026-09-25T00:09:23+0200
updated: 2026-10-04T13:24:39+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-25T00:09:23+0200
---

# gen-update-payload-expected.mjs requires a module the TS server retirement removed

It fails with MODULE_NOT_FOUND out/test/updatePayload.js. src/updatePayload.ts was removed in 567fc5c2. update-payload-expected.json is now frozen, and the Rust test update_payload_derivations_reproduce_the_ts_oracle_exactly still passes against it.

Evidence: reports/cc-alignment/20260924_234354+0200-I9b2-main-verify.md, Step 1.

## Approval log

- 2026-09-25T00:09:23+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## STATE

Next action: decide whether to retire gen-update-payload-expected.mjs and treat update-payload-expected.json as a frozen golden file, documenting that in the Rust test's own comment/name rather than leaving a dead generator that fails on a fresh checkout. — 2026-09-25

## Notes

2026-10-04: generator retired (throws at top with the reason); Rust test comment says the oracle is frozen; update_payload_parity 1 passed.
