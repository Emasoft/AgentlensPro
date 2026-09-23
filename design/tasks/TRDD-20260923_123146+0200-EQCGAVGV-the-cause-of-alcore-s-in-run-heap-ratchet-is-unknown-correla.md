---
trdd-id: EQCGAVGV
title: The cause of alcore's in-run heap ratchet is unknown - correlate before choosing a fix
column: dev
created: 2026-09-23T12:31:46+0200
updated: 2026-09-23T12:46:45+0200
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
NEXT ACTION: read the ratchet-correlation report and decide.

Problem — the live collector's phys_footprint climbs until the 2,048 MB guard (TRDD-WKLD508O) exits it; 8 exits on 2026-09-23 (rss-hard-cap.log), all but #1 after WARM boots (server.log "resumed N log tail offsets (0 invalid/rotated -> cold read)"). Candidates: rebuild churn (TRDD-7RM5YW2T), the statusline stream, a boot-phase effect (exits #1 at 251 s and #8 at 640 s). Verified facts: the /api/statusline-samples handler (rust-core/crates/agentlens-core/src/ui.rs:1396-1420) appends to the statusline store and updates counters/activity clock but does NOT bump data_version; statusline POSTs were 18,528 of the last 20,000 lines of requests.log (08:01-10:20Z) - requests.log covers the UI/API port only, OTLP on :4318 is not in it, so this is a request COUNT share, not ingest volume. Current step: a passive 60-minute live correlation of footprint against summary.misses and statusline count (report under reports/alcore-heap/, name ends -ratchet-correlation.md). Shelved: the 3-variant isolated run (scripts/bench/alcore-ingest-flood.mjs cannot send statusline POSTs, pace low, or drive several port sets). Acceptance: [ ] the dominant term named with a fit that discriminates the candidates; [ ] the fix chosen and filed/linked. related: [7RM5YW2T, WKLD508O, 091Z1FU0, MBQ9LXAN, P08Q5TK1, KBM09XHB]. Evidence: reports/alcore-heap/20260923_112303+0200-heap-attribution.md, reports/alcore-heap/20260923_114454+0200-inrun-growth.md, docs_dev/alcore-rebuild-fix/20260923_120809+0200-advisor.md.
- [ ] on filing the fix card, re-point MBQ9LXAN's and 7RM5YW2T's blocked-by to it (they wait for the fix's deploy, not for this spike)

## Approval log

- 2026-09-23T12:31:46+0200 — MANDATE issued by main-session (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
