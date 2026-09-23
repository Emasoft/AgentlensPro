---
trdd-id: P08Q5TK1
title: The RSS guard's culprit log prints a non-mimalloc lower bound from whole-process RSS
column: backburner
created: 2026-09-23T12:25:14+0200
updated: 2026-09-23T12:25:29+0200
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
---

# The RSS guard's culprit log prints a non-mimalloc lower bound from whole-process RSS

rss_guard.rs prints "non-mimalloc LOWER BOUND = phys_footprint - mimalloc current_rss", but on macOS vendored mimalloc fills current_rss from mach_task_basic_info.resident_size (whole-process RSS, libmimalloc-sys prim.c ~738-747), so the line is footprint minus RSS floored at 0 and does not measure the non-mimalloc share; readers took it as evidence (reports/alcore-heap/...-heap-attribution.md). Fix: report mimalloc's own commit figure and drop or relabel the lower-bound line. Evidence: docs_dev/alcore-rebuild-fix/20260923_120809+0200-advisor.md section 2.2.

## Approval log

- 2026-09-23T12:25:14+0200 — MANDATE issued by main-session (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
