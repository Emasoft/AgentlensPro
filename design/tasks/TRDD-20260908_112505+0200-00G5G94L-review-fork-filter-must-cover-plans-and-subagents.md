---
trdd-id: 00G5G94L
title: The adversarial review fork must cover proposals and sub-agents, with a recursion guard that cannot self-trigger
column: todo
created: 2026-09-08T11:25:05+0200
updated: 2026-09-08T11:25:05+0200
current-owner: main
task-type: infra
min-approval-requirement: none
priority: high
severity: medium
blocked-by: []
npt: []
eht: []
implementation-commits: []
project-id: agentlenspro
scope: project
labels: [review-gate, hooks, subagents, agentlenspro]
---

# The adversarial review fork must cover proposals and sub-agents

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-08 11:25

**NOT STARTED. Nothing here has been investigated, designed, or implemented.** The card exists
because these were spoken owner directives that had gone ~16 hours uncarded while other work
proceeded, which is the exact failure `~/.claude/rules/new-directive-never-drops-the-old-work.md`
and the project's every-change-gets-a-TRDD rule both name: a directive left where it fell, with
nothing on the board asserting it is owed.

**This card is a RESCUE, not a design.** It bundles four directives that are related but probably
not one atomic task (TRDD rule 13). Splitting is expected once someone reads the review-gate code;
the bundle exists because the alternative at the moment of writing was losing them to a context
compaction. **Do not treat the bundling as a considered decision.**

**No verification of any kind has been done** — not that the current filter behaves as (a)
describes, not that sub-agents lack coverage per (b), not that a recursion problem exists per (c),
not that the Stop hook differs from the fork per (d). Every one of those is the OWNER'S
description of the system, recorded faithfully, and **not yet checked against the code**. First
action on resume is to verify each premise before designing anything.

## WHY — the directives, verbatim

Spoken by the owner (2026-09-07 evening, before the compaction that opened this session):

- **(a)** *"have you updated the installed agentlenspro so that the filter on the adversarial
  review hook was fixed as i requested? to also review the descriptions and the planning of
  changes, not only the changes written or committed to disk?"*
- **(b)** *"verify that the fork new filter works even in sub-agents... except for the adversarial
  review fork agents themselves, of course, to avoid infinite recursion"*
- **(c)** *"improve the recursion guard to prevent such issue"*
- **(d)** *"verify that such issues are not present in some form even in the main agent adversarial
  review stop hook. both must be flawless."*

Two further directives from the same exchange concern stalled workers and are recorded here only
so they are not lost; they are operational, not code changes, and may not belong on this card:

- **(e)** *"the lean-workers looks freezed, maybe you should wake them up with a sendmessage"*
- **(f)** *"those subagents need to be recovered"*

## What (a) is actually asking for, as best understood

The gate today fires on turns that **edited or committed** — it keys on writes that already
happened. The owner wants it to also cover a turn that **describes or plans** a change, which is
the `propose-then-review` shape: the review's leverage is highest before the write, because a
proposal review can prevent a defect where a post-write review can only report one.

Whether the installed binary already does this is **unverified** — (a) is phrased as a question
about whether a previously-requested fix was applied, so the first step is to establish the
current behaviour, not to assume either answer.

## Acceptance

1. The current filter's trigger conditions are read from the shipped source and stated, before any
   change is designed. Answer (a)'s literal question: was the fix applied to the *installed*
   `agentlenspro`, which may be a published global install rather than an `npm link` to this repo.
2. A turn that proposes or plans a change, without writing to disk, triggers the review — asserted
   by a test, not by inspection.
3. The filter's behaviour inside sub-agents is established by measurement, and covered.
4. The review-fork agents themselves are exempt, and the recursion guard is shown to be
   non-self-triggering — a test drives the exemption path and asserts no recursion.
5. The Stop hook and the fork gate are compared explicitly; any divergence is either removed or
   recorded with its reason. (d) says "both must be flawless", so a difference that is deliberate
   still has to be written down.
6. Each acceptance box above is mutation-verified where it asserts behaviour: the assertion is
   shown to go RED when the thing it guards is broken. A green assertion never observed failing is
   not coverage — this was measured four separate times on TRDD-WKLD508O during 2026-09-08.

## Derived risks

- **The installed executable may not be this repo.** `agentlenspro` can resolve to a published
  global install; rebuilding here then measuring "the live server" silently measures the published
  bundle. Check what `which agentlenspro` resolves to before drawing any conclusion (CLAUDE.md
  records this trap).
- **A recursion guard is exactly the shape that fails toward silence.** If it over-matches, the
  gate stops firing and nothing reports that it stopped — the failure is invisible, which is the
  worst property a guard can have. Any guard added here needs a test that fails when the guard
  over-matches, not only when it under-matches.
- **A hook registration change needs a session restart** to take effect, so a "it didn't work"
  observation immediately after editing is not evidence about the code.
- (e)/(f) may be stale: those workers were observed frozen on 2026-09-07 and the session has since
  compacted. Verify they still exist before trying to recover them; do not act on a 16-hour-old
  process observation.
