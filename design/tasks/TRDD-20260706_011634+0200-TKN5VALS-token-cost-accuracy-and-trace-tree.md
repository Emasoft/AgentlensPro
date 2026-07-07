---
trdd-id: TKN5VALS
title: Fix Claude token/cost accounting + 5-value expandable trace tree, sticky headers, Context tab
column: dev
created: 2026-07-06T01:16:34+0200
updated: 2026-07-07T10:16:39+0200
current-owner: claude-opus-4-8
assignee: claude-opus-4-8
priority: 2
severity: HIGH
effort: XL
task-type: bugfix
parent-trdd: null
relevant-rules: []
release-via: none
delivery: direct-push
target-branch: fix/logreader-large-jsonl
test-requirements: [typecheck, lint, unit]
impacts: [config-schema]
migration-direction: forward
attempts: 0
implementation-commits: [4d28f24, a98f480, 9a672fa, 9a70df0, 027dd68, 3c0899c, c48908e, 38714bf, 1f3a8d1, c86bfc9, b89dc95, 1729b67, d6582be, 7f5c681, 2e14a23, ae9160e]
external-refs: []
---

# TRDD-TKN5VALS — Token/cost accuracy + expandable 5-value trace tree

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-07

### 🔄 RESUME 2026-07-07 EOD (P8 execution): ALL named P8 requirements shipped — R-A/R-H (History tab, cd04e7a), R-B (U0UYC38A ✅), R-C (ZS1GDXVY ✅), R-G (IQENK7JM ✅), R-I (7612ff5; attribution mirror in media/src/types.ts VERIFIED present), R-J (M36W16L0 ✅), ICHAVFCS ✅. Gap-analysis children (163281a) executed same day: OG9PARZQ ✅ 99cab41 (burn alarm + 5h/7d window budget + get_burn_status/get_session_status MCP — fleet-facing), ZK37VG4X ✅ d26a4d9+91f52d5 (sonnet-5/mythos-5 pricing both tables, UNPRICED fail-loud badge, session dedup/mergedFrom, SLI junk filter + hogs coverage honesty), PJC8N1HO ✅ acde47b (`pnpm run supervise` supervisor + crash.log, durable tail offsets — prod fast-restart "13996 sessions restored, skipping cold rescan", downtime gap markers, History/Context endpoint OOM FIXED (2× repro dead, verified full-tab headless click-through), request logging, heap-guard 503), W0RRL2FZ ✅ 98dcdab+298dca6 (resident-cost tokens×turns-resident itemization — 94.3% of 119.7M tok reconciled on 28e3a88d, top sink identified = janitor-heartbeat cron 42.0M tok·turns; SECOND auto-config hijack path applyLegacyAgentConfig gated). Suite 314/1/0. **IN FLIGHT: 62E8UU41 (spawn-cost rollup + FLEET-COLD/WORKTREE-SCATTER/MODEL-MIX advisor) · PW0H2NXC (Context tab DOM virtualization, 156k→<10k elements). REMAINING: UBEP5XY7 tokens-by-cause (dispatch after 62E8UU41 frees mcpServer.ts) → 6E6416B8 vscode-removal (LAST).** Prod: `pnpm run supervise` on 3000/4316/4318, telemetry ACTIVE. Per-TRDD opus agents, orchestrator verifies gates (node@22 mocha path) before/after commit-by-name, no push.

### 🔴 REOPENED as P8 — "complete context-history browser" (column=dev). P1-P4 shipped; P8 is the user's crystallized demand and is NOT done.

**WHY reopened:** P4 verified the cache-bar drill ONLY on a `.jsonl`-backed session; forks/OTEL dead-ended,
and the drill showed 1200-char EXCERPTS + only `attachment` records — not the full content of every block.
The user (2026-07-07, multiple messages) demands a COMPLETE, LIVE, per-token context-history browser.

**P8 REQUIREMENT (verbatim intent, consolidated from the 2026-07-07 messages):**
The trace tree of each session must be expandable **until it shows the ACTUAL content**:
file content, text output, bash input AND output, tool inputs AND outputs, hook injections,
skill prompts, agent prompts, messages, cron injections — **everything** — each node carrying
**its own token count + taxonomy (kind) + the 4 usage buckets (input/output/cache-read/cache-creation) + cost**.
Plus:
- **R-A** per-STEP expandable content with a step-by-step **DIFF** (what block was added/changed/removed vs prev step → the cache-break point).
- **R-B** the `.jsonl` must be **tailed in REALTIME** (today only OTEL data is live; jsonl-derived content lags a rescan). Every jsonl change reflected live.
- **R-C** every **output file** written into a project-slug subfolder tracked + shown as an **expandable leaf** with its content.
- **R-G** a token count on **everything** — from jsonl usage, OTEL, debug hooks, or a **local tiktoken-like tokenizer** when no usage bucket applies (today it is bytes/4).
- **R-H** AgentLens must IDENTIFY + DIAGNOSE the exact burn-event points (cache break, massive cache-create, model switch, fleet/fork spawn) and make them VISUALLY OBVIOUS in the trace — red-tinted row + 🔴/⚡ emoji label + the one-line CAUSE — so similar events are instantly pinpointable.
- **R-J** PRODUCTIZE: AgentLens must, at install/enable time, SAFELY + REVERSIBLY add the full telemetry env (the R-I config set + OTEL_LOG_RAW_API_BODIES=file:<dir>) to Claude Code's `~/.claude/settings.json` `env` block (+ any needed hooks), with a timestamped backup + a managed-keys marker so uninstall restores EXACTLY the prior state (never clobbering the user's own keys). When AgentLens runs it must enable Claude Code's full telemetry power, export all logs/metrics/traces + raw bodies, and ingest in STREAMING/REALTIME: (a) every session `.jsonl` (incremental tail, not full rescan — R-B), (b) the project-slug SUBFOLDER data / tool-output dumps (R-C), (c) the raw-body files + rich OTEL events (R-I). Everything trackable → stored in the AgentLens DB → surfaced in the web reports + MCP diagnostics. Idempotent, atomic writes, opt-out env, clean uninstall.
- **R-I** use the FULL Claude Code OTEL capability (doc: code.claude.com/docs/en/monitoring-usage). AgentLens currently DROPS every non-tool_result `claude_code.*` log event (otlpCollector.ts:420 `continue`). Must (a) enable + document the richer telemetry env (OTEL_LOG_TOOL_DETAILS=1, OTEL_LOG_USER_PROMPTS=1, OTEL_LOG_ASSISTANT_RESPONSES=1, OTEL_LOG_RAW_API_BODIES=file:<dir>, CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1) and (b) PARSE the rich events: `claude_code.api_request` (per-call model/cost_usd/input/output/cache_read/cache_creation tokens + query_source/agent.name/skill.name/plugin.name/mcp_server.name/mcp_tool.name → tokens attributed to the CAUSE), `claude_code.compaction` (trigger/pre_tokens/post_tokens → surface as burn events), `api_error`/`api_retries_exhausted`, `tool_decision`, `api_request_body`/`api_response_body` (raw literal context per call), and the `claude_code.token.usage` metric attribution. This is a BETTER source than the jsonl for per-call cost + who-caused-it.

**DONE THIS SESSION (P8 groundwork, LOCAL commits on branch fix/logreader-large-jsonl, NOT pushed):**
- `497f019` fork/sub-agent composition fallback — reconstruct from nearest LOGGED ancestor (`resolveLoggedAncestor`), `reconstructedFrom` tag, `budgetedKids`/`mergeSources`, honest `compNote` (no more perpetual "loading"). tsc+esbuild clean; headless drill verify still pending.
- `0e00ad3` NEGATIVE-COST fix (central `sessionCost`): two conventions coexist by dataSource (OTEL=incl-cache, LOG-fork=raw); the −$83/−$47 fork costs HID the fleet-of-forks burn. Verified exact vs live cards (agent-aeb in=274 vs cache=3.52M; synth-ae58 in=10.23M≈cache). Burn now VISIBLE.

**BURN DIAGNOSIS (proof the instrument works, 2026-07-07):** parent `28e3a88d-…` = 5MB jsonl (~1.25M-tok transcript); OTEL mains `synth-ae58`=10.23M input (9.96M cache-read), `8cd52574`=16.98M input (16.67M cache-read) per ~2-min window; a fable-5 parent spawned a FLEET of forks each re-billing the inherited multi-M-token transcript ⇒ millions of tokens/minute. get_context_inflation_report on 28e3a88d works (agent catalog / hooks / skill catalog itemized) BUT the DOMINANT sink — the accumulated transcript — is only the un-itemized remainder → P8 must itemize it.

**NEXT ACTION (P8 build order) — updated 2026-07-07:**
1. ✅ DONE `bd15106` — `src/contextHistory.ts` (all record kinds, FULL text 20k/block cap, per-block tokens+taxonomy+role, per-step usage buckets + DIFF added/changed/removed + firstChangeBlockId; fork/ancestor fallback). MCP `get_context_history(sessionId, turn?, blockId?)` (progressive summaries→step→block) + `/api/history/:id` route + getHistory accessor. VERIFIED on 28e3a88d: 357 steps; dominant sink postCompact 267,921 tok x314; turn 315 = input 2 / cacheRead 18347 / **cacheCreate 242,363** with diff.firstChange=toolOutput:ToolSearch + whole prior prefix in `removed` (the exact /compact prefix-rewrite call).
2. ✅ DONE `cd04e7a` — Webview `media/src/tabs/HistoryTab.tsx` (new `History` tab): per-step rows w/ 4 usage buckets + cost, expand→blocks (24-kind colored badges + token + role + +new/⚡changed/break-point diff badges + `removed since prev`), expand block→FULL text in `<pre>` (overflow:visible, no inner scroll), + **R-H burn-event RED highlights** (🔴 massive cache-create ≥50k / ⚡ cache break w/ firstChange location / 🔴 model switch / ⚠ fleet spawn + one-line cause), red-tinted rows via theme-aware color-mix. HEADLESS-VERIFIED (screenshot reports/context-history/history-t315-expanded.png): T315 shows 🔴 CACHE-CREATE 242.4K + ⚡ CACHE BREAK, blocks drill to text; T316-318 ⚡ CACHE BREAK + ⚠ SPAWN Agent; summary 357 steps / 1.3M cache-created / 40 burn-event steps.
3. ✅ DONE `7612ff5` — R-I parser: ingest rich claude_code LOG events (api_request per-call cost+attribution query_source/agent/skill/plugin/mcp; compaction pre/post tokens; api_error/api_retries_exhausted) as distinct timeline entries, NOT double-counted vs llm_request spans. (media/src/types.ts mirror of the new TimelineEntry attribution fields + UI surfacing = pending, tracked in TRDD-ICHAVFCS.)
4. ✅ DONE (global config, NOT repo) — R-I/R-J config half: `~/.claude/settings.json` env now enables the FULL telemetry surface — OTEL_LOGS_EXPORTER + OTEL_METRICS_EXPORTER (were ABSENT → the root cause of "only OTEL trace data shows"), OTEL_LOG_RAW_API_BODIES=file:~/.agentlens/otel-bodies, ASSISTANT_RESPONSES, delta temporality, metric includes (session/version/entrypoint/account_uuid); backups `~/.claude/settings.json.bak-otel-*`. **REQUIRES a Claude Code restart to take effect** (env applies to NEW sessions only).

**REMAINING P8 WORK — split into child TRDDs (a fresh session grabs each; all parent=TRDD-TKN5VALS):**
- **TRDD-ICHAVFCS** (pri 0, THE user's #1 unmet ask) — per-call full context tree from OTEL RAW API BODIES: click any llm-call/sub-call → the whole literal context at that moment as an expandable taxonomy tree (system/messages/tool in+out/hooks/mcp/thinking), per node taxonomy + the 5 token fields; works for OTEL-ONLY sessions (no jsonl); fix the columns→vertical layout; mirror+surface the 7612ff5 attribution fields; kill the "check the previous turn" dead-end.
- **TRDD-U0UYC38A** (pri 1) — R-B realtime incremental jsonl tail + live-refresh the drill caches.
- **TRDD-ZS1GDXVY** (pri 2) — R-C project-slug subfolder / tool-output-dump files as expandable leaves.
- **TRDD-M36W16L0** (pri 1) — R-J safe reversible telemetry-config install/uninstall manager (reproduce the manual settings.json edits programmatically; backup + managed-keys marker + clean uninstall + opt-out + wire into server start).
- **TRDD-IQENK7JM** (pri 3) — R-G tokenizer-grade per-block token counts (replace bytes/4).
- **TRDD-6E6416B8** (pri 4) — R-E remove the VS Code extension (do LAST).

**On restart:** the new telemetry starts flowing (raw bodies to ~/.agentlens/otel-bodies). Pick up
TRDD-ICHAVFCS first — it turns those raw bodies into the click-any-call full context tree.

**SUPERSEDED — do NOT carry forward:** "column=complete", "ALL PHASES COMPLETE", and any claim the drill/composition is finished — P8 supersedes. The excerpt cap (1200 char) and attachment-only parse are the specific things P8 replaces.

---

### ✅ P1-P4 SHIPPED (history; superseded by P8 where they conflict)

**P4 DONE (2026-07-06) — steps 1-7 all landed, LOCAL commits only (branch fix/logreader-large-jsonl, NOT pushed):**
- Steps 1-2 (`38714bf`, `1f3a8d1`, `c86bfc9`): composition tracer wired end-to-end
  (`loadContextComposition` msg → host/standalone route → webview signal → ContextTab);
  full tool-output blobs; `peakContextPerTurn` persisted; spawn-kind capture; pure
  `src/cacheBreak.ts` classifier.
- Steps 3-4 (`b89dc95`, `1729b67`, `d6582be`, `7f5c681`): Traces cache-split values +
  cache-break markers + spawn-kind badges + every-row composition drill-down; NEW Cache tab
  (hit-rate SLI, ranked break causes, wasted-$ leaderboard, fleet tree); low-cache-hit alert.
- Step 5 (`2e14a23`): MCP — EXTENDED `get_session_detail` (per-turn cache split +
  compositionSummary + subAgents rollup), `get_efficiency_report` (cacheHealth SLI),
  `get_instruction_suggestions` (cache-efficiency suggestion); ADDED 6 tools
  `get_context_composition`, `get_context_growth`, `get_cache_break_report`,
  `get_context_inflation_report`, `find_context_hogs`, `get_subagent_tree`; wired a
  `getComposition` accessor into `McpServerOptions` and BOTH call sites (extension.ts +
  standalone/server.ts). Host `buildCacheBreakReport` added to `src/cacheBreak.ts` (mirrors the
  webview port) so the turn-bucketing lives in one place.
- Step 6 (`ae9160e`): browser live-reload — standalone computes a bundle-mtime BUILD_ID, pushes
  it over the existing dashboard SSE, injects a guarded client snippet that `location.reload()`s
  when the id it loaded with differs (rebuild→restart→auto-refresh; no loop).
- Step 7 VERIFY (this commit): check-types (src+media) clean, lint 0 errors (47 pre-existing
  warnings), esbuild all 5 targets. Drove a headless standalone server on isolated ports over
  the real 18k-session store: all 12 MCP tools listed + called successfully; `get_cache_break_report`
  on session 777b8f52 → 137 breaks, 1.9M wasted tokens, $10.97, offenders ranked with $ cost
  (skill catalog $4.80, hooks $2.50/$1.56); `get_context_growth` real buckets (peak 17k, 98% hit);
  live-reload snippet + SSE buildId confirmed in served HTML. Report:
  reports/trace-ui/20260706_*-P4-step567.md.

**SUPERSEDED — do NOT carry forward:** every "P2 NOT STARTED", "DEFERRED to P4", "TODO (P4 agent)",
and "Blocked until #5 lands" note lower in this body / in reports/mcp/P4-mcp-surface-spec.md is
now DONE. There is no remaining deferred P4 work.

---

**User's verbatim work order (7 items):** costs wrong (9.2k tokens → $6.67);
10M+ tokens reported vs ~15-20k manual sum; trace expansion missing cache
read/write; can't expand event→turn→tool with the 5 values each + a bar of the
selected value above; the metric bars + filter field scroll instead of being
fixed headers like the tabs; sub-agents/forks ignored in totals; add a tab next
to Trace showing context-size trace after each event with turn numbers and
sub-agent/fork sessions as expandable sub-branches.

**Two DECISIONS made by user (2026-07-06):**
1. Headline "tokens" = NEW tokens = `input(uncached) + output + cache-write`.
   cache-read is shown as its OWN labeled value/bar, NEVER folded into the
   headline. Cost still billed on ALL buckets (incl. cache-read).
2. Sequence: **P1 accounting first** (items 1,2,6) → verify → commit; then
   **P2 UI** (items 3,4,5,7) → verify → commit. Separate commits.

**ROOT CAUSES (✓ VERIFIED, file:line):**
- Items 1+2 = ONE bug. `src/logReader.ts:1634` `card.inputTokens = totalInput +
  totalCacheRead + totalCacheCreate` (= totalContext). cacheRead ≈ whole
  transcript re-read each turn, summed over N turns → millions. `writer.ts:152`
  bills `cost_usd` off that same base via
  `calcTokenCostUsd(inputTokens − cacheRead − cacheCreate, cacheRead, cacheCreate, output, model)`.
  So cost is consistent with the STORED (inflated) total but absurd vs a smaller
  displayed figure. Commit 74b7625 fixed only per-ROW dup, not per-TURN cacheRead.
- Item 6. No parent←child rollup. `src/logReader.ts:824` literal
  `// Subagent session attribution is left for a follow-up.` Sidechain only
  TAGGED `initiator:'agent'` at `:1467-1470`; child tokens stay in their own
  session file, invisible to parent.
- Items 3/4/5/7. Trace = flat one-level `TimelineEntry[]`
  (`media/src/tabs/Traces.tsx:523`). Only `type:'llm'` rows carry the 4 token
  fields; cost derived at render (`calcEntryCost`). Only `.tabs` is sticky
  (`media/src/styles/tabs.css:23`); metric bar (re-rendered per SessionBlock),
  filter, time-picker, tab-stats all scroll. No `turn` number, no parent/child
  session link webview-side. Growth chart already has `{turn, tokens, spanId}`
  per-turn series (`media/src/tabs/SessionCharts.tsx:302`).

**PROGRESS (2026-07-06, UPDATED post-resume ~ current session):**
- ✓ **P1 COMPLETE** — committed across `4d28f24`, `a98f480`, `9a672fa`. `pnpm run
  check-types` (src + media) is CLEAN on the current tree. Specifically:
  - P1.1: de-inflate stored `input_tokens` (raw uncached input only); `writer.ts`
    cost bills 4 disjoint buckets directly. Cost value unchanged, total de-inflated.
  - P1.2: `media/src/sessionMetrics.ts` bills raw input directly (a98f480).
  - P1.3: sub-agent/worktree/fleet child transcripts linked to parent project
    (9a672fa) — `parentSessionId` backbone wired extension-side.
  - Type backbone (`turn?`, `parentSessionId?`) present in summarizerTypes + types.
- ✗ **P2 NOT STARTED** (verified: no `media/src/tabs/ContextTab.tsx`; no `turn`/
  `parentSessionId` usage in `media/src/tabs/Traces.tsx`). All of P2.1 (sticky
  headers), P2.2 (4-level 5-value tree), P2.3 (Context tab + sub-branches) remain.
- ✗ **P3 NOT STARTED** (context-composition tracer; heavy, explicitly after P2).

**PROGRESS (2026-07-06 08:52 — P2 done + P3 partial; column→testing):**
- ✓ **Stage A backbone** (commit `1c5fef8`): `turn` (1-based, grouped by assistant
  message.id) + per-turn cache-read/cache-created buckets on timeline entries in BOTH
  `src/logReader.ts` (Claude log) and `src/summarizers/claude.ts` (OTEL); persisted via new
  `timeline_entries.turn` column (schema + idempotent ALTER migration + writer + reader).
- ✓ **P2.1 sticky headers** (commit `b9bf5f0`): metric/sort/group toggles hoisted to shared
  signals in `state.ts`; toolbar `position:sticky` over the `.waterfall` scroll container.
- ✓ **P2.2 turn tree** (commit `b9bf5f0`): `TimelineWaterfall` renders session→turn→step; each
  turn sums children, shows all 5 values (cache-read vs cache-created distinct) + a metric bar;
  sortable by time/value; graceful flat fallback when entries lack `turn`.
- ✓ **P2.3 Context tab** (commit `1f62aa1`): new top-level tab — per-turn context-window growth
  with turn numbers + composition drill-down (exact buckets + estimated content-level sources);
  sub-agent nested sub-branches via `parentSessionId` (inert until linkage lands).
- ✓ VERIFY: check-types (src+media), lint (0 err), esbuild (5 targets) all clean; driven
  headless on 16457 real sessions — Context tab + sticky trace toolbar + 5-values-per-step
  confirmed. Screenshots in `reports/screenshots/20260706_085101+0200-{context-tab,trace-5values}.png`.
- ✗ **DEFERRED (checkpoint)**: (a) real sub-agent session→session linkage + token rollup +
  navigable sub-branches — `parentSessionId` is a project slug, not a child→parent session id,
  and is not persisted/shipped yet; (b) P3 full composition tracer (attachment tokenization,
  system-prompt/CLAUDE.md/rule/memory/hook per-source breakdown, full tool output from `.jsonl`
  sibling subfolders). Turn tree only groups for sessions ingested AFTER Stage A (old DB rows
  have turn=NULL until a re-ingest). See `reports/trace-ui/20260706_085101+0200-P2P3-implementation.md`.

**NEXT ACTION:** Implement P2 in the webview (P2.1→P2.2→P2.3), verify
check-types+lint clean + drive dashboard headless, commit `feat(dashboard): …`.
Then P3. Delegated to a fresh-context agent to keep the orchestrator thin.

**SUPERSEDED — do NOT carry forward:** the older "STILL TODO in P1" list (P1.2/P1.3
were open at 01:20) — P1 is now fully committed and typecheck-clean. Line-number
refs in ROOT CAUSES (e.g. `logReader.ts:1634`) are pre-P1-fix and have shifted.

**Durable artifacts to read before acting:**
- reports/token-accounting/20260706_011126+0200-investigation.md
- reports/trace-ui/20260706_011112+0200-investigation.md

---

## P1 — Accounting correctness (extension host; items 1, 2, 6)

Files: `src/logReader.ts`, `src/database/writer.ts`, `src/database/schema.ts`,
`src/database/reader.ts`, `src/database/migration.ts`, `src/types.ts` +
`media/src/types.ts` (mirror), `src/sessionRepository.ts`,
`media/src/pricing.ts` / `media/src/sessionMetrics.ts` / `media/src/TokenTotals.tsx`
(display side). Keep phase ≤ the coherent accounting-core cluster.

### P1.1 — De-inflate the stored total (items 1+2)
- `src/logReader.ts:1634`: STOP setting `card.inputTokens = totalContext`.
  Set `card.inputTokens = totalInput` (raw uncached input only). The card
  already carries `cacheReadTokens`, `cacheCreateTokens`, `outputTokens`
  separately — keep those. Add/confirm the card exposes all 4 raw buckets.
- DERIVED (mandatory, same edit): `src/database/writer.ts:152` cost calc used
  `inputTokens − cacheRead − cacheCreate` to reconstruct raw input. Now that
  `inputTokens` IS already raw, change to
  `calcTokenCostUsd(inputTokens, cacheRead, cacheCreate, output, model)` (no
  subtraction). VERIFY the money math: dump one real session's 4 buckets and
  confirm cost matches hand-calc at the model's rates. This must not regress cost.
- DERIVED: audit every reader of the `input_tokens` column
  (`src/database/reader.ts`, `src/sessionRepository.ts`, any summarizer, the OTLP
  path `spanSummarizer`/`sessionStore`) — anything treating `input_tokens` as
  "total context" must be updated to the new meaning (raw input) or compute the
  headline as input+output+cacheCreate.
- DERIVED (schema/migration): existing rows hold totalContext in `input_tokens`;
  new rows hold totalInput. Decide: (a) a forward migration that can't recompute
  (data lost) → simplest is to bump the DB/schema version so stale rows are
  re-ingested from logs, OR (b) leave old rows and document the discontinuity.
  Prefer re-ingest if the retention/migration path supports a clean rebuild.

### P1.2 — Headline = new tokens; cache-read split out (display)
- Trace the webview headline field FIRST. Then compute the headline everywhere as
  `input + output + cacheCreate` (NEW tokens). Render `cacheRead` as its own
  labeled value/bar, never inside the headline. Cost unchanged (all buckets).
- Files likely: `media/src/pricing.ts`, `media/src/sessionMetrics.ts`,
  `media/src/TokenTotals.tsx`, `media/src/tabs/*` headline sites.

### P1.3 — Sub-agent / fork rollup (item 6)
- Implement the deferred attribution at `src/logReader.ts:824`. Link child
  (sidechain / Task / fork) session files to their parent via
  `sessionId`/`parentUuid` and roll child `totalInput/Output/CacheRead/CacheCreate`
  INTO the parent card's aggregated total, AND retain the child as a distinct
  session so P2 can render it as an expandable sub-branch.
- DERIVED (feeds P2): add to BOTH `src/types.ts` and `media/src/types.ts`
  (mirror) a `parentSessionId?: string` (or `spawnedBySessionId`) on the session
  summary, and a `turn?: number` on `TimelineEntry`. Populate extension-side in
  the summarizers + `src/dashboardPanel.ts` payload. These are the backbone for
  items 4 & 7.

### P1 verification
`pnpm run check-types` (twice: src + media) + `pnpm run lint` clean; relevant
unit tests (`src/test/**`) pass; hand-verify one real session: headline ≈ manual
sum, cost sane (cents-to-low-dollars for a small session), sub-agent tokens now
appear in parent total. Commit `fix(accounting): …`.

## P2 — Trace UI rework (webview; items 3, 4, 5, 7)

### P2.1 — Sticky headers (item 5)
- Lift the metric-toggle bar out of per-`SessionBlock` `TimelineWaterfall` into
  the Traces tab shell; hoist its `metric` state to a signal (`state.ts`).
- Wrap non-entry chrome (metric bar + filter field + time-range picker +
  tab-stats) in a `position:sticky; top:<tabs-height>` band so ONLY the entry
  list scrolls beneath. Respect the no-nested-scrollbars rule (page scrolls, not
  an inner box). CSS in `media/src/styles/` (waterfall.css/tabs.css/base.css).

### P2.2 — 4-level expandable tree with the 5 values (items 3, 4)
- Make step rows recursive: session → event → turn → command/tool. Each level
  shows all 5 values (input, output, cache-read, cache-write, cost); parent
  levels = sum of children. A bar of the currently-selected metric renders above
  the list (driven by the hoisted `metric` signal). Turn number from P1's
  `turn` field. Keep `highlightSpanId`/`focusedTurn` working per-leaf.

### P2.3 — Context Size tab + sub-branches (item 7)
- New tab `Context` next to Trace (recipe: `media/src/App.tsx` TABS array +
  `ActivePanel` switch + new `media/src/tabs/ContextTab.tsx`).
- Show cumulative context size after each event/tool/command/message (running
  sum of the true context = input + cacheRead per step) with turn numbers.
- Render sub-agent/fork sessions as EXPANDABLE SUB-BRANCHES of the parent
  session using P1's `parentSessionId`. Nested SessionBlocks.

### P2 verification
check-types + lint clean; drive the dashboard (headless) to confirm: sticky
headers don't scroll; expand session→event→turn→tool shows 5 values each; metric
bar above updates on toggle; Context tab renders with turn numbers and expandable
sub-branches. Commit `feat(dashboard): …`.

## P3 — Context-composition tracer — REFINED SPEC (user verbatim, 2026-07-06 post-restart)

**User's sharpened requirements (authoritative; supersedes vaguer P3 prose below):**
1. The **Trace tab itself** shows context size and how it GROWS turn by turn.
2. Each growth point is **expandable to its EXACT source** — including the FULL
   output of the tool that caused it (not truncated).
3. Source data: Claude's per-project/per-session `.jsonl` folders. ALL outputs
   are written either in the session file OR its subfolders — parse both.
4. Show **full detail of everything added to context**: from the SYSTEM PROMPT
   through to the latest messages — every injected piece.
5. **Every turn shows the DIFF**, split into the **cache-READ** part and the
   **cache-CREATED** part (the two must be distinct, per D1).
6. **Sortable by time OR by value**, consistent with the rest of the UI.
7. **Sub-agents:** each spawned sub-agent row carries (a) a LINK to the
   sub-agent's OWN session — expandable inline AND navigable to that session —
   AND (b) the TOTAL tokens of the whole sub-agent session surfaced in the
   PARENT session's numbers.
8. **Every single event measured and reported** — no event omitted.

DERIVED (mandatory): full tool-output capture can be huge → lazy-load/stream per
turn, cap eager tokenization, don't load all attachments into the webview at once
(reuse P2.3's lazy pattern). The cache-read/cache-created diff comes from
`assistant.message.usage` (cache_read_input_tokens vs cache_creation_input_tokens)
per turn — attribute each to its source events.

---

## P3 — Context-composition tracer (EXPANDED SCOPE, user 2026-07-06)

Goal: see, per step, EXACTLY what occupies the context window and what it costs —
every event, message, tool call, inherited context file (CLAUDE.md, each rule,
each memory), hook injection, and sub-agent sub-session — across ALL sessions,
with exact tokens + cost + timestamp. The user wants to diagnose token burn to
the single injected file.

### Feasibility (✓ VERIFIED against a real `.jsonl` 2026-07-06 — this session's log)
The Claude Code `~/.claude/projects/<proj>/<session>.jsonl` is rich enough:
- Entry `type`s seen: `assistant`, `user`, `system`, `attachment`,
  `file-history-snapshot`, `last-prompt`, `mode`, `permission-mode`,
  `queue-operation`, `ai-title`.
- **`attachment` (10,419 in one session)** = the injected context blobs — every
  CLAUDE.md / rule / memory / file-read that enters context. TOKENIZE each to get
  per-source context weight per step. THIS is the enabler for "which file eats
  the context".
- **`system` entries carry `hookAdditionalContext`** = hook injections
  (janitor-memory, pss-skills, token-guard) — attributable too.
- **`assistant.message.usage`** = the 5 token buckets per turn (input/output/
  cache_read/cache_creation) → per-turn cost.
- **`parentUuid`** threads the full event→turn→tool tree; `toolUseID` /
  `sourceToolAssistantUUID` / `toolUseResult` link tool calls ↔ results.
- Sub-agents are SEPARATE session files (`isSidechain==true` was 0 in the main
  session — Agent-tool spawns wrote their own `.jsonl`) → needs CROSS-FILE
  linkage (P1.3's `parentSessionId`), matched via spawn time / cwd / Task tool_use.

### P3 build (after P1+P2)
- Extend the log parser to emit, per step: a context-composition breakdown =
  list of {source (file path / rule / memory / hook / tool-result / message),
  tokens, cost, added-at timestamp, still-resident?}. Tokenize attachments
  (approx tokenizer OK — label as estimate).
- Running context-size series already seeded by P2.3's Context tab; enrich each
  point with its composition breakdown (drill-down: click a step → see the N
  sources occupying context there, sorted by weight).
- Cross-session: ingest ALL project sessions (not just the open one) so ANIME2SVG
  + sub-agent sub-sessions are all visible; render sub-agent sessions as
  expandable branches under the spawning turn.
- The harness floor (CLAUDE.md + rules + tool catalog) becomes an explicit,
  sized line item per turn — the thing currently invisible in the turn breakdown.
- DERIVED: this is heavy data; lazy-load per session, stream, and cap the
  attachment tokenization (don't load 10k attachments into the webview at once).

### P3 verification
Reconcile against claude.ai account dashboard for a window; the per-step
composition sizes should sum (± tokenizer error) to that turn's cache_read+input.

## Notes / gotchas
- `src/types.ts` ↔ `media/src/types.ts` MIRROR — change BOTH on any shape change.
- Two pricing tables hand-synced (`src/pricing.ts` write-time, `media/src/pricing.ts`
  display-time) — cost logic changes may touch both.
- Branch `fix/logreader-large-jsonl`; commits stay LOCAL (origin is upstream
  RogerReed/agentlens — do NOT push). Stage files by name (never `git add -A`).
