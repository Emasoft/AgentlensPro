---
trdd-id: 2R0AXCKL
title: The two real-corpus slow tests flip between runs and turn a green gate red
column: backburner
created: 2026-09-02T01:11:53+0200
updated: 2026-09-04T14:23:13+0200
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
cover it: the load average was LOWER on the failing run, so a load-average scale is the wrong knob.

**DOWNGRADED 2026-09-04 — the cause of the original two failures is UNESTABLISHED, exactly as for
the eight in the section below.** This paragraph used to continue "…the cost is IO/CPU contention
on the bodies dir and the CPU, not runnable-queue depth." That sentence is retracted: it names a
mechanism nothing here measured, and it was written as a *substitute* for the load-average
hypothesis the same paragraph had just disproved — swapping one unmeasured cause for another is
not a correction. The evidence supports one claim: **two runs on the same tree disagreed.** That is
N=2 with the single measured proxy pointing the WRONG way (lower load on the failing run), which is
weaker than the gzip evidence retracted below, not stronger.

The card was retitled the same day for the same reason: it asserted "time out under host
contention" — a cause — in the most prominent field in the file, where a reader takes it before
reading any of this. The filename still carries the old slug; renaming it would break every
`TRDD-2R0AXCKL` path reference for no gain, and the `title:` field is the authoritative one.

## Why it matters

A 🐌 real-machine test that flips on host contention turns the release gate's exit code from 0 to 2
for reasons unrelated to the change under test. Every such flip costs a 10-minute re-run and, worse,
teaches the reader to shrug at a non-zero exit — the exact habit that lets a real failure through.

## Options (decide when picked up)

1. ⚠ **CONTRADICTED BY THIS CARD'S OWN DATA — do not implement as written.** The load-average gate
   below cannot discriminate: the failing run had the LOWER load average (see the Symptom table),
   so this skip would fire on the passing run and not the failing one. Kept, struck, as the record
   of a fix that looked obvious and was disproved by evidence already in the file — the live-pid
   half may still be worth something, the loadavg half is not.
   ~~Skip both under contention explicitly — e.g. when `os.loadavg()[0] / os.cpus().length > 1` or
   when the live server pid is present — and PRINT the skip reason, so a skip is visible, never
   silent.~~
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
| `standalone server — P5 window auto-calibration` (5 tests) | 5 fail | 5 fail | DETERMINISTIC, pre-existing — **now owned by TRDD-CS2W7E77** |
| real-corpus timeouts (`cacheBreakTimeline`, `forensicsIndex`/FAL) | 2 fail | 3 fail | flaky — **this card's known pair** |
| `segmentedSpanStore — compressSealedSegments` gzip (7 tests) | **7 fail** | **0 fail** | differs between runs — cause UNESTABLISHED |
| `serverRuntime — rssPressure` default HWM (1 test) | **1 fail** | **0 fail** | differs between runs — cause UNESTABLISHED |

**Do NOT read those two rows as "flaky" — that word was in an earlier draft of this section and
is not supported.** N=2 with at least three uncontrolled variables between the runs: run A was
preceded by `pnpm run compile-tests` and run B reused the existing `out/` (so run A may not have
tested the same bytes); host load differed and was measured in neither (run A shared the machine
with a `du -sh` over a 98 GB tree, run B with a live review fork); and these tests write real
segments into temp dirs, so run-A residue could have changed run B's starting ground. "Flaky"
names a cause. The measurement supports only the difference.

**The claim that IS supported, and it is the one that mattered:** these failures are not caused by
the 2026-09-04 session's commits, none of which touch `segmentedSpanStore.ts` or
`serverRuntime.ts`. Stopping at that negative was the correct move; naming a class was not.

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
      (`yes > /dev/null &` ×cores), reach the **SAME** verdict for **every** test — not merely the
      two named above. Widened 2026-09-04 on the measurement in the section above: the original
      two-test wording would have been satisfiable while the gzip seven and the `rssPressure` one
      still flipped.
      **"Same verdict" means DETERMINISM, not green.** The five `serverCalibration` tests fail in
      every run; three runs agreeing they fail SATISFIES this box. This card is about a suite that
      cannot make up its mind, not about a suite that passes — do not block it on unrelated
      pre-existing failures. Spelled out because the earlier wording ("agree on the verdict") read
      naturally as "green three times", which would have coupled this card to five failures it does
      not own and made a release blocker unclosable by accident.
- [ ] A skipped run prints WHY it skipped (no silent skip).
- [ ] The `segmentedSpanStore` gzip tests do not depend on the live process RSS: they pass an
      explicit `underPressure` (and, where relevant, an explicit `nowMs`) rather than taking the
      default that reads `rssPressure()`. A test whose outcome depends on how much memory the
      suite happened to be using is not a test of the code under test.
- [ ] The `serverRuntime — rssPressure` HWM-selection failure is triaged. It is NOT covered by the
      sweep-pause story and must not be closed by assuming it is.
      **This box is discharged EITHER by explaining it OR by filing it as its own card** — it must
      not hold this one hostage. Added 2026-09-04 after a review pointed out the first wording
      ("is explained") required solving an investigation this very card records as unresolved,
      which is not a checkbox, it is an open question wearing one. A box that can only be ticked by
      finishing unscoped work is how a bounded card silently becomes unclosable, and this card sits
      on the release gate.

## Notes and lessons learned

- Evidence files were ephemeral (`/tmp/full5.txt`, `/tmp/full6.txt`); the numbers above are the
  record.
