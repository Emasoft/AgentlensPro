---
trdd-id: V50CQS22
title: The default search with no kind runs out of memory at the default limit on this project
column: backburner
status: tasked
created: 2026-11-17T08:00:35+0100
updated: 2026-11-17T08:04:21+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T08:00:35+0100
---

# The default search with no kind runs out of memory at the default limit on this project

Measured 2026-11-17 by the main agent on the frozen set (3,246 transcripts, 2,972 MB, 0 changed), pattern error, through searchTranscripts with no kinds (line mode, the path of a plain agentlenspro search with only a pattern): Out of Memory Error (failed to allocate data of size 16.0 MiB) in under 1 second at AGENTLENS_DUCKDB_MEMORY_LIMIT 1.5GB, unset (2GB default), 2GB and 3GB, on the build of commit 3b84e6b5 AND on the build of commit 6dce222c, in hits, count and files mode and with limit 5; one run per cell (reports_dev/OIMXULDJ/main17-nokind-matrix.txt, main18-nokind-modes.txt). At 16GB it passes in 4.4 s with total 96391. So the default command does not work on this project at its default limit, and the attachment fix of TRDD-OIMXULDJ neither caused nor cured it.

Not known: the cause. Read, not tested: element mode caps every scan group at ELEMENT_SCAN_THREADS = 1 (searchCli.ts:814); the line-mode path sets the scan group's own thread count (searchCli.ts:992), and the source comment at :363 says the JSON reader holds about 2 x maximum_object_size per thread. Not known either: whether line mode ever passed on this frozen set (the 10-run measurements cited at searchCli.ts:127 name 6 cases; which ones was not re-read).

## Acceptance

- [ ] The cause is shown by an experiment that changes one thing (for example the thread count of the line-mode scan groups), not inferred.
- [ ] The no-kind search passes 10 of 10 at 1.5GB on the frozen set in hits, count and files mode, literal and regex, with rc 137 counted apart.
- [ ] Its per-transcript counts equal those of the current build at 16GB (reference to take before the change).
- [ ] A test or a documented measurement guards it; types, lint and the search test file pass.

## Notes and lessons learned
2026-11-17T08:04+0100 main agent, wording of this card narrowed: the measurement went through searchTranscripts (the library function the command calls) in the test build with the frozen file list, not through the agentlenspro executable; the real command may add options or pick another file set, and it was not run (the collector is disabled by the owner). A worker (sonnet) was started on this card without a separate proposal turn; its brief stops it after diagnosis if the fix needs a design change. Until it hands back, no other worker edits src/cli/searchCli.ts. Note for whoever tests: a stale experiment copy out/test/cli/searchCliVariant3.js sits beside the built module (left by the TRDD-OIMXULDJ worker, not removed). 

## Approval log

- 2026-11-17T08:00:35+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
