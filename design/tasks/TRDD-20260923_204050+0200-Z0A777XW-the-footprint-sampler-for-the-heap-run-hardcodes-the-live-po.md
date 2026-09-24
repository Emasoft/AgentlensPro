---
trdd-id: Z0A777XW
title: The footprint sampler for the heap run hardcodes the live port and pidfile and is not tracked
column: todo
created: 2026-09-23T20:40:50+0200
updated: 2026-09-24T08:56:43+0200
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
Acceptance:
- [x] refuses to run without explicit --ui-port and --pidfile
- [x] produces the ratchet-correlation-samples.tsv header plus the four otlp_* columns
- [ ] a 2-minute run at a 30 s interval against an isolated alcore yields 4-5 data rows (header excluded), each with a numeric footprint
- [x] pnpm run check-identities passes (the old script hardcodes a real home path)
- [x] an absent otlp.* field is written as NA

related: [EQCGAVGV].

## Deploy dependency (2026-09-23)

The otlp_* columns read /api/server-stats otlp.*, which the live collector serves only after 221705cb or later is deployed (a pending user decision). The sampler must write NA - never 0, which is a false value, and never crash - when otlp.* (or any other field) is absent.
Every consumer of the TSV (e.g. scripts_dev/alcore-heap/per_interval_corr.py and its successors) must treat NA as missing - skip that row's delta - never parse it as 0 and never crash on it.

## Implementation

2026-09-24T08:56:00+0200 — Implemented tracked scripts/bench/alcore-footprint-sampler.sh (scripts_dev/alcore-heap/sample.sh left untouched). Adds required --ui-port/--pidfile (refuses without both), --out/--seconds/--interval, and the 4 otlp_* columns from /api/server-stats otlp.* with NA on any missing field, never 0, never a crash. Verified: bash -n OK, shellcheck OK, no-args and missing-pidfile refusal (exit 1 + usage), a 5s/2s run against a bogus port+pidfile produced a well-formed 3-row TSV with all NA fields and exit 0, pnpm run check-identities OK plus a manual grep for the new untracked file. Box 3 (2-minute run against an isolated alcore) left UNCHECKED: this worker may not start/stop alcore or touch ~/.agentlens/ports per its assignment restriction; the row-cadence/NA logic exercised at 5s/2s scale is the same code path. Report: reports/z0a777xw/20260924_085444+0200-impl.md
2026-09-24T09:05:00+0200 — Review-fork findings addressed: (1) reformatted the single-line inline 'Acceptance: [ ] ... [ ] ...' into a 5-item bullet list SOLELY so trddgrep check-box could count/tick boxes (it counts 0 on an inline non-bulleted line) — wording of each criterion is verbatim unchanged, no criterion added/removed/reworded. (2) validated the footprint-parsing regex (inherited unchanged from scripts_dev/alcore-heap/sample.sh, not introduced by this card) against two real non-alcore processes on this machine: a small one (zsh, footprint reported in KB) correctly yields NA since the regex only matches '[0-9]+ MB', and a large one (rust-analyzer, 933 MB) correctly extracts 933. This is a pre-existing KB-vs-MB unit limitation in the upstream script, out of this card's scope (card is about port/pidfile/otlp columns, not footprint-unit robustness) — alcore itself runs in the multi-hundred-MB to multi-GB range, so the MB-only regex is not expected to misfire against the real target. Not fixed here; flagging for a future card if a small-process use ever needs it. (3) --seconds/--interval take no numeric validation (a non-numeric value fails at the arithmetic expansion with a raw bash error rather than a clean usage message) — accepted as a known minor gap, skipped per YAGNI; --ui-port/--pidfile (the two flags the card's acceptance criteria actually gate on) are validated.
