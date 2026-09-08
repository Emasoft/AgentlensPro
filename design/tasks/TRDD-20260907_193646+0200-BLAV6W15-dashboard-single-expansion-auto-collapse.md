---
trdd-id: BLAV6W15
title: Only one node may be expanded in the dashboard at a time — expanding one collapses the rest
column: human_review
created: 2026-09-07T19:36:46+0200
updated: 2026-09-08T10:33:37+0200
current-owner: main
task-type: feature
parent-trdd: 7YPQWKPG
min-approval-requirement: none
priority: high
severity: medium
blocked-by: []
npt: []
eht: []
implementation-commits: [3da5ef49, 63926a3f]
project-id: agentlenspro
scope: project
labels: [dashboard, preact, memory, media]
---

# Only one node may be expanded in the dashboard at a time

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-08 10:33

**⚠ WHAT SHIPPED DOES NOT MATCH THE DIRECTIVE'S LITERAL WORDS.** Read this before assuming the
card is done. The directive said *"only one leaf/branch/trace/session can be expanded at any
time"*; what is deployed (`3da5ef49`) is **one session + one branch** — one PATH from root to
leaf, siblings collapsed at every level. That is a deliberate deviation, not an oversight, and
the owner has not been asked to accept it. The card sits in `human_review` for exactly that
decision. Guard hardening landed after in `63926a3f`.
Implemented semantics are **one session + one branch** expanded, i.e. **one PATH from root to leaf**,
with all siblings collapsed at every level. The directive's words were *"only one leaf/branch/trace/
session can be expanded at any time. expanding one branch, must collapse all the others."*

**RETRACTED: "strict single-expansion is incoherent for a nested tree."** I told the owner that. It
is FALSE, and the counter-example is simple — separate *expanded* (intent) from *rendered* (derived):

```
one signal: expandedNodeId
a node shows its children iff  node === expandedNodeId  ||  node is an ancestor of expandedNodeId
```

Exactly one node is expanded; the ancestor chain opens as a rendering consequence, not as expansion
state. Expanding branch B collapses session S unless S is an ancestor of B — the directive's literal
words, with no unmount bug. So the shipped two-signal design is a CHOICE, not the only possibility,
and the owner's spec was never unsatisfiable. Saying it was is a conversation-ender, which is
exactly why it should not have been said.

**The checkable risk in the two-signal design — HALF verified, half a topology argument. Read
which is which.** Two independent signals could admit a state the single-id model cannot:
`expandedBranchId` holding a branch belonging to a *different* session than `expandedTraceId`.

- **VERIFIED (repo-wide grep, `media/src/`).** The ONLY `.value =` writes to either signal are
  `state.ts:226/229/234` — the setters themselves. No module bypasses them. The two hits in
  `Traces.tsx` (`:1300`, `:1707`) are `===` reads. This matters because a Preact signal is
  directly assignable from any importing module, so reading the setters alone would NOT have
  established it — an earlier revision of this block claimed "clean" on exactly that partial
  evidence, and the claim outran what had been checked.
- **VERIFIED (first-hand read, `state.ts:225-231`).** `setExpandedTraceId` sets its own value then
  unconditionally clears `expandedBranchId`, so it cannot leave a stale pairing.
- **NOT verified — an argument, not a measurement.** `setExpandedBranchId` does NOT validate that
  its argument belongs to the currently-expanded session. Nothing in the setter prevents a
  mismatched pairing; the reason one is not reachable is that its only call sites render inside
  the expanded session's own subtree. That is a render-topology claim of the same kind the
  original bug violated, and it is unguarded — `check-single-expansion.js` does not cover it.

The open question for the owner is therefore narrow and NOT urgent: **accept one-path-expanded, or
switch to the single-`expandedNodeId` model above?** Nothing is blocked; the code ships either way.

**GUARD SCOPE — three probes, and the boundary is NOT where I first said it was.**
`scripts/check-single-expansion.js` is a TEXTUAL check over `SubAgentBranch`'s body. It catches any
violation whose forbidden identifier appears **inside** that body, and misses one whose binding is
made **outside** it. Measured 2026-09-08, all three via the script's own argv path-override against
scratchpad copies (the shared tree was never mutated):

| probe | result | what it settles |
|---|---|---|
| old `6b97a2af` `Traces.tsx` | **exit 1**, 2 findings | fires on the historical defect |
| ~~HEAD + in-body alias AND a plain `expandedTraceId.value` read~~ | ~~exit 1, 2 findings~~ | **CONFOUNDED — DISREGARD.** It changed `expandedBranchId.value` to `expandedTraceId.value`, i.e. typed the old bug out plainly, so each finding is explained by a direct textual hit and the alias contributed nothing. `\bexpandedTraceId\b` does NOT match inside `setExpandedTraceId` — no word boundary between `t` and `e` — so the two patterns hit two different inserted lines, neither of them the aliased call. |
| HEAD + alias ONLY, plain read left as `expandedBranchId.value` | **exit 1, exactly ONE finding** (`setExpandedTraceId`) | the isolating version: an in-body alias IS caught, sourced unambiguously to the alias line |
| synthetic file, alias at MODULE scope, body references only `setParent`/`readParent` | **exit 0**, `OK — 1 nesting rule(s) hold` | a binding made outside the body is MISSED. The `1` is the positive control: `checked++` runs only after `componentBody` returns non-null, so the rule provably RAN and found nothing — not a vacuous pass. |

**I told the owner "a reintroduction via an aliased import sails through" — too broad.** It sails
through only when the parent signal reaches the component under a name bound elsewhere: module
scope, a prop, or a context. That is still a realistic reintroduction route, but it is a narrower
hole than I described, and the in-body case is covered.

**The suspected over-match is CLEARED — but by PROBE F, and the two earlier attempts were both
non-discriminating. The retracted reasoning is kept because the failure shape recurs.**
A reviewer suspected `componentBody` runs past `SubAgentBranch` and could blame it for unrelated
code (a wrong-culprit failure in the guard built to prevent one).

- ~~PROBE A: append `function ZZZUnrelated() { setExpandedTraceId("x") }`, exit 0.~~ Rules out only
  the `nextIdx === -1` runaway-to-EOF case; equally consistent with a slice that over-runs.
- ~~PROBE E: `nextIdx = 2834`, body 2834 chars / 63 lines, last three lines `</div>` `)` `}`.~~
  **RETRACTED, two defects.** `body = rest.slice(0, nextIdx)`, so `body.length === nextIdx` **by
  construction** — that was one fact printed twice, reading as corroboration. And *every* JSX
  component ends `</div>` `)` `}`, so the tail is IDENTICAL whether the slice stopped at
  `SubAgentBranch`'s own brace or swallowed a later `const Foo = () => …` arrow component. It
  discriminated nothing while being reported as a measurement.
- **PROBE F — decisive** (`scratchpad/probe-f-slice-discriminator.js`, replicates the slicer):
  **zero** component-shaped `const` declarations inside the slice, **zero** top-of-line `const`
  declarations of any shape, and the text immediately after the slice is
  `function TokensByCausePanel({ steps, card, … })`. Nothing was swallowed; the slice spans
  stripped-source lines 1292–1354 and is genuinely tight.

The residual EOF trap is **no longer a card note** — `63926a3f` makes `nextIdx === -1` an
executable hard failure with its own message, so a refactor that moves `SubAgentBranch` last
reddens the build instead of silently degrading the guard into a whole-file scan.

**The correct axis is NOT in-body vs outside-body** — that conflates where the BINDING is declared
with where the IDENTIFIER TEXT appears, and only the second matters to a regex. `const cb =
useMemo(() => setExpandedTraceId, [])` binds outside and IS caught; `const { p } = props` binds
inside and is MISSED. The real predicate: **does a forbidden identifier survive comment-stripping
inside the slice?** That also explains the prop and context routes for the right reason (the
identifier never appears) rather than by hand-wave. Two evasions follow from `stripComments` itself
and are UNTESTED: a `/*` inside a string/regex literal deletes to the next `*/`, and a `//` inside a
regex/template literal truncates its line — an identifier inside either span is in the body and not
caught. So "catches ANY in-body violation" is false; the honest quantifier is "appears literally in
the comment-stripped slice".

The script's header says the narrowness is deliberate — it encodes one nesting relationship rather
than inferring the render tree. Fair, but the guard's value is regression-pinning of this shape, not
class coverage. Widening it (match the body against any binding transitively derived from the parent
signal) is unstarted.

**IN FLIGHT, uncarded until now.** A background lean-worker was dispatched at ~19:20 to implement
single-expansion auto-collapse in `media/src/`. The card is being written after the dispatch;
that gap is the defect this file corrects.

**The worker holds `media/src/Traces.tsx`.** Do not edit it. Two diagnostics surfaced from that
file mid-refactor (`Cannot find name 'setOpen'` at 1329, then an unused `totalCount` at 1681, the
line having moved 1679 → 1681 between snapshots); both were forwarded to the worker. As of 19:41
`pnpm run check-types` exits 0, so the hard error is resolved.

**Note for anyone rebuilding while this is open:** a bare `node esbuild.js` rebuilds the dashboard
bundle too, from whatever state `Traces.tsx` happens to be in. esbuild does not type-check — it
strips types and emits — so an unresolved identifier compiles to a runtime `ReferenceError`
rather than a build failure. Check `pnpm run check-types` before rebuilding while this card is in
`dev`.

## WHY

OWNER DIRECTIVE, verbatim (2026-09-07): *"even the web app must implement a auto-collapse system,
where only one leaf/branch/trace/session can be expanded at any time. expanding one branch, must
collapse all the others. so only one page of heavy data will be shown in the browser, and
typescript will only need to handle small ephemeral chunks of data coming from the duckdb
query."*

This is the browser half of the same ruling that TRDD-WKLD508O and TRDD-KBM09XHB implement on the
server: nothing heavy is resident, one page of data at a time, discarded after use.

## The requirement that makes it real

**Collapsing must UNMOUNT, not hide.** `display: none` leaves the component mounted, its state
alive and its data retained — the browser still holds every expanded node's payload, which is
exactly the residency the directive forbids. The collapsed branch must be removed from the tree
so its data becomes garbage.

Single-expansion means one expanded node across the whole view, not one per level: expanding any
leaf, branch, trace or session collapses every other expanded node.

## Acceptance

1. Expanding any node collapses all others — asserted by a test, not by inspection.
2. A collapsed node's subtree is unmounted; its data is not reachable from the component tree. A
   test asserts the child component's unmount, or that the fetched payload is released.
3. Expanded-node data is fetched on expand and dropped on collapse, rather than fetched once and
   retained for the session.
4. `pnpm run check-types` and `pnpm run lint` pass. `noUnusedLocals` is on, so a leftover prop or
   variable from the refactor is build-breaking.

## Derived risks

- Removing a prop threaded through several components strands its callers. `totalCount` already
  surfaced this way. Grep for every reference — direct calls, type-level references, tests — per
  the project's no-semantic-search rule.
- A re-fetch on every expand replaces a memory cost with a latency cost. Measure it; do not
  discover it. If a node is expanded and collapsed repeatedly the fetch count grows linearly —
  acceptable under this directive, but worth recording.
- `media/src` must not re-declare anything `src/shared/` exports; `pnpm run check-mirrors` fails
  the build if it does.
