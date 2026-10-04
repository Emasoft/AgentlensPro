---
trdd-id: P08Q5TK1
title: The RSS guard's culprit log prints a non-mimalloc lower bound from whole-process RSS
column: complete
created: 2026-09-23T12:25:14+0200
updated: 2026-10-04T12:51:14+0200
current-owner: main-session
created-by: main-session
task-type: bugfix
min-approval-requirement: none
assignee: main-session
mandate: true
mandated-by: none
approved: true
approval-judge: main-session
approval-datetime: 2026-09-23T12:25:14+0200
project-id: agentlenspro
scope: project
related: [WKLD508O, 7RM5YW2T]
implementation-commits: [ffc9840c]
status: archived
---

# The RSS guard's culprit log prints a non-mimalloc lower bound from whole-process RSS

rss_guard.rs prints "non-mimalloc LOWER BOUND = phys_footprint - mimalloc current_rss", but on macOS vendored mimalloc fills current_rss from mach_task_basic_info.resident_size (whole-process RSS, libmimalloc-sys prim.c ~738-747), so the line is footprint minus RSS floored at 0 and does not measure the non-mimalloc share; readers took it as evidence (reports/alcore-heap/...-heap-attribution.md). Fix: report mimalloc's own commit figure and drop or relabel the lower-bound line. Evidence: docs_dev/alcore-rebuild-fix/20260923_120809+0200-advisor.md section 2.2.

## Approval log

- 2026-09-23T12:25:14+0200 — MANDATE issued by main-session (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-04T12:51:14+0200 — COMPLETE by main-agent@agentlenspro. Owner directive 2026-10-04 "complete all TRDDs!". Independent verification docs_dev/20261004_123719+0200-close-verify-cv2.md, HEAD 8b9e9637: rss_guard.rs write_diagnostic prints the mimalloc commit figure and a relabelled non-mimalloc-dirty floor, no 'non-mimalloc LOWER BOUND' string left in src; fix ffc9840c; no test calls write_diagnostic (none exists)..

## Acceptance

- [x] 1. rss guard diagnostic reports the mimalloc commit figure and drops/relabels the non-mimalloc LOWER BOUND line (verified: rss_guard.rs write_diagnostic prints mimalloc commit and a relabelled non-mimalloc-dirty floor; no 'non-mimalloc LOWER BOUND' string left in src; landed ffc9840c; no test calls write_diagnostic; cv2 2026-10-04)
