---
trdd-id: 563B8WYH
title: alcore crash-loops on the 2GB RSS hard cap with real-world data volume
column: todo
status: tasked
created: 2026-09-26T08:14:31+0200
updated: 2026-09-26T16:45:14+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-26T08:14:31+0200
---

# alcore crash-loops on the 2GB RSS hard cap with real-world data volume

DISCOVERED 2026-09-26 during the post-deploy idle-RSS glance owed by TRDD-Z53IJFE9. The live alcore (f579942e binary, data dir ~/.agentlens: 36805 card rows, 469297 spans in 6 segments) repeatedly crosses its own 2048 MB phys_footprint hard cap and exits: 170 'RSS HARD CAP — phys_footprint ... exiting' lines in ~/.agentlens/server.log (first at line 324051, phys_footprint overshoot was only 2-220 MB (2050-2270); the 2846 MB figure is the mimalloc heap counter — a DIFFERENT gauge that never trips the cap, and heap 2846 > footprint 2270 is itself evidence for open question (b) (freed-but-retained pages). Something restarts it (identity/cadence = open question (c)); boot ingest churn (log scan of 26218 files + hook-spool drain + bodies pass) pushes it over again within minutes — observed uptimes of 3-17 min at kill time. The iso-run deploy gate measured steady 1.10-1.28 GB on an EARLIER copy of the data dir (divergence since is accumulation, not a control), so the live excess comes from real accumulation state, not the binary. OPEN QUESTIONS for the fix: (a) is the cap (2048) simply wrong for this machine's data volume, and what should set it — measured peak, or a config knob? (b) does the mimalloc heap actually shrink between churn spikes (mimalloc holds freed pages), i.e. is a cap-change enough or does the drain need a trim/compaction pass? (c) who restarts it (daemon supervise) and is the restart cadence itself a problem? Fix must not touch the drain-correctness semantics pinned in TRDD-Z53IJFE9's review conditions. Related: reports/deploy/20260925_150640+0200-iso-run-8c74c5c0.md (gate numbers), .claude/project/memory/agentlenspro-ops-lessons-store-durability-and-memory.md

## Approval log

- 2026-09-26T08:14:31+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-26

MEASURED 2026-09-26T16:30+0200 (main session, post-clear): open question (c) ANSWERED — the restarter is the hook-revive supervisor (settings.json hooks run 'agentlenspro hook'; spawn decision goes through reviveBackoffGate at src/cli/hookHandlers.ts:260); after 7 consecutive quick deaths it held off respawning until 16:36:23 (~/.agentlens/.revive-backoff.json: consecutiveQuickDeaths=7, REVIVE_BACKOFF_BASE_MS=30s doubling, MAX 30min). Open question (a) REFINED — the machine has outgrown the cap independent of binary version: requests.log rss= reads 2.1-3.2 GB continuously since 2026-09-25T17:53 (BEFORE f579942e deployed at ~21:09), so the excess is corpus accumulation, not the new binary. NEW MEASUREMENT for (b): at kill time mimalloc current reads 2.7-3.0 GB while phys_footprint reads only 2.0-2.2 GB — the ordering is predicted by the gauge definitions alone (the guard's own line: the heap counter is 'RSS-like and carries clean pages the footprint never charged'), so it CANNOT by itself distinguish mimalloc retaining freed pages (leading hypothesis, dirty arenas not returned) from clean-page accounting; the footprint kills are triggered by churn spikes (boot log scan of 26295 files + restored 36902 cards + bodies pass ingesting up to 196 bodies/87MB in one pass) on TOP of that retained heap. The soft summarization valve (span_window.rs apply_memory_pressure, budget 4096MB) NEVER fires — window holds only 10-110 resident spans at kill time (cap is 1M), so the excess is NOT the summarization window; candidate holders are the restored card set (36,905 cards in memory) and boot-scan parse churn. Kill uptimes: min 26s median 296s max 3.9h over 214 kills in the log window. SS body-volume measure (the Z53IJFE9 step-E wikimem residue, same turn): bodies 30,333 ingested / 12,257 MB freed over 390 non-OVER-CAP passes in a 20.4-22.5h window = 13.1-14.4 GB/day SSD body writes (the '~13 GB/day' first pinned here was the flattering end AND its 14.9 correction endpoint was an arithmetic slip — 12,257 MB / 20.4h x 24 = 14.4; 14.9 implied a ~19.7h span; reconciled statement: span 19.7-22.5h = rate 13.1-14.4 — requests.log starts 17:53:46Z = 19:53 local, not ~18:00 local; server.log has no per-line timestamps so the true span is unverifiable; below the ~20 GB/day estimate at every end, AT OR JUST UNDER the 15 GB/day budget line, NO demonstrated margin; 34.8 GB/day including the iso-run backlog passes is not steady state; the 390-pass exclusion is a marker-match proxy — the window includes crash-restart churn passes, neither backlog nor steady; corrected in wikimem as ATOM-2JW2-CPGV, whose own chain defect (double-anchored supersede left LN86 status:valid carrying the wrong figure) was verified and repaired by ATOM-NSSD-71W1 + ATOM-O9EN-PDYP — quote only the NSSD-71W1 pair). OUTAGE STATE 2026-09-26T17:20: server STILL DOWN — backoff escalated to 9 quick deaths, holding until 17:40:02 local (.revive-backoff.json); no deliberate start made yet. Card work next, then a deliberate start.
