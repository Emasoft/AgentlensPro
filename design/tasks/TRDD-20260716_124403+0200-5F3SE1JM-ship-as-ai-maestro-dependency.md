---
trdd-id: 5F3SE1JM
title: Ship AgentlensPro as an ai-maestro dependency — compatibility alignment + locked CLI contract
column: ai_review
created: 2026-07-16T12:44:03+0200
updated: 2026-07-16T20:55:00+0200
current-owner: main
task-type: feature
severity: major
scope: project
npt: []
eht: []
labels: [ai-maestro, integration, contract, cli]
implementation-commits: [d1a3074, 098b458, 2343ab0]
test-requirements: [unit, typecheck, lint]
---

# Ship AgentlensPro as an ai-maestro dependency

## ⏵ STATE addendum — 2026-07-16 20:55 — cache-health surface locked (Phase 3, closes the last open #3 question)

The ai-maestro Claude's one remaining question on #3 ("are check_cache_expiry /
get_cache_break_report / get_cache_break_gap_report / get_cache_break_timeline stable in 2.8.0?"
— the tailored janitor consumes them to prevent cache-miss/expiration) is ANSWERED as commit
`2343ab0`: +7 contract tests pin the consumed paths (expiry rows incl. `marginMs` TTL-remaining;
break-report per-session + cross-session payload keys; the gap report's 6 FIXED bucket keys = the
5m-TTL-expiry-vs-genuine-break diagnostic; the timeline report + a type-level CacheBreakEvent pin
incl. `ttlTier`/`TTL_EXPIRY`). Honest split posted on #3: everything pinned ships in 2.8.0 EXCEPT
the additive scan-honesty metadata from 4b4dc8f (expiry `coverage{...}`/`note`, break-report
`scanStoppedEarly`/`scanNote`) which lands next release. Gate: 1314/0, tsc 0, lint 0. v2.8.0 is
LIVE on npm (verified earlier today) — nothing owner-gated remains on this card; gate = human review.

## ⏵ STATE — READ THIS FIRST ON RESUME (superseded by the 20:55 addendum above) — 2026-07-16

**✅ ALIGNMENT COMPLETE (Phase 2 done, ~14:30). The ONE remaining step is OWNER-GATED: publish
v2.8.0.** The ai-maestro Claude answered #70 and filed the reciprocal AgentlensPro#3:
AgentlensPro is now an **official ai-maestro dependency** — npm CLI, floor `>=2.8.0`, installed
by their `scripts/install-agentlens.sh` (their commit 5d889dc5, TRDD-WF0UE9BC), same tier as
tldr/fastedit/distill; no CC-plugin wrapper. Their rulings: `~/.agentlens` machine-scope state
ACCEPTABLE; ports no-collision (they are :23000); pin 2.8.0. Phase 2 delivered (commit 098b458):
- `src/test/cliContract.aimaestro.test.ts` locks the 6 additional consumed tools — with
  **corrected** field names (their Q2 list guessed `cost`/`cache_read`/`billingMode`/
  `fiveHour`/`sevenDay`, none of which exist); the true paths are pinned and the corrections
  posted on #3 so their parsers are written against reality.
- R16 security confirm ANSWERED with code evidence: no account tool emits OAuth token material
  (`accountInfo.ts:10-13` — `parseSubscriptionType` single choke-point; tokens never returned/
  logged/persisted; AgentlensPro has no rotation capability at all).
- Gate: 1294 passing / 0 failing, tsc 0, lint 0 errors.
Their installer fail-soft no-ops until v2.8.0 is on npm — so the end-to-end go-live rides
entirely on the owner's push + tag.

(Superseded Phase-1 block below, kept for lineage:)

**Phase 1 DONE (contract lock + coordination filed); Phase 2 BLOCKED on the ai-maestro Claude's
answers.** User directive (verbatim, 2026-07-16): "check the open issues and align with
ai-maestro claude to make the agentlenspro compatible with ai-maestro, so to ship it as a
ai-maestro dependency."

Done:
- **Issue sweep**: AgentlensPro#2 was the janitor's contract-lock request (the only open issue on
  our repo) — ANSWERED with live-verified facts + enforcement; janitor#99 got the typosquat-FP
  recurrence comment; janitor#86 (fleet-status) is addressed to the janitor, not us — nothing owed.
- **Contract lock (commit d1a3074)**: `src/test/cliContract.janitor.test.ts` pins the exact
  janitor-consumed field paths (get_account_status.cacheTtl.minutes;
  get_burn_status.{global.costPerHour, activeSessions, topSessions[].{workspace,sessionId}};
  investigate_burn.{findings[].{cause,shareOfWindow,confidence}, attribution[].workspace}) via the
  REAL payload builders. Gate: 1288 passing / 0 failing, tsc 0, lint 0 errors. Any reshape fails
  CI and the assertion text routes the author to post on AgentlensPro#2 first.
- **Coordination filed**: ai-maestro#70 asks the 5 contract-shaping questions (dependency channel
  npm-vs-plugin-wrapper, consumed surface, ~/.agentlens state-footprint ruling vs their #32,
  ports/env conventions, version floor 2.8.0). Cross-refs their #56 deliverable 4 (planned
  AgentLens skill incorporation) and janitor#78 (cost-series integration, already shipped).

**NEXT ACTION**: when ai-maestro#70 gets answers — (a) add every newly named consumed field to
`cliContract.janitor.test.ts`; (b) implement whatever channel/convention they pick (e.g. a CC
plugin wrapper is a NEW child TRDD, not this one); (c) if they adopt the observed-capacity
surface, extend the contract test with the get_window_budget/get_window_eta paths offered in
AgentlensPro#2's answer.

Load-bearing facts:
- AgentlensPro is an npm CLI, NOT a Claude Code plugin — the `{plugin-name}--v{version}` git-tag
  dependency mechanism (their TRDD-JT3U4ZVM) does not apply; npm semver is our channel unless #70
  says otherwise.
- The janitor consumes us FAIL-OPEN (absent binary degrades silently) — keep it that way; never
  make ai-maestro hard-depend on a running server.
- v2.8.0 is the version to pin (contract test + calibrated windows + attribution feed);
  tag/publish awaits the OWNER's explicit approval (push also releases npm+docker via OIDC).

## Verify

- `npx mocha out/test/test/cliContract.janitor.test.js` → 3 passing (drift guard live).
- AgentlensPro#2 answered: https://github.com/Emasoft/AgentlensPro/issues/2
- ai-maestro#70 open with the 5 questions: https://github.com/Emasoft/ai-maestro/issues/70

## Notes and lessons learned
