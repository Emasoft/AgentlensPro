---
trdd-id: C59VAPT8
title: The skill and agent installer may copy through a symlink at the destination
column: cancelled
status: archived
created: 2026-11-19T01:24:11+0100
updated: 2026-11-19T01:32:55+0100
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
- [x] The copy calls of the skill and agent installers are read, with file and line, and it is stated whether a symlinked destination is written through.
- [ ] If it is: the destination is removed or renamed aside before the copy, and a test with a symlinked destination fails on the code of today and passes after.
- [ ] If it is not: the card is closed with the lines that show it.
2026-11-19T01:32:54+0100 main agent DECISION: NOT A DEFECT, cancelled. Box 1 is met: by W71 (reports_dev/cheap-worker/20261119_w71-symlink-copy/report.md), installSkill (hookInstall.ts:1143) and installAgents (:1218) both write through writeFileAtomic. The main agent read writeFileAtomic and backupFile (hookInstall.ts:1040-1083): when the destination is a symlink the write goes to the link's TARGET ON PURPOSE (doc comment above writeFileAtomic, commit e08db829, TRDD-YL3EWT6N item 4: renaming over the link would replace the user's link with a file, where the old in-place write kept it), and backupFile copies the old bytes to <dataDir>/surface-backups first; it throws when no backupRoot is given. The main agent read the callers: setup.ts:1227/1244/1283 and diagnosticsCli.ts:680-682 pass backupRoot = <dataDir>/surface-backups; hookInstall.ts:1237 passes the caller's options through. src/test/surfaceVerdict.test.ts ran on 2026-11-19 (compile-tests exit 0; 21 passing, exit 0), including 'an installed agent file that is a symlink is replaced through the link' and 'an installed agent file that is a dangling symlink is written at the link target'. ACCEPTED RESIDUALS, named: (1) a DANGLING link at the destination makes the installer create the link's target outside the install folder, with no backup (there are no old bytes); (2) a chain of two links ending dangling has its last link replaced by a regular file (comment inside writeFileAtomic: one hop only). Whether the write-through existed at v2.33.1 is by the doc comment (the old in-place write kept the link), not read at the tag. Box 2's premise (remove the destination first) is refused: it would replace a user's link. Removed from TRDD-HSPUF5XH blocked-by.

## Approval log

- 2026-11-19T01:24:11+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T01:32:55+0100 — CANCELLED by main-agent@agentlenspro. not a defect: write-through of a symlinked destination is deliberate (e08db829), backed up, and tested (surfaceVerdict.test.ts, 21 passing).
