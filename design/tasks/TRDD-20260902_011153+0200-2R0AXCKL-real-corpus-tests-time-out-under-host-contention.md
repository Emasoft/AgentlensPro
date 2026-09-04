---
trdd-id: 2R0AXCKL
title: The two real-corpus slow tests time out under host contention and turn a green gate red
column: backburner
created: 2026-09-02T01:11:53+0200
updated: 2026-09-04T14:12:33+0200
implementation-commits: [84d6f500]
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

## The flaky set is BIGGER than the two tests this card names (measured 2026-09-04)

Two full-suite runs, **same tree, same commit, no source change between them**:

| cluster | run A | run B | verdict |
|---|---|---|---|
| `standalone server — P5 window auto-calibration` (5 tests) | 5 fail | 5 fail | DETERMINISTIC, pre-existing — not this card |
| real-corpus timeouts (`cacheBreakTimeline`, `forensicsIndex`/FAL) | 2 fail | 3 fail | flaky — **this card's known pair** |
| `segmentedSpanStore — compressSealedSegments` gzip (7 tests) | **7 fail** | **0 fail** | **flaky — vanished entirely** |
| `serverRuntime — rssPressure` default HWM (1 test) | **1 fail** | **0 fail** | **flaky — vanished entirely** |

Totals 15 vs 8. **Eight tests in two clusters this card does not name flipped from fail to pass
with nothing changed.** A plausible mechanism for the gzip seven is that
`compressSealedSegments`'s default `underPressure = () => rssPressure().over` reads the LIVE
process RSS, so a mocha process that has grown past the 4096 MB HWM pauses the sweep and returns
`compressed: []` — every "sanity: the segment was actually gzipped" assertion then fails on an
empty array. **That mechanism is UNCONFIRMED** — the RSS at the moment those tests ran was never
measured, and it does not explain the `rssPressure` HWM-selection failure at all (that test
asserts which HWM is *chosen*, is independent of live RSS, and no `AGENTLENS_RSS_HWM_*` env var
was set, which should make it pass). Treat the mechanism as open; the FLAKINESS is measured.

**Consequence for this card's acceptance:** criterion 1 is scoped to "both tests", so it can pass
in full while eight other tests keep flipping — a green acceptance that leaves the release gate
exactly as untrustworthy as before. That is the failure this card exists to prevent, so the
criterion is widened below.

## Acceptance

- [ ] Three consecutive full-suite runs on one tree, one of them under a deliberate foreign CPU load
      (`yes > /dev/null &` ×cores), agree on the verdict for **every** test — not merely the two
      named above. Widened 2026-09-04 on the measurement in the section above: the original
      two-test wording would have been satisfiable while the gzip seven and the `rssPressure` one
      still flipped.
- [ ] A skipped run prints WHY it skipped (no silent skip).
- [ ] The `segmentedSpanStore` gzip tests do not depend on the live process RSS: they pass an
      explicit `underPressure` (and, where relevant, an explicit `nowMs`) rather than taking the
      default that reads `rssPressure()`. A test whose outcome depends on how much memory the
      suite happened to be using is not a test of the code under test.
- [ ] The `serverRuntime — rssPressure` HWM-selection failure is explained. It is NOT covered by
      the sweep-pause story and must not be closed by assuming it is.

## Notes and lessons learned

- Evidence files were ephemeral (`/tmp/full5.txt`, `/tmp/full6.txt`); the numbers above are the
  record.
