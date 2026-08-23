---
trdd-id: YST9ZJ90
title: Memoize the check_cache_expiry ANSWER and abandon server work on client disconnect
column: proposal
created: 2026-08-23T06:48:53+0200
updated: 2026-08-23T06:48:53+0200
current-owner: unassigned
task-type: refactor
approval-tier: 3
priority: high
severity: high
task-scope: standalone-server
parent-trdd: ZFX0MPYZ
relevant-rules: []
---

# Memoize the `check_cache_expiry` ANSWER and abandon server work on client disconnect

## Why this card exists at all

**TRDD-ZFX0MPYZ fixed an AMPLIFIER, not the source, and the source had no card.** It lived only as
a paragraph inside ZFX0MPYZ's STATE block — so when that card's last acceptance box closes and it
goes terminal, the actual runaway would have left the board silently, with the archived card
reading as though the problem were solved. An adversarial review caught that on 2026-08-23; filing
the card is Tier 0 (authoring needs no approval), building it is not.

## The measurement this rests on

From ZFX0MPYZ, all first-hand:

| fact | value |
|---|---|
| `check_cache_expiry` call rate | **147 calls/hour** (769 calls / 5h14m, profiled window) |
| cost of ONE call, minimum | one full recursive `readdir` + `statSync` over **14,509 files** |
| walk duration | 126–1902 ms (n=20, p50 633, p90 750) |
| share of main-thread busy | **36.6%**, the single largest attributed trigger |
| caller | OUTSIDE this repo — ai-maestro-janitor detectors `window-burn-rate.py:50`, `token-usage-anomaly.py:37` |
| CLI budget vs server behaviour | CLI abandons at 1500 ms; **the server keeps walking** |

After the ZFX0MPYZ fix the memo works correctly *within* one request. It does nothing across
requests, so 147 times an hour the server still pays a full walk of every session file on the
machine to answer one boolean.

## The proposed change, and why it is Tier 3

Two parts, both of which alter OBSERVABLE BEHAVIOUR — which is why this waits for the USER rather
than being self-approved:

1. **Memoize the ANSWER, not just the file listing.** `check_cache_expiry` reports against a
   60-minute TTL, so a seconds-fresh answer is not required by the question being asked. A cached
   answer with its own TTL would collapse ~147 walks/hour to a handful.
   *Behaviour change:* the tool can return an answer computed up to TTL ago. Anyone reading it as
   "right now" would be wrong in a way they cannot currently be.
2. **Abandon server work when the client disconnects.** The CLI already gives up at 1500 ms while
   the server continues to completion — work whose result provably nobody will read.
   *Behaviour change:* in-flight requests become cancellable; a caller that disconnects and retries
   gets different timing characteristics than today.

## What is NOT established, and must not be assumed by whoever builds this

- **The session-scaling hypothesis is UNMEASURED.** `cost = N_sessions × N_detectors × beat_rate`
  predicts burn scales with open Claude sessions rather than uptime. The rate was never observed at
  two different session counts. If it is true, memoizing the answer caps a cost that would
  otherwise grow with usage; if false, this is a constant-factor win. The discriminator is written
  into ZFX0MPYZ and has never been run.
- **147/hour is one window's average, not a rate law.** It is the profiled process's own window.
- **Whether the janitor's call frequency is itself the right thing to change** has not been
  considered here. It is a different repo (`how-to-fix-issues-of-other-projects.md` applies: file
  an issue there, never edit it from this session), and reducing OUR cost per call is the fix that
  belongs in THIS repo. Both could be correct.

## Acceptance criteria

- [ ] The USER has approved the behaviour change, or scoped it down explicitly. Until then this
      card does not leave `design/proposals/`.
- [ ] A measurement of the call rate at two different open-session counts, settling or refuting the
      session-scaling hypothesis BEFORE the design is fixed — the shape of the fix depends on it.
- [ ] The answer cache lands with a regression guard that fails when a probe burst issues more than
      one walk per TTL window, falsified in both directions (red before, green after) the way
      ZFX0MPYZ's guard was.
- [ ] Client-disconnect abandonment is proven by a test that disconnects mid-request and asserts the
      server stops working — not by a timing observation.
- [ ] The staleness bound the answer cache introduces is stated as a NUMBER in the code, with the
      measurement it came from, and it is parametric where it depends on walk duration.
- [ ] `agentlenspro cache-expired` still answers correctly, including its documented contract that
      it never prints `false` for a question it could not resolve.

## Approval log

- 2026-08-23T06:48:53+0200 — FILED as a proposal by the session working TRDD-ZFX0MPYZ. Not
  self-approved: both parts change observable behaviour, so this is the USER's call.
