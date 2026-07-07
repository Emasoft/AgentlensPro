---
trdd-id: W0RRL2FZ
title: Resident-cost itemization — rank every context block by tokens × turns-resident, itemize the transcript remainder
column: dev
created: 2026-07-07T13:30:49+0200
updated: 2026-07-07T19:17:00+0200
current-owner: null
assignee: null
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

## ⏵ STATE — APPROVED 2026-07-07 (USER: "go" after the P1-P6 evaluation) — queued for dispatch
Approval log: 2026-07-07T15:25:00+0200 — APPROVED by USER ("go"). Moved to design/tasks, column planned.

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
