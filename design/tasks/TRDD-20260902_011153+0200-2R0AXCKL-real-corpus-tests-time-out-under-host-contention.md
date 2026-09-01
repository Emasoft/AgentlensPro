---
trdd-id: 2R0AXCKL
title: The two real-corpus slow tests time out under host contention and turn a green gate red
column: backburner
created: 2026-09-02T01:11:53+0200
updated: 2026-09-02T01:11:53+0200
current-owner: claude-agentlenspro
task-type: bugfix
project-id: agentlenspro
parent-trdd: 1B98LCVR
blocked-by: []
npt: []
eht: []
---

# The two real-corpus slow tests time out under host contention

## Symptom

Two consecutive full unit-suite runs on the SAME tree (the 2.33.2 gate, alcore binary sha
`d93d698c…`) disagreed only on these two tests:

| run | load at launch | verdict |
|---|---|---|
| full5, 2026-09-01 23:06 | ~20 (this repo's cargo build finishing) | 2536 passing / 0 failing / 9 pending — both tests `✔` (read from the per-test lines; a `comm` diff of the two runs' pass lists differs by exactly these two, and the pending 9→8 delta is a different real-machine test) |
| full6, 2026-09-02 01:00 | ~10 (a foreign `cargo build` — vectrace — saturating CPU; live alcore at 7.4 GB RSS working the same bodies dir) | 2535 passing / **2 failing** / 8 pending, EXIT=2 |

Both failures are mocha TIMEOUTS, not assertions:

- `cacheBreakTimeline.test.ts:697` — "builds a cause cost-peak report from the REAL OTEL bodies
  without crashing" — `this.timeout(loadScaledTimeout(120_000))` (`:700`), exceeded.
- `forensicsIndex.test.ts:465` — "indexApiCalls over the real ~/.agentlens degrades honestly whether
  or not bodies exist" — `this.timeout(derivedTimeoutMs)` = 180 s (`:482`), exceeded.

Both read the machine's real `~/.agentlens/otel-bodies` (thousands of files) and `this.skip()` when
it is absent (`:698`, `:470`), so CI never runs them. `DELEGATION.md` already listed
`cacheBreakTimeline` as a known-unrelated failure on 2026-09-01. The load-scaled budgets did not
cover the contention: the load average was LOWER on the failing run, so a load-average scale is the
wrong knob — the cost is IO/CPU contention on the bodies dir and the CPU, not runnable-queue depth.

## Why it matters

A 🐌 real-machine test that flips on host contention turns the release gate's exit code from 0 to 2
for reasons unrelated to the change under test. Every such flip costs a 10-minute re-run and, worse,
teaches the reader to shrug at a non-zero exit — the exact habit that lets a real failure through.

## Options (decide when picked up)

1. Skip both under contention explicitly — e.g. when `os.loadavg()[0] / os.cpus().length > 1` or
   when the live server pid is present — and PRINT the skip reason, so a skip is visible, never
   silent.
2. Bound the WORK instead of the time: cap the number of bodies files scanned (the tests assert
   "without crashing" and "honest coverage", not completeness), so the runtime is O(cap) regardless
   of corpus size.
3. Move both to a separate `test:machine` script that the release gate does not run.

Option 2 is the one that keeps the tests meaningful AND deterministic; 1 is the cheapest guard;
3 hides the tests. Whatever is chosen: `mocha --exit` is NOT on the table (it masks handle leaks —
see 1B98LCVR STATE, the 90-minute post-summary linger).

## Acceptance

- [ ] Three consecutive full-suite runs on one tree, one of them under a deliberate foreign CPU load
      (`yes > /dev/null &` ×cores), agree on the verdict for both tests.
- [ ] A skipped run prints WHY it skipped (no silent skip).

## Notes and lessons learned

- Evidence files were ephemeral (`/tmp/full5.txt`, `/tmp/full6.txt`); the numbers above are the
  record.
