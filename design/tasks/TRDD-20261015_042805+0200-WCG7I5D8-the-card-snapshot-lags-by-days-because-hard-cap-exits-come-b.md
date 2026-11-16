---
trdd-id: WCG7I5D8
title: The card snapshot lags by days because hard-cap exits come before the first card save
column: todo
status: tasked
created: 2026-10-15T04:28:05+0200
updated: 2026-11-16T23:25:49+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T04:28:05+0200
project-id: agentlenspro
---

# The card snapshot lags by days because hard-cap exits come before the first card save

## Problem
The NDJSON card snapshot (log-sessions) saves only when dirty and at least 300 s after the previous save, counted from boot (log_reader.rs:834-836, 1260-1263); offsets save every 60 s (:833). Runs die at the RSS hard cap after about 4-11 minutes (per the facts report), and the hard-cap exit flushes the span store only (lib.rs:852-861, rss_guard.rs:554, per reports_dev/0bdov3wc-facts.md), so many runs save offsets several times and cards never. The snapshot count repeated across refusals days apart (41,053 on 2026-10-05 and 2026-10-07; 41,619 twice on 2026-10-14) while offsets advanced: the snapshot lagged by days. Evidence: reports_dev/0bdov3wc-facts.md Q4-Q5.

## Fix direction
Save the card snapshot early after boot and in the hard-cap exit path (bounded, off the state lock), or save cards whenever offsets are saved.

## Acceptance
- [ ] A run killed by the hard cap after its first offsets save leaves a card snapshot at least as fresh as those offsets.

## Approval log

- 2026-10-15T04:28:05+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## STATE

2026-11-16 23:14 — CODE READ (rust-core/crates/agentlens-core/src/log_reader.rs, lines 886 to 899 and 1380 to 1405). DurableState::new sets last_cards_save to the boot instant, and tick() saves cards only when cards_dirty AND 300 s (AGENTLENS_CARDS_SAVE_MS, floor 30 s) have passed since last_cards_save, while offsets save every 60 s. So no card save can happen in the first 300 s of a run. That matches the Problem section.
PLAN, not built: add a bool first_cards_saved (false at boot). In tick(), save cards when cards_dirty AND (first_cards_saved is false OR the 300 s cadence has passed); set first_cards_saved after that save. This gives one early card save at the first 60 s timer after cards become dirty, then the old cadence. Test: a DurableState with the default cadence, mark cards dirty, advance past offsets_save only, call tick, and assert the cards delta log on disk holds the card; the test must fail on the old condition.
RISK that must be measured before this ships: save_cards persists the WHOLE store (comment at line 1223 says a whole-store save added to the RSS-cap exits, TRDD-WKLD508O and TRDD-TWDGR75R). One early whole-store save at about 60 s may land during the boot sweep. Measure peak RSS at boot with and without the change on an isolated instance (own HOME and DATA_DIR, sample of at most 4 GB) before closing. The hard-cap exit path (lib.rs 852 to 861) is NOT changed by this plan.
2026-11-16 23:25 — MEASURED on the live data folder and server.log (read only). (1) Run lifetimes: server.log holds 2114 RSS hard-cap exits from 2026-09-27 to 2026-10-27; 492 died under 60 s, 1251 between 60 and 300 s, 209 between 300 and 660 s, 162 later; median 115 s, shortest 6.7 s. So 82 percent of hard-cap runs ended before the first possible card save, which turns the facts file's inference into a count. (2) Sizes: log-sessions snapshot 72302940 bytes in 40534 lines (1784 bytes per stripped card), dated 2026-10-03; delta 4715 lines, dated 2026-10-21; the last hard-cap line reports 74730 card store rows. (3) CODE: save_cards streams records and keeps only the CHANGED lines in memory (delta_log.rs save_from), so the early save's worst case is a body near 74730 x 1784 = 133 MB (an estimate from the two measured numbers, not a measured RSS). (4) CODE: ingest_chunk (boot sweep and every full sweep) puts a chunk's cards in DuckDB and then appends that chunk's offsets to disk at once (log_reader.rs 1274 to 1290), so offsets on disk move from the first seconds of a run; tick(false) runs only inside the sweeper loop, after the boot sweep. CONSEQUENCE: the one-off early save built by the worker cannot help the 492 runs that died under 60 s nor any run killed inside its boot sweep, and it covers one save only. It is committed as a CHECKPOINT on the branch (RULE 0: commit before the edit that replaces it), not merged to main, and its WHY comment wrongly says 4 to 11 minutes. REPLACEMENT PLAN, proposed and not built: append each chunk's cards to the log-sessions delta BEFORE that chunk's offsets are appended (the cards-before-offsets order DuckDB already has), do the same for targeted sweeps, keep the 300 s whole-store save for deletions and compaction, and remove the first_cards_saved flag.

## Review notes

- 2026-11-16 23:17 — Evidence class, corrected after review. MEASURED: no card save is possible in a run's first 300 s (log_reader.rs DurableState::new + tick); one run died at uptime 245674 ms, under 300 s (reports_dev/0bdov3wc-facts.md line 133); the snapshot count repeats across refusals days apart (same file, line 173). INFERRED, not measured: that the days-long lag is caused by runs dying before the first card save (the facts file itself tags it INFERRED, line 176). LIMIT of the plan in work: the one-off early save covers the FIRST offsets save only; a run killed at minute 4 after four offsets saves still leaves cards about three minutes older than its offsets. The acceptance box is met only in that narrow reading. The change is NOT to be committed before the boot peak-RSS measurement on an isolated instance.
