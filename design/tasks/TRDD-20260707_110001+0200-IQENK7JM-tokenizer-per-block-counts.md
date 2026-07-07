---
trdd-id: IQENK7JM
title: Tokenizer-grade per-block token counts (replace bytes/4 estimates)
column: complete
created: 2026-07-07T11:00:01+0200
updated: 2026-07-07T14:59:20+0200
current-owner: null
implementation-commits: [a240c265d01ee92ec1ca58888a7d824506351027]
assignee: null
priority: 3
severity: LOW
effort: M
task-type: feature
parent-trdd: TRDD-TKN5VALS
relevant-rules: []
release-via: none
target-branch: fix/logreader-large-jsonl
test-requirements: [typecheck, lint]
impacts: [dependencies]
external-refs: [https://code.claude.com/docs/en/monitoring-usage]
---

# TRDD-IQENK7JM — Tokenizer-grade per-block token counts

## ⏵ STATE — READ FIRST
DONE (2026-07-07, commit a240c26). Shipped `src/tokenEstimator.ts` (+ mirror `media/src/tokenEstimator.ts`):
`countTokens(text)` (deterministic single-pass segmenter, ~±10-15% of real tokenizers, beats bytes/4 on
code/JSON/CJK), byte-only `estimateTokensFromBytes`, and `calibrateTokens()`. Per-block counts in
contextHistory are now CALIBRATED per step to the exact usage totals (output→usage.output; input→
usage.input+cacheCreate inside a [0.5,2] band, else kept raw). Every bytes/4 token-estimate site routed
through the shared module (contextHistory, contextComposition, rawBodyContext, generatedFiles, and webview
ContextTab/Traces/Sessions/Tools). New `TokenSource` label ('exact'|'calibrated'|'estimated') on
ContextBlock/ContextSource (both type files); BlockRow shows ≈/~ markers + a legend. 19 new tests
(208→227 passing, 0 failing). Verified on a real 2000-step session: output block-sum == usage.output on
1885/2000 steps; headless screenshot confirms the labels (reports/tokenizer/). Follow-up (out of scope):
plumb per-call usage into CallBodyRegistry so rawBodyContext can calibrate too.

User: "anything should have its token count shown … either from the jsonl data, the otel, the debug
hooks or calculated directly with a tiktoker-like tokenizer!"

Currently every per-block count is `approxTokens = bytes/4` (`src/contextComposition.ts`,
`src/contextHistory.ts`, marked `TODO(R-G)`). Real per-turn totals come from the usage buckets; per-BLOCK
counts are estimates.

## Spec — token count precedence per element
1. If the element maps to an authoritative source, USE IT: the OTEL `claude_code.api_request` /
   `token.usage` buckets, the jsonl `message.usage`, or a debug-hook-provided count. (Per-call totals are
   exact; only sub-block splits need estimating.)
2. Otherwise compute with a LOCAL tiktoken-like tokenizer. Evaluate a pure-JS BPE (e.g. `js-tiktoken`,
   MIT, no native deps) — SUPPLY-CHAIN GATED: check TRDD-Y645B1ER / the pnpm hardening before adding a
   dep; if a dep is disallowed, ship a better-than-bytes/4 heuristic (e.g. tiktoken-ish regex splitter,
   ~±5%) and LABEL it estimated. Keep the exact vs estimated distinction visible in the UI.
3. Apply everywhere blocks are counted (`contextHistory`, `contextComposition`, the raw-body tree of
   TRDD-ICHAVFCS). One shared `countTokens(text, model?)` helper.

## Acceptance
- Per-block counts are visibly closer to real tokenization than bytes/4 (spot-check vs a known
  api_request total: the sum of a turn's block estimates should track its usage bucket within a few %).
  Exact-vs-estimated is labeled. check-types+lint+esbuild clean. Any new dep passes the supply-chain gate.
