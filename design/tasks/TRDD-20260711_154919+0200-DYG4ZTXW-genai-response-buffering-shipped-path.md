---
trdd-id: DYG4ZTXW
title: Port gen_ai response-content buffering to the shipped standalone ingest path
column: backburner
created: 2026-07-11T15:49:19+0200
updated: 2026-07-11T15:49:19+0200
current-owner: claude-code-review
assignee: null
priority: 4
severity: LOW
effort: M
labels: [ingest, enrichment, otlp, gen_ai, codex]
task-type: feature
parent-trdd: TRDD-4AFOFVFD
npt: []
eht: []
blocked-by: []
supersedes: []
superseded-by: []
relevant-rules: []
release-via: publish
delivery: pull-request
target-branch: main
merge-strategy: merge
must-pass-tests-before-merge: true
publish-target: npm
publish-channel: stable
test-requirements: [unit, lint, typecheck]
audit-requirements: []
review-requirements: [code-review]
runtime-targets: [macos, linux]
impacts: []
attempts: 0
test-failures: 0
last-test-result: not-run
last-test-at: null
implementation-commits: []
pr-url: null
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-07-11

**What this is:** the S3-F3b half of the OTLP-ingest-drift finding (parent
`TRDD-4AFOFVFD`, §"S3-F3a spec"). S3-F3a (the Codex per-prompt normalizer) is the
correctness half and is being done first; THIS TRDD is the ENRICHMENT half —
deferred deliberately because it needs span-store surgery, carries higher risk, and
delivers data enrichment (not accounting correctness).

**The gap (verified 2026-07-11):** the shipped standalone `processLogs`
(`standalone/server.ts` @1036) DROPS `gen_ai.choice` / `gen_ai.assistant.message`
log events (they fall through the rich-event gate @1087 → `noteDroppedLogEvent`), so
the dashboard shows no assistant response text for gen_ai-instrumented agents
(Codex/OpenAI). The DEAD `src/otlpCollector.ts` (@445-472) DOES handle them: it
`formatGenAiEventContent(raw, eventName)` (@689), buffers by `traceId:spanId` in
`genAiResponseBuffer` (cap `GEN_AI_BUFFER_MAX=500`, oldest-evicted), and injects the
formatted text into the matching LLM span via `sessionStore.injectSpanAttribute(
traceId, spanId, 'gen_ai.output.messages', formatted)` — immediately if the span is
already stored, else on buffer drain when `processTraces` later sees the span.

**WHY BLOCKED / deferred:** the injection target does not exist on the shipped store.
`injectSpanAttribute` lives ONLY on the legacy `src/sessionStore.ts` (@157). The
shipped product uses `SegmentedSpanStore` (`src/segmentedSpanStore.ts`), which
persists spans to disk in segments and has NO attribute-injection method. Injecting
`gen_ai.output.messages` into a span that may already be flushed to a disk segment
requires either (a) a `SegmentedSpanStore.injectSpanAttribute` that locates + rewrites
the owning segment (or holds an in-memory overlay applied on read), and (b) a
`processTraces` drain that applies buffered content when the matching span arrives.
That is real store-level work on the live hot path — out of scope for the S3-F3a
correctness change; tracked here so it is NOT dropped.

## NEXT ACTION

Not scheduled yet (backburner). When picked up: design `SegmentedSpanStore`
attribute injection FIRST (decide: segment-rewrite vs read-time overlay; the overlay
is likely safer — a `Map<traceId:spanId, Record<key,value>>` merged in on read/emit,
no disk rewrite), TDD it in isolation, THEN wire the buffer + drain into the
standalone `processLogs`/`processTraces` reusing a shared gen_ai helper extracted from
the collector.

## Design sketch (integrate, don't delete — per /go-on-yourself)

1. **NEW `src/genAiResponseBuffer.ts`** — extract `formatGenAiEventContent` + the
   buffer/evict logic from `otlpCollector.ts` into a small shared, stateful helper
   (a `GenAiResponseBuffer` class: `capture(traceId, spanId, raw, eventName)` →
   formatted-or-empty, with the cap-evict; `takeFor(traceId, spanId)` for the drain).
   Wire the (retained) collector to it too — no duplicated formatter.
2. **`SegmentedSpanStore.injectSpanAttribute(traceId, spanId, key, value): boolean`** —
   preferred impl: a read-time overlay map so no persisted segment is rewritten;
   returns true if a live/known span matched (so the buffer entry can be dropped).
   Applied wherever the store materializes spans for summarization.
3. **standalone `processLogs`** — on `gen_ai.choice`/`gen_ai.assistant.message`,
   `capture(...)`; try `spanStore.injectSpanAttribute(...)`; if not injected, keep
   buffered. **standalone `processTraces`** — after `addSpan`, drain any buffered
   content for that `traceId:spanId`.
4. **TDD (shipped path):** (a) a gen_ai response event arriving AFTER its span →
   injected on the drain; (b) arriving BEFORE its span → buffered then injected when
   the span arrives; (c) buffer cap eviction; (d) no span ever arrives → no crash,
   entry evicted.

## Load-bearing facts / gotchas

- Same Node split + gate as the parent: `bash scripts/safe-deploy.sh --dry-run`
  (Node 20 for mocha; pnpm crashes under Node 20).
- `formatGenAiEventContent` (collector @689) is the ONLY existing formatter — reuse
  it, don't reinvent.
- Do NOT rewrite persisted disk segments if a read-time overlay suffices (lower risk).

## Approval log
- 2026-07-11 — split out of TRDD-4AFOFVFD S3-F3 during the corrected three-way
  analysis: S3-F3a (Codex normalization) done first; this enrichment half deferred
  because it needs SegmentedSpanStore attribute-injection (higher risk, lower value).
