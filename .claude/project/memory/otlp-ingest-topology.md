---
name: otlp-ingest-topology
description: "which OTLP ingest path is actually live / codex sessions grouped wrong / grouped by conversation not per prompt / multiple otlp parsers or processLogs copies / where does the shipped ingest live / second router is a second truth / why did an ingest fix not take effect / how many places parse the OTLP wire format / what OTEL attributes does Claude Code emit / which telemetry fields are we not reading / where does client_request_id or tool_source go"
ocd: 2026-07-11
lmd: 2026-07-26
metadata:
  node_type: memory
  tier: hub
  type: project
  globs: ["standalone/server.ts", "src/otlpCollector.ts", "src/otlpParser.ts", "src/codexSessionNormalizer.ts", "src/summarizers/codex.ts"]
---

AgentlensPro parses the OTLP wire format in **more than one place**, and only ONE is
live in the shipped npx/Docker product. Before touching ingest, know the full set — a
fix applied to the wrong copy silently does nothing (the "second router is a second
truth" trap, see [[agentlens-burn-token-model]] lesson on rich-event drift).

**The OTLP-log ingest implementations (verified 2026-07-11, TRDD-4AFOFVFD / S3-F3a):**
1. **`standalone/server.ts` `processLogs` — THE SHIPPED PATH.** The standalone server has
   its OWN inline `processLogs`/`processTraces`; it persists to `SegmentedSpanStore`. This
   is what runs on user machines. It uniquely also handles the Claude rich-event gate,
   `tool_result`, and the body-pointer registry (raw API bodies). Since S3-F3b it ALSO
   injects gen_ai response content: a `gen_ai.choice`/`gen_ai.assistant.message` log event
   is formatted (shared `src/genAiContent.ts`) and merged into its LLM span via
   `SegmentedSpanStore.injectSpanAttribute` — a **read-time overlay** (merged on `loadRange`,
   not a disk-segment rewrite), so arrival order is irrelevant and no buffer/drain is
   needed.[^2]
2. **`src/otlpCollector.ts` (`OtlpCollector` class) — DEAD in prod** (0 `new OtlpCollector`
   outside tests). The old VS-Code-era HTTP collector; unit-tested + reactivatable. Its
   gen_ai response-content buffering (`formatGenAiEventContent` → the LEGACY
   `sessionStore.injectSpanAttribute`, which mutates an in-memory span) is the SAME formatter
   the shipped path now shares; only the buffer/drain differs (the legacy store cannot inject
   into a not-yet-arrived span, so it needs a `genAiResponseBuffer` — the segmented store's
   overlay does not).
3. **`src/otlpParser.ts` — only `classifyOtlpPayload` is used in prod.** Its
   `parseLogPayload`/`parseTracePayload` are dead-but-tested.

**Codex per-prompt session grouping (`codex:<conv>:prompt-N`) — the shared normalizer.**
The per-prompt grouping is the design intent (asserted across otlpCollector/otlpParser/
spanSummarizer tests). It now lives ONCE in `src/codexSessionNormalizer.ts`
(`CodexSessionNormalizer`): otlpParser builds one per call (per-payload state), the
collector + the standalone server each hold one long-lived instance (state persists
across payloads/requests). Before S3-F3a the shipped `processLogs` had drifted to group
Codex by conversation-id alone.

**THE FOURTH copy — the summarizer.** `src/summarizers/codex.ts` `groupCodexSpansBySession`
re-derives the SAME `codex:<conv>:prompt-N` grouping from stored spans (honoring an
explicit `codex.session.id` first, else re-deriving via its own ordinal). It is a fourth
grouper — and the one that determines the **user-visible** `/api/summary` grouping. The
ingest store-key (impls 1-3) and the summarized view (impl 4) are grouped by SEPARATE
logic, so an ingest-side grouping change (S3-F3a) has ~zero `/api/summary` effect.

**Phase 0b (2026-07-11) — analyzed and PARTIALLY unified; full fold REJECTED.** impl 4 is a
BATCH grouper (takes the whole stored-span list, time-SORTS it, honors an explicit
`codex.session.id` AS the key, absorbs same-trace non-prompt spans); the normalizer is a
STREAMING resolver (one ingest event at a time, no explicit-id input, incremental trace
map). Feeding the span list through `resolveSessionId` does NOT reproduce impl 4's output
(explicit-id honoring, same-trace guard, and pre-scan all differ), so a full fold would
change the user-visible grouping — rejected. What WAS unified: the two ATOMS both share and
that could silently drift — the prompt-event predicate (`isCodexPromptEventName`, re-exported
into `helpers.ts` as `isCodexPromptSpanName`, ending a byte-identical copy) and the key
FORMAT (`codexPromptSessionId(conv, n)`), both single-sourced in `codexSessionNormalizer.ts`.
`groupCodexSpansBySession` is now covered by a characterization test
(`src/test/codexGrouping.test.ts`) that locks its output.[^3]

**The Claude Code OTEL surface — what it emits, and what we do NOT read** (source:
code.claude.com/docs/en/monitoring-usage.md, verified 2026-07-26). Metrics:
`claude_code.{session,lines_of_code,pull_request,commit}.count`, `claude_code.cost.usage`,
`claude_code.token.usage`, `claude_code.code_edit_tool.decision`, `claude_code.active_time.total`.
Log events: `claude_code.{user_prompt,assistant_response,tool_result,api_request,api_error,
api_refusal,api_request_body,api_response_body,tool_decision,permission_mode_changed,auth,
mcp_server_connection,internal_error,plugin_installed,plugin_loaded}`. Spans:
`claude_code.{interaction,llm_request,tool,tool.blocked_on_user,tool.execution,hook}`.
Token/cost attrs: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`,
`cost_usd`, `cost_usd_micros`. Identity/route attrs: `model`, `query_source`, `speed`, `effort`,
`attempt`, `agent_id`, `parent_agent_id`, `agent.name`, `subagent_type`, `workflow.run_id`,
`workflow.name`, `skill_name`, `tool_name`, `tool_use_id`, `mcp_server_name`, `mcp_tool_name`.
Correlation attrs: `prompt.id`, `message.uuid`, `client_request_id`.

**Three of those are arriving on disk and read by NOTHING here** (verified by grep, 2026-07-26):
`client_request_id`, `message.uuid`, `tool_source`. `client_request_id` is the interesting one —
our per-call attribution currently walks the `previous_message_id` chain (cacheCreationForensics.ts),
which structurally cannot attribute a session's most recent call NOR a compaction's own
summarization call, leaving them in the `unattributable` bucket of `get_cache_event_log`. Whether
`client_request_id` joins to the uuid-named body files is UNPROVEN — a 5-sample probe matched 0,
but the sample was the oldest ids of the day against a rolling RAM-disk spool, so it is
inconclusive, not negative. `workflow.run_id`/`workflow.name` ARE already ingested (spanSummarizer.ts).
Content-size knob we do not set: `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` (default 60 KB truncation).

## Notes and lessons learned
[^1]: [ocd:2026-07-11 lmd:2026-07-11] S3-F3 was first scoped (from a compaction handoff)
  as a two-way, then three-way divergence; the ACTUAL topology is four-way — the
  summarizer's `groupCodexSpansBySession` was missed by the finding AND by the initial
  analysis. Lesson: when consolidating "the N implementations of X", grep the WHOLE
  pipeline (ingest AND the downstream summarizer/reader), not just the ingest layer —
  `grep -rn "codex:.*prompt-" src standalone` surfaced all four. The user-visible behavior
  may be owned by a copy the finding never named.
[^2]: [ocd:2026-07-11 lmd:2026-07-11] S3-F3b (gen_ai buffering to the shipped path) was
  scoped as "port the collector's buffer + drain + injectSpanAttribute" but shipped as a
  SIMPLER read-time overlay with NO buffer. Why: the collector needed a buffer only because
  the legacy `sessionStore.injectSpanAttribute` mutates an EXISTING in-memory span (nothing
  to mutate if the span hasn't arrived, hence buffer-until-it-does). `SegmentedSpanStore`
  instead records the attribute in an overlay `Map<traceId:spanId, {k:v}>` and merges it in
  `loadRange` — so a span appended later still picks it up, and one flushed earlier still
  picks it up; order is irrelevant and the buffer/drain is dead weight. Cap-evicted (500,
  oldest-first) so a never-arriving span cannot leak; in-memory only (lost on restart), an
  accepted tradeoff for LOW-severity enrichment whose dominant ordering is span-first anyway.
  Lesson: when porting a mechanism across stores, port the REQUIREMENT (attach content to a
  span by id, any order) not the incidental MACHINERY (a buffer that existed to work around
  the old store's mutate-in-place constraint).
[^3]: [ocd:2026-07-11 lmd:2026-07-11] Phase 0b was scoped as "fold the fourth copy onto the
  normalizer (adapter: full-span-list in, groups out)". After verifying the algorithms, the
  full fold was REJECTED: the batch grouper honors an explicit `codex.session.id` as the key,
  same-trace-absorbs non-prompt spans, and time-sorts — none of which the streaming resolver
  does, so delegating per-span to `resolveSessionId` would change the user-visible `/api/summary`
  grouping. Shipped instead: single-source only the two atoms that can DRIFT (the prompt
  predicate + the key format) and add the missing characterization test. Lesson: "N copies of X"
  is not always "N copies of ONE thing to merge" — sometimes it is N legitimately-different
  algorithms that share a few ATOMS; unify the atoms (safe), not the algorithms (here, output-
  changing). Verify the merge preserves output with a characterization test BEFORE assuming a
  fold is mechanical — the fourth copy had zero tests, so "output unchanged" was unprovable until
  one existed.
