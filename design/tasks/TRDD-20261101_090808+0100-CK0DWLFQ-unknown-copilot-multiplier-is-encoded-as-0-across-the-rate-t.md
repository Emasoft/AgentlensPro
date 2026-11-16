---
trdd-id: CK0DWLFQ
title: Unknown Copilot multiplier is encoded as 0 across the rate table
column: backburner
status: tasked
created: 2026-11-01T09:08:08+0100
updated: 2026-11-01T09:08:08+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-01T09:08:08+0100
---

# Unknown Copilot multiplier is encoded as 0 across the rate table

ModelRates.multiplier uses 0 to mean included or free. Every Claude model that GitHub's Copilot docs do not list (claude-opus-5-5, claude-fable-5, claude-fable-5-1, claude-mythos-5-1, claude-sonnet-5, and now claude-haiku-5-5) also carries 0, and media/src/sessionMetrics.ts defaults a missing row to 0, so unknown and free read the same. Scope: an explicit unknown representation in ModelRates and every consumer (the TypeScript side and the Rust pricing.json reader). Acceptance: a model absent from the Copilot docs reads as unknown, not 0, in request-mode figures. Split from TRDD-KQ549VCQ scope item 1 on 2026-11-01.

INFERRED, not checked: a caller that branched on lookupRates returning null for claude-haiku-5-5 used to show the call as unpriced and now shows 0 premium requests, which reads as free. No such caller on the multiplier path has been identified yet; find one or drop this. Also unverified in this card: the list of models above was taken from a builder report, and whether the Rust pricing.json reader consumes multiplier at all was not checked.

## Approval log

- 2026-11-01T09:08:08+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
