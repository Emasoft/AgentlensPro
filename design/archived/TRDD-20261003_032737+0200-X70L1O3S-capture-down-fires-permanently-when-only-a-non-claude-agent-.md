---
trdd-id: X70L1O3S
title: CAPTURE DOWN fires permanently when only a non-Claude agent is active
column: complete
status: archived
created: 2026-10-03T03:27:37+0200
updated: 2026-10-16T20:51:20+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-03T03:27:37+0200
implementation-commits: [9197b784]
---

# CAPTURE DOWN fires permanently when only a non-Claude agent is active

Commit a80a5554 made raw-body capture mandatory, so CAPTURE DOWN (server_stats.rs capture_down_since, fed st.last_ingest_activity_ms) is no longer silenced by an opt-out. But last_ingest_activity_ms is stamped in lib.rs ingest_parsed for ANY OTLP span, including Codex/Copilot/OpenCode spans, which never write raw bodies (only Claude Code honours OTEL_LOG_RAW_API_BODIES). A machine whose only active agent is Codex shows CAPTURE DOWN forever. The statusline stamp (ui.rs) is already Claude-only and stays.

Fix: stamp last_ingest_activity_ms only when at least one span in the payload is a Claude Code span (stored name prefix claude_code., the form ingest re-prefixes every Claude span to).

Done when: a non-Claude-only payload leaves last_ingest_activity_ms untouched, a Claude payload stamps it, test in tests/server_stats.rs, mutation-verified, clippy and the touched tests green.

## Approval log

- 2026-10-03T03:27:37+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-16T11:13:23+0200 — column → ai_review by main-agent@agentlenspro. code on main (fix 9197b784), verification not recorded; the main agent verifies next; triage row 4
- 2026-10-16T20:51:20+0200 — COMPLETE by main-agent@agentlenspro. ai_review 2026-10-16: 9197b784 on HEAD; Claude-only stamp verified at lib.rs:1183-1185; server_stats 4/4, clippy clean. Residual (inferred): bare trace-span names with logs export off would never stamp..

## Acceptance

- [x] A non-Claude-only payload leaves last_ingest_activity_ms untouched (lib.rs:1183-1185; test only_claude_spans_tick_the_capture_activity_clock, tests/server_stats.rs:119-136).
- [x] A Claude payload stamps it (same test, second half; server_stats 4 passed, 0 failed on 2026-10-16).
- [x] The test fails if the stamp is unconditional (by reasoning from process_traces: a Copilot span survives ingest; matches 9197b784's message); clippy -D warnings clean.
