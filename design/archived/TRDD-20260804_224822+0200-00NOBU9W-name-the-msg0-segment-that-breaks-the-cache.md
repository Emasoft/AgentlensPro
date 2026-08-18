---
trdd-id: 00NOBU9W
title: Name the msg[0] segment that breaks the cache instead of filing it as usertext
column: completed
created: 2026-08-04T22:48:22+0200
updated: 2026-08-18T12:45:00+0200
current-owner: session
task-type: feature
relevant-rules: []
npt: []
eht: []
---

# Name the msg[0] segment that breaks the cache instead of filing it as usertext

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-04T23:2x+0200

**DONE — but the premise below was WRONG, and that is the finding.** The segment was never
unclassifiable: it is the **sub-agent's TASK PROMPT**, i.e. `msg[0]` is the CONVERSATION's identity,
not a mutable block. Two requests whose `msg[0]` prompt text differs are **different conversations
sharing one session id** (sub-agent calls carry the parent's), so nothing broke — each stream keeps
its own cache. No new content kind was added; the fix is one identity test in `diffBlocks`, and such
pairs now classify as `SUBAGENT_INTERLEAVE` (an EXPECTED cause, out of the avoidable ranking).

**Measured, 2,003 consecutive real turn-pairs:** 397 diverge first exactly there; every sampled one is
a distinct agent prompt ("You are doing a CODE REVIEW of…", "You are auditing source files…", a
review-target line). The existing A→B→A signature could not catch them — it keys on model + tool
catalog, and two sub-agents of the same type share both.

**Done-condition (the UNCLASSIFIED share must MOVE) — met**, same 24 h window, same `minTokens`:

| | before | after |
|---|---|---|
| `UNCLASSIFIED` | 39 events · 2,249,814 tok · **29.1%** | 4 events · 459,248 tok · **5.7%** |
| verdict | *"Dominant AVOIDABLE perpetrator: usertext block changed at pos 39: msg[0] user (UNCLASSIFIED) — 23.2%"* | *"…: model claude-sonnet-5 → claude-opus-5 (MODEL_SWITCH) — 14.4%"* |
| `MEMORY_FILE_CHANGED` | buried | surfaced: 251,494 tok, 3.1% |

(The window moved between the two runs — 125→127 events — so read the ABSOLUTE UNCLASSIFIED drop,
2.25M → 0.46M, not the event-count delta.)

**The load-bearing detail a later reader must not undo:** the test requires kind `usertext` on BOTH
sides. The harness injects CLAUDE.md, the rules and the memory index INTO `msg[0]`, and those DO
change mid-conversation — a memory rewrite alone was 19% of classified break tokens on this machine.
They carry their own kinds, so they keep their own causes; a compaction rewrite of `msg[0]` is
`postcompact` and is claimed earlier. Four regression tests pin exactly this.

**NEXT ACTION:** human review. Shipped in 2.23.0 alongside TRDD-B9ERTBZ9.

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

## Approval log

- 2026-08-14T02:30:00+0200 — COMPLETED (human_review → complete). Reviewed under the owner's
  standing delegation ("review them yourself... based on verified facts"): every load-bearing claim
  verified first-hand against current code with file:line evidence — see
  reports/trdd-review/20260814_015508+0200-batch3-review.md (this card's section); the "four
  regression tests" count reads as 3 pinned SUBAGENT_INTERLEAVE references in
  src/test/cacheBreakTimeline.test.ts — wording nit, core claims confirmed. No contradiction found;
  open residuals, where any, are recorded in that report and are non-blocking.
- 2026-08-18T12:45:00+0200 — ARCHIVED by USER batch directive ("complete all TRDD"); validity
  re-verified: src/cacheBreakTimeline.ts defines SUBAGENT_INTERLEAVE, used in
  src/test/cacheBreakTimeline.test.ts.
