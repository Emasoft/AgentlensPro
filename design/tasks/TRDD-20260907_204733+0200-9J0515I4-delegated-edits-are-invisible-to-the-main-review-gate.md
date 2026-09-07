---
trdd-id: 9J0515I4
title: A delegated edit is invisible to the main review gate
column: todo
created: 2026-09-07T20:47:33+0200
updated: 2026-09-07T20:47:33+0200
current-owner: main-session
task-type: bugfix
min-approval-requirement: none
project-id: agentlenspro
relevant-rules: []
---

# A delegated edit is invisible to the main review gate

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-07

VERIFIED, not inferred. `src/cli/reviewGate.ts` `scanMainTranscriptLines`, the tool_use branch:

```ts
if (b.name === 'Agent' && b.input?.subagent_type === 'fork') { lastFork = i; continue }
if (typeof b.name === 'string' && EDITORS.has(b.name)) { lastWork = i; continue }
if (b.name === 'Bash' && /\bgit\s+commit\b/.test(unquoted(...))) lastWork = i
```

An `Agent` tool_use whose `subagent_type` is anything other than `fork` matches **neither**
branch: `'Agent'` is not in `EDITORS`, and it is not a Bash commit. So it sets neither
`lastFork` nor `lastWork`.

CONSEQUENCE: a turn whose only change is `Agent(subagent_type: 'lean-worker', "edit file X")`
ends with `lastWork` unchanged. If no prose block precedes it in that turn, the gate releases
and the edit ships unreviewed. **This is live, and the main session used exactly this shape
several times on 2026-09-07** (dashboard work delegated to `a106e8229`, cap work to
`aaee5dca`).

Why the exposure is smaller than it first looks — and why it is still real: in practice the
delegating turn almost always also emits prose describing the delegation, and any prose block
sets `lastWork`. So the gate usually fires anyway, **for the wrong reason** — it is reviewing
the sentence, not the delegation. A silent delegation (tool_use with no accompanying text)
is the case that escapes entirely.

NEXT ACTION: decide the policy question below before writing code. Do NOT just add
`b.name === 'Agent'` to the work set — see the trap.

## The trap that makes this non-obvious

The naive fix — treat every non-fork `Agent` tool_use as work — **breaks the fork itself**.
Read the branch order: the fork check runs first and `continue`s, so a fork would still be
exempt. But a *reviewer* dispatched under any other agent type (the plugin reviewers, `judge`,
`chk-review-opus-agent`) would then set `lastWork` and demand a review of the review. That is
the same class of bug `6610fba5` fixed on the subagent side, arriving from the other direction.

The second-order problem: the delegating turn cannot know whether the delegate edited
anything. A `lean-worker` sent to *read* a file is not work; the same worker sent to *edit*
one is. The gate sees only the dispatch.

## Candidate resolutions (pick one, do not stack them)

1. **Count every non-reviewer `Agent` dispatch as work.** Simplest, over-fires on read-only
   delegations. Reuses `REVIEWER_AGENT_TYPES` for the exemption, so the reviewer question is
   already answered and stays answered in one place.
2. **Let the subagent's own SubagentStop gate cover it.** Already true today for a delegate
   that has no Agent tool: `agentCannotSpawn` releases it, so nothing reviews its edits either
   — this option is a no-op dressed as a decision. Reject unless that release is also revisited.
3. **Read the delegate's transcript for edits.** Correct and expensive; the sidechain file is
   on disk and `isSidechain` lines are already skipped by the main scanner, so the plumbing
   exists. Highest fidelity, most code.

## Also found in the same read, and NOT covered by this card

`scanMainTranscriptLines` compares `subagent_type === 'fork'` **case-sensitively**, while
`scanSubagentTranscriptLines` normalizes with `.trim().toLowerCase()` (line 558). The two
halves disagree. No harm observed — the harness emits lowercase `fork` — but the asymmetry is
a latent inconsistency and belongs in whichever change touches this branch.

## Acceptance

- [ ] A policy is chosen and written into the code as a comment naming the rejected options.
- [ ] A unit test in `src/test/reviewGate.test.ts` asserts a silent delegation (an `Agent`
      tool_use with a non-fork `subagent_type`, no text block in the turn) does NOT release
      the main gate.
- [ ] A unit test asserts a reviewer dispatch still does not arm the gate against itself.
- [ ] The `fork` comparison is case-normalized on both sides, or the asymmetry is documented
      as deliberate with its reason.

## Provenance

Found while acting on the review-fork findings for commits `6610fba5`..`c904a00a`
(2026-09-07). Two independent reviews advised carding this one gap rather than accumulating
more. The hole predates the whole 2026-09-07 chain — `6610fba5` did not create it.
