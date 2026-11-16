---
trdd-id: OIMXULDJ
title: search - increment 2 categories and element level matching
column: backburner
status: tasked
created: 2026-11-16T23:49:17+0100
updated: 2026-11-16T23:49:17+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-16T23:49:17+0100
---

# search - increment 2 categories and element level matching

Increment 2 of 4 of the owner's 2026-11-16 search request (quoted in full on TRDD-UIQS9RXZ, which must land first). TypeScript only: src/cli/searchCli.ts, src/test/searchCli.test.ts.

## Why element level
Increment 1 matches the raw JSON line. Categories need the PARTS of an entry: one assistant line can hold text, thinking and several tool calls. Measured census of this project (reports_dev/search-v2/probe.txt): content blocks tool_use 108262, tool_result 80298, text 70401, thinking 63854, server_tool_use 582, advisor_tool_result 574; 68242 of 72856 tool_result entries ALSO carry a top-level `toolUseResult`; 14594 user entries hold a plain-string content; system entries hold a string `content` (7704) with subtypes stop_hook_summary, turn_duration, scheduled_task_fire, informational, away_summary, api_error, compact_boundary, local_command; hook attachments are `attachment.type` hook_success, hook_additional_context, hook_system_message, hook_blocking_error, hook_cancelled, hook_non_blocking_error, async_hook_response, each with `hookName` and `hookEvent`.

## Plan
1. With `--kind` (or `--tool`, `--file`, `--commit`) the engine runs in ELEMENT mode: stage 1 keeps the lines that pass the scope filters and a raw prefilter; stage 2 splits each kept line into elements and matches the pattern against the element's own text (unescaped), so the excerpt is readable text, not JSON.
   The raw prefilter is used only when the pattern contains none of: double quote, backslash, a control character, a non-ASCII character. Otherwise stage 1 keeps every line in scope (correct, slower).
2. Elements and their kind:
   - `prompt`: a user entry's string content, or its `text` blocks, when `isMeta` is not true.
   - `response`: an assistant `text` block. `thinking`: a `thinking` block.
   - `tool-call`: a `tool_use` or `server_tool_use` block (text = name + input JSON).
   - `tool-output`: a `tool_result` or `advisor_tool_result` block. The top-level `toolUseResult` is NOT a second element; it only supplies fields.
   - `diff`: a tool-output whose entry has `toolUseResult.structuredPatch` or `toolUseResult.bashEditDiff`, or a tool-call named Edit, Write, MultiEdit or NotebookEdit.
   - `subagent`: a tool-call named Agent, SendMessage or SubagentHandback, the tool-output answering one, and any element of a subagent transcript when `--kind subagent` is the only scope given.
   - `hook`: an attachment of a hook type listed above (text = content + stdout + stderr + blockingError), and a system `stop_hook_summary`.
   - `command`: a system `local_command`, a `queue-operation` content, an attachment `queued_command`, and a prompt that starts with `<command-name>`.
   - `compact`: system `compact_boundary` and `summary` entries. `error`: system `api_error` and a tool_result with `is_error` true. `cron`: system `scheduled_task_fire`. `system`: any other system entry. `attachment`: any other attachment (opt-in only, never in the default set).
   Default set without `--kind`: unchanged from increment 1 (raw line mode).
3. `--kind K[,K]` selects kinds. `--tool NAME[,NAME]` keeps tool-calls with that name and the tool-outputs answering them (join `tool_use.id` = `tool_result.tool_use_id` inside one transcript; exact name, or a `*` mask). `--file TEXT` keeps tool-calls whose input JSON contains TEXT and tool-outputs whose `toolUseResult.filePath` or `file` contains it, plus the outputs answering a kept call. `--commit SHA` keeps tool-calls and tool-outputs containing SHA (7+ hex chars) and entries whose `toolUseResult.gitOperation` contains it.
4. `--kind model-change` needs no pattern: one row per place where an assistant entry's `message.model` differs from the previous assistant entry of the same transcript (ignoring `<synthetic>`), printed as `from -> to`. Measured: 79 changes in 19 transcripts, 1.3 s.
5. Text output gains the kind and tool: `[tool-output Bash]`. `--json` gains `kind` and `tool`.

## Acceptance
- [ ] One fixture line holding text + thinking + two tool calls yields separate hits, each with its kind, and a pattern present only in the thinking block is not reported as a response.
- [ ] A plain-string user content is found as `prompt`; a tool output present both as a block and as `toolUseResult.stdout` is counted once.
- [ ] Each kind in the list has one test with a matching and a non-matching element.
- [ ] `--tool Bash` returns the call and its output; a `*` mask on the tool name works.
- [ ] `--file` and `--commit` each have a test. `--kind model-change` reports the fixture's change with the right line.
- [ ] A pattern containing a double quote and one containing a newline are found (the prefilter is skipped).
- [ ] Measured on this project and recorded here: wall time and peak RSS of `--kind tool-output`, of `--tool Bash`, and of `--kind model-change`.
- [ ] check-types and lint clean.

## Approval log

- 2026-11-16T23:49:17+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
