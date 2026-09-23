---
trdd-id: J2K6IM4R
title: The review gate arms on a write verb invoked with --help
column: todo
created: 2026-09-23T14:12:31+0200
updated: 2026-09-23T19:05:08+0200
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
