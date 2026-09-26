---
trdd-id: 563B8WYH
title: alcore crash-loops on the 2GB RSS hard cap with real-world data volume
column: todo
status: tasked
created: 2026-09-26T08:14:31+0200
updated: 2026-09-26T08:14:31+0200
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
