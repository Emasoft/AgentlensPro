---
trdd-id: IPEPUEL5
title: The thrash tier rule misattributes on a usage-credits account because report() does not know the TTL regime
column: backburner
created: 2026-09-05T11:26:34+0200
updated: 2026-09-05T11:26:34+0200
current-owner: main-session
task-type: bugfix
priority: medium
min-approval-requirement: none
created-by: DIZ289UQ
related: [DIZ289UQ, VY1IUVUM, K4XQ7M2B]
review-after: 2026-10-03
---

# The thrash tier rule misattributes on a usage-credits account because report() does not know the TTL regime

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-05T11:26:34+0200

TRDD-DIZ289UQ's rule: a big 5m-tier write is a subagent's own prefix; the caller's turns are
1h-tier on a subscription. On a usage-credits account the caller's turns are 5m-tier too, so the
detector files them under `subagentWrites` and `thrash.active` can then fire only on untiered
(old-build) bodies — it does not go quiet, it names the wrong calls. The gate already resolves
the regime (`st.burn.ttl_context(now)` in `burn/agent_gate.rs`); `bodies_activity::report()` does
not receive it. The fix is plumbing that regime into `report()` in both engines (the TS oracle
`src/bodiesActivity.ts` too) and treating 5m as the caller's tier when credits are on.

`medium`, not `low`: the credits regime is a documented, expected state of every subscription
account (the 1h TTL drops to 5m in overage — CLAUDE.md cache doctrine), so any instance that runs
its window down enters it mid-session; the cost there is a wrong culprit in a warning, not a
blocked launch (the gate no longer denies forks), which is what keeps it out of `high`. Raise it
on the first credits-regime capture that shows a false `active`. `backburner` on purpose — no
open card can unblock it, so `blocked-by:`/`unblock-when:` would be a predicate nothing evaluates.

Parked, not built: this machine is on the subscription regime (`get_subscription_usage`: "usage
credits: disabled — 1-hour prompt-cache TTL active"), the store holds no credits-regime capture,
and a fixture written without one would pin an assumed shape — the failure DIZ289UQ hit twice.
The shipped skill tells a credits-regime reader to read `subagentWrites` meanwhile.

## Acceptance

- [ ] A captured credits-regime session (responses with 5m-tier main turns) exists as a fixture
      or a store window, and the rule is written against it, not against an assumed shape.
- [ ] `report()` takes the regime; with credits on, 5m-tier writes count as the caller's; with
      credits off, behaviour is byte-identical to today (both parity oracles unchanged).
- [ ] The skill's credits blind-spot clause is removed in the same change.

## Notes and lessons learned
