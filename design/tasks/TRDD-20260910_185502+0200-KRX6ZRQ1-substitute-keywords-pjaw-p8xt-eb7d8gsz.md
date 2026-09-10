---
trdd-id: KRX6ZRQ1
title: Substitute keywords for atoms PJAW-P8XT and EB7D8GSZ so the 10-keyword floor stops blocking their cleanup
column: todo
created: 2026-09-10T18:55:02+0200
updated: 2026-09-10T18:55:02+0200
current-owner: main
task-type: docs
min-approval-requirement: none
priority: low
blocked-by: []
npt: []
eht: []
implementation-commits: []
project-id: agentlenspro
scope: project
labels: [memory, memgrep]
related: []
---

# Substitute keywords for atoms PJAW-P8XT and EB7D8GSZ so the 10-keyword floor stops blocking their cleanup

## Defect

`memgrep update-mem-atom` refused removing three stale keywords from PJAW-P8XT (in
`.claude/project/memory/agentlenspro-ops-lessons-store-durability-and-memory.md`) and renaming
EB7D8GSZ because each would drop the atom under the 10-keyword floor; commit 9a2443ed narrowed
the descs and deferred this.

## Fix

Pick symptom-phrase substitutes (what a future session would search for) so the count stays
≥10, then run the verbs; `memgrep validate && memgrep lint` on the page.

## Acceptance

- [ ] The stale keywords gone with the floor satisfied
- [ ] Lint/validate clean

## Approval log
