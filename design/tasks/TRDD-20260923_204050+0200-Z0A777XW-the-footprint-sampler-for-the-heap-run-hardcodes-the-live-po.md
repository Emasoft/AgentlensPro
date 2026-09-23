---
trdd-id: Z0A777XW
title: The footprint sampler for the heap run hardcodes the live port and pidfile and is not tracked
column: todo
created: 2026-09-23T20:40:50+0200
updated: 2026-09-23T20:41:01+0200
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
Move it to scripts/bench/alcore-footprint-sampler.sh (tracked) with --ui-port, --pidfile, --out, --seconds and --interval flags, no default that points at the live collector, and the same TSV columns (ts, pid, phys_footprint_mb, summary_misses, spans_inmem, statusline_recv, hook_recv, admitted_total).
Acceptance: [ ] refuses to run without explicit --ui-port and --pidfile; [ ] produces the same TSV header as ratchet-correlation-samples.tsv; [ ] a 2-minute run against an isolated alcore yields 4 rows with a numeric footprint. related: [EQCGAVGV].
