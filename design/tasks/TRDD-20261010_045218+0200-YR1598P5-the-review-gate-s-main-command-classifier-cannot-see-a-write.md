---
trdd-id: YR1598P5
title: The review gate's main command classifier cannot see a write inside a nested shell or a fed script
column: backburner
status: tasked
created: 2026-10-10T04:52:18+0200
updated: 2026-10-10T04:52:18+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-10T04:52:18+0200
---

# The review gate's main command classifier cannot see a write inside a nested shell or a fed script

Split out of TRDD-9YWTNFU8, which measured these on 2026-10-10 and left them unfixed: a write inside `bash -lc '...'` (clustered option), inside a script fed by heredoc, in `bash script.sh`, or in `$SHELL -c` is invisible to both the main gate and the worker gate (src/cli/reviewGateTriggers.ts). The worker path already judges nested shells on shell words (da380f32); the main classifier does not.

Also to confirm here (observed 2026-10-10, NOT traced in the code): the gate armed on a redirect into `$L.old` and `$F.head`, where the variable held a scratchpad path under /private/tmp and the suffix had no slash. 9YWTNFU8 step 1 resolves `$VAR/suffix` only, so this may be the same false trigger in a second spelling.

## Acceptance

- [ ] each of the four invisible forms has a failing test first, then arms the gate
- [ ] the `$VAR.suffix` redirect is either shown not to arm for an ephemeral target, or fixed, with a fail-closed test for a repo target
- [ ] gate suites, check-types and lint pass

## Approval log

- 2026-10-10T04:52:18+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
