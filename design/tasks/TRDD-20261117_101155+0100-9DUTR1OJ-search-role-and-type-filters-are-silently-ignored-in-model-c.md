---
trdd-id: 9DUTR1OJ
title: search - role and type filters are silently ignored in model-change mode
column: backburner
status: tasked
created: 2026-11-17T10:11:55+0100
updated: 2026-11-17T10:20:53+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T10:11:55+0100
---

# search - role and type filters are silently ignored in model-change mode

## Problem
`agentlenspro search --kind model-change --role user` (and `--type`) returns the same model changes as without the flag: in model-change mode the scope filters for role and type are not applied (src/cli/searchCli.ts scopeFilters, the branch guarded by mode !== "change"). A filter that is accepted and silently ignored gives a wrong answer without an error.

## Evidence
Found by the worker of TRDD-OIMXULDJ on 2026-11-17 while writing the scope-filter tests: its test for `--role user` in model-change mode failed on the committed code. It fixed it in 3 lines, the harness review asked for the change to be taken out of that card's commit because the card did not ask for it, and the worker reverted it. The test title in src/test/searchCli.test.ts now says "--role is not applied in this mode: known gap, not asserted". Not re-run by the main agent.
2026-11-17T10:20+0100 main agent: the location is now READ by the main agent in the committed source (src/cli/searchCli.ts at 37e538fc, function scopeFilters, lines 905 to 911): the role and type conditions are pushed only inside `if (mode !== "change")`.

## Decision needed in the fix
A model change is read from assistant entries only, so two behaviours are defensible: (a) apply the filter against the constant role and type "assistant" (the worker's version: `--role user` gives 0, `--role assistant` gives all), or (b) refuse `--role` / `--type` together with `--kind model-change` as a usage error (exit 64). Pick one, say why in the help text.

## Acceptance
- [ ] `--kind model-change --role user` no longer returns the unfiltered changes (0 hits or a usage error, per the decision).
- [ ] A test asserts it and fails on today's code.
- [ ] The help text says what `--role` and `--type` mean in model-change mode.

## Approval log

- 2026-11-17T10:11:55+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
