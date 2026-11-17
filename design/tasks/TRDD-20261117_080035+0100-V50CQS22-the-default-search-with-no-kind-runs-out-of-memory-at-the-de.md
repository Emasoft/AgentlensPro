---
trdd-id: V50CQS22
title: The default search with no kind runs out of memory at the default limit on this project
column: dev
status: tasked
created: 2026-11-17T08:00:35+0100
updated: 2026-11-17T09:11:47+0100
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
implementation-commits: [31c34fb8]
---

# The default search with no kind runs out of memory at the default limit on this project

Measured 2026-11-17 by the main agent on the frozen set (3,246 transcripts, 2,972 MB, 0 changed), pattern error, through searchTranscripts with no kinds (line mode, the path of a plain agentlenspro search with only a pattern): Out of Memory Error (failed to allocate data of size 16.0 MiB) in under 1 second at AGENTLENS_DUCKDB_MEMORY_LIMIT 1.5GB, unset (2GB default), 2GB and 3GB, on the build of commit 3b84e6b5 AND on the build of commit 6dce222c, in hits, count and files mode and with limit 5; one run per cell (reports_dev/OIMXULDJ/main17-nokind-matrix.txt, main18-nokind-modes.txt). At 16GB it passes in 4.4 s with total 96391. So the default command does not work on this project at its default limit, and the attachment fix of TRDD-OIMXULDJ neither caused nor cured it.

Not known: the cause. Read, not tested: element mode caps every scan group at ELEMENT_SCAN_THREADS = 1 (searchCli.ts:814); the line-mode path sets the scan group's own thread count (searchCli.ts:992), and the source comment at :363 says the JSON reader holds about 2 x maximum_object_size per thread. Not known either: whether line mode ever passed on this frozen set (the 10-run measurements cited at searchCli.ts:127 name 6 cases; which ones was not re-read).

## Acceptance

- [ ] The cause is shown by an experiment that changes one thing (for example the thread count of the line-mode scan groups), not inferred.
- [x] The no-kind search passes 10 of 10 at 1.5GB on the frozen set in hits, count and files mode, literal and regex, with rc 137 counted apart.
- [x] Its per-transcript counts equal those of the current build at 16GB (reference to take before the change).
- [ ] A test or a documented measurement guards it; types, lint and the search test file pass.
- [ ] The memory need of the default search is measured against corpus size (or the search retries with one thread or a higher limit on an out-of-memory error), so that growth of the project does not bring the failure back unannounced.

## Notes and lessons learned
2026-11-17T08:04+0100 main agent, wording of this card narrowed: the measurement went through searchTranscripts (the library function the command calls) in the test build with the frozen file list, not through the agentlenspro executable; the real command may add options or pick another file set, and it was not run (the collector is disabled by the owner). A worker (sonnet) was started on this card without a separate proposal turn; its brief stops it after diagnosis if the fix needs a design change. Until it hands back, no other worker edits src/cli/searchCli.ts. Note for whoever tests: a stale experiment copy out/test/cli/searchCliVariant3.js sits beside the built module (left by the TRDD-OIMXULDJ worker, not removed). 
2026-11-17T09:11+0100 main agent, FIX COMMITTED 31c34fb8 (written by a worker; its report and the diff, 7 added and 2 removed lines, read whole by me before the commit). The change: the match test and the scope filters are one WHERE instead of a CTE filter plus an outer filter. Read: both forms keep a row when obj is null, or when it matches and passes the scope filters. MEASURED BY ME on the build of the then-uncommitted source (build newer than source; the commit holds that source unchanged), reports_dev/V50CQS22/main19-old-vs-new.txt, count mode, per transcript, the build of 3b84e6b5 that I kept (not the worker's patched copy) at 16GB against the new build at 1.5GB, one run per cell, 0 differing transcripts in each: plain error 96391; regex err(or|no) 84278; type user 71459; role assistant 8882; since 2026-11-01 18668; includeRequests+includeAttachments 115921; a regex with type assistant and attachments 141445. An until 2026-10-01 cell returned 0 on both builds and shows nothing. One hits-mode run at the unset default limit: total 96391. The search test file: 46 passing; check-types rc 0; eslint rc 0, no line besides npm config warnings. BY THE WORKER FILES, not rerun by me: the two-filter form fails at 1, 2, 3 and 4 threads (3 runs each); 40 of 40 acceptance runs at 1.5GB (hits, count, files, regex, 10 each) with rc 0 after it repaired its rc capture; a fixture with a malformed line, a null line and a line without type gives byte-identical output on old and new over 11 option sets and both the one-file and two-file paths; floor probe: fails at 0.8 to 1.3GB, passes at 1.4GB and above. CAUSE: a correlation, not a mechanism: two FILTER operators against one is what the experiments separate. OPEN, the card is not done: (a) the margin is thin (about 0.1GB under 1.5GB, 0.6GB under the 2GB default) and the transcripts of this project grow every day; nothing was measured about how the need scales, and nothing retries with fewer threads or a higher limit when the error occurs; (b) no committed test guards it: the new form passes the 46 tests, and so does the old one; (c) the agentlenspro executable itself was not run. The worker broke its brief once: it deleted its own scratch builds out/test/cli/v50-*.js; it later left out/test/cli/v50-old.js in place. No bug-scanner verdict (TRDD-9G5JC6OD). 

## Approval log

- 2026-11-17T08:00:35+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-17T09:11:47+0100 — column → dev by main-agent@agentlenspro. fix committed, open boxes remain
