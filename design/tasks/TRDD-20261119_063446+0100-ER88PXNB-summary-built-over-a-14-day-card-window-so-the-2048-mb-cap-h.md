---
trdd-id: ER88PXNB
title: summary built over a 14-day card window so the 2048 MB cap holds
column: todo
status: tasked
created: 2026-11-19T06:34:46+0100
updated: 2026-11-19T06:34:46+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T06:34:46+0100
---

# summary built over a 14-day card window so the 2048 MB cap holds

Stopgap carved out of TRDD-735Q3JF4 so the release (TRDD-HSPUF5XH) can unblock; the resident-card bound and the DuckDB-answers work stay on 735Q3JF4. Rationale (one sentence): the first summary build deep-copies every resident card (about 750 MB of mimalloc commit on 110619 cards) and that alone takes the process to the 2048 MB cap; only the card list the summary build reads is narrowed. Measured basis (735Q3JF4 notes 2026-11-19): base 1.2-1.44 GB before the build, 1.92-2.01 GB after it; with the full summary the three investigate_burn reads ran under a test-only cap of 2304 MB without an exit (ladder runs 20261119_062411 and 20261119_062705), so the read adds at most about 300 MB of commit. Design (from scripts_dev/735q-inc4/proposal-draft.md, window 14 days instead of 7): (1) card_store.rs: a summary window (ids in resident order, member set, cutoff, gen): seeds = resident cards with last_active_ms >= now - DAYS plus the newest 200 roots; closure = ancestors and descendants by parentSessionId plus the placeholder/agent- twin; rebuilt when older than 1 h; a recent card not inside is appended with its family; window_include(id) appends an old card named by id; clear and discard reset it. DAYS from AGENTLENS_SUMMARY_CARD_DAYS (default 14, 0 = every card, today's behaviour). summary_epoch = (epoch << 32) | gen; every change that is not an append at the end bumps gen. (2) lib.rs: summary_snapshot and build_session_summary read the window and summary_epoch; resident set, persist_snapshot, save_cards, burn inputs untouched. (3) ui.rs: before a tool or route that names one session (the sessionId/parentSessionId argument reads, /api/timeline/<id>, /api/composition-index/<id>) call include_in_summary(id), which bumps data_version only when the card entered. (4) The summary gains summaryWindow {days, sinceMs, cards, totalCards} when cards < totalCards. Tests (each fails before its code): T1 engine position hazard under same vs different epoch; T2 window membership (old excluded, recent appended with gen unchanged, include true then false, rebuild drops aged cards and bumps gen, clear resets, DAYS=0 returns every card); T3 engine.build over window == summary_over(window); T4 state: old and recent cards, summaryWindow.totalCards, include moves data_version once. Acceptance: (a) code and tests T1-T4; (b) isolated run on a copy of this machine's 110619-card data at the PRODUCTION cap (no ISO_CAP_MB): idle 5 minutes, the three investigate_burn reads, then two reads at once, both servers exit 0 on SIGTERM; prediction written before the run: commit at first_summary_build <= 1.45 GB and the highest sampled commit <= 1.75 GB; a reading above 1.85 GB falsifies the model; (c) README and the diagnostics skill state the window, the knob and what a tool with a longer range sees. Not fixed: the resident base (about 14 MB a day of growth, 735Q3JF4); tools whose range exceeds 14 days (get_efficiency_report default 30, get_cost_rollup up to 45, get_workspace_patterns with no days) answer from the window and say so.

## Approval log

- 2026-11-19T06:34:46+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
