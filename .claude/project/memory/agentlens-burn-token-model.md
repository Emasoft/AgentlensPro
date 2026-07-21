---
name: agentlens-burn-token-model
description: "5h/7d account window drained fast / burning 1M+ tokens per minute / what is consuming all the tokens / impossible that a few Claude sessions burned the window / cost vs token window limit / cache-read dominating burn / OTEL and JSONL report different token numbers for the same session / session cost looks 100x too big or negative / all 3 OAuth accounts drained one after another over ~2 days / a huge idle main session re-woken every ~15 min by a heartbeat cron / plugin reloads forcing full cache-CREATE rewrites / what exhausted my 7-day rate-limit window with no visible rate-limit wall"
ocd: 2026-07-08
lmd: 2026-07-21
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

## Notes and lessons learned
[^1]: [ocd:2026-07-08 lmd:2026-07-08] The statusline event path originally carried only a total
  (`deltaTokens`), so the per-bucket breakdown landed 100% in `unknown` for exactly the no-OTEL sessions
  the burn monitor watches — the breakdown looked broken until the split was threaded through
  `StatuslineBillingEvent` (commit d3c04b1). Lesson: when adding a per-bucket view, verify it against the
  LIVE event source (statusline), not just the rich OTEL path — most live sessions have no OTEL.
[^2]: [ocd:2026-07-08 lmd:2026-07-08] Two wrong claims made during the investigation, corrected by
  measurement: (a) I reported a "$1008/M / $317-per-turn pricing bug" — FALSE, it was a
  measurement artifact: the statusline writes sparsely, so a per-turn cost `delta` (cumulative − prev)
  lumped MANY turns. Recomputing cost from each line's own buckets vs Claude Code's reported cumulative
  agreed (0.8×) — no pricing bug. Lesson: never derive a per-turn RATE from a cumulative field sampled at
  sparse intervals; compute from per-turn buckets. (b) I hypothesized the "fat floor = CLAUDE.md + rules +
  MCP schemas" and that plugins "break the cache each turn" — BOTH wrong: the OTEL body shows context is
  ~98% transcript / ~0.2% system-prompt, and cache-BREAK turns are only ~4% (of which ~47% are 5-min TTL
  idle-expiry). The cache is EFFICIENT (96% read); the cost is the SIZE re-read, not breakage. AgentLens
  also over-reports $/hr ~4× from the same sparse-delta artifact (TRDD-BURNWDGT fix).
[^3]: [ocd:2026-07-08 lmd:2026-07-08] The concrete acute case: scanning the OTEL raw bodies, the 120
  LARGEST request bodies on the machine were ALL from ONE local visual-agent workspace (model
  claude-fable-5), each carrying the IDENTICAL 8 images = 525.1k tokens, with the total growing
  turn-over-turn — proving 8
  screenshots pasted once and re-sent every turn thereafter. Lesson: a visual agent must analyze images in
  a SUBAGENT (isolated context) or compact immediately; an un-evicted image blob is the single most
  expensive resident-context mistake (~$425 from one paste). This is the evidence behind TRDD-CTXQUERY.
[^4]: [ocd:2026-07-10 lmd:2026-07-10] The dual convention survived so long because THREE mechanisms
  hid it: (a) a read-time detection heuristic (`inputTokens < cache` in mcpServer sessionCost)
  repaired MCP outputs but not the persisted cost or the dashboard's raw fields; (b) a code comment
  in _buildSubAgentCards claimed "parent log cards store incl-cache" citing claude.ts:143/340 +
  logReader.ts:1888 — every cited line proved the OPPOSITE (the citations were to a model field, a
  pluginName field, and the RAW accumulator); the -sub- cards were then "fixed" TO the wrong
  convention on that comment's authority. Lesson: a convention claim in a comment is a HYPOTHESIS —
  verify the cited lines before building on it, and prefer one measured parity test over any number
  of compensating readers.
[^5]: [ocd:2026-07-10 lmd:2026-07-10] The rich-event ingest fix was first applied ONLY to
  src/otlpCollector.ts (unit-tested, green) while the deployment kept dropping every event — the
  standalone server has its OWN processLogs that had drifted (never gained the gate). Lesson: the
  "second router is a second truth" failure mode — before declaring an ingest/parse fix done, grep
  for OTHER implementations of the same wire format and live-verify on the RUNNING deployment, not
  just the unit-tested class; and make drops observable (the otlpDroppedLogEvents counter) so the
  next silent-drop class self-reports.
[^6]: [ocd:2026-07-21 lmd:2026-07-21 keywords:"heartbeat_cron_burn all_3_accounts_drained idle_400k_session plugin_reload_cache_create silent_no_rate_limit_wall"]
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
  aggregate does; per-turn wall-clock ts is unavailable there, so order by the session card's `startTime`.
