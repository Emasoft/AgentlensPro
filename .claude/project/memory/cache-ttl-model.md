---
name: cache-ttl-model
description: "keepWarm says cold turns but the session felt warm / is the cache TTL 5 minutes or 1 hour / why did the heartbeat look like it was rewriting the cache / do fork pingers save money / when is cache_creation a real cold rewrite — the verified TTL-regime matrix and measured keep-warm economics"
ocd: 2026-07-11
lmd: 2026-07-24
metadata:
  node_type: memory
  type: project
  tier: component
---

The prompt-cache TTL depends on session kind AND auth regime (source:
code.claude.com/docs/en/prompt-caching.md, fetched + verified 2026-07-11):

| Session kind | Auth | TTL |
|---|---|---|
| Main conversation | subscription (within plan) | **1 hour**, automatic |
| Main conversation | subscription drawing usage credits | 5 min (auto-dropped) |
| Main conversation | API key / Bedrock / GCP / Foundry | 5 min (`ENABLE_PROMPT_CACHING_1H=1` opts into 1h) |
| Subagent | any | **5 min always** |
| Fork | inherits parent | reads the PARENT's entry; every hit RESETS the parent's timer |

`FORCE_PROMPT_CACHING_5M=1` forces 5m regardless. Every cache hit resets the inactivity
timer; **cron fires are main-conversation turns** and renew the main entry. Small per-turn
`cache_creation` = normal incremental suffix writes; only a full-prefix-sized creation spike
is a true cold rewrite, and its causes are invalidations (model/effort/fast-mode switch,
MCP server connect/disconnect when tools load into the prefix, bare-tool deny, compaction,
CC upgrade) — not TTL expiry on an active session.[^1]

Measured keep-warm economics (this project, 2026-07-11, ~410k context session): every turn
of ANY kind re-reads the full prefix at the 0.1× rate ≈ $0.50/turn; a 230s fork pinger =
~$6.8/h; a 5-min heartbeat = ~$6/h; one avoided cold rewrite ≈ $8. Under the 1h TTL a
dedicated warmer is pure waste — any main turn each ~55 min suffices.[^2] The TTL-regime
matrix is encoded in the diagnostics by TRDD-VY1IUVUM (`ttlAssumedMin` + `ttlSource`
provenance, measured-TTL falsifier). Governed by [[agentlens-burn-token-model]]; see also
[[agentlenspro-ops-lessons]], [[burn-seismic-statistical-model]] (the detector that classifies a
cold rewrite statistically — COLD_REWRITE tag, thrash-vs-marathon decomposition),
[[agent-fleet-cache-economics]] (measured spawn/boot economics under these TTL regimes).

## Notes and lessons learned

[^1]: [ocd:2026-07-11 lmd:2026-07-11] earlier this project treated the 5-min TTL as
  universal (P6 keepWarm CACHE_TTL_MS, COLD_RESUME's 10-min window) and attributed 7-min
  heartbeat gaps to TTL-expiry rewrites; wrong — subscription main sessions run a 1h TTL,
  and the observed creations were invalidations or usage-credit windows. Lesson: a TTL is
  a per-session-regime property, never a constant; classify the regime before classifying
  the turn.
[^2]: [ocd:2026-07-11 lmd:2026-07-11] the fork keep-warm pinger doctrine (unbounded 230s
  ticks) was built on the 5-min premise and retired the day the 1h fact landed; its v4
  instance had ALSO degenerated into a zombie (one endless blocking shell poll — alive in
  the UI, zero API turns, zero warming; liveness = transcript mtime, never task-alive
  status). Lesson: verify the premise a standing order rests on before optimizing its
  implementation.
