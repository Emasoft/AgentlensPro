---
trdd-id: 64A08ED4
title: Body-links boot compaction rewrites the whole history on every boot - add a ratio gate or move it off the boot path
column: todo
status: tasked
created: 2026-10-17T08:33:09+0200
updated: 2026-10-17T08:38:28+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: infra
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-17T08:33:09+0200
---

# Body-links boot compaction rewrites the whole history on every boot - add a ratio gate or move it off the boot path

From TRDD-N6A8VX3G. TRDD-1RJBOEI1 measured compact_from_disk at 700k body-link rows: 5.20 s and 184.7 MiB peak, one run on a loaded machine. The real body rate is about 52,500 a day (proxy: the count of ~/.agentlens/otel-bodies files from 2026-10-04 to 2026-10-17, not counted link rows). A linear extrapolation, which is inferred, not measured: about 12 s per boot after a month and about 140 s after a year. The card's own verdict rule says tens of seconds makes the ratio gate near-term. Options: a delta:snapshot ratio gate on boot compaction mirroring COMPACT_RATIO, or a periodic compaction off the boot path. First step: measure at 1.6M rows before choosing.

## Approval log

- 2026-10-17T08:33:09+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Related residue (2026-10-17)

- Whoever next edits delta_log.rs: two doc comments (about lines 574 and 591) still say body-links keys are 'unique per pointer'. Since 54f7b978 the key is a hash of the full row content. fastedit duplicated the doc block on two attempts, so the edit needs a different approach.
- The wire-path test added in 1b40ac9a (lib.rs body_links_tests) opens a full CoreState, which reads the process HOME (Env::from_process, then BurnRuntime::new). Whether anything is written under the real HOME is unverified. Check it; if something is, set HOME to the temp dir in the test.
