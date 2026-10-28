---
trdd-id: FINMFYDE
title: load_pass_state reads an unreadable or corrupt state file as empty
column: todo
status: tasked
created: 2026-10-29T00:39:49+0100
updated: 2026-10-29T00:39:54+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-29T00:39:49+0100
priority: high
labels: [store, durability]
---

# load_pass_state reads an unreadable or corrupt state file as empty

Found by the review of commit 79723010 (TRDD-ZR3OGSAV). rust-core/crates/agentlens-store/src/pass.rs load_pass_state (pass.rs:84) returns plain (skip, stranded) sets and treats an unreadable or corrupt .pass-state.json as empty, which means "nothing stranded, nothing skipped". Sharpest consequence: alstore unpark (pass.rs unpark_names, pass.rs:773) loads those empty sets and, if the save then succeeds, overwrites the real state file with almost-empty sets, silently destroying every persisted skip and stranded name. The alcore bodies pass (chores.rs:633 calls load_pass_state every tick) also reloads the file each tick, so a corrupt file resets its bookkeeping. Deletion stays safe: the delete gate re-verifies content against the store (pass.rs:562 and 585-587) and does not trust the name sets. Direction: load_pass_state returns io::Result and distinguishes absent (empty is correct) from present but unreadable or corrupt (an error). unpark refuses to save over a state it could not read. The bodies pass logs and skips the save that tick. Acceptance: tests for absent gives empty, corrupt gives Err, and unpark on a corrupt file leaves it byte-identical and exits non-zero; mutation-checked.

## Approval log

- 2026-10-29T00:39:49+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
