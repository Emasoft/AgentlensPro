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
      already carries the `ANCHOR MISS` guard that criterion describes). Its only case list is `AD2`
      — three separator cases (`||`, `&`, `&&`) that ARE pinned in the matrix (13 hits). So it
      contributes **no missing cases**. Six of seven probes now genuinely examined; the case-by-case
      diff of the other six is what remains.
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

## ⚠ HAZARD FOUND 2026-09-04T17:22 — a STALE backup of this guard is sitting in `/tmp`

`/tmp/ad-g.bak` — **24,189 bytes against the current guard's 49,675.** The guard has more than
DOUBLED since that backup was taken (Sep 3 23:49), because the five bypass fixes landed afterwards.
392 diff lines.

**Why it exists:** `probe-ad.js` (the mutation probe, above) writes the guard to `/tmp/ad-g.bak`
before mutating `scripts/deny-symlink-paths.js` **IN PLACE**, then restores it. Verified 17:22 —
the guard is currently byte-identical to HEAD, so the last run's restore succeeded, and the restore
path reads the in-memory `src` rather than the `.bak`, so a fresh run is safe on its own.

**The hazard is the file, not the script.** It is a plausible-looking backup of a safety guard,
named as one, sitting next to a probe that mutates that guard in place. Anyone — human or agent —
who finds the guard mutated by an interrupted run and restores from the obvious backup **silently
reverts all five bypass fixes**, and the matrix would then fail loudly, which is the only reason
this would be caught at all. Left in place rather than deleted: `/tmp` is RULE-0-exempt, but this
is evidence and the call to remove it is the owner's.

**Design consequence for the rewrite:** mutation runs must never write into the repo's guard. The
verification this session did (`66052519`) mutated a `/tmp` COPY and pointed a harness at it, so an
interrupted run leaves the repo untouched and produces no restore-from-stale-backup trap. Adopt
that shape; retire `probe-ad.js`'s in-place pattern when its cases are folded in.

## Notes

`scripts/deny-pkgmanager-symlink-purge.js` shares the same parsing style and will inherit the same
class of defect. Once the tokenizer exists it should be lifted into both, but this card covers
`deny-symlink-paths.js` only.
