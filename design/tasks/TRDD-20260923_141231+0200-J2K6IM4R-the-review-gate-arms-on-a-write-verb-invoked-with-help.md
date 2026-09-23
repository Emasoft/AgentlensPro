---
trdd-id: J2K6IM4R
title: The review gate arms on a write verb invoked with --help
column: todo
created: 2026-09-23T14:12:31+0200
updated: 2026-09-23T19:18:22+0200
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

## Approval log

- 2026-09-23T14:12:31+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Symptom

On 2026-09-23 the Stop-hook review gate demanded a review fork after a read-only Bash call `fastedit multi-edit --help 2>&1 | head -10` ("ran a write-shaped command: fastedit multi-edit"). argparse handles --help before any subcommand runs, so nothing was written. Each false arm spawns a fork that inherits the whole transcript (600-830k subagent tokens each at this session's size).
Same class as the LOCAL memory note review-gate-cannot-resolve-shell-variables: the write-shape classifier matches tokens, not meaning.

## Fix

Smallest fix (in the write-shape classifier, src/cli/reviewGateTriggers.ts -- locate with `tldr structure`): treat a command segment as non-write when its argv after the subcommand is exactly -h or --help (standalone tokens only; downstream pipes allowed). NOT a blanket "contains --help" exemption -- `fastedit edit f --replace x --snippet '--help'` is a real write and must still arm.

## Acceptance

[ ] fastedit multi-edit --help and fastedit delete --help | head do not arm; [ ] fastedit edit f --replace x --snippet '--help' still arms; [ ] a test for each direction in the review-gate trigger tests; [ ] check-types + lint + the review-gate mocha tests pass.

## Ownership

current-owner/assignee main-session; related: TRDD-2CYTNLY1, TRDD-A37YM37G.

## 2026-09-23 — refinement of the Fix rule (from review)

The Fix section's "argv after the subcommand is exactly -h or --help" is too narrow. For CLIs that parse with argparse or clap (fastedit, tldr, trddgrep, memgrep), a STANDALONE -h/--help argv token anywhere prints help and exits before any handler runs: `fastedit --help`, `fastedit multi-edit --help`, and `fastedit edit f -h --replace x` all write nothing.
Rule to implement: a segment of a known argparse/clap CLI does not arm when it has a standalone -h or --help token whose PRECEDING token does not start with "-" (program name, subcommand, or positional). A --help preceded by an option token still arms (conservative: that option may take it as a value), and --snippet=--help is not a standalone token, so it arms.
Unverified: whether argparse/clap even accept `--snippet '--help'` as a value (argparse likely errors "expected one argument", which writes nothing). The rule arms there anyway; a false arm costs a fork, a missed write costs a review.
Scope the exemption to that named CLI list; an unknown CLI keeps today's behaviour.
[ ] fastedit --help and fastedit edit f -h --replace x do not arm; [ ] fastedit edit f --dry-run --help and --snippet=--help still arm.

## 2026-09-23 — second review: the rule must be quote-aware, stop at --, and cite per-CLI evidence

The rule is defined over quote-aware argv (shlex-style), never whitespace tokens: `fastedit edit app.py --replace main --snippet 'p.add_argument("x --help")'` puts a whitespace token --help after a non-option token and would be exempted, yet it writes. Heredoc bodies and $(...) substitutions are excluded from the scan.
Scanning stops at a bare -- (end of options): after it, --help is data and the handler runs (`cmd sub -- x --help`).
The rule applies per segment of a compound command: in `fastedit --help && fastedit edit f ...` the second segment still arms.
A CLI joins the exempt list only with cited evidence of its parser and of no hyphen-swallowing positional or non-help -h on any write verb. Findings 2026-09-23: [fastedit: argparse (src/fastedit/cli.py, editable install; no argparse.REMAINDER; no -h remap; write verbs edit/multi-edit/delete/rename/rename-all/batch-edit checked clean)] [tldr: read-only, no write subcommand exists at all; source uses clap (Cargo.toml clap 4.0); allow_hyphen_values found only on the read-only `search` query positional] [trddgrep: hand-rolled Node argv parser (scripts/trddgrep.mjs, no argparse/clap/yargs/commander) -- NOT eligible for this rule; `set <id> <field> --help` lets --help land as the literal field VALUE (a real write) with a preceding token that does not start with "-", so the drafted rule would wrongly exempt it -- do not add trddgrep to the exempt list] [memgrep: clap (Cargo.toml clap 4.6.1; strings shows 44 clap hits); allow_hyphen_values found only on the read-only `find` query positional; write verbs new-mem-atom/update-mem-atom/migrate-mem-atom/update-mem-topic have no allow_hyphen_values/trailing_var_arg/last(true) and no -h remap]. Empirical (fastedit, scratch file): [`fastedit edit f -h --replace f --snippet 'def f(): return 2'` -> exit 0, prints edit-subcommand usage, file unchanged] [`fastedit edit f --replace f --snippet --help` -> exit 2, "expected one argument" usage error, file unchanged].
Correction to the first refinement: "argparse likely errors" was unverified reasoning; the probe above replaces it. Click-style parsers accept --snippet --help as a value, so parser identity matters; the rule still arms on a --help preceded by an option token either way.
Acceptance (added): [ ] --snippet 'a --help b' still arms; [ ] sub -- x --help still arms; [ ] the second segment of fastedit --help && fastedit edit f ... still arms; [ ] each exempt CLI's evidence is cited in the code comment next to the list.
