---
trdd-id: J2K6IM4R
title: The review gate arms on a write verb invoked with --help
column: ai_review
created: 2026-09-23T14:12:31+0200
updated: 2026-09-24T09:47:46+0200
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
