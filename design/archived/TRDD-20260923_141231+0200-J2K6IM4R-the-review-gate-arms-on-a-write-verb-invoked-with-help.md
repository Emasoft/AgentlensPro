---
trdd-id: J2K6IM4R
title: The review gate arms on a write verb invoked with --help
column: complete
created: 2026-09-23T14:12:31+0200
updated: 2026-10-05T07:46:49+0200
current-owner: main-session
created-by: emanuelesabetta
task-type: bugfix
min-approval-requirement: none
assignee: main-session
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-23T14:12:31+0200
implementation-commits: [954fe1a0, 4c824213]
status: archived
---

# The review gate arms on a write verb invoked with --help

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-23T19:24:53+0200

AUTHORITATIVE RULE — supersedes the Fix section and both refinement sections below:

1. Exempt list is exactly {fastedit, memgrep}, intersected with the verbs the classifier arms today (fastedit: edit, multi-edit, batch-edit, create, duplicate, split, join, delete, move, rename, rename-all, move-to-file, undo — FASTEDIT_WRITE_VERBS, src/cli/reviewGateTriggers.ts:391-394; memgrep: any verb matching /-mem-/, src/cli/reviewGateTriggers.ts:253, e.g. new-mem-atom, update-mem-atom, migrate-mem-atom, update-mem-topic). tldr has no write verb (nothing to exempt). trddgrep is EXCLUDED: its hand-rolled parser makes `trddgrep set <id> <field> --help` write the literal value --help.
2. A segment is matched to a CLI the way the classifier matches it today (path.basename() of the first unwrapped, unquoted argv word after skipping WRAPPERS tokens and NAME=value assignment prefixes, src/cli/reviewGateTriggers.ts:280-299; a full/relative path wrapper like .venv/bin/fastedit still matches via basename, and a leading env assignment FOO=1 fastedit ... still matches; a script-runner wrapper not in WRAPPERS such as uv run fastedit ... does NOT recurse into the wrapped command and so does not match today, src/cli/reviewGateTriggers.ts:201,247-251); the exemption applies only where that match applies. An unmatched wrapper just arms (harmless false arm).
3. Tokenize each segment quote-aware (shlex-style); a --help inside a heredoc body or a $(...) substitution never exempts the outer command, yet a $(...) is still classified as a command in its own right (X=$(fastedit edit ...) must arm); stop scanning at a bare --. Today: shellWords() is quote-aware (single/double quotes, backslash-escapes) and splits on whitespace/operators, src/cli/reviewGateTriggers.ts:46-71; heredoc bodies ARE stripped before tokenizing via stripHeredocBodies(), src/cli/reviewGateTriggers.ts:105-159 (called at :309/:372); there is NO bare -- end-of-options handling anywhere in this file (grep-verified absent) — the "stop at --" rule is NOT implemented today; $(...) substitutions are NOT excluded from the scan either — '(' and ')' are generic segment separators, src/cli/reviewGateTriggers.ts:65, so $(...) content is tokenized and classified like ordinary text (the comment at :42 confirms X=$(git commit) is put in command position, i.e. scanned, not skipped) — narrower than the "excluded" claim in the second review below.
4. The segment's CLI-verb arm is cancelled only when a standalone -h or --help token appears whose preceding token does not start with "-".
5. The exemption cancels ONLY the CLI-verb arm. A redirect (> or >>) or tee in the same segment still arms. Today: the redirect scan, src/cli/reviewGateTriggers.ts:372-381, is a second, unconditional pass over the raw token stream, independent of the per-segment CLI-verb classification pass, src/cli/reviewGateTriggers.ts:356-359; it arms on any non-ephemeral >/>> target regardless of whether that segment's CLI verb was exempted. tee arms through a separate mechanism (ALL_ARGS_ARE_TARGETS, :203/:267-274) only when tee is itself a segment's own base command (e.g. the sibling segment after a pipe, since | starts a new segment at :317) — not literally "in the same segment" as another CLI verb, since one segment has exactly one base command.
6. Applies per segment of a compound command.

Must still ARM: fastedit edit f --snippet 'a --help b'; fastedit edit f --replace x --snippet s -- --help; fastedit edit f --dry-run --help; fastedit edit f --snippet=--help; the second segment of fastedit --help && fastedit edit f --replace x --snippet s; fastedit edit f --help > notes.md; fastedit edit f --replace x --snippet "$(cat s --help)".

Must NOT arm: fastedit --help; fastedit multi-edit --help; fastedit edit f -h --replace x; memgrep new-mem-atom --help.

Superseded body claims: the Fix section's "--snippet '--help' is a real write" is FALSE for fastedit (probe: exit 2, no write) — it still arms, as conservative behaviour; the first refinement's "Unverified ... argparse likely errors" is replaced by that probe; the second review's example 'p.add_argument("x --help")' does not show the hole (whitespace splitting yields the token --help")' , not --help) — the correct case is --snippet 'a --help b'.

## Approval log

- 2026-09-23T14:12:31+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-09-24T09:47:46+0200 — column → ai_review by main-session. --help exemption landed in 954fe1a0; all boxes ticked; mutation-checked
2026-10-04: worker wA re-read the 4 acceptance boxes against src/test/reviewGateTriggers.test.ts (suite review-loop D7, test 'a standalone -h/--help exempts fastedit/memgrep write verbs; anything else still arms' covers both directions and every must-arm/must-not-arm case); scoped run review-gate triggers|review-loop: 66 passing, 0 failing. All boxes were already ticked and hold.
- 2026-10-05T07:46:49+0200 — COMPLETE by main-agent@agentlenspro. review in the owner's stead, order of 2026-10-05 on TRDD-AVUGZV1K; entry Review 2026-10-05 on the card.

## Symptom

On 2026-09-23 the Stop-hook review gate demanded a review fork after a read-only Bash call `fastedit multi-edit --help 2>&1 | head -10` ("ran a write-shaped command: fastedit multi-edit"). argparse handles --help before any subcommand runs, so nothing was written. Each false arm spawns a fork that inherits the whole transcript (600-830k subagent tokens each at this session's size).
Same class as the LOCAL memory note review-gate-cannot-resolve-shell-variables: the write-shape classifier matches tokens, not meaning.

## Fix

Smallest fix (in the write-shape classifier, src/cli/reviewGateTriggers.ts -- locate with `tldr structure`): treat a command segment as non-write when its argv after the subcommand is exactly -h or --help (standalone tokens only; downstream pipes allowed). NOT a blanket "contains --help" exemption -- `fastedit edit f --replace x --snippet '--help'` is a real write and must still arm.

## Acceptance

[x] fastedit multi-edit --help and fastedit delete --help | head do not arm; [x] fastedit edit f --replace x --snippet '--help' still arms; [x] a test for each direction in the review-gate trigger tests; [x] check-types + lint + the review-gate mocha tests pass.

## Ownership

current-owner/assignee main-session; related: TRDD-2CYTNLY1, TRDD-A37YM37G.

## 2026-09-23 — refinement of the Fix rule (from review)

The Fix section's "argv after the subcommand is exactly -h or --help" is too narrow. For CLIs that parse with argparse or clap (fastedit, tldr, trddgrep, memgrep), a STANDALONE -h/--help argv token anywhere prints help and exits before any handler runs: `fastedit --help`, `fastedit multi-edit --help`, and `fastedit edit f -h --replace x` all write nothing.
Rule to implement: a segment of a known argparse/clap CLI does not arm when it has a standalone -h or --help token whose PRECEDING token does not start with "-" (program name, subcommand, or positional). A --help preceded by an option token still arms (conservative: that option may take it as a value), and --snippet=--help is not a standalone token, so it arms.
Unverified: whether argparse/clap even accept `--snippet '--help'` as a value (argparse likely errors "expected one argument", which writes nothing). The rule arms there anyway; a false arm costs a fork, a missed write costs a review.
Scope the exemption to that named CLI list; an unknown CLI keeps today's behaviour.
[x] fastedit --help and fastedit edit f -h --replace x do not arm; [x] fastedit edit f --dry-run --help and --snippet=--help still arm.

## 2026-09-23 — second review: the rule must be quote-aware, stop at --, and cite per-CLI evidence

The rule is defined over quote-aware argv (shlex-style), never whitespace tokens: `fastedit edit app.py --replace main --snippet 'p.add_argument("x --help")'` puts a whitespace token --help after a non-option token and would be exempted, yet it writes. Heredoc bodies and $(...) substitutions are excluded from the scan.
Scanning stops at a bare -- (end of options): after it, --help is data and the handler runs (`cmd sub -- x --help`).
The rule applies per segment of a compound command: in `fastedit --help && fastedit edit f ...` the second segment still arms.
A CLI joins the exempt list only with cited evidence of its parser and of no hyphen-swallowing positional or non-help -h on any write verb. Findings 2026-09-23: [fastedit: argparse (src/fastedit/cli.py, editable install; no argparse.REMAINDER; no -h remap; write verbs edit/multi-edit/delete/rename/rename-all/batch-edit checked clean)] [tldr: read-only, no write subcommand exists at all; source uses clap (Cargo.toml clap 4.0); allow_hyphen_values found only on the read-only `search` query positional] [trddgrep: hand-rolled Node argv parser (scripts/trddgrep.mjs, no argparse/clap/yargs/commander) -- NOT eligible for this rule; `set <id> <field> --help` lets --help land as the literal field VALUE (a real write) with a preceding token that does not start with "-", so the drafted rule would wrongly exempt it -- do not add trddgrep to the exempt list] [memgrep: clap (Cargo.toml clap 4.6.1; strings shows 44 clap hits); allow_hyphen_values found only on the read-only `find` query positional; write verbs new-mem-atom/update-mem-atom/migrate-mem-atom/update-mem-topic have no allow_hyphen_values/trailing_var_arg/last(true) and no -h remap]. Empirical (fastedit, scratch file): [`fastedit edit f -h --replace f --snippet 'def f(): return 2'` -> exit 0, prints edit-subcommand usage, file unchanged] [`fastedit edit f --replace f --snippet --help` -> exit 2, "expected one argument" usage error, file unchanged].
Correction to the first refinement: "argparse likely errors" was unverified reasoning; the probe above replaces it. Click-style parsers accept --snippet --help as a value, so parser identity matters; the rule still arms on a --help preceded by an option token either way.
Acceptance (added): [x] --snippet 'a --help b' still arms; [x] sub -- x --help still arms; [x] the second segment of fastedit --help && fastedit edit f ... still arms; [x] each exempt CLI's evidence is cited in the code comment next to the list.

## Implementation

2026-09-24 — Implemented per the STATE block's authoritative rule: added hasStandaloneHelp(args) in src/cli/reviewGateTriggers.ts (near segmentWriteReason/Resolve) and wired it into the two exempt-CLI call sites (fastedit sub-verb check in deployOrDesignVerbWriteReason; memgrep /-mem-/ check in segmentWriteReason). A standalone -h/--help token (preceding token not starting with '-', scan stops at bare --) cancels only the CLI-verb arm; the independent redirect pass still arms on a same-segment redirect. tldr/trddgrep intentionally excluded per the card's evidence. Added a must-arm/must-not-arm test covering every case from the card's two lists to the D7 suite in src/test/reviewGateTriggers.test.ts. Verified: pnpm check-types exit 0, pnpm lint exit 0 (0 errors), pnpm compile-tests exit 0, mocha on out/test/test/reviewGateTriggers.test.js: 41/41 passing. Mutation check: forcing hasStandaloneHelp to always return false failed exactly the new test (1 failing) and left the other 40 green; restored and reverified green (41/41).
2026-10-04: code and tests done at 90446356; effective only after the installed hook bundle is rebuilt (owner).

## Review 2026-10-05

- 2026-10-05 review, verdict ACCEPT after one added test file. This entry stands in for `human_review` under the owner's order of 2026-10-05 recorded on TRDD-AVUGZV1K; the card goes from `ai_review` to `complete` without resting in that column. The review became development: the reviewing session added one test file (commit 4c824213, test only, no change to src/cli/reviewGateTriggers.ts).
- Run first-hand by the main agent after its own compile (`tsc -p tsconfig.test.json` exit 0), each file alone with `mocha --no-config --require src/test/setup.js --ui tdd --timeout 10000`: out/test/test/reviewGateTriggers.test.js exit 0, 41 passing; out/test/test/reviewGateHelpExemption.test.js exit 0, 3 passing. `eslint --quiet` on the source and both test files exit 0. `tsc --noEmit -p tsconfig.json` exit 0 (the src half of check-types; the media half was not run; 954fe1a0 touches no media file).
- What was found: the acceptance tick "sub -- x --help still arms" had no test until 4c824213. With the line `if (args[i] === '--') return false` removed from hasStandaloneHelp, the existing test stayed green (41 passing, by a worker's report), because its case `-- --help` is already rejected by the option-value guard. Also unpinned before 4c824213: the `-h` spelling on the must-still-arm side, and memgrep on the must-still-arm side.
- Mutations, each run by a worker. (1) Exemption turned off: the old test red, `AssertionError: fastedit multi-edit --help` (read by the main agent in the captured output); this first mutation also reformatted neighbouring lines. (2) Option-value guard removed: by a worker's report the old test went red at `fastedit edit f.ts --dry-run --help` (a loop, so only its first failing case was seen); in the new file, read by the main agent in the captured output, tests 2 and 3 red, actual null against 'fastedit edit' and 'memgrep new-mem-atom', test 1 green. (3) `--` stop removed: the old test green as said above; in the new file, read by the main agent in the captured output, test 1 red, actual null against 'fastedit edit', tests 2 and 3 green. The source was restored byte-identical after each run by the workers' checks; the main agent read the same sha256 (315f96cc...) after the first run and at the end.
- The other must-still-arm cases of the old test were read in the test and not individually mutated. They rest on the tokenizer, the segment split and the redirect pass, which 954fe1a0 did not change: its source diff, read by the main agent, adds hasStandaloneHelp and its comment and changes the two call sites (the memgrep /-mem-/ line and the fastedit sub-verb line), nothing else. Both call sites pass the same args to the same function.
- The three new cases live in src/test/reviewGateHelpExemption.test.ts and not in the old test's list, because fastedit could not address the anonymous test callback ("Symbol not found") and that refusal was not worked around with another write tool. The old test says nothing about the new file.
- Not verified: the fastedit and memgrep parser evidence the exempt list rests on (taken from this card and its code comment); the behaviour of the installed hook in a live session.
- Corrections to this card. The STATE head above is dated 2026-09-23 and describes the rule before it was implemented; its "Today:" sentences are not the current code. hasStandaloneHelp sits at src/cli/reviewGateTriggers.ts lines 237 to 243, not 223 to 231. Commit 90446356 changed this card's file by 3 lines and no file of this card's code (it is the TRDD-PNB9FNJ0 change), so it is removed from implementation-commits, which becomes [954fe1a0, 4c824213]. The note of 2026-10-04 that the change is effective only after the bundle is rebuilt is wrong for 954fe1a0: that commit is dated 2026-09-24, standalone/cli.js was built on 2026-10-01 and contains hasStandaloneHelp (a worker's grep; that the installed hook runs that file is inferred). Two later commits of 2026-09-25 touched these files (90d0d8a6 the source and the test, d5c90dfd the test only); neither adds or removes a line mentioning help or hasStandaloneHelp (the main agent's grep of both diffs). 4c824213 adds a test only, so nothing waits for a build.
- Links read before the move: no npt, eht, parent-trdd or blocked-by in the frontmatter; no other card names this one in those fields (a measuring worker's grep); the body names TRDD-2CYTNLY1 (human_review) and TRDD-A37YM37G (complete) as related only.

## Acceptance checklist 2026-10-05

- [x] `fastedit multi-edit --help` and `fastedit delete --help | head` do not arm. The compiled gate returns null for both and for `fastedit delete f.ts --help | head` (evaluated by the main agent, 2026-10-05); the first and the f.ts form without `| head` are asserted in reviewGateTriggers.test.ts.
- [x] `fastedit edit f --replace x --snippet '--help'` still arms. The compiled gate returns 'fastedit edit' for this exact text (evaluated by the main agent); the test asserts the same rule on `--dry-run --help`, `--snippet=--help` and `--dry-run -h`, not on this exact text.
- [x] A test for each direction exists: five must-not-arm and seven must-still-arm cases in reviewGateTriggers.test.ts, three more must-still-arm tests in reviewGateHelpExemption.test.ts.
- [x] check-types, lint and the review-gate mocha tests pass: `tsc --noEmit` on tsconfig.json and on media/tsconfig.json both exit 0, `eslint --quiet` on the source and both test files exit 0, 41 and 3 passing (all run by the main agent, 2026-10-05; the whole lint and the whole suite were not run).
- [x] `--snippet 'a --help b'` still arms: asserted in reviewGateTriggers.test.ts.
- [x] `sub -- x --help` still arms: asserted since commit 4c824213 in reviewGateHelpExemption.test.ts and seen red with the `--` stop removed; before that commit this box was ticked with no test behind it.
- [x] The second segment of `fastedit --help && fastedit edit f ...` still arms: asserted in reviewGateTriggers.test.ts.
- [x] Each exempt CLI's evidence is cited in the code comment next to the rule: read by the main agent in the 954fe1a0 source diff (fastedit: argparse; memgrep: clap). The evidence itself was not re-verified.
