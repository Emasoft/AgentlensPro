---
trdd-id: 9G5JC6OD
title: Commits in this repository are not scanned by the bug scanner
column: backburner
status: tasked
created: 2026-11-17T06:44:25+0100
updated: 2026-11-17T06:58:45+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: infra
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T06:44:25+0100
---

# Commits in this repository are not scanned by the bug scanner

Found 2026-11-17 while checkpointing TRDD-OIMXULDJ. The owner's rule is that the Ultimate Bug Scanner (ubs) is the check at each commit. Read in the CURRENT machine-wide pre-commit hook (the directory named by git config core.hooksPath, file pre-commit, lines 34 to 39): it scans only repositories whose working-tree root or shared git directory contains the text mods-expert-developer and exits 0 for every other repository, this one included. The checkpoint commit 3b84e6b5 (two search files, 854 insertions) printed no scanner line. Not read: the two backup copies of the hook dated 2026-11-10, so whether an earlier version scanned this repository is unknown. The hook is the owner's file outside this repository: it is not to be edited by an agent.

## Acceptance

- [ ] Owner decision recorded: extend the hook's family test to this repository, or keep the hook and scan by hand.
- [ ] Until then, each commit that touches source files here is preceded or followed by a manual run of ubs on the committed files, with the verdict recorded on the owning card.
- [ ] The files of commit 3b84e6b5 (or of the commit that replaces it after the memory fix) have a recorded ubs verdict.

## Notes and lessons learned
2026-11-17T06:58+0100 main agent: the two backup copies of the hook were read (same directory, pre-commit.bak-20261110_015525 with 95 lines and pre-commit.bak-20261110_023254 with 117 lines). Both carry the same family test at lines 36 to 38: only a path containing mods-expert-developer is scanned, everything else exits 0. So no version of this hook since the first backup of 2026-11-10 scanned this repository; what ran before that date is not known. A manual scan is currently not possible for the search files either (TRDD-MA6H11NB: the scanner did not finish and held 5.7 GB).

## Approval log

- 2026-11-17T06:44:25+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
