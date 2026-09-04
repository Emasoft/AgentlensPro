---
trdd-id: D8L28FFD
title: deny-symlink-paths parses shell syntax with regexes over two drifting string views
column: todo
created: 2026-09-04T04:13:31+0200
updated: 2026-09-04T04:13:31+0200
current-owner: main-session
task-type: refactor
project-id: agentlenspro
scope: project
min-approval-requirement: none
labels: [safety, guard, refactor]
severity: high
effort: M
relevant-rules: [0]
npt: []
eht: []
implementation-commits: []
external-refs: []
---

# Tokenize the command in deny-symlink-paths.js instead of regexing two views of it

## Why this exists

Five consecutive adversarial reviews on 2026-09-03/04 each found a real bypass in the fix for
the previous one. Every fix was correct and every one was verified by measurement; the defect
moved rather than closed. That is the signal this card exists for — the individual bugs are
symptoms, and the cause is structural.

| # | commit | bypass | the layer that was wrong |
|---|---|---|---|
| 1 | `ba72359c` | `cd <wt> \|\| cp x node_modules/` denied a path the command cannot reach | separator carry treated `\|\|`, `&`, `\|` as "still the same shell" |
| 2 | `45570e10` | `cd $PWD && cp x node_modules/` **allowed** where the bare command denied | an unexpanded var resolved to a fictional base, and `matched:true` waved the relative path past the existence gate |
| 3 | `49a7fd8f` | `echo $( cd /elsewhere && pwd ) && cp x node_modules/` **allowed** | a `(?<!\$)` lookbehind guards a CHARACTER; the problem is a REGION |
| 4 | `880b5deb` | `echo $( echo $(date) && cd /elsewhere ) && cp x node_modules/` **allowed** | per-part blanking cannot see an opener two parts away |
| 5 | `1c337d57` | `grep '$(' f && cd <wt> && cp x node_modules/` **allowed** | depth counted SYNTAX on the string the quote mask never cleaned |

## The actual cause

The guard maintains **two views of one command** and every layer picks one by hand:

- **CONTENT view** — `cmd`, the raw text. Stage content is sliced from it *on purpose*, because a
  quoted path must stay extractable.
- **SYNTAX view** — `segmentable`, with quoted spans and fd-dups blanked length-preservingly.
  Segmentation and (since `1c337d57`) substitution depth read this one.

Nothing enforces which view a new layer should read; the coupling is a comment and a runtime
length assertion. Bypasses 3, 4 and 5 are all the same mistake at three different layers, and 5
was introduced by the fix for 4. There are 11+ regexes over these two strings, and each new one
is another chance to pick wrong.

## What to build

Replace the regex layers with **one pass that produces a token stream**, so "syntax" and
"content" are fields of the same object rather than two strings that drift:

- one lexer over `cmd` producing tokens carrying: kind (word / operator / redirect), the raw
  text, its offset, its quoting state, and its nesting context (substitution depth, subshell
  depth);
- segmentation, read-only classification, cwd tracking and path extraction all consume TOKENS,
  never a re-sliced string;
- a token knows whether it is inside `$( )`, `` ` ` ``, `"..."`, `'...'` — so the questions the
  five bypasses got wrong (is this `$(` an opener or an argument? does this `cd` move the parent?
  is this `|` a pipe or data?) become field lookups instead of regex guesses.

## Acceptance criteria

- [ ] The whole existing matrix (`scripts/test-deny-symlink-paths.js`, 102 cases at time of
      writing) passes unchanged. It encodes five measured bypasses and their fixes; **the matrix
      is the specification**, so a rewrite that needs the tests edited is a rewrite that changed
      behaviour.
- [ ] Every case from the five ad-hoc probe scripts is folded INTO the matrix first (they live in
      `/tmp` and are ephemeral — that is how the separator semantics went unpinned for a day).
      **PARTIAL 2026-09-04T17:19 (`53b50100`) — deliberately left OPEN.** Seven probes survive in
      `/tmp` (`probe-{cd,readonly,offsets,components,aa,ad,ad2}.js`). SIX were read; **`probe-ad.js`
      was NOT** — my case-extractor returned nothing for it and I moved on without asking why, so
      its 1939 bytes are still unexamined. One gap was found and folded: the matrix had exactly one
      `&` case (`cd wt & cp x node_modules/`, pinning that a backgrounded cd carries nothing) and
      NOTHING pinning that the segment AFTER an `&` is still judged — a much larger hole, since
      "the cd does not reach here" degrading into "nothing after an & is checked" would leave the
      old case green.
      **The coverage claim behind "everything else was already pinned" is WEAK and must not be
      trusted for the rewrite:** it came from `grep -c` on distinctive tokens (`sed -i`, `oppa`,
      `--output=`…) appearing SOMEWHERE in the 341-line matrix — which establishes the token exists,
      not that the case does. `oppa` returns 5 hits against 4 distinct probe shapes; counting cannot
      tell 5-covering-4 from 5-covering-2. **A real case-by-case diff is still owed**, and this box
      stays unticked until it happens.
      **`probe-ad.js` NOW READ (17:22) — it is not a case list at all**, which is why the extractor
      returned nothing. It is a MUTATION-COVERAGE probe: `AD5` deletes `effectiveCwd`'s `cd`/`pushd`
      match and counts failing matrix cases (it is the precedent for this card's criterion 3, and it
      carries an `ANCHOR MISS` guard of the same spirit). Its only case list is `AD2` — three
      separator cases (`||`, `&`, `&&`) that appear pinned in the matrix, though that rests on the
      same token-counting this box disclaims, so treat it as provisional. It contributes no missing
      cases. **ALL SEVEN probes are now read** (a 17:22 version said "six of seven" and carried that
      count past the turn that read the seventh); the case-by-case diff is owed on all of them.
      **RETRACTED 17:25 — a 17:22 version claimed "the warning I strengthened was derived from a
      probe I had not read". That self-criticism was INVENTED.** Criterion 3's own wording names a
      **`perl`** mutation; `probe-ad.js` is Node using `String.replace`, so "derived from" was my
      inference between similar ideas, not a fact. And the timeline runs the other way: the probe is
      Sep 3 23:49, this card was authored Sep 4 04:13 — AFTER — so its author could simply have read
      it. I conflated "not in this session's working set" with "never read". Manufacturing a
      self-indictment is as much a factual error as manufacturing a credit, and this is the second
      one today (see the `open=2` retraction on TRDD-4MJT92J7).
- [ ] Mutation-verified per layer, and **every mutation diff-confirmed before its count is
      believed** — a `perl` mutation that silently fails to match reports zero failures and reads
      exactly like "this test pins nothing" (this nearly cost a real finding on 2026-09-04).
      **STRENGTHENED 2026-09-04T17:19 — diff-confirmation is NECESSARY BUT NOT SUFFICIENT, and this
      was measured, not reasoned.** Verifying the two new `&` cases took three mutations. The first
      two targeted `stages` (`:664`) — the pipeline split INSIDE a part — and both reported
      "pins nothing". **Both matched their needle and produced a real diff**, so every check this
      criterion currently demands was satisfied and the conclusion was still false: `&` splits
      **PARTS** at `:579`, so the mutated layer is not on the path that behaviour takes. The third
      mutation (`parts.slice(0, 1)` at the `for (const part of parts)` loop, `:604`) flipped the
      DENY case to `allow`, proving the pin. **So a mutation ALSO needs CONTROLS — otherwise it can
      exercise a layer the behaviour never reaches and be indistinguishable from a vacuous test.**
      Note this is the SAME failure the card already warns about, arriving through a door the
      warning did not cover: not "the mutation failed to apply" but "the mutation applied cleanly to
      the WRONG LAYER".

      **TWO controls, and they are DIFFERENT INSTRUMENTS — corrected 17:24 after a first attempt
      used one degenerate case and called it both.**
      - **POSITIVE control** — a case that SHOULD flip and does ⇒ *the mutation is LIVE on the
        layer under test.* It MUST be INDEPENDENT of the tests being verified: if the only thing
        that flips is the test under verification, a non-flip cannot separate "the test pins
        nothing" from "the mutation is inert here" — which is precisely the ambiguity that produced
        two false verdicts. Used here: `cd <wt> && cp x node_modules/`, an existing matrix case
        known to depend on the parts loop → flips to `allow`.
      - **NEGATIVE control** — a case that should NOT flip and doesn't ⇒ *the mutation is TARGETED,
        not blanket.* It must be MULTI-PART with its danger in part 1. Used here:
        `cp x <link>/ & ls file` → stays DENY, so the mutation removes later parts while preserving
        judgement of the first.
      - **The first attempt's control was DEGENERATE and its claim was FALSE.** `cp x <link>/` has
        no separator, so `parts` is a one-element array and `parts.slice(0, 1)` is a literal no-op
        on it — it stayed DENY because the mutant was byte-identical in behaviour for that input.
        That is a tautology, not evidence, and "proves the mutation is targeted" was wrong.

      **What the pin actually covers, stated exactly:** the two `&` cases pin *"parts after the
      first must be judged"* — a SUPERSET of the regression the card describes. They do not isolate
      `&` from `&&`/`;`/`||`, and they do not simulate the specific degradation named above ("the cd
      does not reach here" becoming "nothing after an & is checked"), which would be a change in the
      separator-CARRY logic (`dir`/`dirExplicit` propagation), not in whether the loop enumerates
      parts. Catching the superset is a real pin; claiming it isolates the named regression is one
      step further than the evidence goes.
- [ ] The known-unfixed `$((` miscount (1 open, 2 closes, absorbed by the `Math.max(0, …)` clamp)
      is either fixed by construction or re-documented with its new reasoning.
- [ ] `cd *` remains an accepted, documented miss unless the tokenizer makes it cheap to resolve.
- [ ] No new dependency. This is a guard that must load in a PreToolUse hook, fast.

## Non-goals

- Do NOT aim for a POSIX-complete shell parser. The target is the subset that decides: where does
  a command start and end, what is quoted, what is nested, and which words are paths.
- Do NOT merge the pnpm guard into this one here — that is separate pending work.

## A stale copy of this guard sits in `/tmp` — clutter, NOT the hazard I first called it

`/tmp/ad-g.bak` is **24,189 bytes against the current guard's 49,675**, 392 diff lines apart, taken
Sep 3 23:49 by `probe-ad.js` (the mutation probe above), which mutates
`scripts/deny-symlink-paths.js` **IN PLACE**. The guard is currently byte-identical to HEAD.

**RETRACTED 17:25 — a 17:22 version of this section called it a `⚠ HAZARD` and gave a causal story
that CANNOT HAPPEN.** The claim was: someone finds the guard mutated by an interrupted run,
restores from the obvious backup, and silently reverts the bypass fixes. `probe-ad.js` refutes it
in its own first three lines — **it rewrites `.bak` from the CURRENT guard BEFORE it mutates
anything.** So the hazard's two halves are mutually exclusive: if the probe runs again the `.bak`
becomes correct, and if it never runs the guard is never mutated and nobody goes looking for a
backup. The mutation step ALWAYS follows a `.bak` refresh, so I picked the one mechanism that
cannot produce the trap.

**AND THE PROBE CAN NO LONGER MUTATE THE GUARD AT ALL — measured 17:28, and this kills the hazard
independently of any `.bak` reasoning.** `probe-ad.js`'s mutation anchor is a VERBATIM line of the
Sep-3 guard. Checked against both files:

```
anchor matches CURRENT guard : false
anchor matches Sep-3 .bak    : true
```

So a run today writes the `.bak`, hits its own `ANCHOR MISS` branch, and `process.exit(1)`s —
**before** `fs.writeFileSync(G, mutated)` is ever reached. The guard cannot be left mutated. This
also gives the sharpest form of the `.bak` argument: a stale `.bak` is inconsistent with **any run
that reached line 3**, completed or not, since the guard last changed — and the `.bak` is still
24,189, so none has.

**One correction to the 17:25 retraction, which manufactured a self-criticism.** It called
"positive evidence the probe has not run" a modality overreach. It was not: *"positive evidence
for X"* claims SUPPORT, not proof, and a short `.bak` genuinely is support — the partial-write case
is the single competing explanation and it is rare. I paraphrased my own hedged wording as
"proves" and then retracted the harsher paraphrase. The narrowing to "completed run" is still a
precision gain, but the stated reason does not bite: `fs.writeFileSync` being non-atomic produces a
partial `.bak` only when the process died mid-write, which is by definition **not a completed run**,
so "completed" already excluded it.

**Also dropped: the claim that this was `ATOM-4C5N-32AS` "a third time in one card".** Asserted
without a tally, and it does not survive one — depending where the line is drawn the count is two,
three or five (the two wrong-layer "pins nothing" verdicts are a wrong MEASUREMENT, not an
overclaimed modality; the `⚠ HAZARD` was a false MECHANISM). That is the same miscounting shape as
"three rounds of reasoning", retracted two commits earlier in this sequence.

**What survives, and it is the durable one:** a correction layer is not automatically more reliable
than what it corrects. Every retraction is a new claim and needs the same discipline — including
the discipline of not inventing a fault to retract.

What actually remains: a stale, plausibly-named copy of a safety file, i.e. clutter someone could
misuse for unrelated reasons. A "delete this artifact" note, not a hazard. Left in place — `/tmp`
is RULE-0-exempt, but removing it is the owner's call.

**The design consequence stands on its own and never needed the hazard:** mutation runs must not
write into the repo's guard. `66052519`/`ab8bc616` mutated `/tmp` COPIES and pointed a harness at
them, so an interrupted run leaves the repo untouched. Adopt that shape; retire the in-place
pattern.

**Design consequence for the rewrite:** mutation runs must never write into the repo's guard. The
verification this session did (`66052519`) mutated a `/tmp` COPY and pointed a harness at it, so an
interrupted run leaves the repo untouched and produces no restore-from-stale-backup trap. Adopt
that shape; retire `probe-ad.js`'s in-place pattern when its cases are folded in.

## Notes

`scripts/deny-pkgmanager-symlink-purge.js` shares the same parsing style and will inherit the same
class of defect. Once the tokenizer exists it should be lifted into both, but this card covers
`deny-symlink-paths.js` only.
