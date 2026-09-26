---
trdd-id: DX8PYPLO
title: Drain and boot become measurable and bounded — timestamped chore lines, one bounded re-measure, a resilience bench
column: todo
status: tasked
created: 2026-09-27T00:24:10+0200
updated: 2026-09-27T00:24:18+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: infra
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-27T00:24:10+0200
---

# Drain and boot become measurable and bounded — timestamped chore lines, one bounded re-measure, a resilience bench

OWNER DIRECTIVE (2026-09-26, verbatim): 'make the server faster and resilient to all. no more crashes.' And from the review chain on TRDD-Z53IJFE9: no GB/day figure derived from the timestampless server.log is quotable — three brackets were minted and each was wrong in a different way.

VERIFIED GAPS (all checked in source, 2026-09-26/27):
G1. server.log lines carry NO timestamps — the log Reader has to guess spans from rotation boundaries. The bodies-pass line (chores.rs:368), the hook-spool line, and the boot provenance line are all timestampless. requests.log (the HTTP layer) is the ONLY timestamped log, and it does not cover chore work.
G2. Because of G1, the body-write rate is unmeasurable from history: the Z53IJFE9 wikimem ladder ended at '12,257 MB freed over an unmeasurable span'. A single timestamp on the pass line makes every future measure one grep.
G3. No resilience bench exists: nothing reproduces the crash loop. TRDD-2JOIAH2G's acceptance needs a repeatable scenario — fill otel-bodies with >2 GB while the server is STOPPED, start it, and assert zero RSS-cap exits and drain-to-empty.
G4. The soft summarization valve (span_window.rs apply_memory_pressure, budget 4096 MB) never fires on this failure mode (window holds 10-124 spans vs the 1M count cap), so there is currently NO graduated response between 'working fine' and 'exit(1)'.

DESIGN:
D1. Timestamp every alcore eprintln/println chore line (bodies pass, hook-spool, boot provenance, state lock): one helper, applied at the call sites in chores.rs + bin/alcore.rs + log_reader.rs boot lines. ISO 8601 local, same %Y-%m-%dT%H:%M:%S%z shape as TRDD frontmatter.
D2. After D1 ships and the server has a day of uptime: ONE bounded re-measure of the body-write rate (sum freed MB over a known 1h window) replaces the entire wikimem ladder (ATOM-LN86-T9RZ + ATOM-2JW2-CPGV + ATOM-NSSD-71W1 + ATOM-O9EN-PDYP) with one number — the four lessons get superseded by a fifth that cites the timestamped measurement.
D3. A resilience test (rust-core test or a scripted scenario under src/test/) that runs the G3 scenario against a real alcore binary in an isolated data dir, asserting: zero 'RSS HARD CAP' lines, drain completes, every body in the store (alstore verify on an aside copy). This is the executable form of 'no more crashes' for THIS family — the same discipline that caught the pid-lock regression (serverSingleInstance.test.ts, mutation-verified).
D4. Fold into the 2JOIAH2G implementation order as the instrumentation step (D1 first — the measurement for R2 'measure before picking the number' then exists).

NON-GOALS: no redesign of the store layout (DuckDB is already the direct-ingest target per owner directive), no new buffer, no process split (always-on-ingestion-model lesson: verify the ACTUAL loss vectors first — they are covered).

RELATED: TRDD-2JOIAH2G (the crash-loop fix this instruments), TRDD-Z53IJFE9 (drain semantics pinned — do not break), TRDD-563B8WYH (discovery card).

ACCEPTANCE:
- [ ] every chore/boot log line starts with an ISO 8601 local timestamp
- [ ] the resilience scenario runs green against a real binary and fails when the RSS guard is disabled (mutation check)
- [ ] the wikimem ladder is collapsed to one timestamped measurement
- [ ] a 1h bounded re-measure of the body-write rate exists and is cited by the collapsed lesson

## Approval log

- 2026-09-27T00:24:10+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-09-27T00:24:18+0200 — column → todo by main-agent@agentlenspro. owner directive: resilience + measurability; D1 is prerequisite measurement for 2JOIAH2G R2
