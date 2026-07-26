---
name: cache-ttl-model
description: "keepWarm says cold turns but the session felt warm / is the cache TTL 5 minutes or 1 hour / why did the heartbeat look like it was rewriting the cache / do fork pingers save money / when is cache_creation a real cold rewrite / are our cache-write dollar figures too low / why is a 1-hour cache write more expensive / what is the minimum prefix size that caches at all — the verified TTL-regime matrix, the tiered write rate, and measured keep-warm economics"
ocd: 2026-07-11
lmd: 2026-07-26
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

**The WRITE rate is tiered by that same TTL — and our cost function ignores it.** A 5-minute write
bills at **1.25×** base input; a **1-hour write at 2×**. Not extrapolated from the API pricing doc —
**verified against Claude Code's OWN `cost_usd`** three ways (2026-07-26): (1) solving the implied
write rate over ~700 opus calls gives a median of exactly **$10.0000**/MTok with p10 exactly
**$6.2500** (both published tiers present, so NEITHER flat rate is correct); (2) joining those
events to their raw bodies on `request_id`, the implied rate matches the body's
`usage.cache_creation.ephemeral_{5m,1h}` tier **26/26**; (3) one call reconciles to the cent —
in=2, read=62,610, write=405,521 (all 1h), out=133 → $10/MTok yields `cost_usd` **4.089850** exactly,
while the flat $6.25 yields 2.569146. Main conversations on a subscription take the 1h tier automatically, so their writes
cost **2×**. **FIXED in v2.16.0** (`ba5a432`): `calcTokenCostUsd` takes a trailing `cacheWrite1hTokens` argument
(default 0, so an unaware caller keeps the old behavior and the correction can never silently move a
number), and `cacheWrite1hRate` derives 2×base-input — but ONLY for entries with the Anthropic 1.25×
shape, so a provider that prices writes differently, or not at all, is never handed a rate it does
not charge. Deriving beat hand-editing ~15 entries: a future Claude model is priced correctly the
moment its input rate is added.[^3] **Better still, prefer the harness's own number**: the OTEL
`claude_code.api_request` event carries `cost_usd`, and Claude Code's price table is already
tier-aware — `get_cache_event_log` marks each row `costSource: harness | computed`.
Cache READS are 0.1× in both tiers and a read refreshes the TTL for free (break-even: one read for a
5m entry, two for a 1h entry).

Minimum cacheable prefix, by model: **512** tokens (Opus 5, Fable 5, Mythos 5), 1,024 (Opus 4.8,
Sonnet 5/4.6/4.5), 2,048 (Opus 4.7, Haiku 3.5), 4,096 (Opus 4.6/4.5, Haiku 4.5) — below it nothing
caches at all. Max 4 explicit `cache_control` breakpoints per request, 20-block lookback each.

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
[^3]: [id:ATOM-WRITE-TIER-FLAT, status:valid, keywords:"cache_write_priced_flat_5m_rate one_hour_write_2x_undercount calcTokenCostUsd_single_write_arg tier_already_parsed_but_unused", ocd:2026-07-26, lmd:2026-07-26]
  DO NOT price `cache_creation` with a single flat write rate, BECAUSE the rate is tiered by TTL
  (5m = 1.25×, 1h = 2×) and Claude Code puts every main-conversation turn on a subscription into the
  1h tier automatically — so our flat 5m rate under-reports the most common write on this machine by
  60%, and every burn/attribution figure built on it inherits the error. The tier was never unknown:
  `usage.cache_creation` reports both buckets and we already parse them into
  `cacheCreation5mTokens` / `cacheCreation1hTokens`. DO carry the two buckets through to
  `calcTokenCostUsd` and add `cacheWrite1hPerMTok` to the rate table, so the tier is read from the
  data rather than assumed. (Parsing a field and then not using it is how a known fact becomes a
  silent error.)

[^2]: [ocd:2026-07-11 lmd:2026-07-11] the fork keep-warm pinger doctrine (unbounded 230s
  ticks) was built on the 5-min premise and retired the day the 1h fact landed; its v4
  instance had ALSO degenerated into a zombie (one endless blocking shell poll — alive in
  the UI, zero API turns, zero warming; liveness = transcript mtime, never task-alive
  status). Lesson: verify the premise a standing order rests on before optimizing its
  implementation.
