---
trdd-id: 5YYVANZQ
title: The project ignores the whole reports folder so no evidence path cited in CLAUDE.md exists in a clone
column: backburner
status: tasked
created: 2026-11-17T17:38:23+0100
updated: 2026-11-17T17:38:23+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: docs
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T17:38:23+0100
---

# The project ignores the whole reports folder so no evidence path cited in CLAUDE.md exists in a clone

## Problem
CLAUDE.md line 5 says doctrine sentences must cite their evidence as a report path under reports/. The project's .gitignore line 40 ignores /reports/ (comment on line 39: agent reports may contain private paths or tokens, never commit), and git ls-files reports lists 0 files (read 2026-11-17 17:38). So every reports/ path cited in CLAUDE.md, in cards and in commit messages points at a file that exists only on this machine. The owner's rule of 2026-11-15 (user rule reports-and-memory) says the opposite: reports/ is git-tracked and sanitized before committing, reports_dev/ is the ignored one. Found when the evidence report for TRDD-H9UX6HFB (reports/H9UX6HFB/20261117_173534+0100-disk-load-generator-cumulative-writes.md) turned out to be ignored.

## Not done, and why
The ignore line was not removed and no report was force-added: the existing files under reports/ were written while the folder was ignored, so they were never checked for private paths, machine state or tokens; un-ignoring the folder would offer all of them to the next commit. That is an outward-facing change once pushed.

## Acceptance
- [ ] The owner decides: track reports/ in this project (per the 2026-11-15 rule) or keep it ignored and change CLAUDE.md line 5.
- [ ] If tracked: every existing file under reports/ is either moved to reports_dev/ or reviewed for content and run through sanitize-reports with its path before the ignore line is removed, and the reports cited by CLAUDE.md are committed by name.
- [ ] If kept ignored: CLAUDE.md line 5 says that the cited reports are local to the author's machine, or the evidence is moved into tracked files.

## Approval log

- 2026-11-17T17:38:23+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
