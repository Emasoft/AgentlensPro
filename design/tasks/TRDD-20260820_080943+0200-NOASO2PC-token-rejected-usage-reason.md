---
trdd-id: NOASO2PC
title: Split a token_rejected reason out of subscriptionUsage's http_error catch-all
column: complete
created: 2026-08-20T08:09:43+0200
updated: 2026-08-22T20:02:00+0200
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

- [x] A 401 and a 403 each yield `reason: 'token_rejected'`; a 500 still yields `http_error`.
- [x] No cooldown file is written on a 401/403 (the 429 path is untouched). The 429 branch sits
      ABOVE the new one and returns before it, so `armCooldown` is unreachable from a 401/403 by
      construction rather than by remembering not to call it.
- [x] The unit test asserts all three statuses against the same fixture, so a future refactor that
      re-merges the branches fails loudly. Done as a TABLE over 9 statuses in one assertion loop,
      plus a second test asserting `httpFailureReason(401) !== httpFailureReason(500)` — that
      second one is what actually fails on a re-merge, since a collapsed branch would still return
      *a* reason for every status and could pass a per-case check repaired one row at a time.
- [x] `agentlenspro help get_subscription_usage` lists the new reason. Verified against the LIVE
      schema after `node esbuild.js` + `agentlenspro server restart` — not by grepping the source,
      because the description a consumer reads comes from the running server's bundle. Confirmed
      first that `agentlenspro` on PATH resolves into THIS repo, since CLAUDE.md records that it
      can be a published global install, in which case deploying here would change nothing.

## Implementation note

The status→reason mapping was extracted into an exported `httpFailureReason(status)` rather than
left as an inline ternary. Not decoration: this suite tests pure functions and does not stub
`fetch` (deliberately — the endpoint 429s hard, so driving the HTTP path from tests is the abuse
the back-off exists to prevent), so an inline branch would have been **untestable**, and the
card's requirement is precisely a test that fails on a re-merge. A branch with no callable surface
cannot have one. It returns `null` for 2xx, so a caller that forgets to check `res.ok` cannot
obtain a failure reason for a success.

## Approval log

- 2026-08-22T20:02:00+0200 — COMPLETED by main (self-orchestrating; USER authorised). Tier 0.
  Gates: `check-types` 0, `lint` 0, `check-identities` 0; unit suite 2432 passing / 1 failing —
  that failure is `bodyStore`'s dedup ratio, PRE-EXISTING and identical to the run before these
  changes.

## Notes and lessons learned

The measurement that justifies this is worth keeping even if the card is later cancelled: a
catch-all failure reason is indistinguishable from a transient one, so every consumer downstream
has to guess — and the guess a rotator makes on a dead credential is the expensive one.
