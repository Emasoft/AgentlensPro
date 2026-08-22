---
trdd-id: R2VF2I53
title: Real-corpus tests outgrow their budgets and flake under full-suite load
column: complete
created: 2026-08-19T05:21:23+0200
updated: 2026-08-22T20:35:00+0200
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

## Worked 2026-08-22

**Defect 1 (cacheBreakTimeline) was ALREADY FIXED — this card was stale on it.** Both real-corpus
tests carry `scanCap: 300`, i.e. the INPUT is bounded exactly as the card asked, and the suite
runs **67 passing / 0 failing in 34 s** against a live spool. No work needed.

A methodology note, because it nearly produced a false report: a first run of that file showed
**3 failures, all `Timeout of 2000ms exceeded`** — an artifact of invoking `mocha --no-config`,
which drops `.mocharc.js`'s `timeout: 10000` and falls back to mocha's 2 s default. The product
was fine; the harness was mine. *Verify the harness before blaming the component.*

**Defect 2 (bodyStore) was real, and the diagnosis in this card was close but not the whole
cause.** The card said the input is "a moving target another subsystem actively empties" — true,
but the consequence is sharper than a shrinking sample. Measured on the live spool:

| measurement | value |
|---|---|
| distinct sessions in 400 bodies | 37 |
| largest single session | 54 turns |
| mean shared prefix, first 12 by mtime | **34%** of the previous turn |
| mean shared prefix, longest non-shrinking run | **51%** |
| longest run of pairs sharing ≥70% prefix | **3** |

A >2× dedup ratio needs turns sharing ~85%+. **The drain has removed the ADJACENCY, not just the
volume** — what survives from a session is turns with gaps, and turns either side of a gap share
no transcript at all. So the test was selecting "the largest session group" and asserting a
property that only holds for *consecutive* turns, which its input no longer contained. It failed
honest code, at 1.9× when the card was written and 1.4× by the time it was worked.

**Fix: select on the property itself.** Adjacency is measurable from the bodies — an adjacent pair
shares a long common prefix — so the test now takes the longest run of pairs sharing ≥70% and
**skips with the measurement printed** when fewer than 5 exist. The floor stays at >2×.

**Lowering the floor was the tempting fix and would have been wrong**, which is why it was
falsified rather than argued: mutating the adjacency threshold to 0.50 makes a run available, the
assertion RUNS, and it fails at **1.5×** — proving the floor is still enforced and the skip is
about input availability, not a bypass. A test that skips must still be able to fail.

### How 0.70 was arrived at — two wrong derivations before the right one

The threshold is the fix's one load-bearing constant, so it was chased rather than asserted. Both
of the obvious derivations are WRONG, and they are recorded because each looks convincing alone.

**Wrong derivation 1 — the distribution's shape.** Consecutive-pair
prefix share across all sessions (n=363) is genuinely **bimodal**, but the modes do not split at 70:

```
  0–9%  : 90 pairs      ← gaps: share essentially nothing
 20–29% : 24
 30–39% : 5             ← the TROUGH, i.e. the natural separatrix
 40–59% : 19
 60–69% : 20
 70–99% : 205 pairs     ← adjacency
```

The trough is at **30–39%**, so a shape-derived threshold would sit near 35%, not 70 — and 35
admits runs that measure 1.5×, i.e. it fails the floor. Bimodality is real here but it separates
*adjacent from gapped*, which is not the same question as *what the assertion needs*.

**Wrong derivation 2 — the algebra.** For a chain sharing fraction f, ratio ≈ 1/(1−f), so
`ratio > 2 ⟺ f > 0.50`. Clean, and false: the measured 51%-mean run yields 1.5×, not 2×.

**The right one — sweep T and measure what each admitted run ACHIEVES:**

```
T=0.5  run=7  est-ratio=1.99   ← under the floor
T=0.6  run=7  est-ratio=1.99   ← under the floor
T=0.7  run=3  est-ratio=2.73   ← clears >2 with margin
T=0.8  run=3  est-ratio=2.73
T=0.9  run=3  est-ratio=2.73
```

**0.70 is the lowest threshold at which the assertion is satisfiable at all**, and the cliff is
sharp: 0.60 admits a longer run (7 turns) that measures **1.99** — under by a hair. So the
constant is principled, but on a basis neither obvious nor the one first written down: it is
"lowest T whose admitted run clears the floor", NOT the distribution's shape (whose trough is at
35%) and NOT a first-order model. The naive model `ratio ≈ 1/(1−f)` predicts f > 0.50 suffices;
measurement says it does not, because the first turn's constant ~268 KB tools array and the
per-turn unique content eat the margin. **Trust the sweep, not the algebra.**

### Retractions and unverified claims — recorded because they were nearly shipped as fact

- **RETRACTED: "the 0%-shared pairs prove sessions are interleaved by mtime."** That measurement
  came from a probe whose session extraction was broken (it reported 1 session for 400 bodies; the
  correct extraction finds 37). The inference was kept after the measurement producing it was
  discarded — the exact failure this project hunts. The aggregate means (34% / 51%) and the sweep
  above DO use correct grouping and stand on their own.
- **UNVERIFIED: "the drain removed the adjacency."** Stated as fact in the card and in a code
  comment; it is an inference from low prefix sharing plus a three-day-old card. At least three
  untested alternatives produce identical low sharing: **`/clear` and compaction boundaries**
  (guaranteed present — this session compacted), **subagent bodies filed under the parent's
  `session_id`** (`metadata.user_id`; this project's own cacheBreakTimeline card documents that
  exact behaviour for `agent-*` children, and several forks ran during this session), and
  **mtime ≠ turn order**. The FIX is robust to all of them because it selects on the property
  rather than the cause — but the diagnosis names one cause it never tested.

### The test now skips on this machine, and that is a real cost

Longest qualifying run is 3; it needs 5. Nothing here makes a qualifying run likelier. A
permanently-skipping test is better than a falsely-failing one and worse than no test, because it
occupies the slot where coverage appears to exist.

**The better long-term fix was dismissed too fast: a committed redacted fixture pair.** It was
ruled out on PII grounds, but `CLAUDE.md` documents a redaction PATH (`scripts/redact-spans.js`,
run before committing any fixture) rather than a prohibition — and a pinned fixture makes the test
deterministic on every machine and in CI, which is this card's own first suggestion. Worth its own
card if this keeps skipping.

## Notes and lessons learned

## Approval log

- 2026-08-22T20:35:00+0200 — COMPLETED by main (self-orchestrating; USER authorised). Tier 0.

  **Acceptance met, and re-run so it applies to the FINAL code.** Two green full-suite runs had
  already landed (138 s, 209 s) when two further edits went in — a comment block and the removal
  of a `.filter(Boolean)` from a provably non-empty array. Both are behaviourally inert, but
  "inert" was an assumption, and the criterion says green twice CONSECUTIVELY, so the suite was
  recompiled and run twice again against the shipped bytes: **377 s and 257 s, 2433 passing /
  0 failing / 9 pending**, with the server draining live throughout.

  Second clause also met: neither real-corpus test now depends on an unbounded or
  externally-mutated input without a skip-with-reason guard — `cacheBreakTimeline` bounds its
  input with `scanCap: 300` (already in place), and `bodyStore` selects its input by the measured
  property and prints its reason when the corpus cannot supply one.

  Gates: `check-types` 0, `lint` 0 (415 pre-existing warnings, 0 errors), `check-identities` 0.
