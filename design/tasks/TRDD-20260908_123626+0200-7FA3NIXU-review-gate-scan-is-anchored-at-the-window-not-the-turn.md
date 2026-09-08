---
trdd-id: 7FA3NIXU
title: The review gate charges every answering turn a fork because its scan is anchored at the window
column: backburner
created: 2026-09-08T12:36:26+0200
updated: 2026-09-08T12:36:26+0200
current-owner: main-session
task-type: refactor
scope: project
min-approval-requirement: none
parent-trdd: DRH4ZRGB
---

# The review gate charges every answering turn a fork because its scan is anchored at the window

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-08

Split out of TRDD-DRH4ZRGB, which had accumulated it as a section with no acceptance criteria —
it would have been frozen inside that card when its message boxes ticked. NEXT ACTION: the owner
decides whether to change the anchor at all. Nothing has been edited in the gate.

## The property

`scanMainTranscriptLines` walks the last 4 MB of the transcript, so `lastWork` is a **global
maximum over the window**, not over the current turn. `decideMainGate` then releases only when
`lastFork >= lastWork`.

Consequence: an assistant text block from ANY earlier turn still in the window keeps `lastWork`
high, so **every turn that answers the user must spawn its own fork** — the release is never
inherited. The gate is satisfiable but **not amortizable**.

This is a distinct defect class from TRDD-DRH4ZRGB (which is about the block message's wording).
It has its own fix, its own risk, and its own acceptance criteria, which is why it is its own
card.

## Why this is not simply "working as intended"

It is arguably intended — a proposal in a later turn SHOULD arm the gate (owner order 2026-09-07,
"A PROPOSAL IS WORK"). The defect is narrower: **narrating a review that already happened is
charged as if it were new unreviewed work.** A turn whose only text is the report-out of findings
from a fork spawned in that same turn has nothing unreviewed in it, and pays a full fork anyway.

Measured cost of that on one session: ten forks, 2,421,519 reported `subagent_tokens`, on a
`[janitor-heartbeat]` fire that authored nothing. Those figures are each agent's own
harness-reported `<usage>` — unverified, unweighted, and NOT a cost figure until weighted by the
cache-read/write rate.

## Sketch of a fix — NOT proposed, and deliberately so

> Anchor the scan at the **last user entry** instead of the window start, and allow when a fork
> exists at an index greater than every arming index **in that turn**.

Both owner orders survive: the gate still runs on every turn and is never bypassed (2026-09-03),
and a proposal in a LATER turn still arms it, because that turn's own scan finds no fork after it
(2026-09-07). What it stops doing is charging a second fork for narrating an already-completed
review.

**This is a sketch, not a design.** Three things must be settled before it is one:

1. **What delimits "the turn"?** A user entry is the obvious anchor, but a task-notification and a
   harness prompt both arrive as user-role entries. If those count, an agent could bank a fork and
   then narrate freely across notification-driven turns — which is the loop this would be trying
   to bound, re-entering by the back door.
2. **TRDD-W0ZTTUBA's empty-window case must be re-derived against the new anchor.** The
   `lastWork === -1` fail-open is currently reasoned about relative to a 4 MB window; a per-turn
   anchor makes an empty scan *ordinary* (any turn with no arming block yet), so the same early
   return means something entirely different. Re-deriving it is part of this card, not a follow-up.
3. **It changes when agents are blocked**, which is user-visible behaviour on a mandatory gate.
   That is why `min-approval-requirement: user`.

## Acceptance

- [ ] The return site in `decideMainGate` carries a comment stating whether the window anchor is
      deliberate, and `reviewGate.test.ts` asserts whichever behaviour was chosen. **False today,
      false until someone does the work, true under either decision** — that is the property an
      acceptance criterion needs, and the first draft of this box did not have it: "a decision is
      recorded: change it or keep it" is satisfied by writing one sentence either way, which makes
      it a discussion prompt wearing a checkbox. Exactly the defect removed from TRDD-DRH4ZRGB in
      the same commit that created it here; the correction had not generalised from the instance.
- [ ] If changed: a turn that spawns a fork and then reports its findings does not re-fire the
      gate, and a turn that edits after its fork still does.
- [ ] If changed: the "what delimits a turn" question above is answered in the code, with a
      notification-driven turn as an explicit test case.
- [ ] If changed: TRDD-W0ZTTUBA's empty-window case is re-derived against the new anchor and that
      card is updated with the result.
- [ ] Both owner orders are demonstrably intact (2026-09-03 never bypassed; 2026-09-07 a proposal
      is work).
