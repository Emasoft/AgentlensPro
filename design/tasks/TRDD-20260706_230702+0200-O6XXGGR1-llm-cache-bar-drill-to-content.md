---
trdd-id: O6XXGGR1
title: Make LLM-call cache bars recursively drill into injected-block composition down to content
column: complete
created: 2026-07-06T23:07:02+0200
updated: 2026-07-06T23:12:00+0200
current-owner: claude-opus-4-8
assignee: claude-opus-4-8
priority: 2
severity: HIGH
effort: M
task-type: feature
parent-trdd: TKN5VALS
relevant-rules: []
release-via: none
delivery: direct-push
target-branch: fix/logreader-large-jsonl
test-requirements: [typecheck, lint, dev-browser-headless]
attempts: 0
implementation-commits: [3fcb8ea]
external-refs: []
---

# TRDD-O6XXGGR1 — LLM cache-bar drill to content (P6, follow-on to TKN5VALS)

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-07-06

**Problem (user):** the per-LLM-call Cache-created / Cache-read bars are NOT
expandable — dead ends. Every element must be expandable down to a FINAL LEAF
showing actual content bytes (real tool output / injected block), not summary
fields in a div.

**Root cause (verified in reports/mcp/P6-llm-cache-drill-RESUME.md):**
- Per-LLM-STEP composition renders via the FLAT `rows` path at
  media/src/tabs/Traces.tsx ~L220-233 — Cache-read/Cache-created pushed as
  NON-expandable rows; L233 prints "Injected-block detail loads with the session
  composition." exactly when `hostSources?.length === 0`.
- `hostSources` empty at step-expand because `loadContextComposition(sessionId)`
  is never triggered on step/cache-bar expand.
- A RECURSIVE drill tree ALREADY exists at ~L752-759 (`compKids`) but only at the
  TURN level, not wired into the per-LLM-step StepDetail.

**Fix (3 steps, per resume spec):** (1) lazily trigger `loadContextComposition`
on step/cache-bar expand; (2) replace flat cache rows with the recursive
`compKids` node tree so Cache-created/Cache-read expand into injected blocks, each
drillable to ACTUAL content (`ContextSource.excerpt`/loadBlob); (3) honestly label
the un-itemized remainder ("system prompt + prior transcript (not individually
itemized): N tok") so the number reconciles to cache_creation. Never fabricate.

**Owns (files):** media/src/tabs/Traces.tsx (+ state signals). Webview-only.

**DONE (2026-07-06, commit `3fcb8ea`).** Opus agent verified end-to-end headless:
flat-mode LLM call drills Cache-created (104K) → Skill/Tool/Hook injected blocks +
honest 95.5K "system prompt + prior transcript (not itemized)" remainder that
reconciles to the exact cache_creation → real block content. Agent-side
check-types(src+media)/lint(0 err)/esbuild all clean at commit time. Screenshots:
reports/screenshots/{p6-llm,p6-cachecreated-blocks,p6-block-content}.png. Report:
reports/trace-ui/20260706_230651+0200-P6-impl.md.

**NOTE:** final FULL-TREE re-verify (check-types+lint+esbuild EXIT 0) deferred to
the serialized checkpoint after P7 (TRDD-KT87QPM0) lands — P7's uncommitted src/
edits would confound a working-tree build now. P6's own change is committed &
agent-verified in isolation.
