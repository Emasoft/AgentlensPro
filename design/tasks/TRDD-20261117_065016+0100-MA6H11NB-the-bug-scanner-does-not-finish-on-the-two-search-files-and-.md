---
trdd-id: MA6H11NB
title: The bug scanner does not finish on the two search files and uses 5.7 GB
column: backburner
status: tasked
created: 2026-11-17T06:50:16+0100
updated: 2026-11-17T06:54:42+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T06:50:16+0100
---

# The bug scanner does not finish on the two search files and uses 5.7 GB

Measured 2026-11-17 by the main agent. Command: ubs --files=src/cli/searchCli.ts,src/test/searchCli.test.ts --ci <scratch dir holding the two files as committed in 4f134558> (613 and 403 lines), ubs 'bash /opt/homebrew/bin/ubs', started 06:37:52. Its output (reports_dev/UIQS9RXZ/main3-ubs-4f134558.txt, 45 lines) stopped at 'Scanning js...' at 06:37:56 and did not advance. A process snapshot at 06:49 showed the JS module still running after 11 min 26 s: python -m ubs_core.js_scan with a resident size of 5,998,336 KB (5.7 GB), under the module's own 900 s timeout. The run was stopped by the main agent at 06:50 (host swap 7.8 of 9.2 GB used, a memory acceptance run in progress beside it); a fresh snapshot showed no scanner process left. An earlier scan of the search source in this session also did not finish. So TRDD-UIQS9RXZ has no scanner verdict and cannot get one this way. Not known: which of the two files triggers it, whether it is the file content or the scanner version, whether it would finish given more time or memory. The scanner is an installed tool outside this repository: a defect in it is reported upstream, not patched here.

## Acceptance

- [ ] Each file scanned alone, with a stated time bound and the peak memory read, to find which one does not finish.
- [ ] The cause is recorded (a construct in the file, or a scanner defect with an upstream report).
- [ ] TRDD-UIQS9RXZ and TRDD-OIMXULDJ each have a scanner verdict, or an owner decision that another check replaces it for these files.

## Notes and lessons learned
2026-11-17T06:54+0100 main agent, CORRECTION: which copy of the two files the scanner read is NOT established. The run was started from the repository root with the names src/cli/searchCli.ts and src/test/searchCli.test.ts and the scratch directory as project directory; both names also exist in the working tree. The scanner copied its inputs to a shadow workspace, which was gone when I looked for it after stopping the run, so it could not be compared with the 4f134558 copies or with the working tree. Read 'scratch copies' in the body above as 'the two search files, copy not established'. The next attempt must pass absolute paths of the copies and scan one file at a time.

## Approval log

- 2026-11-17T06:50:16+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
