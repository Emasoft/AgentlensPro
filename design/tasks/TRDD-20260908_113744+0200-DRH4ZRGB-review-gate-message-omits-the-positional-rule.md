---
trdd-id: DRH4ZRGB
title: The review-gate block message omits the positional rule its own instruction violates
column: ai_review
created: 2026-09-08T11:37:44+0200
updated: 2026-09-10T09:55:17+0200
current-owner: main-session
task-type: bugfix
scope: project
min-approval-requirement: none
implementation-commits: [e7d1d3c7, 4521dea7, a18ff9f1]
eht: [7FA3NIXU]
---

# The review-gate block message omits the positional rule its own instruction violates

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-10 09:55

The message work is DONE: all three §Acceptance rows ticked, landed as `e7d1d3c7` + `4521dea7`,
assertions made real guards in `a18ff9f1` (which also split out TRDD-7FA3NIXU); all three in
`implementation-commits`. No review pass is recorded on this card for them. NEXT ACTION:
`ai_review` of those three commits — one fork over their combined diff of `src/cli/reviewGate.ts`
+ `src/test/reviewGate.test.ts`. Before close, execute §⚠ DO NOT CLOSE (two relocations; its
table is the list). Cannot reach `complete` until TRDD-7FA3NIXU (`eht:`) is terminal — it bars
the close, not the review. No approval needed — see the next paragraph.

Filed `proposal` / `user` at first. That was wrong and is corrected: this card's landed content
is ONE clause in a block message and the assertions that pin it, and its own third acceptance
criterion says the predicate is unchanged. Disclosing a rule the gate already enforces **implements** the owner's
never-bypass order (2026-09-03); it does not revise it. Tier 0. The test that catches it is the
one already applied to the sibling card and then not applied here — metadata inheritance across
a card split is the trap, and this card is where it bit twice.

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
   requires the review fork be SYNCHRONOUS, never `run_in_background`. **CORRECTION, same day:**
   this card first said that rule was "currently unimplementable" because the Agent tool
   auto-backgrounds forks. That was wrong. `TaskOutput` with `block: true` on the returned id
   consumes the fork inside the spawning turn, and consuming it is exactly what matters — see
   §The loop.

## The passing shape exists, and my model of the turn boundary was wrong

Settled by review, not by probing. The gate IS satisfiable by a turn that answers the user:

> **One response carrying the user-visible text FIRST and the `Agent` fork `tool_use` as its
> FINAL content block — then emit nothing when the tool_result returns, ending the turn.**

Text before the fork is free; text after it is fatal. What broke it here was **splitting the
text and the fork across two responses**: the fork-only response produced no user-visible
output, the harness injected a complaint turn, and answering that complaint with text-only is
what actually fired the gate. The gate never fired on the fork-only response. My earlier
reasoning placed the turn boundary in the wrong place and concluded the gate was
unsatisfiable-by-construction; it is not, and this card's narrow scoping (the message is
incomplete) is therefore the correct scope.

**Load-bearing and still unverified:** "one transcript entry per content block". If the scan
instead walks one entry per RESPONSE, `[text, fork]` share an index and the `>=` comparison —
not strict ordering — is what lets it pass. Both models yield the same executable shape, so the
recipe above is safe either way; every COST claim derived from the positional rule is not.
Falsifier: count JSONL lines produced by one response containing text plus a tool_use.

## The loop, and who drives it

Backgrounding is the cascade source: a fork's completion notification manufactures a fresh
turn, that turn must emit text, text re-arms the gate, the block demands another fork, and that
fork will notify later. Self-sustaining, terminating only on user input.

**But the gate cannot cause this on its own** — it fires only when a turn produces work. Every
cycle in this session was started by a decision to emit another text block with no user
present. The gate is the amplifier; the repeated choice to answer an empty room is the driver.
Recorded here explicitly because a card that says "the gate loops" produces a patch to the gate
and the behaviour recurs.

Two consequences worth keeping:

- **Consume the fork in-turn** (`TaskOutput block: true`) so no later notification exists to
  force the next turn. This is the terminating action that needs no code change.
- **Do not bundle a deliverable into a gate-mandated spawn.** It makes the loop survivable, and
  a review bundled with a generative task is systematically weaker than the same review alone —
  attention flows to the job with the crisp success criterion.

## A cost property of the gate, distinct from the message defect

The scan runs over the 4 MB window, not over the turn, so `lastWork` is a global maximum:
**every answering turn must spawn its own fork, forever.** The gate is satisfiable but not
amortizable. A minimal change preserving both owner orders would anchor the scan at the last
user entry and allow when a fork sits above every arming index *in that turn* — text after a
turn's fork is the report-out of already-reviewed work, not new unreviewed work. Not proposed
here; noted so the property is not rediscovered as a bug. If it is ever implemented,
TRDD-W0ZTTUBA's empty-window case must be re-derived against the new anchor.

## Cost, measured on the session that found it

Gate fires on a `[janitor-heartbeat]` that performed no authored work. **Every figure here is a
FLOOR** — the session was still running when they were written, and an earlier revision of this
paragraph said "six" after the count had already passed eight, which is the exact imprecision a
paragraph about accurate self-attribution cannot afford.

Ten forks in this chain reported **2,421,519** `subagent_tokens` between them:

| | | | | |
|---|---|---|---|---|
| 213,865 | 234,800 | 217,457 | 241,260 | 258,325 |
| 267,737 | 237,208 | 245,702 | 249,940 | 255,225 |

These are each agent's own harness-reported `<usage>` figures — unverified, unweighted, and NOT
a cost figure (raw tokens are not cost until weighted by cache-read/write rate). The series
trends upward but is **not** monotonic (217,457 follows 234,800); an earlier claim here that it
rose monotonically was wrong.

**One of the ten (237,208) returned zero findings.** It echoed a board-status summary instead of
reviewing. A fork inherits the whole parent transcript, whose strongest local pattern is "the
assistant owes the user a status reply", and a prompt that does not forcibly displace that
identity loses to it. Three amplifiers, all present in that prompt: the reviewed material was
pasted as first-person status prose, the mandatory questions sat *after* a long paste, and
nothing said "you are not the parent". Cost of learning that: 237,208 tokens for no review.

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

- [x] The blocked agent can learn the positional rule from what it is shown, without reading
      source. `e7d1d3c7` put it in `MAIN_BLOCK_REASON`; `4521dea7` corrected it.
- [x] A turn that spawns the fork and then reports to the user does not re-fire the gate — or the
      message tells it not to do that. The message tells it: fork LAST, no further TEXT after,
      and do not split text and fork across two responses.
- [x] The predicate is unchanged (owner order 2026-09-03: the gate is never stopped or bypassed).
      Two string constants and four tests; `decideMainGate` untouched.
**Not a fourth box.** `4521dea7` added assertions so neither surface can silently lose the rule,
and a later commit strengthened them. That is evidence for box 1, not a criterion: a checkbox
authored *after* the work it describes has probability zero of failing at authoring time, so it is
a changelog line wearing a checkbox. It was briefly added and ticked in one edit; removed.

**What the assertions actually cover, after the strengthening.** The first version was mostly
spell-checks — `!/HIGHER/` catches one English word while "strictly after", "greater than" and
"must come later than" express the same wrong strict inequality and all passed; and
`/fork[\s\S]{0,80}LAST/` was co-occurrence, negation-blind, green on "Never put the fork tool_use
LAST". **? INFERRED, not measured** — deleting "AT OR AFTER" from the directive would have left
every assertion green, read off the four regexes (none referenced the phrase); the deletion was
never actually performed and the old assertions never re-run against it. The conclusion is almost
certainly right, which is exactly why filing it under "Measured" was wrong: a correct claim
certified by a method that was not used is indistinguishable, to a later reader, from the measured
figures beside it. It made `4521dea7`'s own subject ("assert it cannot silently rot") false. Now: the boundary phrase is
asserted POSITIVELY, the imperative is matched as a phrase with negation guards, the
`!/TaskOutput/` policy-as-CI test is replaced by a positive assertion on the consequence sentence
(a bare ban also fires on a sentence *warning* against it, and warning requires naming), and the
predicate is pinned in BOTH directions — `(4,4) → release` and `(4,3) → block`, because
`block === false` alone is satisfied by a gate that never blocks.

## ⚠ DO NOT CLOSE THIS CARD YET — it must be SPLIT first

The three acceptance boxes above cover the message, which is done. But this card has accumulated
three sections that are **not this card's task** and have **no acceptance criteria of their own**.
Closing it would freeze them (terminal columns are frozen) inside a document whose title mentions
none of them — content deleted with extra steps.

| section | what it actually is | belongs |
|---|---|---|
| §The passing shape exists | knowledge, no "done" state | PROJECT wikimem page, recall by symptom |
| §The loop, and who drives it | a behavioural lesson | TRDD-T2N1GOZ2, which is already that subject (a LOCAL-scope card — the id stays as prose, it must not enter any frontmatter field) |
| §A cost property of the gate | a **separate defect with its own fix** (scan anchored at the window, not the turn ⇒ every answering turn pays a fork; the fix is anchoring at the last user entry) | **DONE — split out as TRDD-7FA3NIXU**, recorded in `eht:` so this card cannot reach `complete` until it is terminal |

The §Tier paragraph above lectures about metadata inheritance across a card split being "the trap
that bit twice" — written into a card that was itself refusing to split. Recorded rather than
quietly fixed, because the irony is the evidence.

**Also open, found while landing this and NOT part of it:** `pnpm run compile` fails at
`check-duckdb-only` on `main` — store-opener caps exceeded, 24 > 22 non-test and 15 > 14 test,
against a guard whose own text says the caps may only go DOWN. Someone added openers. That is a
live regression, discovered here and left in place; it needs its own card, not a paragraph in a
commit body, or the next commit inherits "compile fails, unrelated" without re-deriving it.
