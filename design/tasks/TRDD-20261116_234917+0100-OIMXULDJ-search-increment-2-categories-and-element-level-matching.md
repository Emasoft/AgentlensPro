---
trdd-id: OIMXULDJ
title: search - increment 2 categories and element level matching
column: dev
status: tasked
created: 2026-11-16T23:49:17+0100
updated: 2026-11-17T02:30:11+0100
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
- 2026-11-17T01:15:05+0100 — column → todo by main-agent@agentlenspro. increment 1 landed (6584d2dd, 4f134558); proposal reviewed by the harness, findings recorded on the card
- 2026-11-17T01:15:06+0100 — column → dev by main-agent@agentlenspro. increment 1 landed (6584d2dd, 4f134558); proposal reviewed by the harness, findings recorded on the card

## Engine plan after increment 1

- 2026-11-17 00:56 — PROPOSED, NOT BUILT. Increment 1 landed with a two-stage engine (commits 6584d2dd, 4f134558), so the Plan above is carried out inside it. Binding over the Plan where they differ. (A) Element mode starts with --kind, --tool, --file or --commit; without them line mode is unchanged. (B) Stage 1 keeps the scan groups, thread counts, object caps, ignore_errors and the invalid-line count of line mode. In the same statement it applies the raw prefilter (only when the pattern is prefilter-safe, Plan item 1) and the scope filters, splits each kept line into elements with UNNEST, matches the pattern against the element's own text, and inserts one small row per matching element: filename, ts, type, role, kind, tool name (calls), tool_use id (calls and outputs), element index, md5 of the raw line. No element text is stored. If that one statement fails at the 2GB no-spill limit on this project, the worker measures the alternative (line-mode stage 1, then the split restricted to the lines kept) and reports both; adopted only at 0 failures in 10 runs of --kind tool-output with a common pattern. (C) --tool: a first scan builds a small table of tool_use blocks whose name matches (filename, id, name); outputs are kept by a semi-join on filename and tool_use id. The tool name printed for an output comes from that table when --tool is given, otherwise from stage 2. (D) --kind model-change: its own statement over assistant entries only (filename, ts, model, md5), previous model by a window ordered by ts inside each file; line numbers from stage 2. (E) Stage 2, shown hits only, one pass per file: the line number by md5 as today, the excerpt cut from the element's own unescaped text, and the tool name of a shown output looked up by tool_use id in that file. (F) total and --count count elements, not lines. (G) Every expected value in a test comes from the fixture read in JavaScript, never from a second SQL query. (H) Measured and recorded before the boxes are ticked: wall time, peak RSS and failures in 10 runs for --kind tool-output, --tool Bash and --kind model-change, on a frozen file set, with the result compared to an independent count for at least one of them. (I) Not in this increment: an index or cache of any kind; masks and fuzzy matching (TRDD-O3U0K4HY); docs and the bundle (TRDD-G2GGBQ0U).
- 2026-11-17 01:14 — TO SETTLE FIRST (harness review of the proposal). (1) The figure '68242 of 72856 tool_result entries also carry toolUseResult' is not shown by reports_dev/search-v2/probe.txt (its toolUseResult line reads 22744), and the 9.7 s explode run is not in probe2.txt (one run, 2543 ms). The worker re-measures the block/toolUseResult duplication before building on it and the card is corrected with its number. (2) --file sits one character from the existing --files: one test that '--files' and '--file TEXT' are not confused by assertKnownFlags or the positional parser. (3) Element mode matches the UNESCAPED text of an element, line mode the RAW JSON line: the same pattern, and above all the same --regex, can give different hits with and without --kind, and total counts elements instead of lines. Both go in the help text.
- 2026-11-17 01:18 — The card went backburner, todo, dev in one step; the assumption checks listed under TO SETTLE FIRST run inside the dev step, as step 1 of the worker's order of work. Worker dispatched 2026-11-17 about 01:15; first files seen 01:17 (reports_dev/OIMXULDJ/frozen.json, one scripts_dev/oim- script).
- 2026-11-17T02:30+0100 — WORKER HANDED BACK PARTIAL, NOTHING COMMITTED (report reports_dev/OIMXULDJ/20261117_022640+0100-impl-report.md, read whole by the main agent; the code diff is not read yet). By its report: element mode built, 43 tests pass in the one test file, check-types and eslint clean. CENSUS CORRECTED (worker, frozen set of 3246 files, 2972 MB): 78930 tool_result blocks, 66989 of them (84.9 percent) in an entry that also has toolUseResult, and every such entry has exactly one tool_result block; the figure 68242 of 72856 in 'Why element level' is not reproducible and is withdrawn. RULE (B) IS TRIGGERED: the one statement ran out of the 2GB limit (4 threads; also with a row filter in front of the UNNEST, even on 1 thread; cause not found). The worker kept the one statement with a keep column and a cap of 2 threads and did NOT measure the alternative, which rule (B) requires. Runs so far, all under a host load of 64 to 139: 3 per case, 0 failures, peak RSS 1176-1217 MB (tool-output), 1764-1873 MB (--tool Bash), 1309-1342 MB (model-change); wall times spread 5 times and are not usable. Never run on real data: prompt, response, thinking, --file, --commit. INDEPENDENT COUNT: JavaScript count of tool-output 'error' = 13973 = engine total. Its 6 'bad lines' against the engine's 0 skipped lines are settled by the main agent (scripts_dev/oim-badlines.cjs, output reports_dev/OIMXULDJ/main-badlines.txt): split on the newline byte only, the 3246 files hold 564186 lines, 0 invalid, 0 blank, 0 files changed in size since the freeze; 2 lines contain U+2028, U+2029 or a carriage return, which the script's readline splits into pieces, so the 6 are pieces of those 2 lines (inferred from the counts, the pieces were not matched one by one). FOLLOW-UP ORDERED from the same worker at 02:29: prototype and measure the alternative of rule (B) in scripts_dev, the 10-run batch and the unmeasured kinds on a quiet host (1-minute load under 15), threads kept at 2 only if every peak is at most 1500 MB, else 1, and a second independent count (--tool Bash). The engine is chosen by the main agent from those numbers.
