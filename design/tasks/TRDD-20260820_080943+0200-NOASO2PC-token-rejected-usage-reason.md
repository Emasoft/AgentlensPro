---
trdd-id: NOASO2PC
title: Split a token_rejected reason out of subscriptionUsage's http_error catch-all
column: todo
created: 2026-08-20T08:09:43+0200
updated: 2026-08-20T08:09:43+0200
current-owner: AgentlensPro session
task-type: feature
severity: LOW
priority: 4
effort: S
labels: [accounts, api, consumers]
approval-tier: 0
relevant-files: [src/subscriptionUsage.ts]
release-via: publish
---

# Split `token_rejected` out of `subscriptionUsage`'s `http_error` catch-all

## Why

`UsageReading.reason` is the payload's honesty field — it says WHY a reading is what it is.
Today a 401/403 (the credential was REJECTED) collapses into `http_error` at
`src/subscriptionUsage.ts:684` (`if (!res.ok) return serve(cached, 'http_error')`), which is the
same value a 500, a timeout, or a DNS failure produces. A consumer can therefore see "no reading"
but never "your token is dead" — and those call for opposite actions: retry later vs re-auth /
rotate.

Surfaced 2026-08-20 by the ai-maestro server session, auditing whether its account rotator could
source from the agentlenspro CLI instead of its own endpoint. Its rotation decision needs two
signals: a model-scoped weekly percentage (WE HAVE IT — `limits[]` `kind: 'weekly_scoped'` with
`scopeLabel`, verified live) and a token-rejected branch (WE DO NOT). Because of the second gap it
is correctly entering agentlenspro as a purely ADDITIVE disjunct for rotation — it may only ever
ADD a limit reason, never remove one. This card closes the gap; it does NOT commit to their
rotation timeline, and nothing on their side depends on it landing.

## What

- Split the `!res.ok` branch on status: `401`/`403` → a new `token_rejected` reason; every other
  non-ok status keeps `http_error`.
- Add `'token_rejected'` to the `reason` union (`src/subscriptionUsage.ts:109`) and to the
  `get_subscription_usage` tool description's failure list, which enumerates the reasons verbatim.
- Do NOT arm the 429 cooldown on it — a rejected token is not rate limiting, and arming the
  back-off would suppress the retry that a fresh credential should get immediately.
- The degrade-to-last-known-reading behaviour is unchanged: `serve(cached, 'token_rejected')`,
  same as every other failure path. A stale reading still suppresses its reset countdowns.

## Acceptance

- [ ] A 401 and a 403 each yield `reason: 'token_rejected'`; a 500 still yields `http_error`.
- [ ] No cooldown file is written on a 401/403 (the 429 path is untouched).
- [ ] The unit test asserts all three statuses against the same fixture, so a future refactor that
      re-merges the branches fails loudly.
- [ ] `agentlenspro help get_subscription_usage` lists the new reason (the description is the
      contract consumers read).

## Notes and lessons learned

The measurement that justifies this is worth keeping even if the card is later cancelled: a
catch-all failure reason is indistinguishable from a transient one, so every consumer downstream
has to guess — and the guess a rotator makes on a dead credential is the expensive one.
