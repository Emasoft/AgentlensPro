---
trdd-id: EQCGAVGV
title: The cause of alcore's in-run heap ratchet is unknown - correlate before choosing a fix
column: dev
created: 2026-09-23T12:31:46+0200
updated: 2026-09-23T14:11:08+0200
current-owner: main-session
created-by: main-session
task-type: spike
min-approval-requirement: none
assignee: main-session
mandate: true
mandated-by: none
approved: true
approval-judge: main-session
approval-datetime: 2026-09-23T12:31:46+0200
---

# The cause of alcore's in-run heap ratchet is unknown - correlate before choosing a fix
## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-23T12:32:07+0200
NEXT ACTION: (1) zero-risk first — redo the correlation on per-interval deltas (Δfootprint vs Δsummary.misses vs Δstatusline per 30 s row, 5-min block maxima, boot phase excluded) from the samples already collected (the report reports/alcore-heap/20260923_134155+0200-ratchet-correlation.md names the TSV); (2) only if still inseparable, the isolated instance with statusline and OTLP load varied independently (recipe in the section above).

Problem — the live collector's phys_footprint climbs until the 2,048 MB guard (TRDD-WKLD508O) exits it; 8 exits on 2026-09-23 (rss-hard-cap.log), all but #1 after WARM boots (server.log "resumed N log tail offsets (0 invalid/rotated -> cold read)"). Candidates: rebuild churn (TRDD-7RM5YW2T), the statusline stream, a boot-phase effect (exits #1 at 251 s and #8 at 640 s). Verified facts: the /api/statusline-samples handler (rust-core/crates/agentlens-core/src/ui.rs:1396-1420) appends to the statusline store and updates counters/activity clock but does NOT bump data_version; statusline POSTs were 18,528 of the last 20,000 lines of requests.log (08:01-10:20Z) - requests.log covers the UI/API port only, OTLP on :4318 is not in it, so this is a request COUNT share, not ingest volume. Current step: a passive 60-minute live correlation of footprint against summary.misses and statusline count (report under reports/alcore-heap/, name ends -ratchet-correlation.md). Shelved: the 3-variant isolated run (scripts/bench/alcore-ingest-flood.mjs cannot send statusline POSTs, pace low, or drive several port sets). Acceptance: [ ] the dominant term named with a fit that discriminates the candidates; [ ] the fix chosen and filed/linked. related: [7RM5YW2T, WKLD508O, 091Z1FU0, MBQ9LXAN, P08Q5TK1, KBM09XHB]. Evidence: reports/alcore-heap/20260923_112303+0200-heap-attribution.md, reports/alcore-heap/20260923_114454+0200-inrun-growth.md, docs_dev/alcore-rebuild-fix/20260923_120809+0200-advisor.md.
- [ ] on filing the fix card, re-point MBQ9LXAN's and 7RM5YW2T's blocked-by to it (they wait for the fix's deploy, not for this spike)

## 2026-09-23T13:44:57+0200 — passive correlation: inconclusive; new candidate

The 60-minute passive live correlation (report below) found summary.misses and statusline `receivedSinceBoot` near-perfectly colinear in live traffic (Pearson r = 0.9992 across all 79 usable rows from both segments), so a passive regression against ordinary traffic cannot attribute footprint growth to rebuild misses versus statusline volume - the two candidates are observationally indistinguishable in this data. New, previously-unexamined candidate found by code read: the 60-second `maybe_seal` chore's `count_lines()` (rust-core/crates/agentlens-core/src/statusline_store.rs:244-246) does a full, unbounded (up to seal_rows x row-size) file read of the live statusline WAL on every tick regardless of whether a seal happens, and its transient allocation size scales with statusline volume accumulated since the last seal. A fresh-restart segment (pid 54845, 19.3 min, only 9.3 min usable after the 10-min boot exclusion) showed NO ratchet - phys_footprint swung 1238-1895 MB with slope -20.9 MB/min, R^2 = 0.16 (noise, not decline) - while summary.misses climbed from 3 to 668 and statusline receivedSinceBoot climbed from 7 to 2,988 over the same window, comparable growth rates to the older process's later blocks (which DID ratchet, e.g. segment 1's 6 full 5-min blocks: fp_max 1536->1853 MB, slope ~15.1 MB/min, R^2 = 0.82). This is directionally consistent with a WAL-size-driven (statusline-seal-check) cause or any cause scaling with process age/heap-fragmentation history rather than cumulative counts, but one 19.3-minute segment is not enough data to decide. Report: reports/alcore-heap/20260923_134155+0200-ratchet-correlation.md.

## Approval log

- 2026-09-23T12:31:46+0200 — MANDATE issued by main-session (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## 2026-09-23T14:10:37+0200 — correction to the passive-correlation section

The fresh-restart segment (pid 54845, 9.3 usable min) cannot show "no ratchet": at 3.5-7 MB/min the ratchet predicts only 33-65 MB over 9.3 min, while that segment's footprint spread was 657 MB (1,238-1,895 MB, R^2 0.16). It is no evidence either way; the earlier "showed NO ratchet" is withdrawn.
The r = 0.9992 was computed between two CUMULATIVE counters (summary.misses, statusline receivedSinceBoot); any two monotonic counters correlate near 1. The inconclusive verdict stands but its reason was wrong - the regression must use per-interval deltas.
count_lines (statusline_store.rs:244-246) is bounded by the WAL size, not "unbounded"; the WAL was ~22.5 MB (/api/server-stats statusline.walBytes 22,530,265 earlier today), so its 60-s transient is on the order of the WAL size - unlikely on its own to drive a 3.5-7 MB/min ratchet; it stays a candidate only as a fragmentation contributor.
