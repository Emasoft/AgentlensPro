---
name: otlp-ingest-topology
description: "which OTLP ingest path is actually live / codex sessions grouped wrong / grouped by conversation not per prompt / multiple otlp parsers or processLogs copies / where does the shipped ingest live / second router is a second truth / why did an ingest fix not take effect / how many places parse the OTLP wire format"
ocd: 2026-07-11
lmd: 2026-07-11
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
   `tool_result`, and the body-pointer registry (raw API bodies).
2. **`src/otlpCollector.ts` (`OtlpCollector` class) — DEAD in prod** (0 `new OtlpCollector`
   outside tests). The old VS-Code-era HTTP collector; unit-tested + reactivatable. It
   uniquely still has the gen_ai response-content buffering (`formatGenAiEventContent` →
   `sessionStore.injectSpanAttribute`) the shipped path lacks (deferred as TRDD-DYG4ZTXW).
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
explicit `codex.session.id` first, else re-deriving via its own ordinal). It is a fourth,
independent copy — and the one that determines the **user-visible** `/api/summary`
grouping. Consequence: the ingest store-key (impls 1-3) and the summarized view (impl 4)
are grouped by SEPARATE logic, so an ingest-side grouping change (S3-F3a) has ~zero
`/api/summary` effect. True single-source-of-truth would fold impl 4 into the normalizer
too (different lifecycle — full-span-list adapter, not a drop-in) — deferred.

## Notes and lessons learned
[^1]: [ocd:2026-07-11 lmd:2026-07-11] S3-F3 was first scoped (from a compaction handoff)
  as a two-way, then three-way divergence; the ACTUAL topology is four-way — the
  summarizer's `groupCodexSpansBySession` was missed by the finding AND by the initial
  analysis. Lesson: when consolidating "the N implementations of X", grep the WHOLE
  pipeline (ingest AND the downstream summarizer/reader), not just the ingest layer —
  `grep -rn "codex:.*prompt-" src standalone` surfaced all four. The user-visible behavior
  may be owned by a copy the finding never named.
