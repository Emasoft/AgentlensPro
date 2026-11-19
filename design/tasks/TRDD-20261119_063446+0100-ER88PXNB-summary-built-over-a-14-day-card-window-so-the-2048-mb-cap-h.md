---
trdd-id: ER88PXNB
title: summary built over a 14-day card window so the 2048 MB cap holds
column: todo
status: tasked
created: 2026-11-19T06:34:46+0100
updated: 2026-11-19T06:38:26+0100
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

## Notes and lessons learned

2026-11-19T06:38+0100 main agent, answers to the harness review of the proposal. (1) REJECTED with evidence, the claim that the base before the summary is 1.8 GB: in all six boots of runs 20261119_054437, 062411 and 062705 the boot-phase burn_scan_start (the last phase before the build) reads 1211-1224 MB of mimalloc commit and first_summary_build 1920-2009 MB, so the build adds 700-790 MB. The composition lines that read 1436 and 1800 MB carry 'summary-cache none' and sit between burn_scan_start and first_summary_build in the same second (e.g. 06:33:28 burn_scan_start up 7.63 = 1224 MB, 06:33:29 composition 1800 MB with mi live 1618 MB, 06:33:29 first_summary_build up 8.44 = 2003 MB), so they sample the build in progress; their '[up 0s]' is the composition tick's own counter. Independent proof that the summary unit is the filler: 735Q3JF4 run C2 (2026-10-23, 59444 cards) with the summary build and its summary_now consumers off held commit at 660 MB against 1964 MB with it on (live +473 MB and free-in-page +836 MB both vanished). (2) Wording: 'the read adds at most about 300 MB' becomes 'the cap guard saw no commit above 2304 MB during the reads' (the guard samples periodically; a peak between samples is not excluded, and the production guard samples the same way). (3) INFERRED, not measured: that a 14-day window cuts the build cost in proportion to its share of cards (15%); fragmentation (free-in-page, about 900 MB in run A of 2026-10-23) may not scale linearly. (4) PREDICTION revised to a delta against the same run's base: first_summary_build minus burn_scan_start <= 200 MB (today 700-790 MB) and the highest sampled commit <= 1.75 GB; a delta above 300 MB or a sample above 1.85 GB falsifies the model. (5) Composition lines re-read with mi live and free-in-page shown (only the derived-slack to mi abandoned fields were elided). (6) NOT FIXED and to be measured in the evidence run: burn_snapshot (lib.rs:590) clones every resident card for burn_summary_now (ui.rs:522, 1005, 4423 run_burn_tick) and burn_subset_summary (lib.rs:618) indexes them all; it is not narrowed by this card.
