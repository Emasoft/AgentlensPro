---
trdd-id: IQENK7JM
title: Tokenizer-grade per-block token counts (replace bytes/4 estimates)
column: todo
created: 2026-07-07T11:00:01+0200
updated: 2026-07-07T11:00:01+0200
current-owner: null
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
