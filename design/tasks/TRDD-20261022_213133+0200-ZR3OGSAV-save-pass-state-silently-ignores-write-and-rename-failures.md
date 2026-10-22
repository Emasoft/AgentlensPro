---
trdd-id: ZR3OGSAV
title: save_pass_state silently ignores write and rename failures
column: todo
status: tasked
created: 2026-10-22T21:31:33+0200
updated: 2026-10-22T21:31:33+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-22T21:31:33+0200
---

# save_pass_state silently ignores write and rename failures

pass.rs save_pass_state (rust-core/crates/agentlens-store/src/pass.rs:101-111) discards both the fs::write error and the fs::rename result. A full disk or a permission error leaves the previous .pass-state.json in place with no log line, so skip and stranded names the pass just changed (including the TRDD-2HRA270Y step-1 pruning) are silently lost and the next pass acts on stale state. Fix: return a Result, and log it at both call sites (alcore bodies_pass and alstore pass), keeping the temp-and-rename atomicity. A stale .json.tmp left after a failed rename must also be removed or reported. Found while reviewing TRDD-2HRA270Y step 3 (docs_dev/20261022-step3-predesign.md). Test: point the state path at a read-only directory, run save, and assert the error is returned or logged.

## Approval log

- 2026-10-22T21:31:33+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
