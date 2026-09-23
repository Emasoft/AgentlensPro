---
trdd-id: Z0A777XW
title: The footprint sampler for the heap run hardcodes the live port and pidfile and is not tracked
column: todo
created: 2026-09-23T20:40:50+0200
updated: 2026-09-23T22:48:04+0200
current-owner: main-session
created-by: main-session
task-type: infra
min-approval-requirement: none
assignee: main-session
mandate: true
mandated-by: none
approved: true
approval-judge: main-session
approval-datetime: 2026-09-23T20:40:50+0200
---

# The footprint sampler for the heap run hardcodes the live port and pidfile and is not tracked

## Approval log

- 2026-09-23T20:40:50+0200 — MANDATE issued by main-session (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Body

scripts_dev/alcore-heap/sample.sh (gitignored, 17 lines) samples phys_footprint via /usr/bin/footprint plus /api/server-stats and /api/debug/log-scan-stats every 30 s, but hardcodes UI port 3000, the live ~/.agentlens/server.pid and a /tmp output path, and runs a fixed 3600 s.
Move it to scripts/bench/alcore-footprint-sampler.sh (tracked) with --ui-port, --pidfile, --out, --seconds and --interval flags, no default that points at the live collector, and the same TSV columns (ts, pid, phys_footprint_mb, summary_misses, spans_inmem, statusline_recv, hook_recv, admitted_total) plus otlp_traces, otlp_logs, otlp_metrics, otlp_parse_errors from /api/server-stats otlp.* (TRDD-9SOYXKNE), so per-kind live rates are recorded per pid over time.
Acceptance: [ ] refuses to run without explicit --ui-port and --pidfile; [ ] produces the ratchet-correlation-samples.tsv header plus the four otlp_* columns; [ ] a 2-minute run at a 30 s interval against an isolated alcore yields 4-5 data rows (header excluded), each with a numeric footprint; [ ] pnpm run check-identities passes (the old script hardcodes a real home path). [ ] an absent otlp.* field is written as NA. related: [EQCGAVGV].

## Deploy dependency (2026-09-23)

The otlp_* columns read /api/server-stats otlp.*, which the live collector serves only after 221705cb or later is deployed (a pending user decision). The sampler must write NA - never 0, which is a false value, and never crash - when otlp.* (or any other field) is absent.
