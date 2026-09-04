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
      DENY case to `allow`, proving the pin. **So a mutation ALSO needs a POSITIVE CONTROL — a case
      it is known to break — or it can exercise a layer the behaviour never reaches and be
      indistinguishable from a vacuous test.** Here the single-part control (`cp x <link>/`, still
      DENY under the mutation) is what shows the mutation is targeted rather than blanket; without
      that pair the run says nothing. Note this is the SAME failure the card already warns about,
      arriving through a door the warning did not cover: not "the mutation failed to apply" but
      "the mutation applied cleanly to the wrong layer".
- [ ] The known-unfixed `$((` miscount (1 open, 2 closes, absorbed by the `Math.max(0, …)` clamp)
      is either fixed by construction or re-documented with its new reasoning.
- [ ] `cd *` remains an accepted, documented miss unless the tokenizer makes it cheap to resolve.
- [ ] No new dependency. This is a guard that must load in a PreToolUse hook, fast.

## Non-goals

- Do NOT aim for a POSIX-complete shell parser. The target is the subset that decides: where does
  a command start and end, what is quoted, what is nested, and which words are paths.
- Do NOT merge the pnpm guard into this one here — that is separate pending work.

## Notes

`scripts/deny-pkgmanager-symlink-purge.js` shares the same parsing style and will inherit the same
class of defect. Once the tokenizer exists it should be lifted into both, but this card covers
`deny-symlink-paths.js` only.
