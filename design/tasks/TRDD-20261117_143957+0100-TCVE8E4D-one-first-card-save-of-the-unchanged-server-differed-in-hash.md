---
trdd-id: TCVE8E4D
title: One first card save of the unchanged server differed in hash from 18 others with the same lines and bytes
column: todo
status: tasked
created: 2026-11-17T14:39:57+0100
updated: 2026-11-17T14:39:57+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T14:39:57+0100
---

# One first card save of the unchanged server differed in hash from 18 others with the same lines and bytes

## Problem
Seen 2026-11-17 in the server gate of TRDD-O4LU9SYJ (reports_dev/O4LU9SYJ/gate/o4-gate-results.json). Seven first card saves on copies of ONE prepared data folder each appended 391 lines, 538,189 bytes, 391 distinct keys, 0 tombstones. Six have sha256 9e89106f…; the first run after the folder was prepared (T-head-1, the unchanged server built from 2de80b5c, save at 14:17, sample newer half copied about 14:16) has 334908f8…. Twelve later saves by the O4 binary on fresh copies (reports_dev/O4LU9SYJ/gate/sha-repro.out, 14:34 to 14:36) all have 9e89106f….

## What is and is not known
- Same line count, byte count and key count, so the difference is line order or same-length values. Which one is NOT known: the data folder was removed before the hashes were compared.
- The run logs of T-head-1, T-head-2 and T-head-3 have the same lines once numbers are normalised (only the order of three background lines moves), and the same log-scan counts (files=1021 changed=254 parsed=254 cards=392). Their server-stats files differ only in pid, ports, paths, memory, load and times.
- The twelve repeats used the O4 binary only, 18 minutes after the sample copy, on a home folder that 14 runs had used. They could not reproduce either 'first run after the copy' or 'control binary only', so they say nothing about the cause.
- Untested candidates: a card value that depends on the clock relative to the transcript files' times; line order from the two parse threads.

## Why it matters
Card-log bytes that differ between two saves of the same input make hash comparison between runs unreliable as a test oracle, and a clock-dependent card value would be rewritten by later saves.

## Acceptance
- [ ] Reproduced: a fresh prepared folder, the unchanged server run once right after the newer half of the sample is copied and once several minutes later, both appended tails kept in a scratch folder, and the differing JSON field paths (or the line order) named.
- [ ] The cause is named from the code, with the line.
- [ ] Either the bytes are made stable, or the reason they may differ is written beside the save and gate scripts compare parsed records instead of raw bytes.

## Approval log

- 2026-11-17T14:39:57+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
