---
trdd-id: VY1IUVUM
title: TTL-awareness — keepWarm and COLD_RESUME must not hardcode the 5-minute cache TTL
column: dev
created: 2026-07-11T08:46:57+0200
updated: 2026-07-11T09:20:00+0200
current-owner: orchestrator-agentlenspro
assignee: ttl-awareness-agent
priority: 1
severity: MEDIUM
effort: M
labels: [diagnostics, cache, correctness]
task-type: bugfix
release-via: publish
target-branch: main
feature-branch: feat/ttl-awareness
merge-strategy: merge
must-pass-tests-before-merge: true
test-requirements: [unit, lint, typecheck]
external-refs: ["code.claude.com/docs/en/prompt-caching.md"]
implementation-commits: []
---

# TTL-awareness in cache diagnostics (USER directive 2026-07-11, doc-verified)

## ⏵ STATE — READ THIS FIRST ON RESUME — 2026-07-11

- **Current state**: spec expanded per USER directive (relayed via the retired keep-warm
  fork, then INDEPENDENTLY VERIFIED against code.claude.com/docs/en/prompt-caching.md by
  the orchestrator). Implementation agent launching on feat/ttl-awareness.
- **NEXT ACTION**: agent delivers parts 1–3; orchestrator deploys + releases; the janitor
  cadence proposal (part 4) is a GitHub issue on Emasoft/ai-maestro-janitor, filed by the
  orchestrator, NOT this repo's work.

## THE VERIFIED TTL MATRIX (doc facts — the ground truth this feature encodes)

| Session kind | Auth | TTL |
|---|---|---|
| Main conversation | Claude subscription (within plan) | **1 hour** (automatic) |
| Main conversation | subscription drawing USAGE CREDITS (over plan limit) | **5 min** (auto-dropped) |
| Main conversation | API key / Bedrock / GCP / Foundry | **5 min** (default; `ENABLE_PROMPT_CACHING_1H=1` opts into 1h) |
| Subagent (named/general) | any | **5 min ALWAYS** (own conversation, own cache; the 1h auto applies only to the main conversation) |
| Fork | inherits parent | reads the PARENT's entry; every hit RESETS the parent's timer |

Also doc-verified and load-bearing for classification:
- `FORCE_PROMPT_CACHING_5M=1` forces 5m regardless of auth (config detection needed).
- Every cache hit resets the inactivity timer; cron/scheduled fires are main-conversation
  turns (they renew the main entry).
- Small per-turn `cache_creation` = NORMAL incremental suffix writes; only a
  full-prefix-sized creation spike = true cold rewrite. Invalidation causes ≠ TTL expiry:
  model/effort/fast-mode switch, MCP server connect/disconnect (non-deferred), bare-tool
  deny, compaction, CC upgrade.
- Cache scope: per machine+directory (+model +effort); rewind re-hits old entries.

## Deliverables (USER directive parts 1–3)

1. **CLI/diagnostics — TTL-regime tracking**: classify every observed session into the
   matrix above (main vs subagent vs fork from existing card lineage; auth regime from
   available signals — plan/account data the burn monitor already tracks, usage-credit
   overflow state, `ENABLE_PROMPT_CACHING_1H`/`FORCE_PROMPT_CACHING_5M` env detection via
   setup/config inspection where possible; when a signal is absent, report
   `ttlSource: 'assumed'` — NEVER silently guess). Surface `ttlAssumedMin` + `ttlSource:
   'doc-matrix'|'config'|'measured'|'assumed'` on keepWarm output and gap classification.
   Keep the MEASURED estimator as the falsifier: a cache hit after an assumed expiry
   (gap > assumed TTL yet cache_read >> cache_creation) CONTRADICTS the assumption →
   flag it, prefer the measured floor.
2. **Skill recipes** (`skills/agentlenspro-diagnostics/SKILL.md`): a "cache TTL tracking"
   section — how to read keepWarm's TTL-aware output, how to tell true cold rewrites
   (full-prefix creation spikes) from normal suffix writes, the TTL matrix table, and the
   one-liner recipes for auditing a session's warm/cold classification.
3. **Alerts + hooks TTL-aware**: burn-gate COLD_RESUME, the keepWarm diagnostic, and any
   gap-based warning use the per-session TTL regime (not a global 5-min constant). A 7-min
   gap on a subscription MAIN session is NOT a cold-resume risk; the same gap on a
   subagent IS. One shared TTL module (src/shared/ — both runtimes, anti-mirror guard).

## Acceptance

- Fixture matrix tests: same 20-min-gap session classified warm under main+subscription
  (1h), cold under subagent (5m), cold under usage-credits (5m); FORCE_5M override wins.
- Measured-contradiction test: fixture with gap 20min + cache-hit under an assumed 5m
  regime → flagged, ttlSource becomes 'measured'.
- keepWarm/COLD_RESUME read the shared module (grep-proof: no literal 5-minute constant
  left in gate/diagnostic code paths).
- Suite grows from 783/0, zero regressions; docs + CHANGELOG (v2.2.0).

## ADDENDUM 2026-07-11 (USER: "fix immediately") — ROOT-CAUSE BUG + account command

**THE BUG (found by orchestrator, live-verified):** `src/ttlContext.ts resolveAuthRegime`
compares `billing === 'subscription'`, but the REAL `~/.claude.json` oauthAccount value is
`stripe_subscription` (proven: `get_account_status` → `billingType:"stripe_subscription",
hasExtraUsageEnabled:false, rateLimitTier:"default_claude_max_5x"`). So every subscription
account falls through to the `api-key` branch → misclassified → wrong 5-min TTL → the gate/
keepWarm emit false cold-rewrite warnings on a 1h-TTL subscription session. FIX: match any
billingType CONTAINING 'subscription' (case-insensitive) as the subscription regime.

**Part 5 — the account/plan/window command (USER directive):** `get_account_status` must
report, as a clean human-readable summary: email; MODE (subscription within-plan / drawing
usage-credits / api pay-per-token — from billingType + hasExtraUsageEnabled + 5h fill);
PLAN ("Max 5x"/"Max 20x"/"Pro"/… from planType + rateLimitTier `default_claude_max_5x` →
5x, `_20x` → 20x); 5h% and 7d% window used; and cacheTtl {minutes, regime, ttlSource}. The
authoritative 5h/7d % is Claude Code's `rate_limits.{five_hour,seven_day}.utilization`
(0-100) — the statusline reads it (statusline.py ~724-785) and persists to the ingested
usage log; capture it (add ingestion if absent), fall back to AgentlensPro's own calibrated
pct, and stamp `windowSource: 'cc-rate-limits'|'calibrated'|'none'` (never present a null as 0).

## ⏵ STATE UPDATE — 2026-07-11 (resuming to FINISH) — supersedes the incomplete-state block above

Architecture (verified sound): `src/ttlContext.ts` (Node I/O resolver: account+env → regime)
feeds the pure `src/shared/cacheTtl.ts` classifier; keepWarm + gate already consume it (3
committed commits d51f1a0/de77d15/11225fd). NOT a duplicate of anything — the earlier
"duplicate module" worry was wrong. Remaining to finish on `feat/ttl-awareness`: (1) the
stripe_subscription match fix, (2) finish wiring `getTtlContext` into server/burnMonitor
(clear the unused imports), (3) the Part-5 account command enrichment + 5h/7d% ingestion,
(4) tests incl. the stripe_subscription regression + the account-command fixture, (5)
SKILL.md recipes + CHANGELOG v2.2.0, gates (baseline 783/0), merge --no-ff.

## Approval log

- 2026-07-11T09:20:00+0200 — USER directive (5 parts) relayed via retired pinger fork;
  TTL facts independently re-verified against the official doc by the orchestrator before
  authoring. Parts 1–3 = this TRDD; part 4 = janitor GitHub issue (orchestrator).
- 2026-07-11 (later) — USER "fix immediately" after orchestrator wrongly asserted this
  session was on usage credits (it is subscription/Max-5x, ipazia). Root-cause bug found +
  Part-5 account command added. Tier 0 correctness fix.
