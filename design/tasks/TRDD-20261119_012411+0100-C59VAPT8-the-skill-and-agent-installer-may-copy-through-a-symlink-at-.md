---
trdd-id: C59VAPT8
title: The skill and agent installer may copy through a symlink at the destination
column: todo
status: tasked
created: 2026-11-19T01:24:11+0100
updated: 2026-11-19T01:24:11+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T01:24:11+0100
---

# The skill and agent installer may copy through a symlink at the destination

Split out of TRDD-YL3EWT6N on 2026-11-19 as a release blocker of TRDD-HSPUF5XH. The YL3EWT6N 20:30 entry lists as OPEN "the symlink follow-up from 87440d7e (unlink or rename aside the destination before copying)". If an installed skill or agent file is a symlink, a plain copy onto it writes through to the link target, a file outside the install folder. NOT ESTABLISHED: whether installSkill and the agent installer (src/cli/hookInstall.ts) copy onto an existing destination path without removing it first; not read on 2026-11-19. The 2026-11-18 incident of YL3EWT6N (four agent files overwritten, prior content not recovered) is NOT shown to be this mechanism.

## Acceptance
- [ ] The copy calls of the skill and agent installers are read, with file and line, and it is stated whether a symlinked destination is written through.
- [ ] If it is: the destination is removed or renamed aside before the copy, and a test with a symlinked destination fails on the code of today and passes after.
- [ ] If it is not: the card is closed with the lines that show it.

## Approval log

- 2026-11-19T01:24:11+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
