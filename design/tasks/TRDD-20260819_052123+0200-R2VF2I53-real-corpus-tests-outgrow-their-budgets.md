---
trdd-id: R2VF2I53
title: Real-corpus tests outgrow their budgets and flake under full-suite load
column: todo
created: 2026-08-19T05:21:23+0200
updated: 2026-08-19T05:21:23+0200
current-owner: AgentlensPro session
task-type: bugfix
priority: 3
labels: [tests, flaky]
approval-tier: 0
relevant-files: [src/test/cacheBreakTimeline.test.ts, src/test/bodyStore.test.ts]
---

# Real-corpus tests outgrow their budgets and flake under full-suite load

Found 2026-08-18 while triaging the P4b suite run (TRDD-DMWOBWFH). Both suites PASS in
isolation (`--no-config`, 83 passing) and fail only inside the ~10-minute full-suite run
on a loaded machine — the failure count varied 9 → 3 → 2 across consecutive full runs.

Two distinct defects, both environmental coupling to the LIVE corpus:

1. **cacheBreakTimeline — "builds a cause cost-peak report from the REAL OTEL bodies without
   crashing"** exceeded even its own 120s timeout during full-suite runs. The live bodies/
   transcript corpus grows without bound (`~/.claude/projects` measured 18GB), so any fixed
   budget on a real-corpus scan is a countdown to flake. Bound the INPUT, not the time:
   scan a capped window/sample of the corpus, or gate the test on a corpus-size ceiling and
   skip-with-reason above it.

2. **bodyStore — "CONSECUTIVE TURNS OF ONE SESSION dedup hard"** asserts a dedup ratio on
   whatever turn files currently sit in the live spool; observed 1.9× against the asserted
   floor while the P4b drain (now much faster) shrinks the spool to the fresh window —
   i.e. the test's input is a moving target another subsystem actively empties. Pin the
   input: verified fixture pair, or pick the two newest same-session files and skip-with-
   reason when none co-exist.

Acceptance: full suite green twice consecutively while the server drains live; no real-corpus
test may depend on an unbounded or externally-mutated input without a skip-with-reason guard.

## Notes and lessons learned
