---
trdd-id: 12FGMAEP
title: No whole-process memory ceiling once the RSS cap keys on mimalloc commit
column: todo
status: tasked
created: 2026-10-22T19:35:30+0200
updated: 2026-10-23T04:26:22+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-22T19:35:30+0200
parent-trdd: 
unblock-when: [decision:owner gives the whole-process backstop value or records a waiver]
---

# No whole-process memory ceiling once the RSS cap keys on mimalloc commit

Step 4 of TRDD-2HRA270Y moves the hard cap from phys_footprint to mimalloc committed bytes (owner 2026-10-22, DuckDB may exceed 2 GB). DuckDB allocates through system malloc and was measured overrunning its own memory_limit (512MB limit gave 1150 MiB RSS; 1536MB gave 2497 MiB). With the cap on commit, a DuckDB runaway grows until jetsam kills the process and leaves no culprit log. Needed: a footprint backstop well above 2 GB that writes the same culprit log (or a logged warning threshold). The threshold value is the owner's call; record it here when given. Review finding from the step-4 adversarial review, 2026-10-22. 2026-10-22 clone run 1 (docs_dev/20261022-clone-run-report.md): the 2-second RSS sampler peaked at 4701 MB before it stopped at 900 s, while the composition lines show process RSS up to 5362 MB at uptime 1419 s and mimalloc commit peaking at 1873 MB; about 3.5 GB of process RSS sat outside mimalloc commit at that line, and the report does not measure which region holds it. This is deploy-gating: the step-4 guard counts only mimalloc and would not have stopped it. The run's DuckDB memory_limit is not recorded in the report, so the 512/1536 MB overrun ratios above do not apply to this figure.

## Approval log

- 2026-10-22T19:35:30+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
2026-10-22 review-2 notes: the RSS figures above are whole-process RSS (the 512MB figure was a Python host running DuckDB), not an isolated DuckDB measurement; the jetsam-with-no-log outcome is inferred, not observed. The session summary records an earlier owner answer on a 6 GB cap question; the search for it is incomplete (this session's transcript and the cards were grepped; the only 6 GB cap hits are archived 2026-08 cards 34B9JAZK and QK3L5QAS, a different context), so find it before choosing the backstop value. Moved to todo: this gates the 2HRA270Y deploy.

## Open question 2026-10-23

alstore open on the clone store peaks at 2.94 GB (2944614400 bytes) whole-process max RSS with DuckDB memory_limit 1536MB (R36S0PS9 gate): ~1.3 GB sits above DuckDB's configured limit during open (ART indexes, DuckDB allocations outside its accounting, or the Rust heap). mimalloc commit not measured; measure it before judging the 2 GB rule.
Production-cap clone run 2026-10-23 (cap unset = 2048 MB, ladder on by default; docs_dev/20261023-prodcap-run-report.md): server SURVIVED open + cold/warm 50-body exports + 120 s idle, exit=0 on SIGTERM. Peak RSS 4,613,376 KB (4.6 GB), constant through idle. Only mimalloc commit figures are the 60 s composition lines: 655 MB (up 0 s), 1964 MB (up 60 s), 1964 MB (up 120 s); the guard reads the commit every ~5 s tick and exits only above 2048 MB, so the intermediate peak is unmeasured (survival shows it never crossed). Pressure ladder reached stage 3 (metric 2051407872 B, ~96 MB under the cap), shrinking the summarization window to 6 h. phys_footprint 2100 MB at idle (peak 3132 MB) vs RSS 4.6 GB.
alcore's seed took 15.0 s vs 8.7-10 s in alstore; a cold first request pays ~30 s of open; with open-once-per-process that is paid once per start.
