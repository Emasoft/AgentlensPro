---
trdd-id: 6TQ2FBUR
title: Cache-break ROOT-CAUSE diagnostic suite — timeline classifier + cost-peak + repeat-offender
column: completed
created: 2026-07-09T08:22:53+0200
updated: 2026-08-18T12:45:00+0200
current-owner: claude-code
assignee: claude-code
priority: 3
severity: MEDIUM
effort: L
labels: [mcp, cache-forensics, diagnostics, observability]
task-type: feature
parent-trdd: TRDD-CCFORNSC
npt: []
eht: []
blocked-by: []
relevant-rules: []
release-via: none
delivery: direct-push
target-branch: fix/logreader-large-jsonl
test-requirements: [unit, typecheck, lint]
impacts: [public-api]
runtime-targets: [macos, linux]
attempts: 0
last-test-result: pass
implementation-commits: [356f175, 817763c, 77148e8]
---

# Cache-break ROOT-CAUSE diagnostic suite

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-09T10:30+0200

**Goal:** turn AgentLens' cache_creation forensics (TRDD-CCFORNSC, commit 09d2d9c) into a
first-class ROOT-CAUSE suite that NAMES the definitive culprit that broke the prompt-cache prefix,
plus a chronic-offender rollup that flags a systematic misconfigured hook/skill/plugin/tool.

**Data model (proven, TRDD-CCFORNSC):** OTEL bodies at `~/.agentlens/otel-bodies/`.
`<uuid>.request.json` {model, thinking, system[](w/ cache_control breakpoints), tools[](w/
defer_loading + mcp__ names), messages[], metadata.user_id (session/account blob), diagnostics.previous_message_id}.
`req_<id>.response.json` {id (msg_…), usage{…cache_creation{ephemeral_5m,ephemeral_1h}}}.
JOIN proven on real data: group REQUESTS by session_id; order by mtime; turn[i].response id =
turn[i+1].previous_message_id (verified byte-exact on session c8a95d7e). cache_creation of turn i is
billed on turn i's request context → diff prefix(req_i) vs prefix(req_{i-1}).

**Anthropic caching mechanics (docs-confirmed):** PREFIX cache keyed on EXACT bytes; hierarchy
`tools → system → messages`; a change at any layer invalidates that layer + all after it. Model,
extended-thinking (effort), tool_choice, images, speed/fast all key the cache. cache write = 1.25×
(5m) / 2× (1h) input rate; read = 0.1×.

**Deliverables + STATUS:**
- D3 (CORE) `src/cacheBreakTimeline.ts` + `get_cache_break_timeline` MCP tool + repeat-offender
  rollup — [x] DONE (27 unit tests, incl. one synthetic before/after per cause code + systematic
  repeat-offender proof). Gates green.
- D1 enhance `trace_expensive_writes` (rich filters {sessionId, accountUuid, model, minCacheCreate,
  minOutputTokens, turnRange, timeRange, topN} + backward context chain + formats) — [x] DONE
  (3 new tests). Gates green.
- D2 generalize `get_cache_creation_report` → cost-peak finder (buckets + groupBy {session|account|
  model|time|cause}) — [x] DONE. `buildCacheCreationReport` (cacheCreationForensics.ts) keeps
  session/account/model/time on the lightweight response-only scan; the NEW `buildCauseCostPeakReport`
  (cacheBreakTimeline.ts) serves groupBy=cause by scanning EVERY session (not just one target) and
  reusing `classifyTurns`. Both return the identical `CacheCreationReport` shape; `mcpServer.ts`'s
  `get_cache_creation_report` handler dispatches on `groupBy` and renders either with the shared
  `formatCostPeaks`. `buildCacheCreationReport` fails fast (throws) if called directly with
  groupBy='cause' — that dimension is cacheBreakTimeline.ts's job. 10 new unit tests (bucket selection
  {output|total|billable_weighted}, cross-session cause aggregation, output-spike surfacing under
  groupBy=cause, absent-dir/fail-fast edge cases, format rendering). Gates green (check-types, lint,
  esbuild, mocha 448/448 passing).
- Tests + MCP registration + report — [x] DONE (per-deliverable, folded into each D1/D2/D3 entry above).

**NEXT ACTION:** none — all three deliverables (D1, D2, D3) are DONE and gate-green. This TRDD is complete.

**Cause taxonomy (D3), each mapped to a code:** TOOLSET_CHANGED, TOOLS_REORDERED,
TOOL_SEARCH_DEFERRED, MCP_TOOLS_CHANGED, MODEL_SWITCH, EFFORT_SWITCH, HOOK_INJECTION,
SKILL_INJECTION, SKILL_DESCRIPTION_TRUNCATION, SKILL_CHANGED, INLINE_EXEC_RESULT_CHANGED,
CLAUDE_MD_CHANGED, AGENT_METADATA_CHANGED, SYSTEM_TIMESTAMP, CONTEXT_ORDER_CHANGED, TTL_EXPIRY,
COLD_START, COMPACTION, UNCLASSIFIED.

**Load-bearing facts / gotughas:**
- Classify order = docs hierarchy: MODEL_SWITCH → EFFORT_SWITCH → tools layer → system blocks →
  message-prefix blocks → (no structural diff) timing (TTL_EXPIRY/COLD_START) → UNCLASSIFIED.
  A structural prefix change ALWAYS beats a timing gap (the change is the real culprit).
- POINTER-ONLY: fingerprints are stable hashes of block text; NEVER store raw text / base64 / the
  user_id token blob. Only session_id/account_uuid (identifiers, not secrets) + token counts + labels.
- LAZY + BOUNDED: single recency-first capped scan; honest `coverage` block; never load 32k files.
- lean-ctx shell wrapper blocks `python3 -c`, `{…}` groups, and `$(…)` in echo args — use script files.

**CONSTRAINTS:** commits LOCAL only, NEVER push; stage BY NAME; don't touch ~/.claude/settings.json;
don't restart the server; don't delete `.CacheTab.tsx.swp`. Gates per commit: check-types, lint,
esbuild, mocha (compiled).

## Background

The prompt cache is a PREFIX cache. When turn N's `[tools, system, messages]` prefix diverges from
turn N-1 at or before a `cache_control` breakpoint, everything after the divergence is re-billed as
`cache_creation` (1.25×/2× write rate) instead of `cache_read` (0.1×). The existing forensics tools
answer "WHO/WHAT/is-it-TTL-or-break". This suite answers the last question: "WHICH specific element
broke the cache, and is it breaking EVERY turn (a systematic misconfiguration)?"

## Design

Three MCP surfaces:
1. **`get_cache_break_timeline`** — reconstruct a session's ordered turns, diff each significant
   cache_creation turn's prefix vs the previous turn in canonical hierarchy order, classify the FIRST
   divergent element into a cause code, emit a TIMELINE of warning events + a REPEAT-OFFENDER rollup
   (group by (cause, culprit-element identity); flag ≥3-turn recurrences as SYSTEMATIC with a
   plain-language verdict + fix).
2. **`trace_expensive_writes`** (enhanced) — rich filters {sessionId, accountUuid, model,
   minCacheCreate, minOutputTokens, turnRange, timeRange, topN} + formats {json|table|markdown|timeline};
   per event the backward chain of context leading up to it + composition.
3. **`get_cache_creation_report`** (generalized cost-peak) — rank by any bucket
   {cache_creation|output|input|total|billable_weighted}, groupBy {session|account|model|cause},
   surface OUTPUT-token spikes (billed at ~5×) explicitly.

## Approval log
(Tier-0: in-scope feature work on the current project by the dedicated agent; no external approval needed.)
- 2026-08-18T12:45:00+0200 — ARCHIVED by USER batch directive ("complete all TRDD"); validity re-verified: src/cacheBreakTimeline.ts exists, src/mcpServer.ts:1085 registers get_cache_break_timeline.
