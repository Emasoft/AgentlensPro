---
trdd-id: DRH4ZRGB
title: The review-gate block message omits the positional rule its own instruction violates
column: proposal
created: 2026-09-08T11:37:44+0200
updated: 2026-09-08T11:40:48+0200
current-owner: main-session
task-type: bugfix
scope: project
min-approval-requirement: user
---

# The review-gate block message omits the positional rule its own instruction violates

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-08

MEASURED, from source and from the deployed bundle. Not yet fixed. NEXT ACTION: decide
between the one-clause message fix and the wider async-fork question in §Two defects.

## What happens

`decideMainGate` (`src/cli/reviewGate.ts`) allows a Stop iff `scan.lastFork >= scan.lastWork`.
`scanMainTranscriptLines` sets `lastWork = i` on **any** assistant `text` block — deliberate,
per the owner order recorded in that file ("A PROPOSAL IS WORK", 2026-09-07) — and sets
`lastFork = i` on an `Agent` tool_use whose `subagent_type` is `fork`. The build in use writes
one transcript entry per **content block**, so a `text` block emitted **after** the fork spawn
takes the higher index and re-arms the gate.

`MAIN_BLOCK_REASON` — the text the blocked agent actually reads — says:

> Spawn ONE adversarial fork … then act on the findings.

The fork is asynchronous, so its findings cannot exist within the spawning turn. The only
in-turn reading available is *spawn, then reply* — and the reply is the `text` block that
re-arms the gate. The rule that would prevent this is stated only in a code comment
(`THE EXIT IS POSITIONAL … Spawn the review as the turn's final act, not mid-turn`), which the
constrained agent never sees. `review-gate --directive` does not state it either.

## Two defects, separable

1. **The message is incomplete.** One clause would close it: *spawn the fork as your turn's
   final block; any prose after it re-arms this gate.* Does not touch the owner-ordered
   predicate.
2. **The async spawn is the primary cause.** `~/.claude/rules/propose-then-review-then-implement.md`
   requires the review fork be SYNCHRONOUS, never `run_in_background`. The Agent tool as
   exposed here auto-backgrounds forks and offers no synchronous option, so that rule is
   currently unimplementable — which is a finding in its own right and may be the better fix.

## Cost, measured on the session that found it

Six consecutive gate fires on a `[janitor-heartbeat]` that performed no authored work.
Six forks belonging to this chain reported **1,433,444** `subagent_tokens` between them
(213,865 + 234,800 + 217,457 + 241,260 + 258,325 + 267,737), with more in flight. These are
each agent's own harness-reported `<usage>` figures — unverified, unweighted, and NOT a cost
figure (raw tokens are not cost until weighted by cache-read/write rate).

## What is established, and what is not

**✓ VERIFIED IN THE ARTIFACT** — `command -v agentlenspro` → `readlink -f` resolves to this
repo's `standalone/cli.js` (npm link; no published-global ambiguity), and that bundle contains
`scan.lastFork >= scan.lastWork` with two `lastFork = i` and three `lastWork = i` assignment
sites. That is the arming-and-clearing skeleton of ONE function, and nothing more.

**⚠ SOURCE-VERIFIED, ARTIFACT-UNVERIFIED** — `isNoReviewSentinel`'s `startsWith`, `split('\n')`,
`tail.some(...)` later-line rejection and `[\s—:-]+` separator strip were read in source only.
The bundle grep returned the bare constant `NO REVIEW POSSIBLE"` and stopped — `[^;]{0,220}`
consumed nothing past it — so it established that the STRING shipped, not that the PREDICATE
did. Same status: `isSidechain` filtering, `readTranscriptTail`'s window, `EDITORS` membership,
the `git commit` regex.

**✗ UNDECIDABLE ON THIS EVIDENCE, not merely unmeasured** — whether the sentinel turn released
or blocked. Every later turn re-arms the gate independently, so a fire after the sentinel turn
is predicted whether or not the sentinel matched. Do not re-run this non-experiment.

**✗ INHERITED, NOT VERIFIED** — "one entry per content block", taken from a source comment
citing a 2026-09-07 measurement.

## NOT a defect: the gate and its supervisor disagree BY DESIGN

`[review-supervisor]` reported "3 change(s) have landed with no adversarial review after them
(9 review forks, 3 consequential actions)" on a turn the gate had released. That looks like two
components contradicting each other on one transcript. It is not — they ask different questions,
and `src/cli/reviewSupervisor.ts` says so outright (`Enforcement is the gate's job; this one only
has to be` advisory):

| | counts as work | verdict |
|---|---|---|
| gate, `scanMainTranscriptLines` | `text` blocks **+** `EDITORS` **+** `git commit` | hard block, positional `lastFork >= lastWork` |
| supervisor, `scanSupervision` (:42-57) | `EDITORS` **+** `git commit` only — **no text branch** | advisory; `unreviewed` resets to 0 on a fork, increments per edit |

Both were right about the same turn: three `Write`/`Edit` calls landed with the fork arriving in
a *later* response, so the supervisor's counter read 3; and separately my prose sat after the
fork, so the gate blocked. Recorded here so the next reader does not re-open it as a conflict.

## Adjacent: the 4MB tail window — TRDD-W0ZTTUBA (INDEPENDENT, not an EHT)

Found alongside this card while reading `reviewGate.ts`; that is a discovery-moment relationship,
not a causal one. W0ZTTUBA is pre-existing and fixing this card's message causes nothing it must
handle, so it is deliberately NOT recorded as an `eht:` — that field would block this card from
reaching `complete` on an unrelated, unreproduced fail-open.

`decideMainGate` returns `block: false` when `lastWork === -1`, **before** consulting `lastFork`
— a fail-open in a gate the owner ordered never bypassed. That is a different defect class from
this card (correctness vs message wording) with a different lifecycle, so it lives in its own
card. Measurements are there.

## Adjacent: a flush-race on the fork entry — noted, not carded

Nothing guarantees the harness flushes the assistant entry carrying the fork `tool_use` before
the Stop hook `fstat`s and reads the file. Unverified in both directions — but it predicts
*intermittent* fires, and the six observed fires were six-for-six explained by the positional
rule, while the three fork-last turns all passed. No evidence it has bitten.

## Acceptance

- [ ] The blocked agent can learn the positional rule from what it is shown, without reading source.
- [ ] A turn that spawns the fork and then reports to the user does not re-fire the gate — or the
      message tells it not to do that.
- [ ] The predicate is unchanged (owner order 2026-09-03: the gate is never stopped or bypassed).
