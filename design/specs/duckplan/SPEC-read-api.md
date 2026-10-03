---
title: DuckDB-index redesign - read API (every operation is a call to a SQL function over the index, bounded memory)
status: draft (revision 1 of the fact-check; R2/E7 pending for the items marked OPEN-R11, OPEN-R12)
scope: project
sources: SPEC-operation-catalog.md (CAT); SPEC-schema.md (SCH); docs_dev/duckplan-decisions.md (D) and duckplan-decisions-r1.md (R1, wins on conflict); reports/DUCKPLAN/20261003_185312+0200-e4-tree-paging.md (E4); 20261003_185422+0200-e2-rollup.md (E2); 20261003_190033+0200-e3-dedup.md (E3); 20261003_192823+0200-duckdb-capabilities.md (CAP); 20261003_165118+0200-concurrency-and-flaws.md (CF, hazards H9 H11 H13 H17 H19 H20 H21)
---

# Read API for the alcore DuckDB index

Convention: DECIDED = a decision log entry or a report decided it (cited). OPEN = not decided; the named report/spec will decide. INFERRED = this spec's own proposal. Function names are the INFERRED names from CAT section 2.2 (prefix `sql_` dropped in the route name). All write operations (CAT: H6-H10, H13-H15, H23, H28, H30, H44, `sql_clear_*`, `sql_import_sessions`) are OUT of scope here (write-side spec); they only appear where a read function interacts with them.

Table names follow SCH (the schema spec), not the earlier CAT sketch: there is NO table `raw_line`; raw content is read through the table macro `raw_lines(file_id, gen, from_off, to_off)` (over `raw_stage` + `raw_index` + Parquet parts, SCH 4.7); reads of nodes go through the view `node_visible` (SCH 4.7), never `node`.

## 0. Cross-cutting read rules (apply to every function of section 2)

### 0.1 Engine prerequisites (D-ENG-1, R1-ENG1, D-ENG-10, D-14)
- The duckdb crate features `json` and `parquet` are enabled STATICALLY. Every read function that uses `to_json`, `json_extract*`, the `payload` column of `hook_event`, `read_parquet` (inside `raw_lines`) or `read_ndjson_auto` depends on them (CAP 16: without the feature they autoload from the network and, with autoload off, fail with a Catalog Error). `autoinstall_known_extensions=false; autoload_known_extensions=false` are set only AFTER every DuckDB instance of the process was verified to work with the static features (R1-ENG1: transcript_sql, bodies Parquet COPY included); a missing feature then fails at startup, never at the first request.
- No `icu`. No `SET TimeZone`, no `date_trunc`/`strftime` of a local day, no TIMESTAMPTZ in any query (D-14). Bucketing is in Rust (section 7).
- Output typing for any function whose result goes through `to_json` (D-ENG-10): counts are BIGINT; DOUBLE only for values < 1e16; never FLOAT, DECIMAL, NaN or Infinity; timestamps are epoch-ms BIGINT (never TIMESTAMP/DATE); never HUGEINT in an output column (`api_call.message_id` is HUGEINT: output `message_id_text`; the HUGEINT is allowed only inside an opaque cursor). INFERRED, not measured in the reports: `sum()` of a BIGINT column returns HUGEINT in DuckDB, so every aggregate in a function body is wrapped in `CAST(... AS BIGINT)` (and `avg` yields DOUBLE, checked against the 1e16 bound); a golden diff guards every function (D-ENG-10, T1).
- Cost values are priced in Rust from token buckets at `now` (SCH: cost is not stored); functions return buckets, not dollars.

### 0.2 Visibility: which rows each function reads
Every read goes through one of these classes; the VIS column of section 2 names it.
- `RU` = node-level facts through `node_visible` and `node_rollup` (numbers are the in-place per-batch totals, D-3).
- `DISP` = display rows (`event`, `tool_use`, `tool_result`, `call_block`): ONLY rows of the current generation, i.e. `JOIN file f ON f.file_id = t.file_id AND f.gen = t.gen` (R1-D4: display rows filter `gen = file.gen`; zero superseded files in the corpus today, D-DAT-1). The surviving direction after the final review is that ONLY display rows are gen-filtered: OPEN-R12 (pending R2/E7).
- `API` = `api_call` rows: NEVER gen-filtered (unique per message, `nk` fixed at first ingest, SCH 4.4). Window and node-scoped scans alike. This is the likely direction recorded in OPEN-R12; if R2 decides otherwise only the `API` rows of node-scoped functions (F08, F12 with `id`, F23, F34) change.
- `LINES` = `raw_lines(file_id, gen, ...)` of the CURRENT gen of the node's file only (`gen = file.gen`).
- `ARCH` = `raw_lines` of the generations OLDER than `file.gen` (the archived-lines view, F48, R1-D4: pruned lines stay viewable, nothing is lost).
- `OTEL`/`SIDE` = `otel_span*`, `hook_event`, `account_*`, `collector_run`, `call_block` metadata: not gen-scoped.
- `FS` = no stored data.
- Clear semantics (OPEN-R11): R1-D10 proposed a clear watermark that every read applies; the final review rejected adding a predicate to every read and clear is expected to keep today's meaning (drop OTEL spans, rebuild the derived tables). Therefore NO function carries a clear predicate in this revision: every function reads exactly the data the current index epoch holds (a clear replaces the derived tables, so "post-clear" holds by construction). The single seam if R2 decides otherwise is the view `node_visible` plus one macro `clear_floor()` (returns 0 today) used as `ts_ms >= clear_floor()` in the `API`/`DISP` scans; no function body is to be copied-and-edited.
- Node identity (R1-D5: `(dev, inode)` vs path) is OPEN pending R2; read functions are keyed on `nk` and `session_id` only and do not depend on it.

### 0.3 Row-bound classes (every function declares one; the declared bound is enforced, section 8)
- PAGE: at most `limit` rows, default 50, max 200 (`limit+1` read for the has-more probe).
- TOPN(N): at most N rows, N a per-function constant or capped parameter; response carries `{top_n: N, truncated: bool}`.
- ONE: a single row/object.
- WIN: window aggregate; result is O(groups), `LIMIT`-capped, the scan is windowed on `ts_ms`; Rust folds one row at a time.
- SES: rows of ONE node (session). The row count is not bounded by a constant (one session can hold tens of thousands of lines; largest corpus line 4.4 MiB, D-DAT-7) but Rust memory is O(1): iterator or streaming fold only. The `/api/q` route pages SES lists with cursor `byte_off`, `limit` default 500, max 2000 (INFERRED); legacy adapters iterate the whole session.
- USQL: user SQL / preset, `LIMIT n+1` wrap, default 100, max 10000.

## 1. Route surface

### 1.1 Generic route (INFERRED)
`GET /api/q/:name?<typed params>` runs allowlisted function `:name` and returns `{ "v": <i64>, "boot_id": "...", "clear_epoch": <i64>, "complete": bool, "backfill": {files_done, files_total, bytes_done}, "data": <function output> }` (the last two per CF H18; `complete=false` while backfill runs). `v` is `meta.data_version` (SCH 4.1: a counter that never decreases across restart, prune or clear, H17/H28), read in the same read transaction as the data, never in a separate statement (CF H9). `POST /api/q/:name` with a JSON body is accepted only for functions whose parameter list exceeds URL limits (Q31/Q47 `sql`, Q46 `filter`), same contract.
- Allowlist: a static Rust table `name -> FnSpec{ params: [ParamSpec{name, type, required, default, min, max}], lane: interactive|heavy, deadline_ms, row_bound, vis, method }`. A name not in the table is 404 `{"error":{"code":"unknown_function"}}`. `vis` is the section 0.2 code. No SQL text from the client ever reaches DuckDB except Q31 `run_transcript_sql` / Q47 `run_diagnostics_sql` (CAT C18/C25: presets plus user SQL, heavy lane, with the `transcripts`/forensics views). Read-only enforcement of user SQL is OPEN-R5 and is NOT achievable by simply calling the connection read-only: `try_clone` connections share the writer's Database instance, whose access mode is read-write, and CAP verified neither an `access_mode` per clone nor an `interrupt` (INFERRED). Candidates (bench + security card): statement allowlist by parsing, or a separate read-only instance over a checkpointed copy (costs memory, counted in section 5).
- Typed params: `i64`, `f64`, `bool`, `str` (max 4 KB), `id` (session/node id, validated against the id grammar of CAT C20 400 case), `enum`, `epoch_ms`, `window` (`5h|7d|24h|<n>h|<n>d` parsed to a ms span in Rust), `cursor` (opaque, section 3), `tz` (IANA name, section 7). Unknown param = 400; missing required = 400; out of range = 400 (never clamped silently, except where the existing contract clamps: those caps are kept by the adapter, section 1.3).
- Error shape: `{"error":{"code":"bad_param|unknown_function|not_found|cursor_expired|deadline|overloaded|backfill_incomplete|internal","message":"...","param":"<name?>"}}`. Status: 400, 404, 410 (`cursor_expired`, a cursor minted under another `clear_epoch`), 408 (deadline), 503 (`overloaded`, with `Retry-After`), 500. DuckDB error text is logged, never returned verbatim (INFERRED).

### 1.2 MCP and CLI mapping (INFERRED)
- MCP: each of the 53 tools keeps its schema in `assets/mcp-tools.json` (CAT H41). `tools/call` dispatch becomes `arg-parse (existing) -> FnSpec params -> function -> existing shaper`. The lean wrapper (`verbosity`, `maxTokens`) stays after the shaper, unchanged.
- CLI: the existing CLI keeps calling `/mcp` (cliCore.ts callTool) and the existing routes. `agentlenspro <tool>` needs no change. A new generic `agentlenspro q <name> --param v` calling `/api/q/:name` is OPEN (not required by any operation; do only if the golden harness needs it).

### 1.3 Existing contracts stay exact, except the decided fixes (D-12)
Every existing route and tool is a THIN ADAPTER: parse its own params, call one or more functions of section 2, run the existing Rust shaper (estimator, pricing, merge stamps, key order) over the returned rows, and emit the exact old bytes. The function layer returns rows/columns only; contract shaping (caps such as 20/25/50, `slice` semantics, 400 messages) lives in the adapter, not in SQL. Goldens compare everything exactly EXCEPT the deliberate deltas: CAT section 4 D1-D10 and the four D-12 fixes below. The CAT list of "quirks goldens must KEEP" is superseded where it conflicts with D-12 (CAT still lists three of the four as kept; it is to be corrected by the contract-delta card):
- `latestSession` is the NEWEST card (F46), no longer the oldest.
- `dailyStats` is no longer input-only with `costUsd` 0: F45 returns every token bucket per day (and model) so Rust prices them; the exact new fields are fixed by the contract-delta card (INFERRED).
- Burn weights include the 1h cache-write tier: F13/F16/F32 return `cache_create_5m`, `cache_create_1h` and the count of calls that carry the split (NULL never means 0, SCH 4.4); the weights stay in Rust.
- The `workspace` filter of Q2-Q4 is honoured by F07.
Per R1-D12 each of these four needs an effects consumer sweep (an EHT item for every CLI/skill parser that reads the changed field). Quirks that stay: Q1 `workspace` substring match on sessionId/userRequest; Q22-Q24 omit the ancestor fallback that H33-H35 apply; `/api/cards/*` carry no merge stamps. `/api/q/*` is additive and has no legacy contract.

## 2. Function catalog

Column legend: A = args; SQL = tables/joins/filters/order/limit/cursor; OUT = output columns; BOUND = class of section 0.3 plus the numeric cap; VIS = section 0.2 code; CX = complexity; M = candidate methods for SPEC-method-bench (P = prepared SQL + Rust row mapping; MAC = SQL macro; VT = Rust VTab/table function, viable per D-ENG-11; J = `to_json`/DuckDB-side JSON under the section 0.1 typing rules; S = serde in Rust). The method is NOT decided here: SPEC-method-bench picks, lowest RSS then lowest CPU, ties to the simplest (D-15, OPEN-R1). Tables are the SCH ones (`node`, `node_key`, `node_meta`, `node_rollup`, `root_cache`, `spawn_edge`, `spawn_result`, `event`, `api_call`, `tool_use`, `tool_result`, `otel_span`, `otel_span_attr`, `account_map`, `account_state`, `call_block`, `hook_event`, `collector_run`, `ingest_batch`, `ingest_batch_root`, `file`, `meta`, `legacy_card`).

### 2.1 Lists, trees, summary (E4, E2, D-3, D-5 DECIDED)

| id | function | A | SQL sketch | OUT | BOUND | VIS | CX / notes | M |
|---|---|---|---|---|---|---|---|---|
| F01 | `summary_sessions` (C01: H2, S4, V0, V1) | `now`, `cursor?`, `limit` | roots (`root_cache` rows with `nk = root_nk`) JOIN `node_visible` JOIN `node_rollup`, ordered `(created_ms DESC, nk DESC)`; title/user_request/workspace/model from `node_meta` by `arg_min`/`arg_max`; `efficiency`/`backgroundSpans` from `otel_span_attr` for the page's nks only; strip-by-projection | one card per row, same fields as old H2 session | PAGE 50 (max 200). D6: the old "ship every card" becomes a page; OPEN-R4 whether H2 keeps a legacy `?all=1` | RU+OTEL | E4 variant C: root page p50/p95 4.3/12.9 ms (Python harness, created_ms fell back to mtime for 9,912 untimestamped files; D-DAT-6 instead does NOT list them) | P, VT, J |
| F02 | `cards_page` (C02: H32a) | `limit` 1..200, `cursor` | `SELECT ... FROM root_cache rc JOIN node_visible n ON n.nk = rc.nk JOIN node_rollup r ON r.nk = rc.nk WHERE rc.nk = rc.root_nk AND (n.created_ms, n.nk) < (c_ms, c_nk) ORDER BY n.created_ms DESC, n.nk DESC LIMIT limit+1` (`created_ms` lives on `node`, not on `root_cache`, SCH 4.3) | card cols, `next_cursor` | PAGE 50 (max 200) | RU | DECIDED cursor `(created_ms DESC, nk)`, NOT last_active (E4) | P, MAC |
| F03 | `cards_children` (C02: H32b) | `parent_nk` | `v_spawn_link` / `root_cache` children of one root JOIN `node_rollup`; order `(created_ms, nk)` | card cols | TOPN 500 + `truncated` (decided here, INFERRED: E4 children p95 3.2 ms at ~1 child avg) | RU | indexed-free lookup; children of one node | P |
| F04 | `cards_by_ids` (C02: H32c) | `ids[]` <= 200 | `node_visible` JOIN `node_rollup` WHERE `nk IN (?)` | card cols | TOPN 200 | RU | point lookups | P |
| F05 | `cards_stats` (C02: H32d) | - | `count(*) GROUP BY source`, `max(created_ms)` over `node_visible` | counts, newest root | ONE | RU | O(nodes ~40k) scan of narrow columns; OPEN: one-row `stats` table if > 20 ms | P, MAC |
| F06 | `session_timeline` (C03: H39, V2, V12) | `id` | `event`, `api_call` (via `event.message_id`), `tool_use`, `tool_result` WHERE `nk = ?` ORDER BY `(byte_off)` (single file per node; `(ts_ms, file_id, byte_off)` across files, SCH 4.4); plus displaced OTEL `api_request` graft (`otel_span` rows for this nk from FND-06) | timeline entries | SES (D5: no demotion), streamed, section 4.5; `/api/q` pages by `byte_off` | DISP+API+OTEL | O(rows of session) | P, VT, J |
| F07 | `session_pool` (C04: Q1,Q2,Q3,Q4,Q10,Q11) | filter struct (`agent`, `workspace`, `window`, `limit`, `sortBy`) | `node_visible` JOIN `node_rollup` JOIN `node_meta` WHERE filters ORDER BY <sort> LIMIT n; Q3 token match on the `user_request` meta row via `ILIKE`; Q2 loop-signal over `tool_use` GROUP BY; Q4/Q2/Q3 honour `workspace` (D-12) | rows for the existing shapers | TOPN: adapter keeps today's per-tool caps; pool cap N=2000 OPEN (golden diff) | RU+DISP (loop signal) | E2: chosen option A_nopk Q1 page-50 p95 4.1 ms idle / 6.4 ms during ingest at 60k sessions (other rollup options 4-29 ms); ILIKE over `node_meta` and the loop-signal GROUP BY were NOT measured. Q11 `predict_session_cost` also needs `tool_result` bytes: not covered by this function, OPEN-R13 | P, MAC |
| F08 | `turn_growth` (C05: Q7) | `id` | `api_call` JOIN `event` GROUP BY `event.turn` for one nk | turn, input, cache, output (BIGINT) | SES (turns of one session) | API+DISP | O(session) | P |
| F09 | `sub_agent_children` (C05: Q8) | `id` | `v_spawn_link` + `node_rollup` | per-child rollup | TOPN 500 + `truncated` (as F03) | RU | | P |
| F10 | `spawn_rollup` (C05: Q8,Q9) | `id` | recursive CTE over `spawn_edge` (depth cap 16, INFERRED; E4: path-derived parents are depth 1 in the corpus), SUM of rollups | one object | ONE | RU | O(descendants) | P, VT |
| F11 | `instruction_inputs` (C06: Q5,H26) | `workspace` | `node_rollup` JOIN `node_meta`(workspace) JOIN `tool_use` WHERE workspace = ? | rows feeding `instruction_advisor` | TOPN 5000, iterator | RU+DISP | | P |
| F12 | `cost_by_cause` (C07: Q12) | `id` or `window` | `api_call` GROUP BY the cause columns, optionally JOIN `node` | cause, token buckets (BIGINT) | WIN: O(causes) | API | E2 measured a 7-day top-100 scan of `api_call` (p50 8-12 ms idle, p95 up to 57 ms during ingest for one option) on 1M rows inserted in `ts` order; NO cause GROUP BY was measured and `api_call` has only `cache_break_cause` (SCH OPEN-O7): the cause columns of Q12 are not specified; backfill inserts old data late, which can defeat zonemap pruning on `ts_ms` (OPEN-R10) | P, MAC |

### 2.2 Burn, accounts, cache (windowed scans; E2/D-3: no per-window rollup, windowed top-N scan of `api_call`)

| id | function | A | SQL sketch | OUT | BOUND | VIS | CX / notes | M |
|---|---|---|---|---|---|---|---|---|
| F13 | `burn_events` (C08) | `window_ms`, `now` | `api_call` WHERE `ts_ms >= now-window`, aggregated by (minute, model, account) with `cache_create_5m`, `cache_create_1h`, `n_1h_known` (D-12: weights incl. 1h tier stay in Rust) | per-minute aggregates (BIGINT) | WIN: O(window minutes x models x accounts) | API | 4 s tick, must be < 100 ms: OPEN-R10 (Rust bench); CF H21: Rust folds over an iterator, no `collect()` | P, MAC, VT |
| F14 | `burn_status` (C08: H21,Q13,Q14,Q15,F2) | `now` | F13 + `account_state`, `node_rollup` for session status | burn object inputs | WIN: cap 100 accounts | API+RU+SIDE | | P |
| F15 | `burn_risk_inputs` (C09: H22,Q17) | thresholds | `api_call` last 5-60 min GROUP BY nk (fan-out), `hook_event` last N | per-node counts | WIN: cap 200 nodes | API+SIDE | | P |
| F16 | `window_events` (C10: Q16,Q18,Q19) | `account`, `window` | `api_call` JOIN `node_account` WHERE account = ? AND `ts_ms` in window; top-N burners ORDER BY weighted DESC LIMIT N; the weighted key uses 5m/1h columns | rows or top-N | TOPN 100; Q18 ETA fold over minute buckets | API+SIDE | | P, MAC |
| F17 | `account_state_at` (C10: Q20) | `ts` | `account_state` WHERE `ts_ms <= ?` ORDER BY `ts_ms` DESC LIMIT 1 | one row | ONE | SIDE | | P |
| F18 | `last_request_per_node` (C11: Q21) | `scope`, `threshold` | `max(ts_ms)` over `api_call` GROUP BY `nk` (restricted by project/session; CAT says `event`, but `event` has `type`, not `kind`, SCH 4.4: INFERRED mapping, golden decides); transcript-tail fallback via `raw_lines(file_id, gen, from_off, to_off)` ORDER BY `byte_off` DESC LIMIT 1 | nk, last_ts | WIN: O(active nodes), cap 2000 | API+LINES | | P |
| F23 | `cache_break_inputs` (C16: Q27,V4) | `id` | `api_call` per turn ORDER BY `(ts_ms, file_id, byte_off)` for ONE node (api_call has no `seq` ordering column beyond the upsert guard, SCH 4.4) | per-turn usage rows | SES, iterator into `cache_break.rs` | API | | P, VT |
| F32 | `cache_break_events` (C23: Q41,Q42) | `scope`, `window`, `minTokens`, `topN` | `api_call` window scan with LAG over `(nk ORDER BY ts_ms, file_id, byte_off)` filtering cache_read drop | break events | TOPN (cap per tool) | API | window function over a window: heavy lane | P |
| F30 | `cache_creation_groups` (C22: Q38,Q40) | `window`, `groupBy`, `bucket` | `api_call` GROUP BY group key (+ bucket boundaries CTE from Rust, section 7) | groups (BIGINT) | WIN: O(groups), cap 1000 | API | Q40 `get_cache_break_gap_report` has no dedicated function in this catalog: OPEN-R13 | P, MAC |
| F31 | `expensive_writes` (C22: Q39) | thresholds, `chainDepth` | `api_call` WHERE `cache_create_tokens >= ?` ORDER BY it DESC LIMIT N; `backwardChain` join `call_block` | rows | TOPN 100 | API+SIDE | | P |
| F37 | `billed_usage_by_hour_model` (C26: Q48,Q49) | `window` | `api_call` GROUP BY hour bucket (section 7), model | hourly rows | WIN: hours x models, cap 1000 buckets | API | | P, MAC |
| F38 | `causing_call` (C26) | `episode ts range` | `api_call` rows by `ts_ms` range plus the raw line via `raw_lines` at the row's `(file_id, gen, byte_off)`, LIMIT 1 per episode | row | TOPN = episodes (<= maxEpisodes) | API+LINES | | P |

### 2.3 Transcript-derived and body-derived

| id | function | A | SQL sketch | OUT | BOUND | VIS | CX / notes | M |
|---|---|---|---|---|---|---|---|---|
| F19 | `context_composition` (C12: Q22,H33,V3) | `id`, `parent?` | `raw_lines(file_id, gen, 0, next_off)` of the node's file (+ ancestor chain via `v_spawn_link` for the H33 parent fallback only); estimator stays Rust | lines | SES iterator; one line may be 4.4 MiB (D-DAT-7, CF H7/H21): `raw_lines` range read with a byte cap | LINES | | P, VT |
| F20 | `context_history` (C13: Q23,H34,V5) | `id`, `parent?`, `turn?`, `blockId?` | `raw_lines` + `v_api_call` (`input_incl_cache`) for the node | lines + usage | SES iterator | LINES+API | `usage.input` cache-inclusive (CAT C13) | P, VT |
| F21 | `conversation` (C14: Q24,H35) | `id`, `turnFrom`, `turnTo` | `event` rows of the turn range (byte_off range) then `raw_lines` over that range | lines | SES, range cap 20 turns by adapter | DISP+LINES | | P |
| F22 | `composition_aggregate` (C15: Q25,Q26) | pool | F19 over a bounded pool of sessions (adapter caps 20/25) | per-session composition | TOPN pool 20/25; each consumed as an iterator, ONE session in memory at a time | LINES | OPEN: caps lifted only in the golden run (CAT D8) | P, VT |
| F24 | `cache_risk_commands` (C17: H24,Q28) | `window`, `kinds`, `limit`, `minTokens` | `raw_lines` joined to `file.mtime_ms` for the window and `event.ts_ms` in window, risk kinds (command extraction), ORDER BY ts DESC LIMIT n. `file_mtime` is `file.mtime_ms` (SCH 4.1), not a `raw_line` column | rows | TOPN `limit` | LINES+DISP | scan of a line window; OPEN: pre-extracted `risk_command` column at ingest (SPEC-method-bench) | P, VT |
| F25 | `transcripts` view (C18: Q29,Q30,Q31) | - | `CREATE VIEW transcripts AS SELECT ... FROM raw_lines(...)` per current-gen file (replaces `read_ndjson_auto`); presets are fixed SQL, incl. Q29 `get_skill_attribution` and Q30 `burn_seismic` (CAT C18) | per preset | USQL (default 100, max 10000), `SELECT * FROM (<sql>) LIMIT n+1`; this bounds returned rows, NOT scan memory | LINES | heavy lane; needs the static `json` feature (json functions over `line`) | P |
| F26 | `call_context` (C19: H38,Q32) | `sid`, `request|span` | `call_block` JOIN `api_call` WHERE ... ORDER BY `block_idx` | blocks | SES-request: blocks of one call, cap 5000 OPEN-R7 | SIDE+API | account side effect (NS-4) is a write: stays in the adapter | P |
| F27 | `composition_summary` (C20: H36) | `sid` | `call_block` GROUP BY `kind`/`label` per turn | summary rows | SES, O(turns x kinds) | SIDE | | P, MAC |
| F28 | `block_content` (C20: H37,Q33) | `sid`,`turn`,`idx`,`full` | one `call_block` row; `full=false` truncates with `substr`; images never ship bytes | one block | ONE (<= byte cap, OPEN-R7) | SIDE | | P |
| F29 | `scope_pool` (C21: Q34,Q35,Q36) | `project`, filters, `topN` | `call_block` JOIN `node_visible` WHERE project map; GROUP BY / ORDER BY LIMIT N | rows | TOPN 100 (`groupBy` O(groups), cap 1000) | SIDE+RU | | P, MAC |
| F34 | `session_burn_profile` (C24: Q44) | `id`, `window` | `api_call` GROUP BY turn bucket for one node | profile rows | SES | API | | P |
| F33 | `heartbeat_fires` (C24: Q43) | `marker`, `window`, `fire` | `call_block` WHERE `instr(text, marker) > 0` AND `captured_ms` in window | fire rows | TOPN 500 | SIDE | | P |
| F35 | `cache_event_log` (C24: Q45) | `mode`, `project`, `session`, `window`, `limit`, `tz` | `api_call` LEFT JOIN `otel_span_attr` (cache_miss_reason) ORDER BY `ts_ms` DESC; cursor `(ts_ms, message_id)` (api_call has no `call_id`) | rows | PAGE 50 (max 200) | API+OTEL | `tz` only formats display strings in Rust (section 7) | P |
| F36 | forensics views (C25: Q46,Q47) | - | native views `api_calls`, `call_content`, `call_injections` over `api_call`/`call_block` (no `forensics.db`, no write-on-read, CAT D7) | per preset | USQL (as F25) | API+SIDE | heavy lane | P |
| F48 | `archived_lines` (R1-D4 archived-lines view) | `id`, `cursor`, `limit` | `raw_lines(file_id, g, 0, ...)` for `g < file.gen` of the node's file, ORDER BY `(gen, byte_off)` | lines (BLOB-safe, section 0.1) | PAGE 50 (max 200) | ARCH | NEW function: the lines of superseded generations, never deleted (D-10/SCH 4.1); empty today (0 superseded files, D-DAT-1). The need for it is tied to OPEN-R12 | P |

### 2.4 Events, host, debug, SSE

| id | function | A | SQL sketch | OUT | BOUND | VIS | CX / notes | M |
|---|---|---|---|---|---|---|---|---|
| F39 | `hook_events` (C27: H11) | `session`, `ev`, `since`, `until`, `limit`, `cursor` | `hook_event` WHERE ... ORDER BY `(ts_ms DESC, hook_id DESC)` LIMIT n+1; `payload` output via `to_json`/cast | rows | PAGE 50 (max 200) | SIDE | needs the static `json` feature (`payload JSON`) | P |
| F40 | `lifecycle_events` (C27: H12,Q50,V6) | `limit`, `kinds`, `session`, `window` | as F39 with `event` filter | rows | PAGE 50 (max 200) | SIDE | | P |
| F41 | `body_writers` (C30: Q37) | `window_min`, `active_min`, `limit` | `node_visible` join of an FS dir-scan list (Rust passes `(path, mtime, size)` as a bounded VALUES list or temp table, <= `limit` x 4 rows) | rows | TOPN `limit` | RU+FS | FS-dependent (NS-10) | P |
| F42 | `codex_trace_ids` (C33: H16) | - | `otel_span` WHERE `name LIKE 'codex.%'` GROUP BY `trace_id`, window 24 h | ids | WIN cap 1000 | OTEL | | P |
| F43 | `span_attr` (C33: H17) | `traceId`,`spanId`,`key`,`fromMs` | `otel_span_attr` latest row for `(trace_id, span_id, key)` (full value, NS-8) | one value | ONE (value cap OPEN-R7) | OTEL | | P |
| F44 | `sidebar` (C34: H1,F1,S6) | `now` | live keys from `node_rollup` (`last_active_ms >= now - X`), `otel_span.received_ms` window, current session | sidebar object | WIN: cap 500 active nodes | RU+OTEL | 4 s coalesced; must be < 50 ms (OPEN-R10); replaces the in-RAM `window.spans` walk (CF H21) | P, MAC |
| F45 | `daily_stats` (C34: F1 dailyStats, V7) | `tz`, `from`, `to` | `api_call` GROUP BY the Rust-generated day bucket (section 7) and model: all token buckets per day (D-12 fix: no longer input-only / `costUsd` 0) | rows (BIGINT) | WIN: days x models, cap 400 days | API | | P |
| F46 | `current_session` (C34) | `now` | the NEWEST card (D-12 fix: no longer the oldest-card quirk of `latestSession`) | one object | ONE | RU | | P |
| F47 | `collector_gaps` (C36: H31) | - | `collector_run` gap rule >= 15 s via LAG | gaps | TOPN 100 | SIDE | | P |

Functions that are NOT SQL (C28, C29, C32, C37 and Q52/Q53, H25, H27) stay unchanged. Total: 48 read functions (F01-F48): F01-F47 grouped from CAT cards C01-C27, C30, C33, C34, C36, plus F48 from R1-D4. Cards C31 (`sql_clear_all`, `sql_clear_spans`, `sql_import_sessions`) are write functions, excluded. CAT operations with no function of their own (OPEN-R13): Q6 `get_session_detail` (compose F06+F09+F10 in the adapter, INFERRED), Q11 tool_result bytes, Q40 gap report.

## 3. Paging contract

- Every list function returns `{rows, next_cursor|null, v}`. `v` = `meta.data_version` read INSIDE the same read transaction as the page query (`BEGIN; SELECT value_int FROM meta WHERE key='data_version'; <page>; COMMIT` on one reader connection), never in a separate statement (CF H9 item 4, H17; counter semantics SCH 4.1). DECIDED (CF, SCH).
- Cursor encodings (opaque to clients: base64url of a versioned tuple `1|<fields>`; INFERRED encoding):
  - Root/card lists (F01, F02): `(created_ms, nk)` strictly `<` keyset, order `created_ms DESC, nk DESC`. DECIDED (E4: dups 0, misses 0; the `last_active_ms` cursor gave 197 dups / 248 misses and is forbidden).
  - Archived lines (F48): `(gen, byte_off)` ascending.
  - Event lists (F39, F40): `(ts_ms, hook_id)` DESC; `hook_id` immutable monotone. F35: `(ts_ms, message_id)` DESC (HUGEINT only inside the opaque cursor).
  - Leaf walks of the `/api/q` variants of SES functions (F06, F19-F21): `(byte_off)` within the node's current-gen file (immutable; CF H9).
  - The cursor embeds the `clear_epoch` and `boot_id` of the first page (INFERRED). A cursor minted under another `clear_epoch` is answered 410 `cursor_expired` (a clear replaces the derived tables, so a keyset cursor is meaningless afterwards); a changed `boot_id` alone does not invalidate a keyset cursor (the keys are immutable).
- Client rule when `v` changes between pages: pages stay internally valid for immutable-key lists (no dup, no miss for start-snapshot rows); the client MAY keep walking and treats a changed `v` as "newer data exists, refresh page 1 when convenient". For views that need exact totals (summary totals across pages) the client refetches page 1. Server never rejects a cursor for `v` mismatch (INFERRED).
- Phantoms: a row inserted after the walk started that sorts behind the cursor appears as an extra; documented as harmless (E4: 936 phantoms, 0 dups, 0 misses). Rollup-backed numbers are "latest at page time", not snapshot-consistent across pages (CF H9 option 2). An exact-snapshot design via a `node_rollup_delta` table is NOT adopted: D-3 chose the in-place per-batch update of `node_rollup` (option A_nopk of E2: no primary key, no ART), which keeps no history. `last_active_ms` is a displayed field only, monotone, clamped at ingest (SCH 4.3: batch commit time + 60 s, value OPEN-O14; CF H20 proposed ingest wall + 5 min) and never decreases.
- Exact-snapshot walk (E4 variant iii: version history + `arg_max`) is not adopted; OPEN-R3 stays only as "adopt if a product requirement for exact snapshots appears" (E4: p95 10.6 ms, cold 419 ms, needs a history table).
- Activity, token and cost sorts (`last_active`, `tokens`, `cost`, burners, hogs) are TOP-N, not paged: `N` capped per function (section 2), no cursor, response states `{top_n: N, truncated: bool}`; the client re-requests after SSE `changedRoots`. DECIDED by E4 and D-5 for the activity sort; INFERRED for token/cost.

## 4. Reader pool

1. Pool (INFERRED sizes, OPEN-R2/R9: SPEC-method-bench): `Connection::try_clone` x 4 interactive + 1 heavy, created at boot; a `Connection` is Send, not Sync (CF H19), so each is owned by a pool slot behind a `tokio::sync::Semaphore` (4 permits interactive, 1 heavy). No clone per `spawn_blocking` task. VERIFIED (CAP 2f, D-ENG-4): writer + `try_clone` readers give snapshot isolation without blocking.
2. Lane assignment is static per FnSpec (`lane`): heavy = F12, F13 (if > 100 ms), F22, F24, F25, F30-F32, F36, F37, Q31/Q47 user SQL, F48; interactive = the rest. A request waits for a permit up to `queue_wait_ms` (default 200 ms, INFERRED) then gets 503 `overloaded` + `Retry-After`.
3. Per-request deadline: interactive 2 s, heavy 20 s (INFERRED, OPEN-R9). Enforcement is by `Connection::interrupt()` (duckdb-rs `InterruptHandle`) from a timer; CAP verified no interrupt behaviour, so this is INFERRED and a test (T6) must prove that an interrupted query frees the connection and its transaction. The slot is released on completion or interrupt; response 408 `deadline`. Today's 20 s wall budgets and scan caps are removed from the logic (CAT D8) and replaced by this deadline plus row bounds.
4. Never hold a transaction across requests (CF H9, H19): each request = one short read transaction opened and closed inside the handler. Streamed responses (item 5) hold one transaction for the stream, bounded by the write deadline.
5. Streaming: large results (F06, F19-F21, F25, F36) stream rows through a bounded `tokio::sync::mpsc` channel (capacity 64 rows or 1 MB, INFERRED) from the blocking producer to the response body; write deadline per chunk 5 s (INFERRED): on timeout the response is aborted, the connection is interrupted and released, the transaction ends (CF H19). Pages <= 2 MB (INFERRED) are fully materialised and the connection released before sending. Exports use a dedicated connection and a hard wall-clock limit (OPEN-R6, write-side spec).
6. Checkpoint gate: DEMOTED to a FALLBACK (R1-CKPT). CF H13 proposed `parking_lot::RwLock<()>` (readers SHARED per query/stream; the writer EXCLUSIVE for `CHECKPOINT`). CAP measured the opposite risk: with a long-lived reader transaction the WAL stayed 12-18 MB (7), `CHECKPOINT` with concurrent readers returned ok in 0.03 s and never blocked the reader or the writer (2f, D-ENG-4), and the default `checkpoint_threshold` of 16 MB is kept (D-ENG-7). So the gate is NOT built unless test W-T16 (writer spec) shows a checkpoint starved or an unbounded WAL under the reader pool. If it is needed: shared lock per query/stream, exclusive for `CHECKPOINT` only (never `FORCE CHECKPOINT`), and a stream that outlives the 5 s write deadline cannot hold it. Exclusive-duration and 64 MB / 256 MB / 1 GB WAL replay figures: CAP 14 measured replay at ~2.5 s and ~1 GB RSS per GB of WAL, and the WAL is NOT truncated at open (D-ENG-7).
7. Readers run at normal QoS; never from `bg_rt` and never on a background-QoS thread (CF H11/H19; R1-D7: LIVE work is normal QoS, only BACKFILL is background).

## 5. Memory budget for reads

Rule (CF H21, D-16): the plan publishes the SUM of all DuckDB instance limits plus the Rust-side budget plus the allocator margin against the RSS cap. `memory_limit` counts only DuckDB-managed memory: process RSS runs 120-330 MB above it (D-ENG-9; CAP 2g measured 631 MB RSS at a 512 MB limit). R1-BUDGET: the writer spec's static budget sums to 2,226 MiB, above today's 2,048 MiB cap, so the startup check needs the interim 4,096 MiB cap (D-13, itself a plan, R1-D13) or a smaller sum after the bench. This spec contributes the read side only:

| item | value |
|---|---|
| DuckDB `memory_limit` of the index instance (shared by writer and all readers) | TBD (SPEC-method-bench; D-16) |
| DuckDB `threads` | TBD (same; E2/E4 measured with threads=2, memory_limit=512MB: all 7 E2 options passed read p95 limits; E2 peak RSS 346-381 MB incl. ~245 MB harness baseline) |
| other DuckDB instances (cards.duckdb, forensics replacement, a read-only instance for user SQL if chosen, OPEN-R5) | TBD (same) |
| Rust read-side: pool of 5 connections (per-connection overhead) | TBD. CAP measured an idle open at RSS 20 MB and ~1-2 MB of ART per touched index (lazy load), not a per-clone figure |
| ART memory on reads | `api_call` PK is the only bounded index (SCH 3.1); read-only point queries load ~1-2 MB (CAP 5/8); a write touching many keys loads the whole index and an OOM is FATAL (D-ENG-2): reads never run bulk writes |
| Rust streaming buffers: 5 slots x (64 rows or 1 MB) | <= 5 MB (INFERRED) |
| Largest single materialised page | 2 MB cap (INFERRED) |
| Single `raw_lines` content row range-read cap | OPEN-R7 (largest corpus line 4.4 MiB, D-DAT-7) |
| Test asserting RSS growth under 40 concurrent calls | section 9 (T5) |

No number in this table other than the streaming buffers and page cap is established; E2/E4 RSS figures are single-process Python-harness figures and are not budget numbers (E4 "Unverified": not measured with the Rust binary).

## 6. SSE

- Frame (DECIDED CF H17, INFERRED field layout): `{"v": i64, "since": i64, "boot_id": "<uuid>", "clear_epoch": i64, "changedRoots": [nk...]}`; `changedRoots` capped at 200 per frame; overflow sends `"changedRoots": null, "overflow": true` meaning "refetch pages".
- Change feed: table `ingest_batch_root(batch_id, root_nk)` written in the batch transaction by the writer; `ingest_batch` is never deleted, CLEAR inserts a `kind='clear'` row and bumps `clear_epoch` (CF H17, SCH 4.1). `v` = `meta.data_version`, monotone across restart and clear (CF H11, H17, SCH 4.1). The `since` of a frame is a `batch_id`/version boundary resolved by the writer spec (OPEN-R6: `ingest_batch_root` retention; a `since` older than retained rows is treated as a gap).
- Emission: the existing 4 s coalescing (`PUSH_COALESCE_MS`) stays. A frame is built by `SELECT DISTINCT root_nk FROM ingest_batch_root WHERE batch_id > ? AND batch_id <= ? LIMIT 201` plus F44 `sidebar` for live keys; `burnStatus` and `alert` frames (F2, F3) keep their producers (C08, C09).
- Reconnect/gap rules (INFERRED): client sends `Last-Event-ID: <v>` (or `?since=v`); server replays one catch-up frame with `since=<v>` and the changed roots in `(v, current]`; if `boot_id` or `clear_epoch` differ, or `since` precedes retained rows, or overflow, the frame carries `reset: true` and the client drops cached pages and refetches page 1. A frame with `v < client v` and same `boot_id`/`clear_epoch` is ignored.
- Frame compatibility: the legacy `update` frame payload (F1) keeps its exact shape for the current dashboard; the new fields are additive keys (OPEN: verify key order against `update_payload_parity.rs`, decided by C34 golden diff).

## 7. Time

- Storage and API: epoch milliseconds (i64) only; never DuckDB TIMESTAMP in an output column (CF H20, D-ENG-10). Ordering by `byte_off` within a file and `(ts_ms, file_id, byte_off)` across files (SCH 4.4), never by wall time.
- `tz` param: IANA name. D-14 DECIDES the mechanism (day buckets from a tz parameter, in Rust, DST-safe, no ICU). The default for `/api/q` is `UTC`; which zone `dailyStats` uses (UTC vs local days) is OPEN-R8, decided by the contract-delta card together with the D-12 `dailyStats` fix; legacy adapters pass what they use today until then.
- Bucket boundaries are generated in Rust (`chrono`/`chrono-tz`, 23/25-hour DST days correct) into a small `(bucket_start_ms, bucket_end_ms)` table passed as a VALUES CTE (<= 1000 rows, cap enforced) joined to the facts with `ts_ms >= s AND ts_ms < e`. No ICU `TimeZone`, no `date_trunc` for local buckets (D-14; CAP 16 found the 2-arg `timezone()` works without icu, but it is not used: the Rust buckets are the single owner).
- One owner function: `fn buckets(from_ms, to_ms, bucket: Hour|Day|Week, tz) -> Vec<(i64,i64)>` in one module; F30, F35, F37, F45 call it; no other code computes a bucket.
- `now` is a parameter of every function that uses the clock (`now_ms` injected by the adapter; FND-00 clock injection, CAT).

## 8. Bounded-input Rust logic

Rule (CF H21): no function in the read path `collect()`s a result whose size is unbounded. Each Rust consumer takes `impl Iterator<Item = Result<Row>>` (or a `FnMut(Row)` fold) over `query_map`/the VTab stream.

| function family | row bound into Rust | consumption |
|---|---|---|
| F01, F02, F35, F39, F40, F48 (PAGE) | `limit+1` <= 201 | collected (bounded by constant) |
| F03, F04, F07, F09, F11, F16, F24, F29, F31, F32, F33, F38, F41, F47 (TOPN) | N <= per-function cap (section 2) | collected (bounded by constant) |
| F22 (TOPN pool 20/25) | pool constant, but each session composition is large | iterator per session, ONE session in memory at a time (not collected) |
| F05, F10, F17, F28, F43, F46 (ONE) | 1 row | collected |
| F12, F13, F14, F15, F18, F30, F37, F42, F44, F45 (WIN) | O(groups), cap enforced by `LIMIT` and by bucket count <= 1000 | DuckDB aggregates; Rust folds one row at a time |
| F06, F08, F19, F20, F21, F23, F26, F27, F34 (SES) | unbounded count in principle (one session); bounded per session | iterator only; `cache_break.rs`, composition estimator, `burn_status_for` (CF H21) and `cache_break_timeline.rs` get an iterator or a streaming fold (O(1) memory); any function that today takes `&[T]` is changed to take an iterator (the per-function change is a task of the owning card, OPEN: list decided in each card) |
| F25, F36 (USQL) | `LIMIT n+1` wrap, default 100, max 10000 | streamed |

Every function of section 2 appears in exactly one row above (48 ids); test T4 asserts it.

Enforcement: a `ReadBound` wrapper counts rows pulled from a result and fails the request with 500 `internal` + log (a bug, not a client error) if a function declared bound N yields more than N (+1 for the has-more probe). Tests: section 9 T4/T5.

## 9. Tests per function family

All tests are real (real DuckDB file, real alcore HTTP server per `tests/ui.rs` style; no mocks). Files under `rust-core/crates/agentlens-core/tests/` (proposed names: `read_api_golden.rs`, `read_api_paging.rs`, `read_api_version.rs`, `read_api_deadline.rs`, `read_api_memory.rs`, `read_api_visibility.rs`).

| # | family | test | asserts |
|---|---|---|---|
| T1 | every F01-F48 (golden diff) | replay the FND-00 golden corpus (fixed clock, fixed ingest order) through the old adapter output and the new function adapter | byte-for-byte equal (key order included, both `verbosity` modes) except the CAT section 4 D1-D10 deltas and the four D-12 fixes (section 1.3), each pinned by its own expected-delta file; one test function per card; numeric typing rules of section 0.1 (BIGINT counts, DOUBLE < 1e16, epoch-ms) checked on every output |
| T2 | paging F01-F04, F35, F39, F40 | walk all pages while a second thread ingests 1000+ batches updating `last_active_ms` of delivered and undelivered roots and inserting new roots (E4 experiment replayed) | dups = 0; misses of start-snapshot rows = 0; phantoms allowed and counted; repeat with the old `last_active_ms` cursor as a negative control that FAILS (dups > 0), proving the test can fail |
| T3 | version consistency | one request returns `v` and rows: ingest concurrently, compare `v` with the `data_version` visible in the same transaction | rows never contain data from a batch newer than the returned `v`; `v` equals `meta.data_version` in the same transaction (violated deliberately in a negative variant that reads `v` in a separate statement) |
| T4 | row bound | every function over a 10x oversized fixture; static check of the FnSpec table | rows returned <= declared bound; `ReadBound` trips on an injected over-yield; every F id has a bound class AND a VIS code AND appears once in the section 8 table; no read-path file contains `.collect::<Vec<` over a query result except the PAGE/TOPN/ONE set (allowlist file) |
| T5 | memory bound | 40 concurrent heavy and interactive calls on the 41k-session fixture | RSS growth of the process <= budget (value TBD, section 5); semaphore holds: at most 4+1 queries run concurrently; excess get 503 within `queue_wait_ms` |
| T6 | deadline | a function made slow with a large fixture and a 50 ms deadline | 408 `deadline` within deadline + 100 ms; the interrupt actually stops the query (INFERRED mechanism, section 4.3); connection returned to the pool and reusable; no stuck transaction (checkpoint succeeds afterwards) |
| T7 | streaming | client that stops reading a streamed F06/F19 response | write deadline aborts it, connection released, `CHECKPOINT` runs within X s (X OPEN); stream memory <= buffer cap |
| T8 | checkpoint under readers | writer past the WAL threshold while 4 readers loop and one holds a long transaction | checkpoint completes; WAL stays near the 16 MB threshold; no reader errors. This test is the read-side half of writer test W-T16: it decides whether the section 4.6 gate (fallback) is built |
| T9 | SSE | reconnect with old `since`, with changed `boot_id`, after CLEAR, with overflow; a pre-clear cursor on a page route | frames follow section 6: replay of changed roots, `reset:true` cases, ignore of stale `v`; `v` monotone across restart and clear; 410 `cursor_expired` for a cursor of another `clear_epoch` |
| T10 | time | `buckets()` over a DST spring-forward and fall-back day (Europe/Rome 2026-03-29, 2026-10-25), and `tz=UTC`; the whole suite runs with autoload off and no icu | 23 h and 25 h days correct; F45/F30/F37 bucket sums equal a reference computed independently; epoch-only output |
| T11 | adapters | each existing route/tool through `/api/q` adapter vs old code on the same fixture (the "thin adapter" claim) | existing tests `ui.rs`, `card_routes.rs`, `card_pagination.rs`, `mcptools_parity.rs` stay green unchanged, except the D-12 fields |
| T12 | dispatch (CAT "NONE" gaps) | new dispatch tests for Q2-Q4, Q7-Q11, Q14, Q18-Q28, Q38-Q47 per CAT card verification columns | argument defaults and resolver wiring match old behaviour |
| T13 | engine features | open the index with autoload/autoinstall off; call every function that uses `to_json`, `json_*`, `read_parquet`, and the `hook_event.payload` column; feed DOUBLE >= 1e16, FLOAT, NaN, DECIMAL into a probe function | static `json`/`parquet` work offline; the probe shows what D-ENG-10 forbids, and no shipped function can emit it |
| T14 | visibility (display vs billing) | a fixture with a node whose file has two generations: display rows in both, `api_call` rows in both | F06/F08-display/F21 show only `gen = file.gen`; F48 returns the old-gen lines; `api_call` windowed totals (F13, F12, F37) are identical with and without the gen bump (OPEN-R12 default); flips with the R2 decision |

## 10. OPEN items

| id | question | decided by |
|---|---|---|
| OPEN-R1 | per-function method: SQL macro vs Rust VTab vs prepared SQL; `to_json` vs serde (to_json allowed under D-ENG-10 typing rules; VTab viable per D-ENG-11) | SPEC-method-bench (D-15) |
| OPEN-R2 | pool size, `threads`, `memory_limit`, per-connection overhead (CAP gives no per-clone figure); checkpoint threshold stays the 16 MB default (D-ENG-7); WAL replay is ~2.5 s/GB (CAP 14, measured, closes the "WAL replay times" part) | SPEC-method-bench; writer test W-T16 |
| OPEN-R3 | exact-snapshot paging (history table, E4 variant iii) or `node_rollup_delta`: NOT adopted (D-3, E4); reopen only on a product requirement | product requirement |
| OPEN-R4 | H2 legacy "ship every card" mode vs page-only (D6) | contract-delta card (SPEC-contract-delta) |
| OPEN-R5 | Q31/Q47 user SQL allowlist and read-only enforcement (a `try_clone` connection is not read-only; no `interrupt` evidence either) | security card + SPEC-method-bench |
| OPEN-R6 | `ingest_batch_root` retention; export connection | write-side spec |
| OPEN-R7 | `raw_lines` single-line range-read cap; `call_block`/`block_content` caps (CF H7) | write-side spec and ingest report |
| OPEN-R8 | UTC vs local day buckets for `dailyStats` (mechanism decided by D-14) | contract-delta card (CF H20) |
| OPEN-R9 | deadlines, queue wait, channel sizes (all INFERRED numbers in section 4) | SPEC-method-bench |
| OPEN-R10 | E2 residue: F44/F13 within 100 ms at 41k sessions with the real Rust binary; windowed `api_call` scans after a backfill that inserts old rows late (E2 inserted in `ts` order, so zonemap pruning on `ts_ms` was not stressed) | SPEC-method-bench |
| OPEN-R11 | clear semantics: R1-D10 clear watermark (every read hides older data) vs today's meaning (drop OTEL spans, rebuild derived tables). Reads currently carry no clear predicate; the seam is `node_visible` + `clear_floor()` (section 0.2). Under the watermark option a straddling node's rollup would still include pre-watermark totals, and `raw_index` has no `ts` column to filter lines by | R2/E7 (pending) |
| OPEN-R12 | generation semantics: display rows gen-filtered (`gen = file.gen`), `api_call` and its totals never gen-filtered, node rollup not recomputed per gen (R1-D4 (b)(c) pending); fate of F48 follows | R2/E7 (pending) |
| OPEN-R13 | CAT operations without a function: Q6 (compose F06+F09+F10), Q11 (`tool_result` bytes), Q40 (gap report), Q12 cause columns (SCH OPEN-O7) | owning cards C05, C04, C22, C07 |

## Revision log

Revision 1 (fact-check against D, R1, E2, E3, E4, CAP, CAT, SCH; coordinator update applied: R1-D10, R1-D4(b)(c), R1-D5 marked OPEN pending R2/E7).
1. Garbled sentence in section 3 ("E2 decided in-place update, no PK needed... see OPEN-R3") rewritten: D-3 chose A_nopk (no PK, no history), so exact snapshots via `node_rollup_delta` are not adopted; OPEN-R3 narrowed.
2. Table names aligned to SCH: `raw_line` does not exist (`raw_lines` macro, `file.mtime_ms` for `file_mtime`); F02 joined `node` for `created_ms` (it is not on `root_cache`) with the root predicate `nk = root_nk`; reads through `node_visible`; `node_hist`/`stats`/`call_id`/`event.kind`/`seq` ordering references replaced.
3. `v` changed from `max(ingest_batch.id)` to `meta.data_version` (SCH 4.1, H17/H28: counter never lowered by prune or clear).
4. `last_active_ms` clamp: spec said 5 min, SCH says 60 s (OPEN-O14); now defers to SCH.
5. Section 0.1 added: D-ENG-1/R1-ENG1 static json+parquet then autoload off; D-14 no ICU; D-ENG-10 typing rules; HUGEINT never in output; explicit BIGINT casts on aggregates (INFERRED, not in the reports).
6. D-12 fixes applied and the CAT "quirks to keep" conflict recorded: `latestSession` = newest (F46), `dailyStats` all buckets (F45), burn weights incl. 1h tier (F13/F16/F32 return the 5m/1h split), Q2-Q4 workspace filter honoured (F07); R1-D12 effects sweep noted.
7. Every function now states a BOUND class with a numeric cap and a VIS code (section 0.2/0.3); SES defined (O(1) Rust memory, `/api/q` paging at limit 500/2000).
8. F03 cap resolved (500 + `truncated`); F09 aligned; F14 reclassified WIN (was "ONE +O(accounts)"); F22 consumption fixed (iterator per session, was "collected"); F32/F38 and the ONE functions added to the section 8 table (they were missing); section 8 and section 2 now agree, asserted by T4.
9. Contradiction fixed: leaf walks were both "paged by byte_off" (section 3) and "streamed whole" (section 2/4.5); now legacy adapters stream, `/api/q` pages.
10. R1-D4 (display rows gen = file.gen, archived-lines view) applied as F48 and the DISP/LINES/ARCH classes; (b)(c) marked OPEN-R12 per the coordinator.
11. R1-D10 NOT applied as a per-read predicate (coordinator): OPEN-R11, with the single seam `clear_floor()`; cursor/clear interaction defined (410 `cursor_expired`, INFERRED).
12. R1-CKPT: checkpoint gate "DECIDED" demoted to fallback pending W-T16; CAP 2f/7 evidence cited; T8 rewritten.
13. Unbacked claims flagged INFERRED: `Connection::interrupt()` (CAP verified no interrupt), read-only user SQL on a `try_clone` connection (shares the writer's read-write instance), spawn depth cap 16.
14. E2/E4 citations corrected: E2 Q3 is a top-100 7-day scan, not a cause GROUP BY (F12 cause columns do not exist, SCH OPEN-O7); E2 inserted in `ts` order so backfill zonemap behaviour is unmeasured (OPEN-R10); F07 numbers now cite the chosen A_nopk row; E4 created_ms fell back to mtime for 9,912 files while D-DAT-6 does not list them.
15. Section 5 updated with CAP: memory_limit vs RSS gap (D-ENG-9), R1-BUDGET 2,226 MiB vs 2,048 MiB, ART read behaviour; "capability report pending" removed (the report exists); numbers still TBD from the bench.
16. Missing coverage recorded (OPEN-R13): Q6, Q11 tool_result bytes, Q40, Q29/Q30 as presets of F25.
17. OPEN resolution: OPEN-R2 partly resolved (WAL replay measured, checkpoint threshold kept at 16 MB), OPEN-R3 closed as not adopted, OPEN-R8 narrowed (mechanism decided); new OPEN-R11, R12, R13.
18. Tests: T13 (engine features offline), T14 (display vs billing visibility), T9/T10/T4 extended; error code `cursor_expired` added.
19. Pending, not applied (R2/E7): R1-D5 node identity `(dev, inode)`: reads are keyed on `nk`/`session_id` and do not depend on it.
