---
title: DuckDB-index redesign - operation catalog (126 operations, one row each, grouped into implementation cards)
status: draft
scope: project
sources: reports/DUCKPLAN/20261003_171551+0200-operation-contracts.md (R), reports/DUCKPLAN/20261003_182757+0200-transcript-format-facts.md (T)
---

# Operation catalog for the alcore DuckDB-index redesign

Purpose: the single list from which one TRDD card per operation group is minted. Every row cites the contract report (R) section; anything this catalog adds on its own (class, grouping, proposed function names, prerequisite units) is marked INFERRED. R = `reports/DUCKPLAN/20261003_171551+0200-operation-contracts.md`; T = `reports/DUCKPLAN/20261003_182757+0200-transcript-format-facts.md`. Tests are `rust-core/crates/agentlens-core/tests/<file>`.

Counting: R states 126 operations = 48 HTTP route/method pairs + 53 MCP tools + 4 SSE frames + 6 shell tokens + 15 dashboard views (R Key findings). R numbers HTTP entries H1-H44; this catalog expands H32 into four routes (H32a-d) and H42 into two paths (H42a `/`, H42b `/index.html`) to reach 48 pairs (the split of H42 is INFERRED; R lists "GET / and GET /index.html" as one entry). H44 (OTLP ingest) is counted by R "for completeness" and is write-side. Shell tokens are numbered S1-S6 in the order of R 5.2 (INFERRED numbering). F0 (the initial `:` comment) is not an operation.

## 0. Legends

Class (INFERRED, from R fields (a)-(c) of each entry; `+` joins two): SSD = single-session detail; PL = paged list; AGG = aggregate over sessions/window; TOPN = top-N scan; OTEL = OTEL-merge dependent (output depends on the log-vs-OTEL merge or on `otel_span`); FS = filesystem/external operation; W = write; ST = static/constant (no data).

Sources: proposed tables `node, node_key, spawn_edge, spawn_result, raw_line, event, api_call, tool_use, tool_result, otel_span, otel_span_attr, node_meta (title, entrypoint), rollup (= node_rollup)` per R 0.1, plus NS-n gaps from R 7.1 (restated in section 3). `call_block` = proposed child table of `api_call` that closes NS-2 (R 7.1). `hook_event`, `account_state`, `collector_run` = proposed tables that close NS-3, NS-4, NS-9 (R 7.1 "smallest fix"). `N/A` = operational state, not data (R dom=X).

Clock column: `now` = handler or shaper reads `crate::now_ms()`; `win` = window/cutoff derived from now; `budget` = 20 s wall-clock budget (non-deterministic coverage, R 7.3C); `mtime` = file mtime input (R 7.3D); `tz` = system time zone (R 7.3F); `browser` = browser `Date.now()` (R 7.3H); `ingest` = ingest-time stamp stored as a column (R 7.3E); `-` = none. Details of every clock: R 7.3.

Parity column: "NONE" = no test of any kind (R 7.2); "dispatch NONE" = engine has parity tests but the MCP dispatch arm (argument parsing, defaults, resolver wiring) has none (R 7.2).

## 1. Operation table

### 1.1 HTTP routes (48 pairs; R section 2)

| id | name | kind | inputs | contract ref | class | data sources needed | parity test today | clock | consumers (CLI/skill/UI) | card |
|---|---|---|---|---|---|---|---|---|---|---|
| H1 | `ANY /events` (SSE) | HTTP/SSE | none (any method) | R 2 H1, 5.1 | OTEL | node, rollup, event, api_call, otel_span.received_at; NS-1, NS-4 | tests/ui.rs:159; update_payload_parity.rs | now | media/index.html:387 (+ poll fallback :370) | C34 |
| H2 | `GET /api/summary` | HTTP | none | R 2 H2, 1.1, 1.4 | AGG+OTEL | node, rollup, spawn_edge, node_meta, otel_span(+attr for `efficiency`/`backgroundSpans`, NS-8); NS-1 | tests/ui.rs:95,:215; summarize/claude/codex/copilot/feed_merge parity; summary_engine.rs; card_pagination.rs | win (span window) | index.html:377 poll; bench script; no CLI | C01 |
| H3 | `GET /api/server-stats` | HTTP | none | R 2 H3 | FS | N/A (counters, fs walks) | tests/server_stats.rs; ui.rs smoke | now, mtime | cliCore.ts:263, serverControl.ts:515,570,695, setup.ts, storeAdmin.ts | C28 |
| H4 | `GET /api/embed-status` | HTTP | header `x-agentlens-viewer` | R 2 H4 | ST | N/A | tests/ui.rs:392,:329; embed_auth_parity.rs | - | external embed host only | C28 |
| H5 | `GET /api/hook-config` | HTTP | none | R 2 H5 | FS | N/A (config file) | tests/ui.rs:392; server_stats.rs | - | diagnosticsCli.ts:310; Alerts.tsx:580 | C29 |
| H6 | `POST /api/hook-config` | HTTP W | JSON patch, 8 KB cap | R 2 H6 | W+FS | N/A (config file) | tests/ui.rs:392 | - | diagnosticsCli.ts:339; Alerts.tsx:590 | C29 |
| H7 | `POST /api/clear` | HTTP W | none | R 2 H7 | W | truncates node, spans, cards, log state (all owned tables) | tests/ui.rs:392; card_reuse.rs; log_reader_parity.rs | - | index.html:186,190; diagnosticsCli.ts:657 | C31 |
| H8 | `POST /action` (`clearAll`) | HTTP W | JSON, 256 KB cap | R 2 H8 | W | truncates otel_span only | tests/ui.rs:392 | - | Settings.tsx:15; index.html:186 | C31 |
| H9 | `POST /api/statusline-samples` | HTTP W | JSON object, 512 KB | R 2 H9 | W | NS-6 (statusline store) | tests/ui.rs:1237; statusline_parity.rs | ingest | statuslineCapture.ts:68 | C32 |
| H10 | `POST /api/hook-events` | HTTP W | JSON, 512 KB | R 2 H10 | W | NS-3 (`hook_event`) | tests/ui.rs:558; hook_spool_drain.rs | ingest | hookHandlers.ts:441 | C27 |
| H11 | `GET /api/hook-events` | HTTP | `session, ev, since, until, limit` | R 2 H11 | PL | NS-3 (`hook_event`) | tests/ui.rs:558 | - | skill commands-and-options.md:29 | C27 |
| H12 | `GET /api/lifecycle-events` | HTTP | `limit, kinds, session` | R 2 H12 | PL | NS-3 (`hook_event`) | tests/ui.rs:558 | - | LifecycleTab.tsx:131 | C27 |
| H13 | `POST /api/import` | HTTP W | `{sessions[]}`, 64 MB | R 2 H13 | W | writes node, event, rollup | tests/ui.rs:484 | now | Import.tsx:134 | C31 |
| H14 | `POST /api/write-prompts-file` | HTTP W | `{agent,label,prompt}` | R 2 H14 | W+FS | N/A (file append) | tests/ui.rs:635 | now | index.html:204 | C32 |
| H15 | `POST /api/branch-dump` | HTTP W | `{slug,sessionId,dumps[]}`, 48 MB | R 2 H15 | W+FS | N/A (file write) | tests/ui.rs:635 | now | CopyBranchButton.tsx:134 | C32 |
| H16 | `GET /api/debug/codex-store-groups` | HTTP | none | R 2 H16-H20 | AGG | otel_span (names `codex.*`) | tests/ui.rs:719 | win | benches only | C33 |
| H17 | `GET /api/debug/span-attr` | HTTP | `traceId, spanId, key, fromMs` | R 2 H16-H20 | SSD | otel_span_attr (NS-8: full values) | tests/ui.rs:719 | now (default fromMs) | benches only | C33 |
| H18 | `GET /api/debug/capture-activity` | HTTP | none | R 2 H16-H20 | ST | N/A (ingest stamp) | tests/ui.rs:2205 | ingest | benches only | C29 |
| H19 | `GET /api/debug/requests` | HTTP | none | R 2 H16-H20 | ST | N/A (request ring) | tests/ui.rs:695 | now | benches only | C29 |
| H20 | `GET /api/debug/log-scan-stats` | HTTP | none | R 2 H16-H20 | ST | N/A (counters) | tests/ui.rs:392 | - | benches only | C29 |
| H21 | `GET /api/burn-status` | HTTP | none | R 2 H21 | AGG+OTEL | api_call, node, event; NS-4 (capacity, account, ttl), NS-2 (`residentBlobs`) | tests/ui.rs:845; burnmonitor/burnttl/keepwarm parity | now, win | none direct (dashboard via SSE) | C08 |
| H22 | `GET /api/burn-risk` | HTTP | none | R 2 H22 | AGG | NS-2, NS-3, last burn status | NONE (route); engine burnguard_parity.rs | now | diagnosticsCli.ts:263 | C09 |
| H23 | `POST /api/agent-gate` | HTTP | hook payload, 1 MB | R 2 H23 | AGG+W | NS-3, NS-4, transcript tail (raw_line); mutates `advisory_issued` | tests/ui.rs:939; agentgate_parity.rs | now, mtime | hookHandlers.ts:475, agentGate.ts | C09 |
| H24 | `GET /api/cache-risk-commands` | HTTP | `window, limit, kinds` | R 2 H24 | TOPN | raw_line (+file_mtime column) | tests/ui.rs:1276; cacherisk_parity.rs | now, mtime | LifecycleTab.tsx:56 | C17 |
| H25 | `GET /api/generated-file` | HTTP | `path` | R 2 H25 | FS | NS-5 (filesystem) | tests/ui.rs:1276; generated_files.rs | mtime | index.html:324; state.ts:240 | C29 |
| H26 | `GET /api/instruction-suggestions` | HTTP | `workspace` | R 2 H26-H28 | AGG | node, rollup, tool_use, loop-signal fn; NS-7 (instruction files) | tests/ui.rs:1161; instructions_parity.rs | now | no consumer found (R) | C06 |
| H27 | `GET /api/instruction-files` | HTTP | `workspace` | R 2 H26-H28 | FS | NS-7 | tests/ui.rs:1161 | - | no consumer found (R) | C06 |
| H28 | `POST /api/instructions/apply` | HTTP W | `{workspace,targetFile,appliedText,id}` | R 2 H26-H28 | W+FS | NS-7 | tests/ui.rs:1161 | now (date) | no consumer found (R) | C06 |
| H29 | `POST /api/bodies/export` | HTTP | selection criteria, 1 MB | R 2 H29-H30 | FS | NS-2 (body archive volumes) | tests/ui.rs:1083; bodyarchive_parity.rs | - | diagnosticsCli.ts:664 | C37 |
| H30 | `POST /api/bodies/purge` | HTTP W | none | R 2 H29-H30 | W+FS | NS-2 (body archive volumes) | tests/ui.rs:1083 | - | diagnosticsCli.ts:676 | C37 |
| H31 | `GET /api/collector-gaps` | HTTP | none | R 2 H31 | AGG | NS-9 (`collector_run`) | tests/ui.rs:758 | - | none direct; rides F1 and Q1 | C36 |
| H32a | `GET /api/cards/page` | HTTP | `limit` 1..200, `cursor ms:seq` | R 2 H32 | PL | node (+`seq`, NS-1), rollup | card_routes.rs:63-117; card_pagination.rs; card_store*.rs | - | none found | C02 |
| H32b | `GET /api/cards/children` | HTTP | `parentId` | R 2 H32 | PL | node, spawn_edge, rollup | card_routes.rs | - | none found | C02 |
| H32c | `GET /api/cards/by-ids` | HTTP | `ids` | R 2 H32 | PL | node, rollup | card_routes.rs | - | none found | C02 |
| H32d | `GET /api/stats/overview` | HTTP | none | R 2 H32 | AGG | node (count by source, newest root) | card_routes.rs | - | none found | C02 |
| H33 | `GET /api/composition/:sessionId` | HTTP | id, `parent` | R 2 H33-H35 | SSD | raw_line (+node ancestor chain) | ctxcomposition_parity.rs; ctxcomp_parity.rs; ui.rs:1419 | - | state.ts:280; shim index.html:333 | C12 |
| H34 | `GET /api/history/:sessionId` | HTTP | id, `parent` | R 2 H33-H35 | SSD | raw_line, api_call | ctxhistory_parity.rs; ui.rs:1451 | - | state.ts:348; index.html:350 | C13 |
| H35 | `GET /api/conversation/:sessionId` | HTTP | id, `parent` | R 2 H33-H35 | SSD | raw_line | conversation_parity.rs; ui.rs:1485 | - | TranscriptView.tsx | C14 |
| H36 | `GET /api/composition-index/:sessionId` | HTTP | id | R 2 H36-H38 | SSD | NS-2 (`call_block`), node (project map) | ui.rs:1341; rawbodyctx/ctxsession/callbodyregistry parity | now (cost) | state.ts:316 | C20 |
| H37 | `GET /api/block-content/:sid/:turn/:idx` | HTTP | `full` | R 2 H36-H38 | SSD | NS-2 (`call_block`) | ui.rs:1341 | - | ContextTab.tsx:236 | C20 |
| H38 | `GET /api/callcontext/:sid[/:req]` | HTTP | `span` | R 2 H36-H38 | SSD+W | NS-2 (`call_block`); writes account (NS-4) | ui.rs:1515; rawbodyctx_parity.rs | - | Traces.tsx:282 | C19 |
| H39 | `GET /api/timeline/:sessionId` | HTTP | id | R 2 H39 | SSD+OTEL | event, api_call, tool_use, tool_result, otel_span (graft); NS-5 | ui.rs:790,:886 | - | HistoryTab.tsx:296; index.html:315 | C03 |
| H40 | `GET /mcp` | HTTP | none | R 2 H40 | ST | N/A | tests/ui.rs:1565 | - | cliCore.ts:43,245 | C28 |
| H41 | `POST /mcp` (JSON-RPC) | HTTP | JSON-RPC, 4 MB | R 2 H41 | ST | `assets/mcp-tools.json` | tests/ui.rs:1565; mcptools_parity.rs | - | cliCore.ts callTool; setup.ts:177 | C28 |
| H42a | `GET /` | HTTP | none | R 2 H42, 5.2 | ST+OTEL | six tokens (S1-S6) | tests/ui.rs:252 (empty summary only) | now | browsers | C35 |
| H42b | `GET /index.html` | HTTP | none | R 2 H42, 5.2 | ST+OTEL | same as H42a (INFERRED split) | tests/ui.rs:252 | now | browsers | C35 |
| H43 | static assets + 404 | HTTP | path | R 2 H43 | ST | N/A (`media_dir`) | tests/ui.rs:252,:304 | - | browsers | C28 |
| H44 | OTLP ingest `/v1/traces,logs,metrics` | HTTP W | OTLP bodies (port 4318) | R 2 H44 | W | writes otel_span, otel_span_attr | tests/otlp.rs; received_at_stamp.rs | ingest | Claude Code exporters | FND-05 |

### 1.2 MCP tools (53; R section 3). All pass through H41 and the lean wrapper (R 1.4: undocumented args `verbosity`, `maxTokens`; goldens run both modes).

| id | name | kind | inputs | contract ref | class | data sources needed | parity test today | clock | consumers | card |
|---|---|---|---|---|---|---|---|---|---|---|
| Q1 | `get_recent_sessions` | MCP | `limit, agent, workspace` (substring on sessionId/userRequest) | R 3.A Q1 | AGG+OTEL | node, rollup, tool_use, node_meta; NS-9 (`collectorGaps`) | sessionreports_parity.rs:33-86; ui.rs:2078 | now | setup.ts:1374, watchCli.ts; skills | C04 |
| Q2 | `get_workspace_patterns` | MCP | `days` (`workspace` silently dropped) | R 3.A Q2 | AGG | node, rollup, tool_use | sessionreports_parity.rs:99,117; dispatch NONE | now | skill tool-cheat-sheet | C04 |
| Q3 | `find_relevant_context` | MCP | `task` | R 3.A Q3 | TOPN | node.user_request, tool_use, loop-signal fn | sessionreports_parity.rs:138,157; dispatch NONE | - | skill | C04 |
| Q4 | `get_efficiency_report` | MCP | `days` | R 3.A Q4 | AGG | node, rollup | sessionreports_parity.rs:172-205; dispatch NONE | now | skill | C04 |
| Q5 | `get_instruction_suggestions` | MCP | `workspace` | R 3.A Q5 | AGG+FS | node, rollup, tool_use; NS-7 | sessionreports_parity.rs:222,258; instructions_parity.rs; dispatch NONE | now | skill | C06 |
| Q6 | `get_session_detail` | MCP | `sessionId` | R 3.A Q6 | SSD | node, rollup, event, api_call, spawn_edge, raw_line; NS-5 | sessionreports_parity.rs:289,318; ui.rs:2118,2166 | now | skill | C05 |
| Q7 | `get_context_growth` | MCP | `sessionId` | R 3.A Q7 | SSD | event/api_call grouped by `event.turn` | spawntree_parity.rs; dispatch NONE | - | skill | C05 |
| Q8 | `get_subagent_tree` | MCP | `sessionId` | R 3.A Q8 | SSD | node, spawn_edge, rollup | spawntree_parity.rs; dispatch NONE | now | skill | C05 |
| Q9 | `get_agent_tokens` | MCP | `agentId, parentSessionId` | R 3.A Q9 | SSD+OTEL | node, spawn_edge, rollup, event; NS-6 (statusline branch) | agenttokens_parity.rs; dispatch NONE | now | watchCli.ts, diagnosticsCli.ts | C05 |
| Q10 | `get_cost_rollup` | MCP | `groupBy, windowHours, sinceIso, untilIso, subagentsOnly, parentSessionId, liveOnly, sortBy, topN` | R 3.A Q10 | AGG | node, rollup, spawn_edge | sessionreports_parity.rs:345,365; dispatch NONE | now, win | watchCli, diagnosticsCli, budgetCli; skills budget.md | C04 |
| Q11 | `predict_session_cost` | MCP | `task, subagentType, fileBytes, topK` | R 3.A Q11 | TOPN | node, rollup, tool_result bytes | sessionreports_parity.rs:394,414; dispatch NONE | now | diagnosticsCli.ts; skill budget.md | C04 |
| Q12 | `get_cost_by_cause` | MCP | `sessionId` or `days` | R 3.A Q12 | AGG | api_call GROUP BY cause columns, node | bycause_parity.rs; dispatch NONE | now, win, budget | skill | C07 |
| Q13 | `get_burn_status` | MCP | none | R 3.A Q13 | AGG+OTEL | api_call, node; NS-4 | ui.rs:1672; burnmonitor_parity.rs | now, win | attribution.ts:107, watchCli.ts, diagnosticsCli.ts | C08 |
| Q14 | `get_session_status` | MCP | `sessionId, workspace` | R 3.A Q14 | SSD+OTEL | node, rollup, api_call, event; NS-4 | ui.rs:1712 | now | skill | C08 |
| Q15 | `get_window_budget` | MCP | `accountId` | R 3.A Q15 | AGG | as Q13 | mcptools_parity.rs:190-237; ui.rs:1755 | now | skill | C08 |
| Q16 | `get_account_status` | MCP | `all` (true = -32601) | R 3.A Q16 | AGG | NS-4, api_call | mcptools_parity.rs:294,323; ui.rs:1892; all_accounts_parity.rs | now | main.ts, allAccountsCli.ts; skills | C10 |
| Q17 | `check_burn_risk` | MCP | `fanoutThreshold, spikeTokensPerMin` | R 3.A Q17 | AGG | NS-2, NS-3, NS-4 | ui.rs:1817; burnguard_parity.rs | now | diagnosticsCli.ts:269 | C09 |
| Q18 | `get_window_eta` | MCP | `account, rate_window_min` | R 3.A Q18 | AGG | api_call, node; NS-4 (`account_state`) | windoweta_parity.rs; dispatch NONE | now | budgetCli.ts:270, watchCli | C10 |
| Q19 | `get_account_burners` | MCP | `account, interval, limit` | R 3.A Q19 | TOPN | api_call, node; NS-4 | acctburners_parity.rs; dispatch NONE | now | skills | C10 |
| Q20 | `get_account_state_at` | MCP | `ts` or `iso` | R 3.A Q20 | SSD | NS-4 (`account_state`) | hogstate_parity.rs; acctstatetimeline_parity.rs; dispatch NONE | - | skill | C10 |
| Q21 | `check_cache_expiry` | MCP | `sessionId, all, project, thresholdMinutes` | R 3.A Q21 | AGG | event max ts per node, raw_line tail; NS-4 | cacheexpiry_parity.rs; dispatch NONE | now, budget | cacheExpiredCli.ts:252 | C11 |
| Q22 | `get_context_composition` | MCP | `sessionId, turn` (no parent fallback) | R 3.T Q22 | SSD | raw_line | mcptools_parity.rs:85; ctxcomposition_parity.rs; dispatch NONE | - | skills | C12 |
| Q23 | `get_context_history` | MCP | `sessionId, turn, blockId` | R 3.T Q23 | SSD | raw_line, node.model | mcptools_parity.rs:100; ctxhistory_parity.rs; inflation_parity.rs | now (price) | skill | C13 |
| Q24 | `get_conversation` | MCP | `sessionId, turn, turnFrom, turnTo` | R 3.T Q24 | SSD | raw_line | mcptools_parity.rs:118,136; conversation_parity.rs | - | diagnosticsCli.ts | C14 |
| Q25 | `get_context_inflation_report` | MCP | `sessionId` or `workspace` (cap 20) | R 3.T Q25 | TOPN | node, raw_line | inflation_parity.rs; residentcost_parity.rs; dispatch NONE | now | skill | C15 |
| Q26 | `find_context_hogs` | MCP | `scope, topN` (cap 25) | R 3.T Q26 | TOPN | raw_line, node | hogstate_parity.rs; dispatch NONE | - | skill | C15 |
| Q27 | `get_cache_break_report` | MCP | `sessionId` or `workspace` (cap 20) | R 3.T Q27 | SSD+TOPN | event/api_call (usage per turn), raw_line | cachebreakreport/cachebreak/cbverdict parity; dispatch NONE | now, budget | skill | C16 |
| Q28 | `get_cache_risk_costs` | MCP | `window, minTokens, topN, workspace, kinds` | R 3.T Q28 | TOPN | raw_line (commands), event/api_call, node | riskcosts_parity.rs; dispatch NONE | now, budget, mtime | diagnosticsCli.ts | C17 |
| Q29 | `get_skill_attribution` | MCP | `window, topN` | R 3.T Q29 | AGG | raw_line (+file_mtime) | skillattr_parity.rs; dispatch NONE | now, mtime | diagnosticsCli.ts; skills | C18 |
| Q30 | `burn_seismic` | MCP | scope, window, FDR/CFAR params | R 3.T Q30 | AGG | raw_line (already a DuckDB query) | seismicrun/files/render/stats parity; dispatch NONE | now, mtime | diagnosticsCli.ts | C18 |
| Q31 | `run_transcript_sql` | MCP | `preset, sql, sessionId, window, limit` | R 3.T Q31 | AGG | raw_line (view `transcripts`) | transcriptsql_parity.rs; dispatch NONE | win | watchCli.ts:348 | C18 |
| Q32 | `get_call_context` | MCP | `sessionId, requestId, spanId` | R 3.B Q32 | SSD+W | NS-2 (`call_block`) | mcptools_parity.rs:22; ui.rs:1625; rawbodyctx_parity.rs | - | skill | C19 |
| Q33 | `get_block_content` | MCP | `sessionId, turn, blockIndex, full` | R 3.B Q33 | SSD | NS-2 (`call_block`) | ui.rs:1946 | - | skill; ContextTab.tsx:236 | C20 |
| Q34 | `get_image_report` | MCP | `scope` | R 3.B Q34-Q36 | TOPN | NS-2, node (project map) | ctxscope/ctxsession/residentcost parity; ui.rs:2006 | now (cost) | skills | C21 |
| Q35 | `find_resident_blobs` | MCP | `scope, kind, minTokens, minResidentTurns, topN` | R 3.B Q34-Q36 | TOPN | NS-2, node | as Q34 | now | skill | C21 |
| Q36 | `query_context_blocks` | MCP | `project, sessionId, kind, model, minTokens, turnFrom, turnTo, groupBy, topN` | R 3.B Q34-Q36 | AGG | NS-2, node | as Q34 | now | skill | C21 |
| Q37 | `get_body_writers` | MCP | `window_min, active_min, limit` | R 3.B Q37 | FS | NS-10 (dir mtime scan), node | bodywriters_parity.rs | now, mtime | skill | C30 |
| Q38 | `get_cache_creation_report` | MCP | `window, groupBy, bucket, topN, format` (`cause` returns error) | R 3.B Q38-Q40 | AGG | api_call; NS-2 (composition), NS-4 (account filter) | ccreport/ccforensics parity; MCP wiring NONE | now | skills | C22 |
| Q39 | `trace_expensive_writes` | MCP | `sessionId, accountUuid, model, minCacheCreate, ..., chainDepth` | R 3.B Q38-Q40 | TOPN | api_call; NS-2 (backwardChain), NS-4 | ccforensics_parity.rs; MCP wiring NONE | now | skills | C22 |
| Q40 | `get_cache_break_gap_report` | MCP | `minCacheCreate, window` | R 3.B Q38-Q40 | AGG | api_call; NS-2 | ccforensics_parity.rs; MCP wiring NONE | now | skills | C22 |
| Q41 | `get_cache_break_timeline` | MCP | `sessionId, scope, minTokens, window, topN, format` | R 3.B Q41-Q42 | TOPN | NS-2, raw_line | cbtimeline/cbverdict/cbreport parity; MCP wiring NONE | now + private clock | diagnosticsCli.ts; skills | C23 |
| Q42 | `get_cache_break_causes` | MCP | `scope, minTokens, window, topN` | R 3.B Q41-Q42 | AGG | NS-2 | cbcauses_parity.rs; MCP wiring NONE | now + private clock | diagnosticsCli.ts | C23 |
| Q43 | `get_heartbeat_cost` | MCP | `marker, sessionId, window, fire` | R 3.B Q43 | AGG | NS-2 (request text marker) | hbcost_parity.rs; dispatch NONE | now, mtime | heartbeatCostCli.ts | C24 |
| Q44 | `get_session_burn_profile` | MCP | `sessionId, window` | R 3.B Q44 | SSD+OTEL | NS-2, node (graft of `tokensSource`) | sbprofile_parity.rs; wrapper graft NONE | now, mtime | skill | C24 |
| Q45 | `get_cache_event_log` | MCP | `mode, project, sessionId, context, limit, window, format` | R 3.B Q45 | PL | NS-2, otel_span, api_call | ccevent_parity.rs; dispatch NONE | now, tz, env | statuslineHistoryCli.ts; skills | C24 |
| Q46 | `compare_configs` | MCP | `groupBy, metric, agg, filter, rankOrder, topN` | R 3.B Q46-Q47 | AGG+W | api_call (+call_content, call_injections = NS-2); re-index write on read | forensicscompare_parity.rs + 5 more forensics parity | now (5 min staleness) | skill | C25 |
| Q47 | `run_diagnostics_sql` | MCP | `preset, sql, params, format, limit` | R 3.B Q46-Q47 | AGG+W | forensics.db tables (api_calls, call_content, call_injections) | forensicssql_parity.rs; dispatch NONE | now | diagnosticsCli.ts | C25 |
| Q48 | `investigate_burn` | MCP | `windowHours, untilIso, maxFiles` | R 3.B Q48-Q49 | AGG | NS-2, NS-3, raw_line | burnscan_parity.rs; dispatch NONE | now, mtime | ctxmapCli.ts, diagnosticsCli.ts | C26 |
| Q49 | `get_rate_limit_report` | MCP | `windowHours, maxEpisodes, maxFiles` | R 3.B Q48-Q49 | AGG | NS-2, NS-3, raw_line | ratelimit_parity.rs; dispatch NONE | now | skills | C26 |
| Q50 | `get_lifecycle_events` | MCP | `session, kinds, window, limit` | R 3.D Q50 | PL | NS-3 (`hook_event`) | mcptools_parity.rs:256; ui.rs:1858 | now (win) | diagnosticsCli.ts | C27 |
| Q51 | `get_loaded_plugin_versions` | MCP | `plugin, activeMinutes, staleOnly` | R 3.D Q51 | FS | raw_line, NS-11 (plugin cache dir) | lpv_parity.rs; dispatch NONE | mtime | diagnosticsCli.ts | C30 |
| Q52 | `get_runtime_inventory` | MCP | none | R 3.D Q52 | FS | N/A (process table) | runtimeinv_parity.rs; dispatch NONE | now | skill | C30 |
| Q53 | `get_subscription_usage` | MCP | `force, format` | R 3.D Q53 | FS | NS-11 (network), NS-4 (token, cache file) | subusage_parity.rs; subusageb_parity.rs; dispatch NONE | now, network | skills | C30 |

### 1.3 SSE frames and shell tokens (R section 5)

| id | name | kind | inputs | contract ref | class | data sources needed | parity test today | clock | consumers | card |
|---|---|---|---|---|---|---|---|---|---|---|
| F1 | `update` frame | SSE | built from summary + spans + build_id | R 5.1 F1 | AGG+OTEL | node, rollup, event (turnInputTokens), otel_span.received_at, pricing fn; NS-1, NS-9 | update_payload_parity.rs:25; ui.rs:159 | now, ingest | App.tsx:375-406; sidebarWebview.ts:352 | C34 |
| F2 | `burnStatus` frame | SSE | burn tick (4 s) | R 5.1 F2 | AGG | as H21 | NONE for emission (burn_rotation.rs:6); ui.rs:845 | now | App.tsx:407 | C08 |
| F3 | `alert` frame | SSE | burn tick new-alert id; agent-gate | R 5.1 F3 | AGG | burn alerts (H21) + NS-3 | NONE for emission; ui.rs:939 gate-origin | now | index.html:405 | C09 |
| F4 | `sessionChanged` frame | SSE | never emitted | R 5.1 F4 | PL | would need node.offset advance (INFERRED) | NONE (no producer) | - | App.tsx:412 expects it | C38 |
| S1 | `@@VIEWER_META@@` | shell | viewer role | R 5.2 | ST | viewer gate | NONE (restricted branch) | - | index.html:5 | C35 |
| S2 | `@@BASE_PATH_JSON@@` | shell | constant `""` | R 5.2 | ST | constant | tests/ui.rs:252 | - | index.html:11 | C35 |
| S3 | `@@BASE_PATH@@` (x4) | shell | constant `""` | R 5.2 | ST | constant | tests/ui.rs:252 | - | index.html:7,8,531,541 | C35 |
| S4 | `@@SESSION_SUMMARY_JSON@@` | shell | stripped summary (H2) | R 5.2 | AGG+OTEL | as H2 | NONE with non-empty summary | - | index.html:83 | C01 |
| S5 | `@@BUILD_ID_JSON@@` | shell | boot `now_ms` | R 5.2 | ST | boot stamp | tests/ui.rs:252 | ingest (boot) | index.html:86 | C34 |
| S6 | `@@SIDEBAR_INIT_JSON@@` | shell | `compute_sidebar_payload` (F1 live keys) | R 5.2 | AGG | as F1 | NONE with non-empty summary | now | index.html:540 | C34 |

### 1.4 Dashboard views (R section 6). Views are client computation over server payloads; "parity" for all of them is `src/test/browser/dashboardSmoke.test.ts` only (R 6 intro, 7.2).

| id | name | kind | inputs (server calls) | contract ref | class | data sources needed | parity test today | clock | consumers | card |
|---|---|---|---|---|---|---|---|---|---|---|
| V0 | Global derived state (`state.ts`) | view | H2/F1 sessions[] | R 6 V0 | PL | node, rollup (ships every card; pagination would change it) | smoke only | browser | all tabs | C01 |
| V1 | App chrome (`App.tsx`) | view | F1, F2, `collectorGaps` | R 6 V1 | AGG | F1 sources | smoke only | browser | - | C01 |
| V2 | Sessions tab | view | H2, H39 | R 6 V2 | SSD | node, rollup, spawn_edge, event, tool_use; NS-5 | smoke only | browser | - | C03 |
| V3 | Context tab | view | H39, H34, H33, H36 | R 6 V3 | SSD | event/api_call, raw_line, NS-2 | smoke; ctxhistory/ctxsession parity | browser | - | C12 |
| V4 | Cache tab | view | H2, H39, H33 (hydrate 25) | R 6 V4 | AGG | rollup, spawn_edge, event/api_call, raw_line | smoke; cacheBreak.test.ts | browser | - | C16 |
| V5 | History tab | view | H34, H39 | R 6 V5 | SSD | raw_line, api_call; NS-5 | smoke; ctxhistory_parity.rs | browser | - | C13 |
| V6 | Lifecycle tab | view | H12, H24 | R 6 V6 | PL | NS-3, raw_line | smoke; ui.rs:558,1276 | - | - | C27 |
| V7 | Analytics tab | view | H2 + F1 `dailyStats` | R 6 V7 | AGG | rollup, event/api_call | smoke only | browser, tz | - | C34 |
| V8 | Advisor tab | view | H2 (client suggestions) | R 6 V8 | AGG | node, rollup, tool_use | smoke only | - | - | C06 |
| V9 | Export / Import tabs | view | H2 (shim export), H13 | R 6 V9 | AGG+W | node, rollup | smoke; ui.rs:484 | browser | - | C31 |
| V10 | Help tab | view | none | R 6 V10 | ST | none | smoke | - | - | C28 |
| V11 | Alerts / Automation / Settings | view | H2, F2, H5, H6, H8 | R 6 V11 | AGG | rollup, event; NS-4 | smoke; hook-switches round trip | browser | - | C08 |
| V12 | Trace / Flow / Charts components | view | H39, H38, H35 | R 6 V12 | SSD | event, api_call, tool_use, tool_result, otel_span; NS-2, NS-5 | smoke only | browser | - | C03 |
| V13 | Live sidebar | view | F1 live keys, S6 | R 6 V13 | AGG | F1 sources | NONE | browser | - | C34 |
| V14 | Unmounted views (Agents, Cost, Flow, Tools, Insights) | view | none observable | R 6 V14 | ST | none (moot unless re-mounted) | NONE | - | - | C38 |

## 2. Implementation cards

Convention: a card is one bounded, verifiable change. Verification for every op in every op card: a golden diff (captured from the current alcore through FND-00 harness, both `verbosity` modes for MCP ops, compared byte-for-byte or key-order-for-key-order against the SQL-backed implementation), plus the new tests named per card where R 7.2 says NONE. Card sizes follow the 1-6 target except C28/C29 (unchanged-behaviour regression cards, 6 each). Function names are INFERRED proposals.

### 2.1 Foundation cards (no operation of their own; every op card depends on a subset)

| card | slug | delivers | closes | notes |
|---|---|---|---|---|
| FND-00 | golden-harness | injectable clock at `crate::now_ms()` (lib.rs:911), fixed ingest order (`seq`), unlimited 20 s budgets and scan caps, golden capture of every op in section 1 at HTTP/MCP level (R 7.3 intro: shapers already take `now`, handlers do not), a lean/full double capture | R key finding 8; R 7.3 A-C | prerequisite of every verification below |
| FND-01 | schema-core | tables `node` (+`seq`, `account_id`, `conversation_id`), `node_key`, `spawn_edge`, `spawn_result`, `node_meta` | NS-1; columns node.seq / account_id / conversation_id | R 0.1 assumptions |
| FND-02 | ingest-raw-line | `raw_line` ingest by byte offset with a GLOBAL dedupe key on `uuid`/`message.id`; `file_mtime` column | column raw_line.file_mtime; T summary items 1-6 | parser fixes listed in section 4 |
| FND-03 | ingest-derived | `event`, `api_call`, `tool_use`, `tool_result` built from `raw_line` (+turn, compaction columns, 1h split, speed, `files_changed_note`) | columns event.turn, event.compaction_*, api_call.cache_create_1h, api_call.speed, tool_use.files_changed_note | `api_call` must expose both bucket conventions (R 7.1 decision 1) |
| FND-04 | rollup-and-cost | `rollup` table/view; per-session cost computed from totals priced at `now` (not a sum of per-call cost) | R 7.1 decision 4 | pricing stays a Rust function (R 7.1 deterministic assets) |
| FND-05 | otel-ingest | `otel_span` (+`received_at`) and `otel_span_attr` (full attribute values); owns **H44** (OTLP ingest) | NS-8; column otel_span.received_at | H44 parity: otlp.rs, received_at_stamp.rs |
| FND-06 | merge-function | log-vs-OTEL merge as a function over (`node`, `otel_span`): log wins for `claude_code`, displaced `api_request` kept for the graft; `tokensSource/coverageNote/mergedFrom` stamps; 24 h span-window predicate | R 7.1 decisions 2-3 | feed_merge_parity.rs is the oracle |
| FND-07 | body-ingest | `call_block` child table of `api_call` (block kind, label, tokens, bytes, role, text, request/response linkage) | NS-2 | gates C19-C26 |
| FND-08 | hook-event | `hook_event` table + ring replacement | NS-3 | gates C09, C26, C27 |
| FND-09 | account-state | `account_state` table + `node.account_id` fill + capacity/ttl config as deterministic asset | NS-4 | gates C08, C09, C10, C11 |
| FND-10 | collector-run | `collector_run` table | NS-9 | gates C36 |
| FND-11 | statusline-decision | decide keep-out-of-scope vs `statusline_sample` table | NS-6 | field is never populated live (R 1.2); default = stays outside DuckDB |

### 2.2 Operation cards

| card | slug | operations | shared function(s) introduced (INFERRED) | prerequisites | verification |
|---|---|---|---|---|---|
| C01 | summary-sessions | H2, S4, V0, V1 | `sql_summary_sessions(now)` (ordering by start desc then `seq`; strip-by-projection; `efficiency`/`backgroundSpans` from `otel_span_attr`) | FND-00..06 | golden diff H2 and S4 (same object); NEW: shell with non-empty summary (R 7.2 NONE); key-order test already `ui.rs:2235` |
| C02 | card-pages | H32a, H32b, H32c, H32d | `sql_cards_page(cursor,limit)`, `sql_cards_children`, `sql_cards_by_ids`, `sql_cards_stats` (raw log cards, NO merge stamps) | FND-00, 01, 03, 04 | golden diff of the four routes incl. 400 messages and `nextCursor`; existing card_routes.rs/card_pagination.rs must stay green |
| C03 | session-timeline-detail | H39, V2, V12 | `sql_session_timeline(id)` = event + api_call + tool rows + graft of displaced OTEL `api_request` entries; `fileOps` from tool bytes | FND-00..06 | golden diff H39 (incl. cold-card case that today reparses, ui.rs:886); generatedFiles stays outside (NS-5); smoke test for V2/V12 |
| C04 | session-reports | Q1, Q2, Q3, Q4, Q10, Q11 | `sql_session_pool(filters)`, `session_cost_from_totals(card, now)` reuse, percentile helper | FND-00..06 | golden diff both lean modes; NEW dispatch tests for Q2, Q3, Q4, Q10, Q11; keep quirks (workspace dropped Q2-Q4, Q1 substring match, `slice` semantics) |
| C05 | session-detail-tree | Q6, Q7, Q8, Q9 | `sql_turn_growth(id)`, `sql_sub_agent_children(id)`, `sql_spawn_rollup(id)` | FND-00..04, 06 | golden diff; NEW dispatch tests Q7, Q8, Q9; Q6 generatedFiles stays FS (NS-5); Q9 statusline branch NS-6 (stays null) |
| C06 | instruction-advice | Q5, H26, H27, H28, V8 | `sql_instruction_inputs(workspace)` feeding the existing `instruction_advisor` | FND-00..04 | golden diff Q5/H26; H27/H28 unchanged (NS-7 stays outside); NEW dispatch test Q5 |
| C07 | cost-by-cause | Q12 | `sql_cost_by_cause(session|days)` GROUP BY on api_call cause columns | FND-00, 01, 03, 04 | golden diff with the 50-session cap and 20 s budget removed in the golden run; NEW dispatch test; keep reconciliation block |
| C08 | burn-monitor | H21, Q13, Q14, Q15, F2, V11 | `sql_burn_events(window)`, `sql_burn_status(now)` (weights 1/5/0.1/1.25, NOT 1h-aware, R key finding 3) | FND-00, 01, 03, 04, 09 | golden diff H21 vs Q13 (enriched vs labelled only); NEW: F2 emission test (R 7.2 NONE), dispatch tests Q14 resolution order |
| C09 | burn-risk-gate | H22, H23, Q17, F3 | `sql_burn_risk_inputs()`; agent-gate stays stateful Rust | C08, FND-07, FND-08 | NEW: H22 route test and F3 emission test (R 7.2 NONE); existing ui.rs:939/1817 stay green |
| C10 | account-windows | Q16, Q18, Q19, Q20 | `sql_window_events(account, window)`, `account_state_at(ts)` | C08, FND-09 | golden diff; NEW dispatch tests Q18-Q20; Q16 `all:true` stays -32601 |
| C11 | cache-expiry | Q21 | `sql_last_request_per_node()` (event max ts; transcript tail via `raw_line`) | FND-00, 02, 03, 09 | golden diff incl. `unknown` verdict case; NEW dispatch test; 20 s budget removed in golden run |
| C12 | context-composition | Q22, H33, V3 | `sql_context_composition(id, parent?)` over `raw_line` (estimator stays Rust) | FND-00, 02 | golden diff; keep Q22 no-parent-fallback vs H33 parent fallback; NEW dispatch test Q22 |
| C13 | context-history | Q23, H34, V5 | `sql_context_history(id, parent?)` (history `usage.input` is cache-INCLUSIVE) | FND-00, 02, 03 | golden diff of the three Q23 shapes + H34; NEW dispatch test Q23 |
| C14 | conversation | Q24, H35 | `sql_conversation(id, turn range)` | FND-00, 02 | golden diff all three Q24 shapes (range cap 20, summary cap 500); NEW dispatch test Q24 |
| C15 | context-scans | Q25, Q26 | `sql_composition_aggregate(pool)` | C12 | golden diff with caps 20/25 lifted for goldens only; NEW dispatch tests Q25, Q26 |
| C16 | cache-break-report | Q27, V4 | `sql_cache_break_inputs(id)` feeding `cache_break.rs` | C12, FND-03 | golden diff; NEW dispatch test Q27; decide fate of TS duplicates (R key finding 9) |
| C17 | cache-risk-commands | H24, Q28 | `sql_cache_risk_commands(window)` over `raw_line` (needs `file_mtime`) | FND-02, 03 | golden diff H24 and Q28; NEW dispatch test Q28 |
| C18 | transcript-sql | Q29, Q30, Q31 | `raw_line` exposed as the `transcripts` view (replaces `read_ndjson_auto` glob) | FND-02 | golden diff of every preset; Q30 seismic report text; NEW dispatch tests Q29-Q31 |
| C19 | call-context | H38, Q32 | `sql_call_context(sid, request|span)` over `call_block` | FND-07, 09 | golden diff incl. "not captured" messages; account side effect (NS-4) kept or dropped by decision; existing ui.rs:1515,1625 |
| C20 | composition-index-blocks | H36, H37, Q33 | `sql_composition_summary(sid)`, `sql_block_content(sid,turn,idx,full)` | FND-07 | golden diff incl. 400 bad-id and image-never-ships-bytes; ui.rs:1341,1946 |
| C21 | scoped-composition | Q34, Q35, Q36 | `sql_scope_pool(project)` + composition aggregates | C20 | golden diff; coverage block; ui.rs:2006 |
| C22 | cache-creation-forensics | Q38, Q39, Q40 | `sql_cache_creation_groups(...)`, `sql_expensive_writes(...)` over `api_call` (+ `call_block` for composition/backwardChain) | FND-03, 07, 09 | golden diff with `format=json`; NEW MCP wiring tests (R 7.2 NONE); `groupBy:"cause"` error preserved |
| C23 | cache-break-timeline | Q41, Q42 | `sql_cache_break_events(window)`; private clocks (R 7.3C) replaced by the injected clock | FND-00, 07, 02 | golden diff; NEW MCP wiring tests |
| C24 | call-forensics-misc | Q43, Q44, Q45 | `sql_heartbeat_fires(marker)`, `sql_session_burn_profile(id)`, `sql_cache_event_log(mode)` | FND-07, 05, 03 | golden diff; Q45 pinned with fixed time zone and env (R 7.3F-G); NEW dispatch tests |
| C25 | forensics-db | Q46, Q47 | native views replacing `forensics.db` (`api_calls`, `call_content`, `call_injections`); `ensure_fresh_index` write-on-read removed | FND-03, 07 | golden diff of every preset; existing forensics*_parity.rs must stay green; NEW dispatch tests |
| C26 | burn-investigation | Q48, Q49 | `sql_billed_usage_by_hour_model(window)`; causing-call join over `raw_line` | FND-02, 03, 07, 08 | golden diff; NEW dispatch tests |
| C27 | lifecycle-hooks | H10, H11, H12, Q50, V6 | `sql_hook_events(filters)`, `sql_lifecycle_events(...)` | FND-08 | golden diff; ui.rs:558,1858 stay green |
| C28 | http-infra | H3, H4, H40, H41, H43, V10 | none (unchanged); only `tools/list`/`tools/call` dispatch now routes to SQL functions | FND-00 | regression: existing tests unchanged and green; H3 `store`/`spans` counters re-pointed (INFERRED) |
| C29 | debug-config | H5, H6, H18, H19, H20, H25 | none (unchanged; H25 generated-file stays FS, NS-5) | FND-00 | regression: existing tests green |
| C30 | host-introspection | Q37, Q51, Q52, Q53 | none for Q52/Q53 (external, NS-11); Q37 `sql_body_writers` joins NS-10 dir scan with `node` | FND-01 | regression goldens with fixture directories; Q51 needs `raw_line` + plugin cache dir fixture |
| C31 | clear-import | H7, H8, H13, V9 | `sql_clear_all()`, `sql_clear_spans()`, `sql_import_sessions()` (TRUNCATE/INSERT) | FND-01, 03, 04, 05 | golden diff of H13 counts; NEW: assert H7 truncates every owned table, H8 only `otel_span` |
| C32 | file-writers-statusline | H9, H14, H15 | none (unchanged file writers); H9 per FND-11 | FND-11 | regression: ui.rs:635,1237 |
| C33 | otel-debug | H16, H17 | `sql_codex_trace_ids()`, `sql_span_attr(traceId,spanId,key)` | FND-05 | golden diff; ui.rs:719 |
| C34 | sse-update | H1, F1, V7, V13, S5, S6 | `sql_sidebar(now)`, `sql_daily_stats()` (UTC days, `costUsd` 0, `totalTokens` input-only), `sql_current_session()` | C01, C04 | golden diff of the F1 frame (update_payload_parity.rs oracle with pinned clock); keep `latestSession` = OLDEST card quirk |
| C35 | shell | H42a, H42b, S1, S2, S3 | none (token substitution unchanged) | C01, C34 | NEW test with non-empty summary and Restricted viewer (R 7.2 NONE) |
| C36 | collector-gaps | H31 | `sql_collector_gaps()` over `collector_run` (>= 15 s gap rule) | FND-10 | golden diff; ui.rs:758 |
| C37 | body-archive-admin | H29, H30 | none (archive volumes stay outside DuckDB) | FND-07 | regression: ui.rs:1083, bodyarchive_parity.rs |
| C38 | dead-surface-decisions | F4, V14 | none; decision card: implement `sessionChanged` or delete dashboard handler; keep or remove five unmounted views | C01 | decision recorded in the card; if kept, NEW test for emission |

Card count: 38 operation cards + 12 foundation cards (FND-00..FND-11); operations covered: 126 (H44 is owned by FND-05, the other 125 by C01-C38). Cards C28, C29 have 6 operations but change no behaviour.

## 3. Gap list: every NS-n and column gap -> closing card

| gap | what | closed by | or stays outside DuckDB |
|---|---|---|---|
| NS-1 | `cards.seq` ingest order | FND-01 (`node.seq`), pinned by FND-00 | - |
| NS-2 | raw API bodies / `CallBodyRegistry` | FND-07 (`call_block`) | body archive volumes (H29/H30, C37) stay outside: file-level admin |
| NS-3 | hook-event store | FND-08 (`hook_event`) | - |
| NS-4 | account / plan / TTL / capacity / `account-state.ndjson` | FND-09 (`account_state`, `node.account_id`) | keychain/OAuth reads (Q53) and CC settings env stay outside: secrets and external state |
| NS-5 | `generatedFiles` / scratch tree / file contents | none | stays outside DuckDB: depends on the live filesystem (R 7.1), unless snapshotted at ingest (decision card needed, INFERRED) |
| NS-6 | statusline sample store | FND-11 (decision) | default stays outside; field never populated live (R 1.2, Q14) |
| NS-7 | instruction files on disk | none | stays outside DuckDB: filesystem (H27/H28, Q5 inputs) |
| NS-8 | OTEL attribute payload text/length | FND-05 (`otel_span_attr` with full values) | - |
| NS-9 | collector lifecycle runs | FND-10 (`collector_run`) | not derivable from `otel_span.received_at` gaps (R 7.1) |
| NS-10 | directory scans by mtime/size | none | stays outside DuckDB: operational (Q37, H3 `bodies`) |
| NS-11 | process table, plugin cache, `claude --version`, usage endpoint | none | stays outside DuckDB: external (Q51-Q53) |
| col node.conversation_id | codex.rs:695 | FND-01 | - |
| col node.seq | NS-1 | FND-01 | - |
| col node.account_id | NS-4 | FND-01 + FND-09 | - |
| col api_call.speed | `speedBlendedCostUsd` | FND-03 | - |
| col api_call.cache_create_1h | `cacheCreate1hTokens` | FND-03 | - |
| col event.turn | Q7, per-turn growth | FND-03 | - |
| col event.compaction_trigger/pre_tokens/post_tokens | compaction entries | FND-03 | - |
| col tool_use.files_changed_note | claude.rs:716 | FND-03 | - |
| col otel_span.received_at | `isActive`, `lastActivityMs` | FND-05 | - |
| col raw_line.file_mtime | window filters H24, Q28-Q31 | FND-02 | - |
| contract decisions R 7.1 (1-5) | two bucket conventions; 24 h span window; merge as function; cost from totals; client duplicates of server logic | FND-03 (1), FND-06 (2, 3), FND-04 (4), C16/C06/C34 (5, INFERRED mapping) | - |

## 4. Operations whose output changes by design (seed of CONTRACT-DELTA.md)

Sources: T for the parser bugs, R for the contract changes. Affected-op lists are INFERRED from which ops read the changed field.

| # | change | why (evidence) | operations affected |
|---|---|---|---|
| D1 | subagent usage keyed by `message.id`, LAST (max) row wins instead of first row | T Q2: in subagent files 1,736 of 1,876 repeated ids differ and output_tokens grows; first-row rule undercounts ~95% of last.out (lib.rs `on_entry`) | every op that reads subagent token totals or cost: H2, H32a-d, Q1, Q4, Q6, Q8, Q9, Q10, Q11, Q12, H21, Q13, Q14, F1, V2, V4, V7 |
| D2 | sibling subagent files deduped on a global `uuid`/`message.id` key (today double counted) | T summary 4: 81,766 shared head uuids in 1,134 sibling file groups | same set as D1, plus Q8 `spawnRollup` |
| D3 | workflow subagent files (`subagents/workflows/wf_<id>/agent-*.jsonl`, 3,137 files) get a `parent_session_id` | T Q5: lib.rs L1341-1356 matches neither the worktree nor the `subagents` rule, so no parent is set | H32b (children), Q8, Q9, Q10 (`subagentsOnly`, `parentSessionId`), V2, V4 `spawnRollup`, session counts in Q2/Q4, F1 `sessionCount` |
| D4 | `journal.jsonl` (112 workflow journals) and `*.orphaned-*.jsonl` files skipped by discovery | T Q5/Q16: both match the `jsonl` extension in `collect_jsonl_files` and are ingested as sessions today | H2 session list, H32a-d, Q1, Q2, Q4, Q10, F1 `sessionCount`/`agentSources`, V0 |
| D5 | timelines uncapped, not demoted: `timelineTruncatedCount`, `timelineRetainedBytes`, `demote_cold_timelines` retire | R 1.2, F1 note: `turnInputTokens` is retention-dependent today | F1 `currentSession.turnInputTokens`, S6, V13, H39, V2, Q7 |
| D6 | paging fields added; shipping every card replaced by a page | R V0: pagination is the largest contract change for the UI; H32 cursor shape exists | H2, H1/F1 `sessionSummary`, S4, V0, V1 |
| D7 | reads that write removed: no reparse-on-GET, no `ensure_fresh_index` re-index | R key finding 7 | H39, Q46, Q47 (and H38/Q32 account recording, by decision) |
| D8 | wall-clock budgets and scan caps removed/changed (20 s; pools 20/25/50) | R key finding 8: coverage varies run to run today | Q12, Q21, Q25, Q26, Q27, Q28 (`coverage` blocks change) |
| D9 | compaction modelled (`compact_boundary`, `isCompactSummary`, `logicalParentUuid`) | T Q4: parser does not handle them; optional (INFERRED: a decision, not a bug fix required for cost) | Q24 `compactions`, Q23, H35, V3 |
| D10 | `tokensSource:"merged"` and `stamp_identity_merge` (no live caller) dropped or kept by decision | R 1.1 | H2, Q1, Q10, Q9, Q14, Q44 |

Quirks goldens must KEEP (not deltas; R key finding 5): `get_recent_sessions.workspace` matches sessionId/userRequest; `workspace` dropped by Q2-Q4; Q22-Q24 omit the ancestor fallback that H33-H35 apply; `latestSession` in `update.sidebar` is the OLDEST card; `dailyStats.totalTokens` input-only and `costUsd` always 0; `/api/cards/*` has no merge stamps; burn weights ignore the 1h write tier.
