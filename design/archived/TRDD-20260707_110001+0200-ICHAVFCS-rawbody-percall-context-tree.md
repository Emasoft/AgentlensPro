---
trdd-id: ICHAVFCS
title: Per-call full context tree from OTEL raw API bodies — click any call, see the whole context
column: completed
created: 2026-07-07T11:00:01+0200
updated: 2026-08-18T12:45:00+0200
current-owner: claude-opus-4-8
assignee: claude-opus-4-8
implementation-commits: [94bef67, 0ade84d]
priority: 0
severity: HIGH
effort: XL
task-type: feature
parent-trdd: TRDD-TKN5VALS
relevant-rules: []
release-via: none
target-branch: fix/logreader-large-jsonl
test-requirements: [typecheck, lint]
impacts: [config-schema]
external-refs: [https://code.claude.com/docs/en/monitoring-usage]
---

# TRDD-ICHAVFCS — Per-call full context tree from OTEL raw API bodies

## ⏵ STATE — READ FIRST
This is the USER'S #1 UNMET DEMAND (2026-07-07, repeated): "if i click to expand a specific
llm-call or a sub call, i must be able to see the WHOLE content of the context at that moment"
— every element (tool call, tool output, hook injection, agent response, mcp response, message,
thinking) as an expandable tree, each labeled with taxonomy + the 5 token fields
(input/output/cache-read/cache-creation/cost). Must work for OTEL-ONLY sessions (synth-*, the
fable-5 fleet) which have NO `.jsonl`.

**WHY the existing views fail:** the jsonl-based History tab (TRDD-TKN5VALS R-A, shipped cd04e7a)
and the Sessions-tab `LlmContextBreakdown` (media/src/tabs/Traces.tsx) BOTH require a local
`.jsonl`. The user's burn sessions are OTEL-only → `findSessionFile` returns null → the UI dead-ends
on "This session has no local transcript to itemize (OTEL-only…)" and punts to "open the preceding
turns yourself". For OTEL-only sessions the content bytes were never on disk.

**THE SOURCE (already configured):** `OTEL_LOG_RAW_API_BODIES=file:~/.agentlens/otel-bodies`
is now set in ~/.claude/settings.json (this session). After a Claude Code restart, CC writes the
UNTRUNCATED exact request body per call to `<dir>/<uuid>.request.json` (and `<request_id>.response.json`),
emitting `claude_code.api_request_body` / `claude_code.api_response_body` LOG events with `body_ref`
(file path) + `request_id` + `model` + `query_source`. That request body IS the whole literal context
(system prompt + every message + tools) at that call.

## Spec
1. **Ingest** `claude_code.api_request_body` / `api_response_body` events in `src/otlpCollector.ts`
   (mirror the rich-event path added in commit 7612ff5 — the `isClaudeRichEvent` gate). Capture
   `body_ref` (or inline `body`), `request_id`, `model`, `query_source`, `session.id`. When `body_ref`
   is a file path, read it lazily (do NOT load all bodies into memory — they can be MBs each).
2. **Reconstruct** a per-call context tree from the raw request JSON `{system, messages[], tools[]}`:
   - `system` → one/many `system` blocks (+ split CLAUDE.md / rules if identifiable).
   - each `messages[]` entry → blocks by content type: text→`userMsg`/`assistantMsg`, `tool_use`→
     `toolInput` (Bash→`bashInput`), `tool_result`→`toolOutput` (Bash→`bashOutput`), `thinking`→
     `reasoning`, MCP tool_use/result→tagged with `mcp`/toolName, image→`other`.
   - `tools[]` → one `toolCatalog` block.
   - Reuse the `ContextBlockKind` taxonomy + `ContextBlock` shape from `src/contextHistory.ts`
     (already defined + mirrored in media/src/types.ts). Add a `buildContextFromRawBody(requestJson)`
     that returns `ContextBlock[]` with per-block token estimates (see TRDD-IQENK7JM for real tokens).
   - Correlate to the llm call by `request_id` (matches the `api_request` event + the llm_request span).
3. **Serve** it: a new accessor/route `/api/callcontext/:sessionId/:requestId` (or extend
   `/api/history`) returning the per-call block tree. MCP: extend `get_context_history` (or a new
   `get_call_context`) so the block tree is drillable over MCP too.
4. **UI**: clicking an llm-call (Sessions-tab `LlmContextBreakdown` in Traces.tsx AND the History
   tab) shows the reconstructed block tree — every node expandable to actual text, labeled taxonomy
   + the 5 token fields. **Fix the layout the user flagged**: the call-detail fields render in COLUMNS;
   make it a VERTICAL expandable token-bar subtree. Replace the "open the previous turn" dead-end.
5. **Mirror + surface attribution**: the rich-event fields added to `TimelineEntry` in 7612ff5
   (costUsd/querySource/agentName/skillName/pluginName/mcpServerName/mcpToolName/preTokens/postTokens/…)
   are NOT yet in `media/src/types.ts` — mirror them, and surface per-call attribution ("issued by
   subagent X / skill Y / mcp Z", exact cost) on the call row.
6. **Honest fallback**: a call with no raw body on disk (legacy OTEL-only, pre-config) shows a clear
   "raw body not captured for this call (recorded before raw-body logging was enabled)" — never a
   perpetual spinner, never "check the previous turn".

## Acceptance
- After a CC restart with raw bodies on, clicking ANY llm-call in an OTEL-only session shows the full
  context tree drilled to real text, per node taxonomy + tokens; verified HEADLESS (dev-browser,
  never Safari) with a screenshot. Layout is vertical. check-types(src+media)+lint+esbuild clean.

## Approval log

- 2026-08-18T12:45:00+0200 — ARCHIVED by USER batch directive ("complete all TRDD"); validity re-verified: src/rawBodyContext.ts exists, src/mcpServer.ts:742/3545 registers get_call_context, standalone/server.ts:4280 serves /api/callcontext, media/src/tabs/Traces.tsx:268-282 wires the UI to it.
