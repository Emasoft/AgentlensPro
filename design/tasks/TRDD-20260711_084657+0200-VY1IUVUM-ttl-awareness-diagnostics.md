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

## Approval log

- 2026-07-11T09:20:00+0200 — USER directive (5 parts) relayed via retired pinger fork;
  TTL facts independently re-verified against the official doc by the orchestrator before
  authoring. Parts 1–3 = this TRDD; part 4 = janitor GitHub issue (orchestrator).
