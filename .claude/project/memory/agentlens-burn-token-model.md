---
name: agentlens-burn-token-model
description: "5h/7d account window drained fast / burning 1M+ tokens per minute / what is consuming all the tokens / impossible that a few Claude sessions burned the window / cost vs token window limit / cache-read dominating burn / OTEL and JSONL report different token numbers for the same session / session cost looks 100x too big or negative / all 3 OAuth accounts drained one after another over ~2 days / a huge idle main session re-woken every ~15 min by a heartbeat cron / plugin reloads forcing full cache-CREATE rewrites / what exhausted my 7-day rate-limit window with no visible rate-limit wall"
ocd: 2026-07-08
lmd: 2026-07-30
metadata:
  node_type: memory
  tier: hub
  type: project
  globs: ["src/burnMonitor.ts", "src/statuslineUsage.ts", "media/src/tabs/Alerts.tsx"]
---

# AgentLens burn / token-consumption model

**The recurring question — "what is consuming all these tokens? / the 5h window drained in a breath":**
On real Claude Code workloads **~96% of every consumed token is `cache_read`** — the resident context
(a large CLAUDE.md + `~/.claude/rules/*` + MCP tool schemas [lean-ctx ~100 tools, codegraph,
chrome-devtools] + the accumulated marathon transcript) **re-read on every single turn**. Fresh input
~0.1%, output ~0.2%, cache-create ~3-4%. So a session doing a few turns/min over a 300-400k-token
resident context "consumes" millions of cache-read tokens/min — huge COUNT, but cache-read is billed
0.1× input, so cheap in dollars. N concurrent marathon sessions multiply it. It is NOT phantom
double-counting (usage is deduped by Anthropic `message.id`).

**Root cause = resident-context floor (~300-400k/turn) × marathon turn count × N concurrent sessions.**
Levers to cut burn, biggest first: (1) shrink the per-turn floor — trim CLAUDE.md + rules + shed unused
MCP servers; (2) don't run many marathon sessions at once; (3) start fresh sessions (the transcript
floor resets) instead of 2000-turn ones.

**Cost-vs-token nuance (important):** the rate/window numbers in `burnMonitor.ts` sum all 4 buckets
equally, so raw tokens over-state consumption if a plan's window is COST-based. BUT even cost-weighted
(cache-read 0.1×), cache-read stays ~70% of the window's billable weight — its sheer volume wins. Raw 5h
≈ 227M tokens ↔ cost-weighted ≈ 31M input-equivalents (7.3×) ↔ actual cost ≈ $897; read
`consumedCostUsd` / `consumedBillableWeighted`, not raw tokens, to judge a cost-based window.

**Where it lives:** `src/burnMonitor.ts` — `ConsumptionEvent` (2 sources: OTEL `api_request` rich +
statusline billing deltas), `BurnRateWindow.breakdown` + `billableWeightedPerMin`, `WindowConsumption`
(5h/7d), `BILLABLE_WEIGHTS` (output 5×, cacheRead 0.1×, cacheCreate 1.25× — model-independent, NOT
Anthropic's undisclosed window weighting). `src/statuslineUsage.ts` carries the per-turn bucket split
onto the statusline event (no-OTEL sessions). Webview `BurnBreakdownBar` in the Alerts config section.
`/api/burn-status` + SSE (4s tick) + MCP `get_burn_status`/`get_session_status`.

**Known GAP (tracked in TRDD-BURNWDGT):** the window budget pools consumption **machine-wide across all
accounts** — WRONG, because rate limits are **per OAuth account** (token in the macOS keychain). Rotating
accounts mid-window must not pool. Also missing: cost-based capacity, empirical capacity calibration
(measure consumed at a PREMATURE window end = a rate-limit hit, NOT a time rollover), and account/plan
awareness (current account, plan type, % 5h + % 7d remaining). See [[agentlens-account-window-budget]].

**What actually fills a turn's context (measured from the OTEL raw request bodies, not the jsonl):** the
context is ~98% **MESSAGES** (the append-only transcript), ~2% tool schemas, ~0.2% system prompt (CLAUDE.md
+ rules are TINY in the prefix, NOT the bloat). The Anthropic API is STATELESS, so the WHOLE transcript is
re-sent every call and a block only leaves on COMPACTION — so anything pasted early rides forward, re-read
(cache_read) every turn, for the session's life. The acute case: **a local visual (SVG) agent
(claude-fable-5) carried 8 stuck screenshots = 525.1k tokens = ~half its 1M window, re-read every turn (~$425 of its ~$1,342 cost)**
[^3]. Fix: do image work in a SUBAGENT (isolated context → image never enters the parent transcript);
compact aggressively. AgentLens ALREADY parses these bodies (`src/rawBodyContext.ts buildCallContext`);
the missing piece is a queryable index + MCP tools + a resident-blob alert — tracked in TRDD-CTXQUERY.

**SHIPPED (2026-07-08) — the query surface answers this now, ask instead of hand-parsing bodies:**
TRDD-CTXQUERY landed the lazy OTEL-body composition index + MCP tools that answer "how many images /
who read them / per-account 5h+7d window % / resident-blob cost" directly: `get_image_report`,
`find_resident_blobs`, `query_context_blocks`, `get_block_content` (drill to one block's actual text),
plus the account/window tools from TRDD-BURNWDGT — `get_account_status`, `get_window_budget`, and a
per-account `get_burn_status`. The dashboard also grew a Composition panel (per-session block-type
breakdown + resident-blob list, lazy on trace-tree expand) and a resident-blob alert badge on session
cards. Both TRDDs are `column: complete`, gate-green.

**SHIPPED (2026-07-10) — ONE token convention, and why the feeds disagreed:** every
`SessionSummaryCard` now stores **FOUR DISJOINT BUCKETS** (`inputTokens` = RAW uncached input;
`calcTokenCostUsd` bills each bucket at its own rate — this is the schema invariant, enforced at
every ingestion site: claude/copilot/codex summarizers + logReader sub cards, with OpenAI-shaped
input shedding its contained cached tokens). Before this, OTEL cards stored input INCL-cache while
log cards stored it raw — same session read 318×–1,246× apart between feeds, write-time cost
double-billed cache on OTEL cards, and a read-time `inputTokens < cache` heuristic papered over
MCP outputs only[^4]. Per-call values were EXACT in all three sources (2,340-call join vs raw
response bodies, 0 mismatches) — the discrepancy was purely stored semantics + coverage.
Standing contract: `src/test/tokenConventionParity.test.ts`. Persisted old rows: SQLite OTEL rows
normalized in place; the standalone's restart sidecars are version-stamped (`LOG_INGEST_VERSION`,
single constant in `src/collectorState.ts` shared with db.ts) and ignored on mismatch → cold
rescan rebuilds. Evidence: `reports/token-discrepancy/20260710_141134+0200-otel-vs-jsonl.md`.

**Two ingest paths exist and once drifted (2026-07-10)[^5]:** the extension's `src/otlpCollector.ts`
AND the standalone's own `processLogs` in `standalone/server.ts`. The rich-event gate (bare vs
`claude_code.`-prefixed names, the OTLP 1.4 `eventName` proto field, session.id-first keying) now
lives in ONE shared module `src/otlpLogEvents.ts`; rejected log-event names are counted as
`otlpDroppedLogEvents` in `/api/server-stats` so a silent drop is visible. Async Agent launches
now get linkage child cards (`spawnAsync`, zero buckets = "not reported", never "free").

**OPEN (Phase B, the remaining user-visible symptom):** OTEL cards key on `interaction.spanId`,
log cards on the transcript UUID → the "OTEL wins" merge can never collide and one session serves
as 1 log card + up to ~336 per-trace OTEL cards. Correlation key (`session.id` attr) exists on
llm_request + interaction spans. Merge semantics need care: OTEL totals are LOWER BOUNDS beyond
the MAX_SPANS window and include sub-agent calls the log parent excludes.

**INCIDENT (2026-07-19 → 07-21) — a heartbeat cron, not the user, burned ~2 days of window across
all 3 accounts[^6]:** a ~400k-token **main** conversation (`querySource: repl_main_thread`) was left
idle but kept alive by a background heartbeat cron firing every ~15 min for ~2 days (~190 turns). Every
fire is a full main-conversation turn, so each re-billed the whole ~400k prefix; on top of that **~6
plugin reloads mid-session each broke the cache prefix → a full ~400k cache-CREATE write (billed
1.25×)**, the expensive bucket the steady-state model (96% cheap cache-read) does NOT cover. OAuth
auto-rotation then fed the runaway to each account in turn with **no visible rate-limit wall** — the
drain was silent until the 7-day window was ~176% consumed across the three. This is the third burn
multiplier beyond the two in the root-cause line above: **(4) an automated waker (cron/heartbeat) ×
(5) idle-but-huge session × (6) silent cross-account rotation.** Root fix that worked: `/clear` — a
fresh session starts from a small base, collapsing the per-turn re-bill (`cost ≈ turns ×
per-turn-context` loses on both factors in a woken marathon). Evidence (gitignored, machine-local):
`reports/burn-investigation/20260721_100514+0200-3-account-exhaustion-culprit.md`.

**Scope note:** this page is PROJECT scope (git-tracked and pushed) and is clean — no secrets, home
paths, usernames, emails or hostnames. The `memory-scope-leak` detector has flagged it for a
"high-entropy secret"; that is a verified false positive on long identifiers, not a leak.[^8]

See also: [[burn-seismic-statistical-model]] (the calibrated statistical detector built ON this
cost model — marked-point-process null, PELT events, per-event root-cause attribution);
[[agent-fleet-cache-economics]] (measured fleet spawn/cache-race/inline-vs-lazy economics);
[[image-resident-cost-guard]] (this model applied to image blocks — and why an image read is NOT a
prefix break, so the pre-flight guard warns instead of denying); [[agentlenspro-identity]]
(project identity page that cites this accounting model); [[agentlenspro-ops-lessons]] (ops
doctrine governed by this model, per its own "Governed by" line); [[always-on-ingestion-model]]
(cites this as the gate the admission controller sheds); [[cache-ttl-model]] (the TTL/write-tier
model this page's cost figures depend on); [[otlp-ingest-topology]] (cites this page's rich-event
drift lesson — the "second router is a second truth" trap).


^ATOM-4QBH-SS0F [desc:"Which tool answers which sub-agent question — fleet tree vs single agent vs context composition vs prefix survival", keywords: how_much_context_does_each_sub-agent_use per-subagent_token_cost which_agent_is_burning_the_window fleet_cost_after_a_fan-out fork_vs_fresh_spawn_cost subagent_spawn_tree agent_down-arrow_number_is_not_cost, type: reference, ocd: 2026-08-02, lmd: 2026-08-02]

Three tools answer "what is every sub-agent costing me", and they are not interchangeable. `get_subagent_tree --sessionId <any node in the tree>` is the FLEET view: every child with its spawn-KIND (fork = cache-warm; fresh/worktree/fleet = cache-cold), model (inherited vs override), spawning turn, rolled-up tokens and cost — plus `spawnRollup` with named antipatterns (FLEET-COLD = 3+ cold children re-billing the inherited prefix, WORKTREE-SCATTER, MODEL-MIX), each with its aggregate waste and a one-line remediation. The root resolves automatically from any node, so a child id is enough. `get_agent_tokens --agentId <id>` is the SINGLE-agent view: the four disjoint billing buckets, cost_usd, spawn metadata, and `lastTurnContextRead` — the live context-size proxy. Its `ccDisplayEquivalent` reconciles with Claude Code's per-agent down-arrow footer, which is VOLUME MOVED, not billing — quote cost_usd for spend, never the arrow. An async child with no transcript is flagged `asyncTokensUnknown` (unknown, NOT measured-free). `ctxmap` decomposes ONE agent's context at STARTUP; `ctxvis` measures whether its prefix SURVIVES into turn 2, which is the number that decides the recurring bill. Call the tree BEFORE a fan-out to pick the cheaper spawn shape, not only after to explain the invoice.

## Notes and lessons learned
[^1]: [id:ATOM-STATUSLINE-BUCKET-SPLIT, status:valid, keywords:"statusline_breakdown_landed_in_unknown per_bucket_split_missing_no_otel_sessions StatuslineBillingEvent_commit", ocd:2026-07-08, lmd:2026-07-08] The statusline event path originally carried only a total
  (`deltaTokens`), so the per-bucket breakdown landed 100% in `unknown` for exactly the no-OTEL sessions
  the burn monitor watches — the breakdown looked broken until the split was threaded through
  `StatuslineBillingEvent` (commit d3c04b1). Lesson: when adding a per-bucket view, verify it against the
  LIVE event source (statusline), not just the rich OTEL path — most live sessions have no OTEL.
[^2]: [id:ATOM-BURN-INVESTIGATION-WRONG-CLAIMS, status:valid, keywords:"1008_per_M_pricing_bug_false measurement_artifact_cumulative_delta fat_floor_claude_md_hypothesis_wrong cache_break_only_4_percent derive_from_per_turn_buckets", ocd:2026-07-08, lmd:2026-07-08] Two wrong claims made during the investigation, corrected by
  measurement: (a) I reported a "$1008/M / $317-per-turn pricing bug" — FALSE, it was a
  measurement artifact: the statusline writes sparsely, so a per-turn cost `delta` (cumulative − prev)
  lumped MANY turns. Recomputing cost from each line's own buckets vs Claude Code's reported cumulative
  agreed (0.8×) — no pricing bug. Lesson: never derive a per-turn RATE from a cumulative field sampled at
  sparse intervals; compute from per-turn buckets. (b) I hypothesized the "fat floor = CLAUDE.md + rules +
  MCP schemas" and that plugins "break the cache each turn" — BOTH wrong: the OTEL body shows context is
  ~98% transcript / ~0.2% system-prompt, and cache-BREAK turns are only ~4% (of which ~47% are 5-min TTL
  idle-expiry). The cache is EFFICIENT (96% read); the cost is the SIZE re-read, not breakage. AgentLens
  also over-reports $/hr ~4× from the same sparse-delta artifact (TRDD-BURNWDGT fix).
[^3]: [id:ATOM-IMAGE-RESIDENT-BLOB, status:valid, keywords:"8_screenshots_pasted_once_resent_every_turn 525k_tokens_from_images visual_agent_analyze_in_subagent un_evicted_image_blob_most_expensive_mistake", ocd:2026-07-08, lmd:2026-07-08] The concrete acute case: scanning the OTEL raw bodies, the 120
  LARGEST request bodies on the machine were ALL from ONE local visual-agent workspace (model
  claude-fable-5), each carrying the IDENTICAL 8 images = 525.1k tokens, with the total growing
  turn-over-turn — proving 8
  screenshots pasted once and re-sent every turn thereafter. Lesson: a visual agent must analyze images in
  a SUBAGENT (isolated context) or compact immediately; an un-evicted image blob is the single most
  expensive resident-context mistake (~$425 from one paste). This is the evidence behind TRDD-CTXQUERY.
[^4]: [id:ATOM-DUAL-TOKEN-CONVENTION, status:valid, keywords:"otel_cards_incl_cache_log_cards_raw comment_convention_claim_wrong verify_cited_lines_before_building token_convention_parity_test", ocd:2026-07-10, lmd:2026-07-10] The dual convention survived so long because THREE mechanisms
  hid it: (a) a read-time detection heuristic (`inputTokens < cache` in mcpServer sessionCost)
  repaired MCP outputs but not the persisted cost or the dashboard's raw fields; (b) a code comment
  in _buildSubAgentCards claimed "parent log cards store incl-cache" citing claude.ts:143/340 +
  logReader.ts:1888 — every cited line proved the OPPOSITE (the citations were to a model field, a
  pluginName field, and the RAW accumulator); the -sub- cards were then "fixed" TO the wrong
  convention on that comment's authority. Lesson: a convention claim in a comment is a HYPOTHESIS —
  verify the cited lines before building on it, and prefer one measured parity test over any number
  of compensating readers.
[^5]: [id:ATOM-SECOND-ROUTER-SECOND-TRUTH, status:valid, keywords:"fix_applied_to_one_copy_not_the_deployed_one standalone_processLogs_drifted grep_for_other_implementations otlpDroppedLogEvents_counter", ocd:2026-07-10, lmd:2026-07-10] The rich-event ingest fix was first applied ONLY to
  src/otlpCollector.ts (unit-tested, green) while the deployment kept dropping every event — the
  standalone server has its OWN processLogs that had drifted (never gained the gate). Lesson: the
  "second router is a second truth" failure mode — before declaring an ingest/parse fix done, grep
  for OTHER implementations of the same wire format and live-verify on the RUNNING deployment, not
  just the unit-tested class; and make drops observable (the otlpDroppedLogEvents counter) so the
  next silent-drop class self-reports.
[^6]: [id:ATOM-HEARTBEAT-CRON-BURN, status:valid, keywords:"heartbeat_cron_burn all_3_accounts_drained idle_400k_session plugin_reload_cache_create silent_no_rate_limit_wall", ocd:2026-07-21, lmd:2026-07-21]
  DO NOT leave a huge (300k+) main session idle while a background heartbeat/cron keeps waking it,
  and DO NOT chase mid-session plugin reloads on such a session, BECAUSE every automated wake is a
  full main turn that re-bills the entire prefix and every reload forces a full cache-CREATE rewrite
  (1.25×) — together they drained all 3 OAuth accounts over ~2 days with no visible rate-limit wall
  (auto-rotation masked it). DO `/clear` (or pause the waker) to reset the per-turn floor the moment a
  woken marathon is suspected; diagnose with `agentlenspro --risk` / `get_burn_status` /
  `get_account_status` (raw-body capture may be off, so investigate_burn can be blind).
[^7]: [id:ATOM-CBRK-SUBST, status:valid, keywords:"cache break attribution composition path vs raw OTEL bodies buildCacheBreakReport buildCacheBreakTimeline reload-cost returned 0 empty bodies dir", ocd:2026-07-21, lmd:2026-07-21]
  DO NOT build a new cache-break / reload-cost tool on the raw-OTEL-bodies TIMELINE path
  (`buildCacheBreakTimeline`/`buildPluginReloadCosts`/`scanSessionsAndResponses`), BECAUSE the
  `~/.agentlens/otel-bodies` dir can be EMPTY on a machine with body-archiving off (TRDD-EYA3X5MQ:
  reload-cost returned 0 / "0 request body files" there) even while the aggregate reports show data.
  DO build it on the COMPOSITION path (`buildCacheBreakReport` over `getComposition` + the `sessions`
  cards — what `get_cache_break_report` uses) — that source is persisted and has data wherever the
  aggregate does. (Superseded in part: per-turn wall-clock IS available now — `CacheBreakTurn.tsMs`
  was exposed for the command→turn join, so order by that rather than the card's `startTime`.
  See [[cache-risk-command-detection]].)
[^8]: [id:ATOM-ENTR-IDENT, status:valid, keywords:"memory-scope-leak detector high-entropy secret false positive long camelCase identifier flagged as secret in project memory page", ocd:2026-07-21, lmd:2026-07-21]
  DO NOT act on a `memory-scope-leak` "high-entropy secret" finding against THIS page without
  checking the actual string, BECAUSE it is a verified FALSE POSITIVE (2026-07-21): the detector's
  entropy heuristic does not exempt long identifiers, and the flagged runs are `scanSessionsAndResponses`,
  `consumedBillableWeighted`, `buildCacheBreakTimeline` and friends — a technical page is mostly made
  of those. Scanned for every real secret shape (`sk-`/`ghp_`/`AKIA`/PEM/JWT/40-hex/`token=`) and for
  home paths, emails and hosts: all absent. DO grep the concrete secret shapes before demoting a page
  to LOCAL, and keep the verdict (`reports/janitor-memory-scope-leak/`) so it is not re-litigated.
[^9]: [id:ATOM-INVB-BLIND, status:valid, keywords:"investigate_burn_says_nothing_burned no_API_traffic_found_in_the_window findings_zero_while_burn_status_shows_millions requestFilesScanned_0_complete_true raw_body_dir_ignores_spoolDir", ocd:2026-07-23, lmd:2026-07-23]
  DO NOT read `investigate_burn`'s "No API traffic found in the window — nothing burned here"
  as an absence of BURN, BECAUSE it is an absence of DATA: measured 2026-07-23 at one instant,
  `get_burn_status` showed 2,315,075 tok/min across 7 sessions while `investigate_burn
  --windowHours 1` returned findings 0, all totals 0 and coverage `requestFilesScanned: 0,
  bytesOnDisk: 0, complete: TRUE, note "full coverage of the window"` — because
  `src/burnInvestigator.ts:375` hardcodes `~/.agentlens/otel-bodies` and never calls
  `effectiveBodiesDir()` (`src/captureConfig.ts:77`), so it misses every machine with a
  configured `capture.spoolDir` (1,876 body files sat in the spool; the hardcoded dir held 0).
  DO cross-check with `--risk` / `get_burn_status` (they read the live feed and never go blind),
  and treat a zero-file scan as a BLIND SPOT, never as a clean verdict. Fix: TRDD-8N3KQW2R.
[^10]: [id:ATOM-READ-SEMANTICS, status:valid, keywords:"get_cost_rollup_sinceIso_is_not_a_delta one_minute_window_reported_320M_tokens totalTokens_excludes_cache how_to_measure_tokens_used_since_a_timestamp", ocd:2026-07-23, lmd:2026-07-23]
  DO NOT read `get_cost_rollup --sinceIso T` as "tokens since T", and DO NOT read
  `get_agent_tokens.totalTokens` as the session's token consumption, BECAUSE the first returns
  WHOLE-SESSION totals for every session that merely OVERLAPS the window (a 1-minute window
  reported 320M tokens) and the second is input+output only, EXCLUDING cache (1,550 + 614,578 =
  616,128 on a session with 315M cache-read). Both read like deltas/totals and are neither, so a
  watcher built on them reports numbers that are wrong by orders of magnitude in the direction
  that hides a problem. DO compute "since T" by SAMPLE-AND-SUBTRACT (snapshot at t0, subtract),
  and always sum the four buckets explicitly when you mean total tokens.
