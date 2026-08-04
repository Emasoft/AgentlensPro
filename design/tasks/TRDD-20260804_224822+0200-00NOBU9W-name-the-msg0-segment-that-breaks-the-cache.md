---
trdd-id: 00NOBU9W
title: Name the msg[0] segment that breaks the cache instead of filing it as usertext
column: todo
created: 2026-08-04T22:48:22+0200
updated: 2026-08-04T22:48:22+0200
current-owner: session
task-type: feature
relevant-rules: []
npt: []
eht: []
---

# Name the msg[0] segment that breaks the cache instead of filing it as usertext

## The finding (measured, not suspected)

Immediately after TRDD-B9ERTBZ9 shipped its TIER 1 causes, the classifier was run over the last 24 h
of real captured bodies: **115 classified events, 6.95 M cache_creation tokens, and `UNCLASSIFIED`
still the single largest bucket at 32.4% (39 events, 2.25 M tokens)** — unchanged, because none of
the newly modelled causes is what is producing it.

The dominant real shape, straight from the events' own `rawDiffSummary`:

```
turn  87  cc   6,962  cr 252,424  | usertext block changed at pos 46: msg[0] user; sys=3 msg=67 (was 68)
turn 349  cc  10,263  cr 206,728  | usertext block changed at pos 46: msg[0] user; sys=3 msg=47 (was 54)
turn 350  cc 199,874  cr   4,486  | usertext block changed at pos 46: msg[0] user; sys=3 msg=56 (was 47)
turn 356  cc 199,861  cr   4,486  | usertext block changed at pos 46: msg[0] user; sys=3 msg=54 (was 55)
```

So the break IS localised — to a specific segment index of the giant injected FIRST user message —
and then thrown away, because `classifyContentKind` has no kind that matches that segment's text and
`usertext` maps to `UNCLASSIFIED`. The classifier knows *where*; it cannot say *what*.

## Why this is its own task, not a B9ERTBZ9 leftover

B9ERTBZ9's scope was the DOCUMENTED cause list (what the API/CC docs say invalidates a prefix). This
is the opposite problem: the invalidation mechanism is already understood, and what is missing is
**content classification of the segments inside msg[0]** — a local taxonomy question about what
Claude Code injects, answerable only by reading real bodies.

## What the work is

1. Take the real breaks above and extract the offending segment's TEXT from the raw bodies (locally,
   never into a report — msg[0] carries CLAUDE.md, memory, and machine paths).
2. Group the offenders by what they actually are. `segmentInjected` splits on `Contents of <path>`
   boundaries, so a segment at position 46 of msg[0] is most likely one of the many rule files, a
   memory page, or an un-bounded stretch between two boundaries.
3. Add the kind(s) — and, where the perpetrator is identifiable, a `hookSignature`-style backtrace so
   the repeat-offender rollup can collapse them into ONE named actor.
4. Re-measure the same window and report the UNCLASSIFIED share before/after. **A change that does
   not move that number is not done**, whatever the tests say.

## Constraints carried over

- POINTER-ONLY: kinds and short labels cross the boundary, never segment text.
- A kind that cannot be emitted from real captured bodies must not be added.
- Verify against REAL bodies; synthetic fixtures hid both method errors in TRDD-V8YOWHVT.

## Evidence

The measurement above, taken 2026-08-04 22:40 +0200 against the live spool immediately after
commit `05497e8`. Parent context: TRDD-B9ERTBZ9 (STATE block), TRDD-V8YOWHVT.
