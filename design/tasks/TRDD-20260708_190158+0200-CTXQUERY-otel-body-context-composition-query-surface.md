---
trdd-id: CTXQUERY
title: OTEL-raw-body context-composition query surface — images, resident blobs, per-block, fully queryable
column: complete
created: 2026-07-08T19:01:58+0200
updated: 2026-07-08T22:36:25+0200
current-owner: 777b8f52
assignee: null
priority: 1
severity: HIGH
effort: L
labels: [context-composition, otel-raw-body, mcp, images, cache]
task-type: feature
parent-trdd: null
npt: []
eht: []
relevant-rules: []
release-via: none
delivery: direct-push
target-branch: main
feature-branch: fix/logreader-large-jsonl
test-requirements: [unit, typecheck, lint]
runtime-targets: [macos, linux]
impacts: [public-api]
attempts: 1
last-test-result: pass
implementation-commits: [66b1b36, 04918c7, dfb97c7, 0b4dd70]
external-refs: []
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-08

**DONE (2026-07-08):** lazy composition index + 4 MCP tools (get_image_report/find_resident_blobs/query_context_blocks/get_block_content) + dashboard composition panel (lazy trace-tree expand) + resident-blob card badge all shipped & gate-green.

**WHY:** During the burn investigation we discovered — by hand-parsing OTEL raw request bodies — that
**ANIME2SVG (claude-fable-5) carries 8 stuck screenshots = 525.1k tokens = ~half its 1M context window,
re-read (cache_read) on EVERY turn** (the Anthropic API is stateless → the whole append-only transcript,
incl. those images, is re-sent every call). ~$425 of ANIME2SVG's ~$1,342 lifetime cost was re-reading
those 8 images. The USER wants AgentLens to make this DISCOVERABLE and FULLY QUERYABLE — not a manual dig.

**USER REQUIREMENT (verbatim intent):** "this kind of info must be included in agentlens, accessible via
MCP, via commands, that allow to query: the number of images sent, the time/turn/agent that read them,
the context percentage used, the cache create, etc. — and also what project and session. ALL possible
queries on these data must be possible, so we can investigate."

### THE DATA SOURCE (already captured — do not re-plumb)
- `OTEL_LOG_RAW_API_BODIES=file:~/.agentlens/otel-bodies` is SET → Claude Code writes
  the full untruncated `{system, messages[], tools[]}` per call to `<uuid>.request.json` (21,878 files
  present). This IS the exact context of each call.
- AgentLens ALREADY parses one body: `src/rawBodyContext.ts` `buildCallContext(bodyFilePath)` →
  `ContextBlock[]` (per-block kind + token count via `countTokens`, TRDD-IQENK7JM). `CallBodyRegistry`
  indexes session→body pointers. MCP `get_context_composition` / `get_call_context` exist but parse
  on-demand per call — there is NO cross-session/queryable INDEX and NO image/resident-blob queries.

### WHAT TO BUILD (the gap)
0. **LAZY SCANNING — do NOT eager-index all 21,878 bodies (USER directive 2026-07-08).** Parse a body's
   composition ON DEMAND, exactly when it is needed, and CACHE the parsed result (per call/session) so a
   repeat view/query is instant. Two triggers: (a) the user EXPANDS a trace-tree branch in the dashboard
   (a session/turn) → parse that session's bodies then; (b) an agent QUERIES the MCP (via a skill) →
   parse the scope the query touches then. This mirrors AgentLens's existing lazy `loadSessionDetail` /
   `loadContextComposition` fire-on-expand pattern and the on-demand `buildCallContext`. A query with a
   broad scope parses lazily across the matched sessions (bounded + cached), never a background sweep.
1. **A per-call composition record (built lazily, cached)** — NOT a pre-built persisted index. On first
   touch of a call/session, build `{project, sessionId, agent/subagent, turn, ts, model, contextTokens,
   contextPct(of window), blocks:[{kind, tokens, count, firstSeenTurn, hashOrRef}], images:{count,
   tokens}, toolResult:{tokens}, text:{tokens}, thinking:{tokens}, cacheCreate, cacheRead}` via
   `buildCallContext`, and cache it (LRU, like `CallBodyRegistry`). A resident-block tracker correlates a
   block across a session's already-parsed turns → residentTurns + cumulative re-read tokens/cost. The
   cache is the only persistence; nothing is scanned until asked for.
2. **MCP query tools** (extend `src/mcpServer.ts` + pass accessors from `standalone/server.ts`):
   - `get_context_composition(sessionId, turn?)` — per-turn block breakdown incl. images (EXTEND existing).
   - `get_image_report(scope?)` — # images per session/project, tokens, firstSeenTurn, residentTurns,
     cumulative cache-read cost. (Answers "number of images sent + who read them + cost".)
   - `find_resident_blobs(scope?, kind?, minTokens?, minResidentTurns?)` — any block (image/tool_result/
     text) resident > N turns, ranked by wasted cumulative re-read cost. THE eviction-candidate finder.
   - `get_context_growth(sessionId)` — context% + per-bucket per turn (EXTEND existing to add block kinds).
   - `query_context_blocks(filter, groupBy)` — the GENERIC engine the USER asked for: filter by any of
     {project, session, agent, kind, model, minTokens, turnRange, timeRange, contextPctRange}, group-by
     any dimension, aggregate tokens/count/cost. "All possible queries" = one flexible tool + docs.
   - `get_block_content(sessionId, turn, blockIndex, full?)` — DRILL-TO-CONTENT (USER 2026-07-08): the
     index is pointer-only (counts + refs, no stored bytes), but this resolver reads the body file via
     `buildCallContext` and returns the ACTUAL text of one block — used "when requested, or when the
     trace tree is expanded deeply enough". Reuse the `loadBlob`/`BLOCK_TEXT_CAP` pattern; `full:true`
     opt-in returns the uncapped single block. Image blocks return metadata + ref, never the base64 bytes.
   - **COMPLETENESS (USER 2026-07-08): cover the FULL taxonomy, not just images.** Every block `kind`
     (text/tool_use/tool_result/image/thinking/system/tool-schema/cache_control) and every request-level
     field (model/system/tools[]/messages[]/usage buckets) is represented uniformly — images are just one
     `kind`. The query engine filters/groups by ANY kind or field so arbitrary investigation is possible.
3. **Dashboard surface** (webview): a "Composition" view (per session: block-type breakdown bar + a
   flagged list of resident blobs — "525k images resident 400+ turns, $425" — click to the turn). Cache
   tab already exists; add the composition/blob panel there or a new tab.
4. **A proactive FLAG**: sessions with a block resident > threshold turns/tokens surface in Alerts +
   a card badge (like the burn alarm). This is what turns the manual dig into a one-line alert.

### NEXT ACTION
Assign + implement piece 1 (the index) first — everything else reads from it. Build in a FRESH session
or via delegated sub-agents: this discovery happened in session 777b8f52 which is itself a ~1M-token
top-3 burner, so continuing the BUILD here re-pays that floor every turn. Read the wikimem page
[[agentlens-burn-token-model]] + this STATE block, then start.

### LOAD-BEARING FACTS
- Body files are `<uuid>.request.json` (request) + `<request_id>.response.json`; the REQUEST body is the
  context. `MAX_RAW_BODY_BYTES=64MB` guard in rawBodyContext. Token est: `countTokens` (real tokenizer),
  not chars/4 (my hand-analysis used chars/4 ≈ ±15%).
- Image blocks: `{type:"image", source:{...base64...}}` — a single 46–77k-token block each; ANIME2SVG had
  8 in ONE message re-sent every turn.
- Anthropic API is STATELESS → the entire append-only `messages[]` is re-sent every call; a block only
  leaves the context on COMPACTION. That's WHY images ride every turn.
- Fix guidance to surface to users: do image work in a SUBAGENT (isolated context → image never enters
  parent transcript); compact aggressively; don't retain full-res blobs.
- SECURITY (standing): commits LOCAL only, NEVER push (origin=upstream). Stage by name. Body files may
  hold sensitive content — the composition index stores TOKEN COUNTS + refs, never the blob bytes
  (mirror `CallBodyRegistry`'s pointer-only rule). Reports under gitignored reports/.

### DURABLE ARTIFACTS
- `.claude/project/memory/agentlens-burn-token-model.md` (updated with the image finding).
- `src/rawBodyContext.ts`, `src/summarizers/summarizerTypes.ts` (ContextBlock types), `src/mcpServer.ts`.
- The evidence: `~/.agentlens/otel-bodies/*.request.json` (ANIME2SVG bodies each carry the 525k images).

## Body

Make the OTEL-raw-body context composition a first-class, fully-queryable dataset in AgentLens: index
every call's per-block composition (images, tool_results, text, thinking, tool schemas, system) keyed by
project/session/agent/turn/time, track resident blocks (a block re-read across N turns) and their
cumulative wasted cache-read cost, and expose it via MCP query tools + a dashboard panel + a proactive
"resident blob" alert. The concrete trigger was ANIME2SVG's 8 stuck screenshots (525k, ~half its window,
re-read every turn, ~$425). See the STATE block for the authoritative plan and the exact data source.
