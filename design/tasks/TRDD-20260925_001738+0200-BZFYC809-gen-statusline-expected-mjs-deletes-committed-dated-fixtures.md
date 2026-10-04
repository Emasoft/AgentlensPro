---
trdd-id: BZFYC809
title: gen-statusline-expected.mjs deletes committed dated fixtures when run on a later day
column: todo
status: tasked
created: 2026-09-25T00:17:38+0200
updated: 2026-10-04T13:24:37+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-25T00:17:38+0200
---

# gen-statusline-expected.mjs deletes committed dated fixtures on every run

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-25

Next action: pin the date the generator writes into statusline-tree/{main,subagent}/<date>/, or stop pruning committed paths.

Facts: it writes a statusline-tree/{main,subagent}/<today>/ directory and prunes an older one, so the working tree shows committed rust-core/crates/agentlens-core/tests/fixtures/statusline-tree/main/2026-08-20/*.parquet and *.ndjson as deleted. A `git add -u` or `commit -a` would delete committed fixtures.

Evidence: I9b2-main-verify.md, Step 1 table.
A second run on the same day deletes nothing new.

## Approval log

- 2026-09-25T00:17:38+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-10-04: gen-statusline-expected.mjs now pins Date.now and process.pid to the committed tree's values (2026-09-24, pid 6308). Main part and WAL regenerate byte-identical; the subagent part is renamed once (ms 779 to 695) because the committed one was sealed 84 ms later; stable on re-run. statusline_parity 3 passed.
