---
trdd-id: T29F5MOZ
title: core_cap_guard fails on a literal SET threads=1 in the R36S0PS9 seed path
column: todo
status: tasked
created: 2026-10-23T07:52:13+0200
updated: 2026-10-23T07:52:13+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-23T07:52:13+0200
---

# core_cap_guard fails on a literal SET threads=1 in the R36S0PS9 seed path

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-23
- Symptom (peer-session report, not re-run here; the test location and the literal line were checked): cargo test -p agentlens-core fails core_cap_guard::no_literal_duckdb_threads_outside_the_allowlist (rust-core/crates/agentlens-core/tests/core_cap_guard.rs:188).
- Cause (peer's attribution to 2405b7b3, not checked): commit 2405b7b3 (TRDD-R36S0PS9) added a literal SET threads=1 at rust-core/crates/agentlens-store/src/lib.rs:1749. Reported by a peer session to fail identically on 7852efa6; the rest of the suite was 928 passed, 1 failed (peer report, not re-run here).
- NEXT ACTION: decide whether that SET threads=1 belongs on the guard's allowlist (with its reason) or should be removed or rewritten in whatever form the guard accepts (read core_cap_guard.rs first; not yet read); then make the test pass.
- Related: TRDD-R36S0PS9 (introduced it), TRDD-735Q3JF4 (where it was found).

## Approval log

- 2026-10-23T07:52:13+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
