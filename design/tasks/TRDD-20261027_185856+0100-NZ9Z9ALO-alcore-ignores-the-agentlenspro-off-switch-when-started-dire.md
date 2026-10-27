---
trdd-id: NZ9Z9ALO
title: alcore ignores the AgentlensPro off switch when started directly
column: todo
status: tasked
created: 2026-10-27T18:58:56+0100
updated: 2026-10-27T18:58:56+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-27T18:58:56+0100
---

# alcore ignores the AgentlensPro off switch when started directly

Premise verified 2026-10-27. The CLI honours the AgentlensPro off switch: src/cli/serverControl.ts line 297 refuses to start the server while the DISABLED switch file (~/.agentlens/DISABLED) exists. alcore itself never reads that file. Command run: grep -rn DISABLED rust-core/crates/agentlens-core/src. It returns 5 lines and none of them tests for the file: lib.rs:317 (a doc comment on the embed feature), cache_break_timeline.rs:185 and :1068 (CACHING_DISABLED), bin/alcore.rs:225 (a comment) and spool_tap.rs:482 (a log line). A case-insensitive grep returns 27 lines, none of which tests for a file named DISABLED. The comment at bin/alcore.rs:225 says the omission is deliberate: NO_REVIVE only, never the global DISABLED switch, because DISABLED is terminal and is handled by the CLI gate. So this is a design gap, not an accident. A second, separate problem: the comment at src/cli/serverControl.ts lines 927 to 930 says that under DISABLED the spawn must proceed so the child refuses with EX_CONFIG 78. alcore only exits 78 for the embed-key refusal at bin/alcore.rs:305 (grep for exit(78) across rust-core/crates), so a supervisor that spawns alcore under DISABLED gets a live server. Whether that spawn is reachable under DISABLED is not traced here. Why it matters: an alcore started directly (a test harness, a stale LaunchAgent, a manual run) runs and ingests while the owner believes AgentlensPro is off. Open question for design: should alcore refuse to start, or start read-only, when the DISABLED switch is present? If it refuses, the clone harness must then pass an explicit override. Source: docs_dev/20261027_190000+0100-735Q3JF4-inc1-acceptance-rerun-report.md (premise corrections).

## Approval log

- 2026-10-27T18:58:56+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
