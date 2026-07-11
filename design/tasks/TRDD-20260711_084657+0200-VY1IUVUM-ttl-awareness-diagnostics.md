---
trdd-id: VY1IUVUM
title: TTL-awareness — keepWarm and COLD_RESUME must not hardcode the 5-minute cache TTL
column: backburner
created: 2026-07-11T08:46:57+0200
updated: 2026-07-11T08:46:57+0200
current-owner: orchestrator-agentlenspro
priority: 3
severity: MEDIUM
effort: M
labels: [diagnostics, cache, correctness]
task-type: bugfix
release-via: publish
test-requirements: [unit]
implementation-commits: []
---

# TTL-awareness in cache diagnostics

## Problem

The P6 `keepWarm` diagnostic (warm/cold turn classification, wastedWriteTokens) and the
burn-gate's COLD_RESUME logic classify against a HARDCODED ~5-minute prompt-cache TTL.
Field evidence (2026-07-11, USER analysis relayed via the retired keep-warm fork): the
main conversation's cache entry lives ~1 HOUR in current Claude Code sessions, and cron
fires are main-session turns that renew it. Under a 1h TTL:

- `keepWarm` mis-labels turns with 5–60 min gaps as "cold" (overstating wastedWriteTokens);
- COLD_RESUME arms for stalls that were never cold;
- the entire fork-pinger recommendation class (warm every <5 min) becomes wasteful advice —
  measured live: a 230s-tick fork pinger burned $6.8/h to insure warmth the heartbeat (and
  the 1h TTL) already guaranteed.

## Fix design (verify FIRST, then parameterize)

1. **Measure, don't assume**: derive the EFFECTIVE TTL from our own bodies/statusline data —
   find turns whose gap since the previous request exceeds a candidate TTL yet still show
   `cache_read >> cache_creation` (a hit after the assumed expiry FALSIFIES that TTL).
   Compute per-session observed max-gap-with-hit; that is the TTL floor. Do this as a
   one-off audit script first (evidence in the TRDD), then as a small runtime estimator.
2. **Parameterize**: `AGENTLENS_CACHE_TTL_MINUTES` env/config with default derived from the
   estimator (fallback: the measured floor, not a guess); `keepWarm` + COLD_RESUME +
   gap-classification all read ONE shared constant module (single source of truth — no
   second copy in media/).
3. **Surface provenance**: keepWarm output gains `ttlAssumedMin` + `ttlSource:
   'measured'|'config'|'default'` so the number's basis is visible.

## Acceptance

- Audit script output committed as evidence (observed TTL floor per model/session class).
- With TTL=60min configured, a replayed session with 20-min gaps reports warmTurns (not
  cold); with TTL=5min the same fixture flips — test both.
- Suite grows, zero regressions; one shared TTL constant, anti-mirror guard clean.
