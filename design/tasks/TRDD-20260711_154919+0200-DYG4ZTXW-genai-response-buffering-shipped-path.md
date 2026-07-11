---
trdd-id: DYG4ZTXW
title: Port gen_ai response-content buffering to the shipped standalone ingest path
column: complete
created: 2026-07-11T15:49:19+0200
updated: 2026-07-11T22:40:00+0200
current-owner: claude-code-review
assignee: claude-code-review
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
attempts: 1
test-failures: 0
last-test-result: pass
last-test-at: 2026-07-11T22:35:00+0200
implementation-commits: [5bdf629]
pr-url: null
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-07-11

**✅ DONE + verified (2026-07-11).** Shipped in Phase 0a of the /go-on-yourself plan.
The shipped `standalone/server.ts` `processLogs` now formats `gen_ai.choice`/
`gen_ai.assistant.message` events (shared `src/genAiContent.ts`) and injects
`gen_ai.output.messages` into the matching LLM span via a NEW
`SegmentedSpanStore.injectSpanAttribute` **read-time overlay** (merged on `loadRange`,
no disk-segment rewrite). Gate GREEN **884 passing / 0 failing** (876 baseline + 6 store
overlay unit tests + 2 real-boot integration tests), tsc 0-error, check-mirrors OK.
Committed on branch `feat/genai-response-buffering`, merged `--no-ff` to main (see git log).
Not pushed (npm pkg — the v2.5.0 release is cut at the END of the whole plan, not per phase).

**KEY DESIGN DECISION — overlay, NOT buffer (deviates from the sketch below, deliberately).**
The design sketch modeled the collector's buffer + drain + `injectSpanAttribute`. Shipped as a
SIMPLER pure read-time overlay with NO buffer: the collector needed a buffer only because the
legacy `sessionStore.injectSpanAttribute` mutates an EXISTING in-memory span (nothing to mutate
if the span hasn't arrived yet). `SegmentedSpanStore` records the attribute in an overlay
`Map<traceId:spanId, {k:v}>` merged in `loadRange`, so a span appended later still picks it up
and one flushed earlier still picks it up — order-independent, buffer/drain unnecessary.
Cap-evicted (500, oldest-first); in-memory only (lost on restart), an accepted tradeoff for
LOW-severity enrichment whose dominant ordering is span-first anyway. The shared `genAiContent.ts`
formatter now backs BOTH the collector and the shipped path (no duplicate). Full WHY in the
wikimem `[[otlp-ingest-topology]]` `[^2]` lesson.

**Verification artifacts:**
- Unit: `src/test/segmentedSpanStore.test.ts` — 6 overlay cases (after-span, before-span, upsert,
  cap-evict, orphan-no-crash, clear).
- Integration (real boot): `src/test/standaloneGenAiInject.test.ts` — boots the built server,
  POSTs an LLM span + its `gen_ai.choice` log in BOTH orderings, asserts the injected
  `gen_ai.output.messages` via the new read-only localhost `/api/debug/span-attr` endpoint.

---

**What this is:** the S3-F3b half of the OTLP-ingest-drift finding (parent
`TRDD-4AFOFVFD`, §"S3-F3a spec"). S3-F3a (the Codex per-prompt normalizer) is the
correctness half and was done first; THIS TRDD is the ENRICHMENT half —
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
