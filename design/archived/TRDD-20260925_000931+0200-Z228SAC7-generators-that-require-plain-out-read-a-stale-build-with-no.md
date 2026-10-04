---
trdd-id: Z228SAC7
title: Generators that require plain out/ read a stale build with no script to refresh it
column: complete
status: archived
created: 2026-09-25T00:09:31+0200
updated: 2026-10-04T13:58:23+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-25T00:09:31+0200
implementation-commits: [20bdbd3e]
---

# Generators that require plain out/ read a stale build with no script to refresh it

gen-burnscan-expected.mjs requires ../out/burnInvestigator.js, the plain out/ tree from tsconfig.json. compile-tests only builds out/test/, check-types emits nothing, and no npm script rebuilds out/, which was last built 2026-09-22. A regeneration therefore read pre-fbaae7d0 code and produced false fixture drift.

Evidence: reports/cc-alignment/20260924_234354+0200-I9b2-main-verify.md, "Correction" section.

## Approval log

- 2026-09-25T00:09:31+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-04T13:58:23+0200 — COMPLETE by main-agent@agentlenspro. Owner directive 2026-10-04 "complete all TRDDs!". 20bdbd3e; checks run by the main agent: clippy -D warnings exit 0; burnscan_parity 9, statusline_parity 3, update_payload_parity 1 passed; the burnscan generator re-run left the fixtures unchanged.

## STATE

Next action: list every generator under rust-core/crates/agentlens-core/tests/fixtures/ that requires ../out/ rather than ../out/test/, then either repoint each to the compiled test output or add one npm script that builds plain out/ before fixture regeneration. — 2026-09-25

## Notes and lessons learned

2026-10-04: this card also carries box 3 of the closed TRDD-MF4YQWWA: after the generator runs again, regenerate the burnscan expected fixture and require a zero diff and burnscan_parity passing.
2026-10-04: gen-burnscan-expected.mjs repointed to out/test/burnInvestigator.js (the only generator importing plain out/; all others already use out/test/). compile-tests + regeneration: zero diff on every expected fixture; burnscan_parity 9 passed. Box 3 of TRDD-MF4YQWWA satisfied.

## Acceptance

- [x] Every generator imports the compiled test output (out/test/) instead of plain out/; gen-burnscan-expected regenerates with zero fixture diff and burnscan_parity passes 9 of 9 (20bdbd3e); checklist written from the card's own text at close time, 2026-10-04.
