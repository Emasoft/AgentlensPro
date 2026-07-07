---
trdd-id: W0RRL2FZ
title: Resident-cost itemization — rank every context block by tokens × turns-resident, itemize the transcript remainder
column: complete
created: 2026-07-07T13:30:49+0200
updated: 2026-07-07T23:05:00+0200
current-owner: null
assignee: null
implementation-commits: [98dcdab, 298dca6]
priority: 2
severity: MEDIUM
effort: M
task-type: feature
parent-trdd: TRDD-TKN5VALS
approval-tier: 2
relevant-rules: []
release-via: none
target-branch: fix/logreader-large-jsonl
test-requirements: [typecheck, lint]
impacts: []
external-refs: []
---

# TRDD-W0RRL2FZ — Resident-cost itemization of the transcript

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-07 23:05

**COMPLETE.** Shipped in `98dcdab` (feature) + `298dca6` (safety fix found during verification).
Gates: check-types 0 · lint 0 errors · esbuild clean · unit suite 314 passing / 1 pending / 0
failing (baseline 300 + 14 new residentCost tests). Full report:
`reports/resident-cost/20260707_224615+0200-W0RRL2FZ.md` (gitignored, local).

**What shipped**
- `src/residentCost.ts` + `media/src/residentCost.ts` (mirror): `buildResidentCostReport(history)`
  — per-block `residentCost = Σ occurrences × tokens × turns-resident`, residency bounded by
  compaction turns (steps carrying a postCompact block), reconciled against exact per-step usage
  (Σ input+cacheRead+cacheCreate); SIGNED labeled unattributed remainder; per-kind remediation.
- `get_context_inflation_report(sessionId)` → new `residentCost` field (totals, reconciliation,
  compactionTurns, top-10 blocks each with remediation + drill pointer into get_context_history).
  Workspace scope deliberately unchanged (would double the pooled scan cost).
- Webview: `ResidentCostList` summary panel in the History tab (expandable rows drill to
  first-occurrence text) + lazy per-session panel in the Context tab. History loading unified via
  `state.requestContextHistory` (VS Code postMessage → dashboardPanel `loadContextHistory`;
  standalone shim → `/api/history`) — also fixes the VS Code webview where HistoryTab's old direct
  fetch was CSP-blocked.
- Types mirrored in `src/summarizers/summarizerTypes.ts` ↔ `media/src/types.ts`.

**Load-bearing finding — the "268k × 314 postCompact" was a mis-classification artifact.**
`buildContextHistory`'s old `isCompactSummary || isMeta → postCompact` branch folded 312
`[janitor-heartbeat]` scheduled-task fires (~855 tok each) into one fake "compact summary" id —
that aggregate IS the "postCompact 267,921 tok × 314" of the parent diagnosis (bd15106 note).
Ground truth on 28e3a88d: exactly 3 real compactions (isCompactSummary + compact_boundary) at
turns 314/359/559, summaries only ~2.8-3.5k tok each. Fixed classification: only isCompactSummary
→ postCompact; scheduled fires → `cron: scheduled task: <name>`; caveats → `cron: local-command
caveat`; other metas → `harness: meta`.

**Acceptance verified on 28e3a88d** (live session — numbers drift as it grows; run
`scripts_dev/verify-resident-cost-28e3a88d.js`): itemized 94.3% of 119,691,987 exact cumulative
context tokens (remainder 5.7%, labeled) → "reconciles within a few %" ✓. Top resident-cost block
= `cron: scheduled task: janitor-heartbeat` 42.0M tok·turns (Σ266,760 tok ≈ the ~268k × 312 fires
≈ the ~314 turns) — the diagnosed entity itemized by its TRUE name (the acceptance's "postCompact"
naming was the bug); real postCompact summaries itemize by name (Σ8,563 tok, 0.88M tok·turns).
MCP proof end-to-end on an isolated server (`scripts_dev/verify-mcp-inflation.js`); headless UI
proof via dev-browser (History panel + Context lazy panel, screenshots in reports/screenshots/).

**Incident + fix (298dca6):** during verification an isolated test server (OTLP_PORT=14319,
AGENTLENS_NO_TELEMETRY_CONFIG=1) still rewrote the global telemetry endpoints of Claude Code /
Codex / Copilot to its ephemeral port — `applyAutoConfig` gated only step 1; the legacy
per-agent writers ran unconditionally. All three configs restored to :4318 and the gates now
early-return before BOTH writers (re-verified empirically).

**SUPERSEDED — do NOT carry forward:** "the top resident-cost block is the postCompact summary
(~268k × ~314)" — that entity is the cron heartbeat aggregate; the real summaries are small.

**NEXT ACTION:** none — TRDD complete. Follow-up ideas live elsewhere (Context tab DOM
virtualization is TRDD-PW0H2NXC; the headless proof stalls on the un-virtualized 12k-session DOM).

## Approval log
- 2026-07-07T15:25:00+0200 — APPROVED by USER ("go"). Moved to design/tasks, column planned.
- 2026-07-07T23:05:00+0200 — COMPLETED (implementation 98dcdab, safety fix 298dca6; gates green).

## Why
The cost model is `cost ≈ turns × per-turn-context`: a block is expensive not for its size but
for its size × HOW LONG it rides forward. The proven dominant sink of the diagnosed burn — a
postCompact summary of 267,921 tokens resident for 314 turns (~84M cumulative read tokens) — is
still only the UN-ITEMIZED remainder in `get_context_inflation_report`. contextHistory already
knows every block per step (bd15106); nobody multiplies the two dimensions.

## Spec
1. **Resident-cost metric**: for each distinct context block across a session's steps, compute
   `residentCost = Σ(tokens present at step)` (≈ tokens × turns-resident) + firstSeen/lastSeen
   turn + kind. Pure derivation over the existing ContextHistory — no new ingestion.
2. **Itemize the remainder**: the inflation report's "conversation remainder" becomes a ranked
   list of its actual constituents (postCompact summaries, big tool outputs riding forward,
   pasted files, repeated hook injections), each with resident-cost, kind, origin turn.
3. **Surface**: top-10 resident-cost blocks panel in the Context tab + History tab summary; new
   field in `get_context_inflation_report`; each entry links to the block drill (full content).
4. **Remediation hints**: per kind ("this tool output rode 200 turns — extract the fact and drop
   the blob", "compact earlier / smaller summary").

## Acceptance
- On session 28e3a88d (the diagnosed burn), the top resident-cost block is the postCompact
  summary (~268k × ~314 turns) — itemized by name, not remainder; the report's remainder bucket
  shrinks accordingly and reconciles with per-step usage totals within a few %.
  check-types+lint+esbuild clean; headless proof.
