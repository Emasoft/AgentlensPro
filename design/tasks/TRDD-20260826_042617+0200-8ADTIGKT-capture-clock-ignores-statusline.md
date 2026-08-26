---
trdd-id: 8ADTIGKT
title: The capture-liveness clock ignores statusline samples so a statusline-only machine never raises CAPTURE DOWN
column: todo
created: 2026-08-26T04:26:17+0200
updated: 2026-08-26T04:26:17+0200
current-owner: AgentlensPro session
task-type: bugfix
severity: LOW
scope: project
project-id: agentlenspro
min-approval-requirement: none
relevant-files: [src/cli/serverControl.ts]
npt: []
eht: []
---

# The capture-liveness clock counts two of three feeds

TRDD-4FMHW124 shipped capture-liveness detection for `server status`. Its own
description lists three things that count as capture: OTEL spans, POSTed hook
events, and statusline samples. The implementation bumps the activity clock on
the first two only.

## Direction of the error

FALSE NEGATIVE only, and that is the whole reason this is LOW and not urgent: a
machine where only statusline traffic flows would keep reporting an ageing
capture clock and could eventually say CAPTURE DOWN while capture is, in fact,
working. It can never raise a false alarm about a healthy feed going quiet, and
it can never mask a real outage of the two feeds it does watch.

Found by an adversarial review fork over 5dfac15, checking the card's claims
against the diff rather than against the card's prose.

## Acceptance

- [ ] Either the statusline sample path bumps the same activity clock, or the
      card's own list of what counts as capture is corrected to the two feeds
      that actually do — one source of truth, not two descriptions.
- [ ] Whichever way it goes, a test pins it, so the list and the code cannot
      drift apart again silently.
