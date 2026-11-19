---
trdd-id: Y61ZMGQA
title: Raw body discovery misses a same-path replacement on Linux when the inode number is reused
column: backburner
status: tasked
created: 2026-11-19T20:26:21+0100
updated: 2026-11-19T20:26:21+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T20:26:21+0100
---

# Raw body discovery misses a same-path replacement on Linux when the inode number is reused

## Problem

src/rawBodySourceIdentity.ts classifyFromContent decides 'replaced' by inode alone (lines 253-254). Linux reuses a freed inode number at once: in a node:22-bookworm container (overlayfs), unlink then recreate at the same path gave the same ino 119747, while birthtimeMs and ctimeMs differed. The 'replaced' class is then unreachable for that pattern and the file is read as unchanged or changed. macOS APFS does not reuse the number. The precondition comment (lines 247-252) covers only ino 0, not reuse.

Found by CI run 44592701995 (PR 29): three rawBodySourceIndex.test.ts tests failed on Linux. For 2.34.0 the tests were changed to keep the old file open while recreating it (no inode reuse), which tests the inode contract, not the Linux gap. Diagnosis: reports_dev/HSPUF5XH/20261119-ci-fix/discovery-linux.md.

## Candidate fix (not decided)

Persist birthtimeMs (statx btime) in SourceIndexRecord and compare it with ino; bump SOURCE_INDEX_FORMAT_VERSION (3) and read older records as unknown birthtime. ctime is not usable: utimes moves it.

## Acceptance

- [ ] A test that unlinks and recreates at the same path WITHOUT holding the old file open classifies 'replaced' on Linux (run in a Linux container) and on macOS.
- [ ] The precondition comment names inode reuse.
- [ ] Unverified so far: exposure in production; raw body files and transcripts are written under unique names or appended (INFERRED, not measured).

## Approval log

- 2026-11-19T20:26:21+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
