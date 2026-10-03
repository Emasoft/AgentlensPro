---
trdd-id: HH1NP0KD
title: Replace the Node CLI on every hook and statusline path with small dedicated Rust binaries
column: design
status: tasked
created: 2026-10-03T20:40:31+0200
updated: 2026-10-03T20:40:31+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: refactor
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-03T20:40:31+0200
---

# Replace the Node CLI on every hook and statusline path with small dedicated Rust binaries

## Why
Owner directive 2026-10-03: "why are you using the same cli executable for all hooks? just create some small fast rust digest-optimized and focused binaries, simple thin wrappers over duckdb" and "the hooks should do the same, each with a super optimized custom rust ingester running superfast duckdb in few milliseconds." Measured: every hook/statusline fire spawns the full Node agentlenspro CLI, about 230 ms CPU and 71 MB RSS per spawn whatever the verb does; about 53k spawns per day (statusline about 60%), roughly 3.4 CPU-hours per day. Evidence: reports/hook-binaries/20261003_203907+0200-hook-inventory.md (gitignored, local).
## Scope
Five verbs: hook (15 events), gate (PreToolUse+PostToolUse), review-gate (Stop, SubagentStop), review-supervisor (Stop, UserPromptSubmit), statusline. Each gets a focused Rust binary that keeps the exact output contract listed in the inventory (kill-switch first, stdout contract, exit 0, timeouts, spool/revive for hook, fail-open for gate, inner-command passthrough for statusline).
## Open decision (pending measurement)
DuckDB allows concurrent writes inside one process; across processes it needs the Quack client-server extension (DuckDB >= 1.5.3, documented experimental). Candidates being benchmarked: shared file, per-session file, spool file read later by DuckDB, plain POST to alcore, Quack client attached to alcore. Pick per hook kind by CPU-ms per event, binary size, and zero lost events under 22 concurrent sessions.
## Constraints
review-supervisor matches the literal command string "agentlenspro review-gate" in settings files; renaming the hook command needs that check updated in the same change. Settings changes need owner approval.

## Approval log

- 2026-10-03T20:40:31+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
