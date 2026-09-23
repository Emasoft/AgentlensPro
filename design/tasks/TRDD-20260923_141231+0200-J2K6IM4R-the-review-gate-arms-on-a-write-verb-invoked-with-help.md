---
trdd-id: J2K6IM4R
title: The review gate arms on a write verb invoked with --help
column: todo
created: 2026-09-23T14:12:31+0200
updated: 2026-09-23T14:12:47+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: bugfix
min-approval-requirement: none
assignee: emanuelesabetta
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
