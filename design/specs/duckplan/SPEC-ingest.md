---
title: DuckDB-index redesign - ingest (how every source becomes rows in alcore's index: per-line, incremental, idempotent)
status: draft
scope: project
sources: docs_dev/duckplan-decisions.md (D, authoritative), reports/DUCKPLAN/20261003_182757+0200-transcript-format-facts.md (T), reports/DUCKPLAN/20261003_165118+0200-concurrency-and-flaws.md (F: H3-H8, H15, H16, H18, H24-H27), reports/DUCKPLAN/20261003_164140+0200-anthropic-docs-facts.md (A), reports/DUCKPLAN/20261003_190027+0200-e5-spill-and-images.md (E5), reports/DUCKPLAN/20261003_190622+0200-e1b-raw-storage-settle.md (E1b), design/specs/duckplan/SPEC-operation-catalog.md (CAT), design/specs/duckplan/SPEC-legacy-card-import.md (LEG), docs_dev/duckplan-decisions-r1.md (R1: REVISION 1, supersedes the decision-log items it names; on conflict R1 wins)
---

# Ingest: sources to rows

Marks: VERIFIED = read this session in a file or report (file:line given); INFERRED = deduced here; OPEN = undecided or unmeasured, must be settled before it is relied on. Decision ids D-x are from the decision log and R1-x from its REVISION 1 (which supersedes D-1, D-4, D-6, D-7, D-10 and parts of D-5 as named there); T/F/A/E5/E1b/CAT/LEG are the reports and specs named in `sources`. Code paths are under `rust-core/crates/`: `agentlens-logscan/src/` (lib.rs, codex.rs, copilot.rs, opencode.rs, discovery.rs) and `agentlens-core/src/log_reader.rs`.

## 0. Rationale and shape (one sentence, one picture)

Rationale: every byte Claude Code, Codex, Copilot or OpenCode writes becomes durable raw content plus derived rows through ONE pure function per source, in batches that commit atomically with the file offset, so a crash, a restart, a rotation or a second read can neither lose nor duplicate a line.

```
discover/watch -> scheduler (one owner per file, D-8)
      -> producer (LIVE: normal QoS; BACKFILL: background QoS, R1-D7): open handle, verify identity, read to last newline,
         rows_for_line(ctx, line) per line  -> BatchRows (all tables) + new ctx + new offset
      -> bounded byte queue, LIVE lane first, BACKFILL lane (D-7)
      -> writer thread (normal QoS, owns the write connection):
         ONE transaction = raw lines (through the RawSink, section 2.7) + derived rows
                           + rollup deltas computed from the rows actually APPLIED
                           + CAS(file_gen offset, ctx) + ingest_batch row
```

**Pending revision (coordinator note, revision 2 after experiment E7).** Four R1 items are under revision, and every passage of this spec that depends on one is marked **PENDING R2/E7 - OPEN** and written so the replacement is a local change: (1) R1-D4(b) and (c), the generation filter and the same-file-only usage update: the likely replacement is that `api_call` totals are NEVER gen-filtered, that the row with the LARGEST usage wins, that attribution (owner) is fixed at first insert, and that old values are read through a staging join before the upsert (sections 0 rule 2, 3.3, 5.3, OP-28); (2) R1-D5 file identity, which needs the explicit decision table of section 5.4 (written there from the coordinator's rule, still PENDING until R2 confirms it); (3) R1-D10 `/api/clear`, whose likely replacement is today's meaning (drop OTEL spans, rebuild derived data) instead of a watermark (section 8.2, OP-30); (4) the items of R1 that this spec already treats as OPEN (R1-D1 backend, R1-D4-ART mechanism).

Four rules that every later section repeats because they are the whole point:

1. **Pure derivation.** `rows_for_line` reads nothing but its arguments (no clock, no filesystem, no database). The same function runs for live tail, backfill, and the admin reindex that rebuilds derived tables from raw into a side database (R1-D10, which replaces D-10's rebuild-on-clear). Same input, same rows.
2. **Idempotency is per ROW (R1-D4, replacing D-4; (b) and (c) are PENDING R2/E7 - OPEN, see the callout above).** (a) A re-read of the same file bytes is prevented by the offset compare-and-set (D-8, D-ENG-5); the offset moves in the same transaction as the rows it covers. (b) A generation bump (replaced or pruned file) ingests the new generation as NEW rows; old-generation rows stay in the archive, hidden from display by `gen = file.gen`, and that node's rollup is RECOMPUTED from current-generation rows (node-scoped, section 5.3). (c) Cross-file duplicates (sibling subagent files, fork copies) matter only for totals: `api_call` is unique on `(source, message_id)` and usage columns are updated ONLY by a later row of the SAME file (section 3). (d) Rollup deltas are computed from the rows the batch actually applied (changed-row capture), never from the batch's input.
3. **Nothing is silently dropped or deleted.** Unparsable, unknown, oversized, torn and vanished things are stored raw, counted, and surfaced; no row or file state is ever deleted by ingest (RULE 0, D-11).
4. **The raw backend is pluggable (R1-D1 is OPEN).** Raw line storage is one of (D) a zstd column inside DuckDB, (C1) Parquet parts written by DuckDB `COPY`, (C2) Parquet parts written by the Rust parquet crate. Ingest talks to it only through the `RawSink` contract of section 2.7, so the choice made by the Rust bench changes no other section.

Accepted exceptions to "append-only" that this spec introduces (to be listed in the concurrency analysis, F summary note):

| id | update | why it must be an update | bound |
|---|---|---|---|
| UX-1 | `file_gen` row: `offset`, `size_seen`, `tail_hash`, `ctx` per batch | the CAS and resume context (D-8, D-9) | one row per file generation, about 28k rows, unindexed columns |
| UX-2 | `node.created_ms` NULL to value, once | set-once UPDATE on a non-indexed column when the first timestamped line arrives (R1-D5, duckdb-capabilities section 9); nodes without a timestamped line are not listed | once per node |
| UX-3 | `file.path` rebind on a detected move | file identity is `(dev, inode)`, the path is an updatable attribute (R1-D5, section 5.4) | rare |
| UX-4 | `api_call` usage columns, by a later row of the same file only (R1-D4(c)) | usage of one message grows across rows of one file (T Q2) | per message, guarded, section 3 |
| UX-5 | `node_rollup` per batch (D-3) | owned by D-3, listed for completeness | not this spec |
| UX-6 | legacy adoption (LEG section 4) | owned by LEG | not this spec |
| UX-7 | `file.gen` bump and the node-scoped rollup recompute on a generation bump (R1-D4(b)) | the display filter `gen = file.gen` and the current-generation totals | rare (0 superseded files in the corpus, T Q16) |

## 1. Discovery

### 1.1 Roots (reuse, unchanged)

The root resolvers in `discovery.rs` are reused as is, with their `Env` injection (VERIFIED, discovery.rs): `claude_projects_dirs` (CLAUDE_CONFIG_DIR list or `~/.claude/projects`, plus XDG), `codex_sessions_dirs` (CODEX_HOME or `~/.codex/sessions`), `copilot_session_state_dir` (`~/.copilot/session-state`), `vscode_family_workspace_storage_roots` (seven IDEs), `opencode_data_dirs`. Symlinked project directories and symlinked files stay invisible, as today (`collect_jsonl_files` uses `DirEntry::file_type()` which does not follow links, discovery.rs:170-183); that is a documented non-support, not an accident (F H6).

### 1.2 Classification: one function, name-pattern table

Today `collect_jsonl_files` keeps any regular file whose extension is `jsonl` (discovery.rs:170-183). That ingests `journal.jsonl` (112 files) and `*.orphaned-*.jsonl` as sessions and skips `*.jsonl.superseded-*` by accident of extension (T Q5, Q16). It is replaced by one classifier `classify_path(root, path) -> Kind` (the existing `LogRoots::classify`, discovery.rs:293, extended), applied identically by the full walk and the watcher path:

| path shape under the Claude projects root | Kind | derives a node? | what is stored | decision |
|---|---|---|---|---|
| `<proj>/<sid>.jsonl` | `claude_main` | yes, key = stem | raw + derived | as today |
| `<proj>/<sid>/subagents/agent-<id>.jsonl` | `claude_sub` | yes, parent = `<sid>` from the path | raw + derived | as today (lib.rs:1349-1356) |
| `<proj>/<sid>/subagents/workflows/wf_<id>/agent-<id>.jsonl` | `claude_wf` | yes, parent = `<sid>` (the directory two levels above `workflows`) | raw + derived | D-DAT-5; fixes the 3,137 files with no parent today (CAT delta D3) |
| `.../wf_<id>/journal.jsonl` | `aux_journal` | NO | raw only (role `journal`) | D-DAT-5; CAT delta D4. First line keys `agentId,key,type`; it is not a transcript (T Q5) |
| `<proj>/<sid>.orphaned-<ts>-<suffix>.jsonl` | `aside` | NO | raw only (role `aside`) | D-DAT-1, D-DAT-5, A retention section |
| `<proj>/<sid>.jsonl.superseded-<ts>` | `aside` | NO | raw only (role `aside`) | same; matched by NAME, because its extension is not `jsonl` |
| `<proj>/**/tool-results/<name>` (any extension) | `spill` | NO | raw chunks (section 1.3) | D-2 |
| `<proj>/<sid>/subagents/agent-<id>.meta.json` | `aux_meta` | NO | raw only, whole file | OPEN OP-7 (contents not inspected) |
| everything else | ignored | | | |

Why `aside` and `journal` are raw-only rather than skipped or ingested as sessions. A set-aside file is, per the docs, "a previous transcript for the session that Claude Code set aside instead of overwriting or deleting it" and is swept by retention like any transcript (A). The owner rule is that full content is copied into DuckDB and never lost (D header); skipping it would lose the only copy once retention fires. Ingesting it as a session would create a phantom node whose key carries the `.orphaned-...` suffix (T Q16) and would double-display its history. Raw-only keeps every byte, derives nothing, creates no node, and cannot double count tokens (it derives no `api_call` rows). The single orphaned file in the measured corpus is 232 bytes, 2 lines, identical to the head of its live successor (T Q16). Its legacy card, if any, is preserved by LEG as an orphan card (node absent after catch-up).

Node identity and natural key (R1-D5, which replaces D-DAT-5's "identity = file path"). A node's IDENTITY is the `(dev, inode)` of its session file: a moved or renamed file keeps its node and the path is an updatable attribute (section 5). The `node_key.session_id` string is a LOOKUP ALIAS frozen at first sight, used for legacy adoption and joins, never as identity: the file stem for `claude_main`, Codex and Copilot (identical to today's card key, lib.rs:1278 `file_stem`, so LEG's orphan test keeps working); for `claude_sub` and `claude_wf` the path-qualified `<parent_sid>/<stem>` and `<parent_sid>/wf_<id>/<stem>`, because subagent stems collide across parents (408 collisions, D-DAT-5) and today's stem-keyed card map loses one of each pair silently (F H3). Because identity is the inode, the 408 collisions cannot merge nodes even if two aliases ever coincide. The node row carries `agent_id` = the stem without the `agent-` prefix, the join key to `spawn_result.agent_id` (F H8, feed_merge.rs:159-170). LEG's orphan test for bare `agent-<hex>` card keys needs an alias lookup from the bare stem to the qualified key: OPEN OP-1 (cross-spec, owner LEG; note R1-DAT9: the orphan count may be skewed by colliding stems and moved files, and LEG applies its own exact rule).

### 1.3 Spill files (D-2, E5)

Facts (E5, VERIFIED): 743 `tool-results/` directories, 46,632 files, 0.94 GB; p50 3.9 KB, p99 125.6 KB, max 64 MiB; 46,490 text files (913.9 MB) and 142 `.jpg` (26.2 MB); growth about 18 MB/day over the last 30 days; the JSONL line holds only a preview and a path inside a `<persisted-output>` block, so the full content exists only in the spill file; Claude Code sweeps them with the session (A).

Rules:
- A spill file is a blob, not a line log. It is read in 1 MiB chunks by bytes (never split on newlines, so binary `.jpg` and a 64 MiB single-line text file are handled identically) and stored as `raw_line` chunk rows with `kind='spill'`, key (file_id, gen, byte_off) where `byte_off` is the chunk start. Reassembly is concatenation ordered by `byte_off`. Byte-exact round trip is a test (TS-23).
- The newline rule of section 6 does not apply to spill files; the identity and gen rules of section 5 do. A spill file that grows is continued from its offset; one whose head fingerprint changes starts a new gen.
- Ingest promptly, newest first (a spill is only referenced by path; once swept it is gone). Total backlog is 0.94 GB, so it is a small part of the backfill (E5 section 4).
- `tool_result.spill_path` is extracted from the result text: find the `Full output saved to ` phrase inside the `<persisted-output>` block and take the path up to whitespace, then relativize against the projects root. A text block without a parsable path leaves `spill_path` NULL and is counted by a `spill_ref_unparsed` row in the raw index parse note (OPEN OP-8: the exact grammar of the block was observed only as prose in E5).
- Deleted spill: row and chunks kept, `file.state='missing'` (section 5.5).
- Not copied (E5): `~/.claude/paste-cache` (2 MB), `/private/tmp/claude-*` scratch, image-cache (absent). Inline base64 images (899 lines, 426.9 MB) are already inside the JSONL lines and are stored once there.

### 1.4 Other sources

| source | path shape | session key | unit | identity |
|---|---|---|---|---|
| Codex | `<codex>/sessions/**/*.jsonl` (rollout files) | file stem (codex.rs build_result) | line | section 5 |
| Copilot CLI | `<copilot>/session-state/<uuid>/events.jsonl`, only that filename (discovery.rs:293 classify) | the directory name `<uuid>`, not the stem (copilot.rs:269, log_reader.rs:318-330) | line | section 5 |
| Copilot Chat delta log | `<ide>/User/workspaceStorage/<hash>/chatSessions/<uuid>.jsonl` | stem | line, stateful (section 4.3) | section 5 |
| Copilot Chat legacy | `<uuid>.json`, only when no `<uuid>.jsonl` sibling exists (discovery.rs:204-258) | stem | whole file, 64 MiB cap (copilot.rs MAX_JSON_BYTES) | by content change |
| OpenCode | `<opencode>/opencode.db` plus `-wal`, `-shm` | `session.id` per row | SQLite rows | section 4.4 |
| OTEL span segments | the span store day files `<utc-day>.ndjson` and sealed `<utc-day>.ndjson.gz` | n/a (spans are not sessions) | line | section 9.2 |

Codex files and Copilot logs get the same `aside`/`superseded` name rules as Claude (a name containing `.orphaned-` or `.superseded-` is raw-only), applied by the same classifier; no such file is known to exist for them (OPEN OP-9, never observed).

### 1.5 Watcher and backstop

Reused unchanged (VERIFIED): the recursive `notify` watcher over `watch_dirs` with canonical-path rebasing (log_reader.rs:1353-1400), the 300 ms debounce that collapses a burst into one targeted sweep (`WATCH_DEBOUNCE`, log_reader.rs:1266), the 60 s full-sweep backstop (`FULL_RESCAN`, log_reader.rs:1263), the unnamed-event promotion to a full sweep (log_reader.rs `Msg::Unnamed`), and the 5 s poll fallback when no watcher attached.

What changes: **scanning never parses.** A watcher event or a backstop sweep only stats and classifies a path and calls `scheduler.mark_dirty(file)`. The scheduler (D-8, F H3) owns `HashMap<FileKey, Idle | Queued | InFlight{lane}>` plus a `dirty` bit: an event for an `InFlight` file only sets `dirty` and the scheduler re-queues it after the commit; backfill never picks a dirty or in-flight file. The cheap unchanged gate stays as a pre-open optimization only: (mtime, size equal to the committed offset, inode) means skip without opening (log_reader.rs:456). Correctness never depends on it; the opened-handle checks of section 5 do. Time-of-check/time-of-use between a path `stat` and the open (F H6) is removed by taking identity from `fstat` of the opened handle only.

Live producers read at most `LIVE_MAX_BYTES` per turn from one file (initial value 8 MiB, F H3; tuned by SPEC-method-bench); the remainder of a large unread file moves to the BACKFILL lane, so a never-visited 700 MB transcript is never read at LIVE priority. LIVE producers (watcher-driven reads and the NDJSON tailer) run at NORMAL QoS; only BACKFILL runs at background QoS (R1-D7, section 8.2).

Boot: state comes from the index (`file_gen` offsets and ctx), not from the `log-offsets` sidecars, which are not read after cutover (all-at-once cutover, D header). The server answers immediately with the partial-corpus flag of section 8.4; today's boot gate (`boot_rx` handshake, log_reader.rs:1424-1450) is removed (F H18).

## 2. Per-line extraction

### 2.1 The function

```rust
/// Pure. No clock, no fs, no db. `ctx` is the only cross-line state (section 2.5).
fn rows_for_line(meta: &FileMeta, ctx: &mut Ctx, src: &LineSrc, line: &[u8], out: &mut BatchRows);

struct LineSrc  { file_id: u64, gen: u32, byte_off: u64, len: u32, line_hash: u64 }
struct FileMeta { kind: Kind, node_key: String, parent_session_id: Option<String>, agent_id: Option<String> } // fixed at first sight
```

One implementation per source: `claude`, `codex`, `copilot_cli`, `copilot_chat` (the chat delta log, stateful), plus the non-line `opencode` and `copilot_chat_json` described in section 4. Rust is the only place where the UTF-16 length parity helpers (`utf16_len`, `snip`, `cap_text`, lib.rs:53-90) are needed, because wire strings are capped in JS code units; the stored `*_head` columns store the capped text exactly as `snip`/`cap_text` produce it.

`BatchRows` is columnar per table and carries the rows, the set of touched `nk` (for `ingest_batch_root`, D-5), and the batch's min/max timestamps. It carries NO rollup deltas: the writer derives every delta from the rows the batch actually applied (R1-D4(d), section 3.3). The producer fills it, the writer only appends it (F H2).

### 2.2 Line pipeline (every line of every line-based source)

1. Split on `\n` only (a `\r` stays in the line; serde_json accepts trailing whitespace). Torn-tail rule: section 6.
2. Record a **raw index row for every complete line, including blank ones** (so the census is the newline count, F H29): `(file_id, gen, byte_off, len, line_hash, entry_type, ts_ms, parse_status)`, where `line_hash` is xxh3-64 of the line bytes, `entry_type` is the top-level `type` string (open set, dictionary VARCHAR, NEVER an ENUM, F H7), `ts_ms` is the parsed `timestamp` or NULL, and `parse_status` is one of `ok, blank, unparsable, non_object, invalid_utf8, oversize`. The raw bytes themselves go to the raw sink (section 2.7), whichever backend R1-D1 settles on. The columns `entry_type`, `ts_ms`, `parse_status`, `line_hash` are requested of the schema spec (OPEN OP-2): they make "unknown entry types are counted, never fatal" an ordinary `GROUP BY entry_type` and the census exact, with no extra counter table that could drift.
3. Invalid UTF-8: raw stored as BLOB bytes (D-1, F H7), `parse_status='invalid_utf8'`, no derived rows. Lossy decoding is rejected: it fabricates content and would make derived rows disagree with raw.
4. JSON parse with `serde_json::from_slice` into an object; a parse failure on a COMPLETE line is `unparsable`, a non-object value is `non_object`. These are statuses, not dead letters: raw is stored, nothing is retried, nothing stalls (the offset advances). Distinguish from DB-level failures (section 7.3).
5. Dispatch on `type` through a match with a catch-all arm. An unknown type produces the raw index row and nothing else.
6. Per-line time fields: `ts_ms = parse_ts_ms(timestamp)` (ISO UTC milliseconds, 100% of timestamped rows, T Q12; the nanosecond-string fallback of lib.rs `parse_ts_ms` is kept). An unparsable or absent timestamp is NULL, never 0.

### 2.3 Claude: what each entry type derives

Counts from T Q2 (558 files, 572,017 lines) show which types matter. Derived rows exist only for what operations need; everything else stays in raw (C-cards read raw JSON through SQL, CAT FND-02).

| entry type (share) | rows written |
|---|---|
| `assistant` (21%) | one `event` (kind `llm` or `tool`); one `api_call` candidate when `message.usage` is an object; one `tool_use` per `tool_use` content block with a non-empty `name`; one `spawn_edge` per `Task`/`Agent`/`Workflow` block; `node_meta` model note |
| `user` (18%) | one `event` (kind `user_input`); one `tool_result` per `tool_result` block that has a `tool_use_id`; one `spawn_result` when the line has EXACTLY ONE such block and `toolUseResult` is an object (lib.rs:811, F H24); set-once `node_meta` for the first qualifying user text |
| `system` (14%) | `event` only for `compact_boundary` (columns `compaction_trigger`, `compaction_pre_tokens`, `compaction_post_tokens`, CAT FND-03; the sub-field names inside `compactMetadata` are INFERRED from CAT, OPEN OP-6); timestamps feed node bounds; other subtypes (`turn_duration`, `stop_hook_summary`, `local_command`, `away_summary`, `scheduled_task_fire`, `informational`) raw only |
| `attachment` (20%) | none beyond node time bounds and first `cwd` |
| `ai-title` | `node_meta(key='title')`, last wins |
| `custom-title`, `agent-name` | `node_meta` (keys `custom_title`, `agent_name`) |
| `fork-context-ref` | `node_meta(key='fork_ctx')` with `agentId, contextLength, parentLastUuid, parentSessionId` (T Q2, Q9: identifies forked subagents; adds a second parent hint, not used for identity) |
| all other types (`queue-operation`, `mode`, `last-prompt`, `atis-latch`, `permission-mode`, `file-history-*`, `bridge-session`, `history-suppression`, `cost-state`, `pr-link`, `agent-setting`) | raw index row only |

Every timestamped line, of any type, updates the node's `first_ts`/`last_ts` bounds in the batch delta (today `on_entry` does this before the type test, lib.rs:754-760). The first non-empty string `cwd` seen sets `workspace` once; the first non-empty `entrypoint` sets `entrypoint` once (lib.rs:761-786) (both `node_meta`, set-once through ctx flags, section 2.5).

Key columns written on the display rows (all with the key `(file_id, gen, byte_off, sub_index)`, no index; idempotency from the offset CAS, D-4 as revised by R1-D4):

- `event`: `nk, ts_ms, ts_suspect, kind, turn, model, msg_key (HUGEINT, the api_call key, NULL for non-assistant), msg_first BOOLEAN, text_head, text_len, uuid, parent_uuid, span_ord`. `uuid`/`parent_uuid` are extracted (16 bytes each) because they are cheap, are the evidence for D-DAT-3 and D-DAT-4, and are 100% present on user/assistant/system/attachment lines and 0% elsewhere (T Q15); retaining them is for the schema spec (OPEN OP-2). `text_head` is a bounded prefix (initial 512 chars, OPEN OP-3 against the bench); the full text is a point read of the raw line, which D-1 measured at 4-6 ms p95.
- `tool_use`: `nk, ts_ms, tool_use_id, name, file_path (first non-empty of file_path, filePath, path, lib.rs coalesce_string), op (read, edit, write, other), in_bytes, files_changed_note`. `op` follows lib.rs exactly: `Read`/`read_file` is read; `Edit`, `MultiEdit`, `replace_string_in_file`, `NotebookEdit` is edit (`in_bytes` = `edit_input_bytes`, which sums `edits[].new_string` for MultiEdit, else `new_string`, `newString`, `content`); `Write`/`create_file` is write (`in_bytes` = UTF-8 length of `content`).
- `tool_result`: `nk, ts_ms, tool_use_id, bytes (UTF-8 length of the string content or the sum of text blocks, lib.rs tool_result_bytes), summary_head (200 UTF-16 units), spill_path, is_error`.
- `spawn_edge` (written when the `Task`/`Agent`/`Workflow` tool_use is read, immutable): `parent_nk, tool_use_id, spawn_turn (= ctx.turn at that line), spawn_ts_ms, spawn_kind (fleet when the tool is Workflow, fork when subagent_type is fork, worktree when isolation is worktree, else fresh), requested_type (subagent_type else description), prompt_head (32k cap), model_override, isolation`. First write per `(parent_nk, tool_use_id)` wins (lib.rs:636-640 returns early on a known id).
- `spawn_result` (its own append-only row when the result line is read, never a patch to the edge, F H8): `parent_nk, tool_use_id, agent_id, status, is_async, usage buckets, total_tokens, tool_use_count, duration_ms, agent_type, resolved_model, tool_stats (readCount, searchCount, bashCount, editFileCount, otherToolCount), final_text_head (4000 UTF-16 units)`. The `status: async_launched` shape (no usage or no totalTokens) writes `is_async=true` with `agent_id`/`resolved_model`; a later non-async result is a second row and wins by `(gen, byte_off)` at read (lib.rs:673-710).
- `node_meta(nk, key, value, gen, byte_off)`: INSERT-only; read as `arg_max(value, (gen, byte_off))` for last-wins keys (`title`) and `arg_min` for set-once keys (F H26); keeps text out of the hot rollup (F H10).

Cross-line joins that today need accumulator state are NOT state any more; they are read-time joins on an id:

| today's accumulator (ClaudeAccum, lib.rs:389-424) | replaced by |
|---|---|
| `pending_reads` (tool_use id to file path, resolved at a later line to add read bytes) | join `tool_use(op='read')` to `tool_result` on `tool_use_id` at read time |
| `pending_tool_results` (attach `fullResult`/`resultSummary` to the issuing entry) | same join; summary = first non-empty result by `byte_off`, full = last, as `attach_full_result` overwrites and `result_summary` is set only while None (lib.rs:723-750) |
| `sub_agents` (spawn then complete) | `spawn_edge` join `spawn_result` on `(parent_nk, tool_use_id)` |
| `seen_message_ids` (first row wins) | global `api_call` upsert (section 3) |
| `has_fast_mode`, `saw_standard_speed`, `blend_turns`, `peak_context_per_turn`, `model` | aggregates over `api_call` (`bool_or(speed='fast')`, `bool_or(speed IS DISTINCT FROM 'fast')`, `max(input+cache_read+cache_create)`, last non-synthetic model by `byte_off`) |
| `tool_counts`, `total_tool_calls`, `files_*`, `file_ops` | `GROUP BY` over `tool_use`/`tool_result` |
| `gen_files` (scratch-path harvest) | not derived: `generatedFiles` stays outside DuckDB (CAT NS-5). The harvest is a pure per-line function and could be stored as `tool_use.scratch_paths`; OPEN OP-10 (owner of NS-5) |

### 2.4 Mapping table: today's card field to rows (lib.rs `Card` L1017-1077, `TimelineEntry` L162-206, `ParsedTranscript`)

`NODE` = `node` row; `META` = `node_meta`; `ROLL` = `node_rollup` numeric columns maintained from batch deltas (D-3); `API` = aggregate over `api_call WHERE nk = :nk`. Every "read" is a read-api concern (SPEC-read-api); this table fixes only what ingest must write so that the field is derivable.

| card field | derivation |
|---|---|
| sessionId, traceId | `node_key.session_id` (section 1.2) |
| source, dataSource, tokensSource | `node.source` = the agent source (`claude_code`, `codex`, `copilot`, `opencode`), `node.origin='live'` (R1-ORIGIN: `live`, `legacy`, `import`), `data_source='log'`; constants for the others |
| initiator | `META('initiator')`: set once by the first qualifying user line (`agent` if that line has `isSidechain=true` while no request is set; `api` if its text starts with `<local-command-caveat>`, then request = text after the caveat or `[api session]`; else `user`, lib.rs:790-800); then forced `agent` by path kind (`claude_sub`, `claude_wf`, worktree project dir, lib.rs:1344-1352) |
| parentSessionId | `node.parent_session_id`, from the path at first sight, a string never an nk (F H8) |
| spawnedByTurn, spawnKind, spawnModelOverride, spawnIsolation, spawnSubagentType, spawnAsync | for a placeholder child: `spawn_edge` join `spawn_result`; for a transcript child: the same row found through `spawn_result.agent_id = node.agent_id` (link predicates are the read-api's, feed_merge.rs:159-245) |
| workspace | `META('workspace')`, first non-empty `cwd` |
| title | `META('title')`, last `ai-title`, `snip(200)` at read |
| entrypoint | `META('entrypoint')`, first non-empty |
| timelineTruncatedCount, timelineRetainedBytes | none: timelines are uncapped (CAT delta D5) |
| userRequest | `META('user_request')`, first qualifying user text, stored capped at 32k units, `snip(500)` at read |
| model | last non-synthetic `api_call.model` by `byte_off`; `-fast` suffix iff `bool_or(speed='fast')` and not `bool_or(speed IS DISTINCT FROM 'fast')` (lib.rs:1269-1285); `claude` if none |
| turns, totalLlmCalls | `ROLL.turns` = `count(*)` of owned `api_call` rows with `counted` (section 3), because each counted row is one message with usage |
| inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, cacheCreate1hTokens | `ROLL` sums of `API` buckets (disjoint, as reported; 1h from `cache_creation.ephemeral_1h_input_tokens`, NULL-aware) |
| cacheHitRate | `cache_read / (input + cache_read + cache_create)` computed at read |
| durationMs, startTime | `ROLL.last_ts - first_ts` (both from all timestamped lines), clamped at 0; `start = first_ts` |
| filesRead, filesChanged, filesWritten | distinct `tool_use.file_path` by `op` (read; edit or write; write), ordered by first `byte_off` (an `IndexSet` today). `filesSearched` is always empty today (never populated, lib.rs on_entry) and stays empty |
| fileOps | `tool_use` (edit_count, write_count, `in_bytes`) joined to `tool_result.bytes` (read_count, read_bytes) per path |
| toolCounts, totalToolCalls | `GROUP BY name` over `tool_use` |
| errors | always 0 today; stays 0 |
| outcome | `tool_calls` if `total_tool_calls > 0` else `text_response`; sub-agent placeholder: `unknown` if async, else by `tool_use_count` |
| peakContextPerTurn | `max(input + cache_read + cache_create)` over `API`, present only when turns > 1 |
| backgroundSpans, loopSignals | empty in the log path; OTEL-derived elsewhere (FND-06) |
| timeline[] | `event` rows (user_input, llm, tool) ordered by `(ts_ms, file_id, byte_off)`; per-field below |
| childCards | placeholder cards = `spawn_edge` join `spawn_result` where the result is done (lib.rs:1152-1157), id `agent_id` or `<parent>-sub-<tool_use_id>`; their tokens from `spawn_result` (disjoint buckets of `toolUseResult.usage`), `cache_hit_rate = cache_read / total_tokens`, tool counts from `tool_stats` |
| blendTurns, speedBlendedCostUsd | per-call `api_call` rows priced at read by the one pricing function (pricing stays Rust, CAT FND-04) |
| accountId | outside ingest (FND-09 `account_state`/`account_map`, F H11) |
| generatedFiles | outside DuckDB (CAT NS-5, OP-10) |
| lastTimestampMs, fileSizeBytes | `file_gen.size_seen`, `ROLL.last_ts` |

`TimelineEntry` fields: `type`/`label` from `event.kind` (`user_input`/`User`, `tool`/`Tool calls`, `llm`/`Response`); `spanId` = `log-u-<n>` / `log-a-<n>` with `n` = `event.span_ord`, the ordinal of user-plus-assistant entries kept in ctx (unique per node; after a gen bump it continues rather than restarts, so it is unique, not contiguous: a documented delta ING-D6); `turn` = `event.turn` (user entries `turn+1`, assistant entries `turn`, lib.rs:821, 960); `model` = `event.model` (the last non-synthetic model seen up to that row, hence `ctx.model`); `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreateTokens`, `cacheCreateTokens1h` = the joined `api_call` row, shown on the entry where `msg_first` is true (today only the first row of a message carries tokens, lib.rs:866-900), `cacheCreateTokens1h` NULL (not 0) when the usage had no `cache_creation` object (lib.rs:176-190 distinction); `durationMs` 0, `isError` false, `errorMessage`/`action`/`toolInput` absent for Claude; `timestamp` = ISO rebuilt from `ts_ms`; `responseText` = `text_head` or a raw point read, capped at 32k units; `resultSummary`/`fullResult` per the join rule above. `fullResult` cap is 500,000 chars before the 32k field cap (lib.rs MAX_TOOL_RESULT_CHARS), a read-time rule.

### 2.5 Cross-line state: `ctx`, and its size bound

After section 2.3 removed everything that is a join, the state that genuinely cannot be derived by a join is small and fixed:

| ctx field | why it cannot be a join | size |
|---|---|---|
| `span_ord` (u64) | wire span ids count user and assistant entries in line order | 8 B |
| `turn` (u64) and `recent_msg_keys` (ring of the last 64 message-key hashes) | `event.turn` and `msg_first` need "is this message new in this file"; assistant rows of one message are adjacent in practice, the ring makes it robust to interleaved non-assistant lines. A message id older than the ring that reappears bumps `turn` once more: `event.turn` is a display number; counts come from `api_call` (so no total depends on it) | 8 B + 1 KiB |
| `model` (last non-synthetic) | `event.model` is a running value | at most 64 B |
| set-once flags: `workspace_set`, `entrypoint_set`, `user_request_set`, `initiator` (enum) | first-qualifying-line semantics (F H26) | 8 B |
| Codex: `turns`, `last_ts_event_msg` | codex.rs counts `last_token_usage` presence and advances `last_timestamp` only on `event_msg` | 16 B |
| Copilot CLI: nothing beyond flags | section 4.2 | 8 B |
| Copilot Chat: `request_push_count`, per-turn merged state `{ts, completion, prompt}` | section 4.3 | 24 B per turn, cap 4096 turns |

Bound: `ctx` serialized is at most 8 KiB for every source except Copilot Chat (cap 4096 turns, about 100 KiB; exceeding the cap is an `ingest_error(kind='ctx_overflow')`, loud, OP-11). It is stored in `file_gen.ctx` and committed with the offset (UX-1, D-9). This replaces the 24-file LRU accumulator cache (log_reader.rs:403) and the unrestored-after-restart accumulator (F H5) with an exact, restart-safe, kilobyte-sized state. A property test (TS-4) proves that splitting a file at every line boundary gives identical tables.

### 2.6 Node creation

A node row is created by the writer at the first batch of a file and is immutable except UX-2: `node(nk, source, origin, kind, file_id, parent_session_id, agent_id, created_ms)` with `source` the agent source and `origin='live'` (R1-ORIGIN: legacy and imported nodes carry `origin='legacy'` or `'import'` and keep their agent `source`; the legacy spec is to be aligned). `created_ms` is the first timestamped line (D-DAT-6: 9,912 files begin with an untimestamped line; T), filled by the one UPDATE of UX-2 when the first batch that carries a timestamp commits. Lists filter `created_ms IS NOT NULL`, which also reproduces today's "no timestamp, no card" (lib.rs:1273-1275, F H8). `nk` is allocated only on the writer thread (F H11). A stub reference from a path-derived parent id allocates the parent's `node_key` without a node (F H8).

### 2.7 Raw storage plug-in (R1-D1 OPEN: D, C1 or C2)

R1-D1 leaves the raw-line backend open between (D) a zstd VARCHAR/BLOB column inside DuckDB (transactional, no staging, 0.22 GB per GB raw, higher CPU), (C1) Parquet parts written by DuckDB `COPY` (0.128 GB/GB, DuckDB-native) and (C2) Parquet parts written by the Rust parquet crate (0.138 GB/GB); on a tie of RAM and CPU the DuckDB-native choice (D or C1) wins. The ingest is written so any of the three plugs in:

```rust
struct RawRow { file_id: u64, gen: u32, byte_off: u64, kind: RawKind /* line | spill_chunk | oc_row */, bytes: Vec<u8> }
trait RawSink {
    /// Called by the writer INSIDE the batch transaction, before COMMIT.
    fn stage(&mut self, txn: &Txn, rows: &[RawRow]) -> Result<()>;
    fn read(&self, file_id: u64, gen: u32, byte_off: u64) -> Result<Vec<u8>>;           // point read
    fn read_range(&self, file_id: u64, gen: u32, from: u64, to: u64) -> RowIter;        // replay: reindex, C-cards
}
```

Backend-independent contract (what the rest of this spec may rely on):
1. The raw INDEX row `(file_id, gen, byte_off, len, line_hash, entry_type, ts_ms, parse_status)` always lives in a DuckDB table and is written in the batch transaction, whatever the backend. It is the census and the lookup key.
2. `stage` makes the bytes durable-or-recoverable BEFORE the transaction commits: (D) the column insert is itself transactional; (C1, C2) the bytes go to a staging table in the same transaction.
3. **An offset never advances past a line that is not durable in the database (staging) or in a registered part.** This is the one invariant ingest adds to every backend.
4. Sealing a staged run into a part (C1, C2) is a writer-side job outside the batch transaction with the R1-D1 crash protocol: write a temp file, fsync it, rename, fsync the directory, then one transaction that registers the index rows and deletes the staging rows; startup reconciles the manifest against the files on disk; parts are self-describing (each row carries `file_id, gen, byte_off, path`) so the index can be rebuilt from parts alone; the Parquet row group is capped by BYTES as well as rows, so lines up to 4.4 MiB cannot inflate writer memory (R1-D1).
5. A differential test (TS-29) runs the same fixtures through every backend that is built and compares `read` bytes, index rows and the census.

Where cost depends on the backend, section 8.3 lists the figure per backend instead of assuming one.

## 3. Usage: one row per (source, message id), same-file updates only

Facts (T Q2, VERIFIED): in main files every row of a repeated `message.id` carries identical usage (12,190 ids, 0 differ); in subagent files 1,876 ids repeat and 1,736 differ, with `output_tokens` growing in every differing group (95% of subagent output sits in the delta between first and last row); today's parser takes the FIRST row (`is_first_row`, lib.rs:850-870) and so undercounts subagent output. Sibling subagent files in one session carry identical rows (same uuid, message.id, requestId, usage; 81,766 shared head uuids across 1,134 file groups); the one fork pair keeps uuid, message.id, requestId and rewrites `sessionId` (T Q9).

Decisions applied: R1-D4(c) and (d) (replacing D-4), D-DAT-2 as narrowed by R1-D4(c) (the last row wins, but only within one file), D-DAT-3 and D-DAT-4 (a copied call counts once, attributed to the first-ingested node), D-ENG-3 (collapse inside the batch first).

### 3.1 Key

`api_call` is UNIQUE on `(source, message_id)`. The stored key is `msg_key` = xxh3-128 of `source + 0x00 + message.id` (HUGEINT; the strings stay in non-indexed columns for diagnostics, OP-2). If `message.id` is absent (0 of 114,862 in M300, T Q10) the id part is `u:` + `uuid` when `uuid` exists, else `f:` + `file_id` + `:` + `gen` + `:` + `byte_off`: such a row counts once, as today (`is_first_row` is true when there is no id). The `sessionId` field is NEVER part of the key (T Q9: forks rewrite it).

The uniqueness MECHANISM is OPEN until experiment E6 (R1-D4-ART): an ART index on the 128-bit key, an index-free anti-join restricted by timestamp (duplicates share the exact timestamp), or monthly key partitions; E6 measures resident memory at 1M, 5M and 20M keys (growth is about 5-9M keys per year), whether ART memory is released by CHECKPOINT or only by reopen, and insert CPU. Ingest is written against a mechanism-independent call, `apply_api_calls(candidates) -> changed rows`, and supplies what each candidate mechanism needs: `msg_key` (ART), `first_ts_ms` and `month` (the restricted anti-join and the partitions). `first_ts_ms` is the timestamp of the FIRST row of the message seen in the file; for a message still inside the 64-entry ctx ring it is exact, for an older id that reappears it is the row's own timestamp. Whether all rows of one `message.id` share an exact `timestamp` is not measured and decides whether the timestamp-restricted mechanism is even sound: OPEN OP-24 (probe).

### 3.2 Candidate row (from an `assistant` line with `message.usage` an object)

Columns: `msg_key, source, message_id, file_id, gen, byte_off, ts_ms (first_ts_ms of the message), upd_ts_ms (this row), model, request_id (top-level requestId, about half the rows, D-DAT-10, T Q2), speed (usage.speed), service_tier, input, output, cache_read, cache_create, cache_create_5m, cache_create_1h, has_tier_split, kind, counted`.

- Buckets are the disjoint figures exactly as `disjoint_anthropic` reads them (lib.rs:147-160): finite positive JSON number else 0 (a string `"5"` is 0). Stored BIGINT (D-ENG-10); values at or above 1e16 clamp to 9e15 and set a `usage_clamped` note; non-integral numbers truncate toward zero.
- Tier split: `cache_create_1h` = `usage.cache_creation.ephemeral_1h_input_tokens` and `cache_create_5m` = `...ephemeral_5m_input_tokens` when the `cache_creation` object exists (11,556 of 11,904 rows, T Q2; `has_tier_split=true`); when it does not (348 rows, 2.9%) both are NULL, never 0, which keeps the `Some(0.0)` vs `None` distinction of lib.rs:176-190. OTEL has no 5m/1h split (A, D-DAT-10): the transcript is the only source, so no OTEL value ever fills these columns.
- `speed` is `usage.speed` (present on 10,382 of 11,904 rows); `fast` rows drive mixed-speed handling at read.
- `request_id` is the join key to OTEL `api_request.request_id` (A). Merge rule on update: `coalesce(new.request_id, old.request_id)`.
- `isApiErrorMessage` rows and `<synthetic>` models are stored like any other (a synthetic model never becomes the node model at read, lib.rs:843-849).

### 3.3 Apply (writer, inside the batch transaction) - PROVISIONAL, PENDING R2/E7 - OPEN

What follows is R1-D4(c) as written (same-file-only updates, guarded by `(gen, byte_off)`). Revision 2 is expected to replace the guard: **the row with the largest usage wins, regardless of file; the owner (attribution) is fixed at the first insert; the old values are read through a staging join before the upsert so the rollup delta is `new - old` of the rows actually changed; `api_call` totals are never filtered by generation.** If R2 confirms it, only step 2 of the list below changes (the `a.file_id = c.file_id` condition becomes `c.usage_rank > a.usage_rank`, with `usage_rank` a total order on the usage columns, `output` first), the SQL guard follows, and the OP-25 sibling risk disappears (a later or larger row from any file corrects the call) at the price of letting a sibling's value replace the owner's. Nothing else in this spec depends on which rule wins, because the deltas are always taken from captured changed rows (R1-D4(d), unchanged).

Per batch (one file, one generation per row, so the collapse is by `(gen, byte_off)`):

1. Collapse inside the batch: keep, per `msg_key`, the candidate with the greatest `(gen, byte_off)` (`QUALIFY row_number() OVER (PARTITION BY msg_key ORDER BY gen DESC, byte_off DESC) = 1`, D-ENG-3).
2. For each collapsed candidate `c` against the stored row `a` (found by the E6 mechanism):
   - no `a`: INSERT, owner = `c.file_id`. Captured as an inserted row.
   - `a.file_id = c.file_id` AND `(c.gen, c.byte_off) > (a.gen, a.byte_off)`: UPDATE the usage columns, `gen`, `byte_off`, `upd_ts_ms`, `request_id`. Captured as an updated row with its old and new values. R1-D4(c) states the guard as `excluded.file_id = api.file_id AND excluded.byte_off > api.byte_off`; `gen` is added to the comparison because a generation bump restarts offsets at 0, so `byte_off` alone is not monotone across generations (OP-26, to confirm).
   - anything else (a row from another file, or an older or equal row of the same file): NOTHING. A sibling or fork copy never reassigns or re-counts a call, and a re-read of the same bytes never fires an update.
3. Rollup deltas come ONLY from the captured changed rows: for an insert `+new` and `+1` turn; for an update `new - old` per bucket (R1-D4(d)). They are never computed from the candidates. The per-node deltas are aggregated per `nk` of the OWNER and applied as one set-based UPDATE (D-3, F H10).

```sql
-- candidates collapsed in `c`; `a` located by the E6 mechanism; changed rows captured for the delta step:
INSERT INTO api_call SELECT ... FROM c WHERE NOT EXISTS (<E6 existence check on c.msg_key>) RETURNING nk_owner, buckets;
UPDATE api_call a SET input=c.input, output=c.output, ..., gen=c.gen, byte_off=c.byte_off
  FROM c WHERE a.msg_key=c.msg_key AND a.file_id=c.file_id AND (c.gen, c.byte_off) > (a.gen, a.byte_off)
  RETURNING a.nk_owner, (c.output - old.output) AS d_output, ...;   -- old values joined before the update
```

Consequences, all deliberate and listed as deltas (section 11):
- **Owner = first ingested.** Display rows (`event`, `tool_use`, `tool_result`) are NOT deduplicated and appear in both sibling files; only `api_call` is unique. A sibling or fork node ingested second shows fewer calls than its file contains. Per-node subagent totals for a shared prefix therefore depend on which sibling was ingested first (newest-first backfill makes "first" arbitrary); corpus totals do not (D-DAT-3, D-DAT-4).
- **Risk, not hidden (OP-25).** If the first-ingested sibling holds an INCOMPLETE row of a growing message and the other sibling holds the later row, the call stays at the lower value and is never corrected, because cross-file updates are forbidden by R1-D4(c). The only evidence that siblings agree is one pair with 101 shared assistant rows of identical usage (T Q9); that is not a proof. Test TS-12b measures disagreement across the 1,134 sibling groups; a nonzero result goes to the owner (the alternative, allowing a cross-file update when `output` is strictly larger, contradicts R1-D4(c)).
- A usage-less first row of a message no longer blocks a later row that has usage; today it does (`seen_message_ids` is marked for a row without usage, lib.rs:850-857, F H5). That is delta ING-D1.
- On a generation bump a message re-asserted by the new generation is updated to the new `gen` by the same-file guard; a message that only the old generation contained keeps its old `gen` (archived, section 5.3).

## 4. Other sources

### 4.1 Codex (VERIFIED: codex.rs)

Rows: `session_meta` (payload `cwd`) sets `workspace` once; `turn_context` (payload `model`) and `event_msg` `token_count` (`info.model`) set the model, last wins; the first `event_msg` `user_message` sets `user_request` through `extract_codex_user_text` (marker `## My request for Codex:\n`); `info.last_token_usage` present increments `ctx.turns`. Timestamps: `first_ts` from any typed line, `last_ts` advances only on `event_msg` lines (codex.rs on_entry), so Codex node bounds differ from Claude's by design.

Tokens: `info.total_token_usage` is CUMULATIVE, so only the latest counts and summing per-turn values drifts (codex.rs header). Represented as ONE `api_call` row per Codex node: key `xxh3-128('codex:' + node_key)`, `kind='cumulative'`, `counted=true`, replaced by every later `token_count` snapshot (guard `(gen, byte_off)` strictly greater; rollup delta = new - old, section 3.3). OpenAI shape is shed at extraction: `input = max(input_tokens - cached_input_tokens, 0)`, `cache_read = cached_input_tokens` (cached is a SUBSET of input), `output = output_tokens + reasoning_output_tokens`, `cache_create = 0`, 1h NULL (codex.rs build_result). No events, no tool rows (the Codex card has an empty timeline). Window functions over `api_call` treat `kind='cumulative'` rows as having no per-call timestamp: OPEN OP-5 (whether burn windows exclude them; today burn reads Claude-derived data, not verified here). `node.conversation_id` (CAT FND-01) cites `codex.rs:695`, which does not exist in the 194-line logscan codex.rs: OPEN OP-12 (locate the source field before FND-01).

### 4.2 Copilot CLI (VERIFIED: copilot.rs:269-405)

Session id = the DIRECTORY name. Rows per event type: `session.start` (`selectedModel`, `context.cwd`, `startTime` fallback for the first timestamp); `user.message` (first only, `transformedContent` through the XML-block skipper); `assistant.message` (`outputTokens`, `toolRequests[]`, `model`); `session.shutdown` (`modelMetrics`). `last_ts` advances on `user.message`, `assistant.message`, `session.shutdown` only.

Tokens: per-message `outputTokens` are on `assistant.message`; input, cache read and cache write exist ONLY in `session.shutdown.modelMetrics[*].usage` (`inputTokens`, `cacheReadTokens`, `cacheWriteTokens`) and the parser SUMS over every shutdown event and model entry (copilot.rs:375-385). Representation:
- each `assistant.message` with non-zero `outputTokens`: one `api_call` row, `kind='call'`, `counted=true`, key `xxh3-128('cli:' + node_key + ':' + line_hash + ':a')`, output only; this is also the turn count (turns = rows with non-zero output, copilot.rs:333-339);
- each `modelMetrics` entry of each `session.shutdown`: one `api_call` row, `kind='aggregate'`, `counted=true`, key `xxh3-128('cli:' + node_key + ':' + line_hash + ':s:' + model)`, input/cache buckets only, output 0 (so output is not counted twice).

Keys use `line_hash`, not `byte_off`, so a re-read of the same bytes at a different offset (a rotated, pruned copy) is a no-op. Two byte-identical lines in one file would merge; each line carries timestamps or ids so this is not expected (OPEN OP-13, one probe on the local `session-state` directories). Tool counts and `files_changed` (tools `edit`, `write`, `create` with `path` or `file_path`) come from `tool_use` rows with `tool_use_id` NULL. Limitation, visible not hidden: an active or crashed session has no input or cache tokens until it shuts down (copilot.rs header); a node with no `kind='aggregate'` row is reported `tokens_partial` by a read-time predicate.

### 4.3 Copilot Chat delta log (VERIFIED: copilot.rs:410-570)

Line grammar: `kind=0` snapshot (`v.creationDate`, `v.inputState.selectedModel.metadata.family` else `.id`), `kind=2` push (`k=["requests"]`, `v` an array of request objects), `kind=1` set (`k=["requests", idx, field]`). The parser keeps per-turn state indexed by `turn_idx = request_push_count + j` for pushes, and the fields arrive in separate lines:

| source line | writes (per `turn_idx`) |
|---|---|
| push item `completionTokens`, `timestamp`, `modelId`, `message.text` (turn 0 only) | completion (first value only, `entry().or_insert`), ts, model if still empty, first user text |
| set `["requests", idx, "completionTokens"]` | completion, OVERRIDES any push value |
| set `["requests", idx, "result"]` | `result.usage.completionTokens` (override), `result.usage.promptTokens` (prompt), `metadata.renderedUserMessage` for the first user text |

Because the final per-turn value is a merge across lines (and a set always beats a push), a single line cannot be turned into a final row. Defined key and merge, with ctx as the merger: `ctx` holds `request_push_count` and `turns: Vec<{ts, completion, prompt, completion_from_set}>`; every line updates ctx exactly as copilot.rs does; at batch end the producer emits ONE `api_call` row per TOUCHED `turn_idx`, key `xxh3-128('chat:' + node_key + ':' + turn_idx)`, `kind='call'`, `counted = (completion present)`, buckets output = completion, input = prompt. The writer upserts with guard "later `(gen, byte_off)` of the last line that touched it wins" (a snapshot of the merged state, so a later batch always supersedes an earlier one and re-delivery is a no-op). This is the idempotent key the brief asks for: `(node_key, turn_idx)`, with the merge done in ctx, not in SQL, because SQL has no way to know that a `set` outranks a `push` that arrived earlier. Node visibility mirrors today's "no card unless at least one turn and a creation date" (copilot.rs:543-545): `created_ms` (UX-2) is set to `creationDate` when the first counted turn row commits; before that the node is hidden.

Duration: `end = max(turn timestamps)` else `creationDate` (copilot.rs:551-553). Read through `ROLL.last_ts`, which for chat nodes takes the max push `timestamp` (lines carry no top-level timestamp, so the generic "every timestamped line" bound does not apply).

OPEN OP-14: today a `kind=0` snapshot's own `requests` array is ignored (copilot.rs:421-440 reads only `creationDate` and the model); if VS Code writes a fresh `kind=0` mid-file after compacting the log, `request_push_count` would be wrong. Probe real chat files before relying on parity; until then parity is kept.

Legacy single-file `.json` (copilot.rs:575): not line-based. Re-read on `(mtime, size)` change through the section 5 handle checks (a changed fingerprint is a new gen); raw stored as 1 MiB chunks (like spill); derived: `node`, `node_meta` (model, workspace from the sibling `workspace.json`, `user_request`), one `tool_use` row per `toolInvocationSerialized` response entry (`name` = `toolId`), `turns = requests.len()`, no tokens (the format has none). Rows are keyed by `(node_key, 'json')` with the newest gen superseding (`arg_max` by `gen`).

### 4.4 OpenCode (VERIFIED: opencode.rs; the DB is not a log)

The DB is read read-only with SQLite's native WAL handling (opencode.rs:119-135); the existing schema-drift guard (`PRAGMA table_info(session)` must show `model` and `tokens_input`, else skip and report) is kept. Tables and keys: `session(id, directory, title, time_created, model JSON, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, parent_id)`, `message(id, session_id, data JSON, time_created)`, `part(id, session_id, message_id, data JSON)`.

Rows are UPDATED IN PLACE: the session token columns are counters on the row, a message gains `time.completed` and `tokens` when it finishes, a tool part moves through pending, running, completed (T Q7). Therefore:

- **Identity** is the SQLite primary key (`session.id`, `message.id`, `part.id`), never `time_created` and never an offset.
- **Change cursor.** `time_created` is immutable, so a cursor on it can never see an update. The cursor is `(time_updated, id)` per table WHEN the column exists (probed with `PRAGMA table_info` on every open, as the drift guard does), with a 60 s overlap on re-read and an equality skip on a per-row content hash (xxh3-64 of the row's columns), so a re-read of an unchanged row writes nothing. When `time_updated` is absent the fallback is a full scan with the same hash skip, gated by the DB change gate (stat of the db and its `-wal`, as `process_file` does for OpenCode, log_reader.rs:561-570). Whether the column exists in the installed OpenCode is OPEN OP-15 (T lists only `time_created`); the implementation must detect, not assume.
- **Versions, not deletes.** A changed row is APPENDED as a new version whose `gen` is a per-row monotone version number, key `(file_id=db, gen=version, byte_off=hash64(table + id), sub_index)`; readers take the max `gen` per `(file_id, byte_off)`. No DELETE runs against any display table (D-ENG-2, D-ENG-8). Raw preservation: each version's envelope `{table, id, session_id, message_id, time_created, data}` is a `raw_line` row.
- **Derived.** `session` row to `node` (`source='opencode'`, key = `session.id`), `META` (title, `directory` as workspace, model id from `model.id`), and ONE `api_call` row `kind='cumulative'`, `counted=true`, key `xxh3-128('oc:' + session.id)`, buckets `input = tokens_input`, `output = tokens_output + tokens_reasoning`, `cache_read`, `cache_create` (clamped, anthropic-shaped passthrough, opencode.rs `b_in..b_cw`), replaced on every change (a later row of the same file by the guard of section 3.3, where for OpenCode the per-row version number is `gen`, so the guard is monotone). Per assistant message: `event` kind `llm` (`Turn <n>` label, message tokens, `time.created`, duration = completed - created) plus an `api_call` row `kind='detail'`, `counted=false` (display tokens only; the card total comes from the session counters, exactly as today, so counting both would double). Per tool part: `event` kind `tool` plus `tool_use` and `tool_result` rows (`op` from `state.input.filePath` and tool name: read, glob, grep read; write, edit, patch write and change, opencode.rs tool loop), `summary_head` from `state.output` (first 2000 chars read, 200 kept), `is_error` when `state.status='error'`.
- **Parity filter kept.** Today only root sessions (`parent_id` null or empty) with a positive token sum are listed (opencode.rs session query). Child sessions are not ingested; whether they should become spawn children is an owner decision with no evidence available: OPEN OP-16.
- **Deletions in the DB are not observable** without a full diff; rows already ingested are kept as history (D-11 spirit). Listed, not solved.
- OpenCode has no `turn` field on entries (opencode.rs TimelineEntry comment): `event.turn` NULL.

## 5. File identity, generations, rotation, moves, deletion

### 5.1 Model

- `file`: one row per slot (a node's file, an aux file, a spill file, a day segment): `file_id`, `kind`, `source`, `path` (current, updatable, UX-3), `gen` (the CURRENT generation, UX-7), `state` in `{active, missing, aside_drained}`, `node_key` (NULL for raw-only kinds).
- `file_gen`: one row per physical generation of a slot: `(file_id, gen, dev, ino, fp_len, fp_hash, tail_hash, offset, size_seen, torn_bytes, lines_read, ctx BLOB, opened_ms, closed_ms)`. `offset` and `ctx` are the CAS target (UX-1).

Decisions: D-DAT-1 (a mismatch of `(dev, inode)`, head fingerprint or newline-at-offset starts a new generation), R1-D5 (node identity is the `(dev, inode)` of the session file and the path is an updatable attribute: a moved file keeps its node; the file is RECOGNISED through `file_gen.(dev, ino)` lookups, and later generations of the same slot are recorded under the same `file_id`), F H6 (take every identity fact from the opened handle).

### 5.2 Opening and verifying (every read, from the opened handle)

1. `open(path, O_RDONLY)`; on macOS set `F_NOCACHE` for backfill reads of files over 64 MiB so the one-time 18.7 GB read does not evict the page cache (INFERRED, not measured; OP-17).
2. `fstat(fd)` gives `(dev, ino, size)`. No path `stat` participates.
3. If `size < offset`: truncation, new gen.
4. If `(dev, ino) != gen.(dev, ino)`: replaced or renamed, new gen (but see 5.3 first).
5. Else `pread` the first `fp_len` bytes (`fp_len = min(4096, offset)` as recorded) and the 64 bytes before `offset`, plus the byte at `offset - 1`. If `xxh3-64(head) != fp_hash`, or `xxh3-64(tail64) != tail_hash`, or that byte is not `\n`: rewritten in place, new gen.
6. Else resume at `offset`.

`fp_hash`/`tail_hash`/`fp_len` are recomputed from the bytes just consumed and committed with each batch, so a file shorter than 4 KiB is fingerprinted over all of it. A rewrite that preserves size, head, and the 64 bytes before the offset while changing the middle is undetectable; it is accepted and listed (measured append-only over one 27-minute window, 0 of 300 files changed inode or head hash, T Q1, which is evidence for rarity, not for impossibility).

### 5.3 New generation (R1-D4(b), PENDING R2/E7 - OPEN)

Provisional text. Under the likely R2 replacement `api_call` is never filtered by `gen` (so the node-rollup-versus-window disagreement of OP-26 vanishes, because calls are counted whatever generation carried them), while the display filter `gen = file.gen` for events, tool rows and raw lines is expected to stay. The rollup recompute below then applies to display-derived counters only. Until R2 the rules below are the working design.

`gen += 1`, `file.gen` is updated (UX-7), `offset = 0`, ctx keeps its set-once flags, `span_ord` and `turn` and clears the ring. The new generation is read from byte 0 and ingested as NEW ROWS: raw lines, index rows, display rows all carry the new `gen`; there is no line-content dedup. (An earlier draft of this spec skipped lines already present; R1-D4(b) replaces that with the simpler per-generation rule, accepting that a pruned rewrite is stored again because generation bumps are rare: 0 superseded files exist in the measured corpus, T Q16.)

- **Display hides old generations.** Every display read filters `gen = file.gen`. Old-generation rows stay in the archive and are exposed by an archived-lines view (rows with `gen < file.gen`), so lines that the prune removed remain viewable and nothing is lost.
- **Rollup recompute, node-scoped.** While a new generation is catching up (`offset < size_seen`) the node's rollup keeps its previous value and per-batch deltas for that node are DEFERRED (`file_gen.rollup_deferred`); when the new generation first reaches `offset = size_seen` at a commit, the writer recomputes the node's rollup from current-generation rows in one set-based statement (UX-7) and clears the flag. During catch-up the node is reported incomplete in `v_ingest_progress`.
- **`api_call` and tokens.** The same-file guard (section 3.3) updates a re-asserted message to the new `gen`; messages only the old generation held keep the old `gen`. Consequence, flagged OP-26: the node rollup (current-generation rows) can be lower than the sum of the node's `api_call` rows (all generations), which is what window functions read; whether the node rollup should count archived calls is an owner decision.
- **Census per generation:** `lines_read(gen) = raw rows stored(gen) + lines_dead_lettered(gen)`.

Rotation by rename-prune is how Claude Code at or above 2.1.208 prunes (log_reader.rs:616-620); this section is what makes a prune lose nothing and add no tokens.

### 5.4 Set-aside and moved files

**Identity decision table (coordinator rule, PENDING R2/E7 - OPEN; R1-D5 as written says only "node identity is the `(dev, inode)`"):**

| observation on open or discovery | decision |
|---|---|
| a known slot's path now holds a different `(dev, ino)` (same path, new inode) | **generation bump on the same node** (section 5.3) |
| a path whose `(dev, ino)` equals a known generation, at a new path | **move**: UX-3 rebinds `file.path`, nothing is re-read, the node is kept |
| a new path with a new `(dev, ino)`, whose session id AND head fingerprint equal those of a node whose file is currently `missing` | **relocation**: the missing node is rebound to the new file (a new generation, because the inode differs), no new node |
| anything else (new path, new inode, no matching missing node) | **new node** (a copy such as `cp -a` lands here) |

The third row is why the head fingerprint is stored per generation and why `missing` nodes are kept (section 5.5). It needs the session id of the candidate file, which is the first timestamped line's `sessionId` for Claude (equal to the stem in every checked main file, T Q14) and the stem for other sources; the exact comparison is OPEN OP-29 (T did not measure how often a relocation looks like row 3 versus row 4).

When a path now holds a different `(dev, ino)` than the slot's current gen, scan the same directory (and, on a missing slot path, the whole root on the next full sweep) for a path whose `(dev, ino)` and `fp_hash` equal the old gen: that is the same file renamed to its `.orphaned-` or `.superseded-` name (a rename keeps the inode). Then:
- the old gen is **drained from the aside path**: read from the old `offset` to its EOF (the tail written after our last read exists only there), store the unterminated last fragment, if any, as `parse_status='torn'` (the gen is closed, no more bytes will come), then mark the gen closed (`closed_ms`); the aside path is recorded as an alias of the slot, NOT as a new slot and NOT ingested as `aside` raw a second time;
- the new file at the original path is the slot's next gen (5.3), its lines ingested as new rows.

A new path whose `(dev, ino)` + head fingerprint equal a known generation of a slot whose recorded path no longer exists is a **move** (R1-D5) (`/cd` relocates a session, A): UX-3 rebinds `file.path`; nothing is re-read; the node key and parent do not change (they are fixed at first sight; a session moved between project directories keeps its node). A copy (`cp -a`, same content, new inode, old path still present) is a new slot (identity is the inode): its raw is stored (it is a distinct file) and its derived display rows appear; `api_call` is unique on `(source, message_id)` and the copy is a different file, so it neither updates nor re-counts any call. Corpus check: 0 of 4,502 stems exist in two project directories today (T Q9, `/cd`).

### 5.5 Deleted files

`ENOENT` on open, or a path that vanished at a full sweep and matches no move or relocation (section 5.4): `file.state='missing'`; `file_gen.offset` and every row stay; nothing is deleted. A later reappearance with the same `(dev, ino)` and matching fingerprints returns to `active` and resumes; a different inode is a new gen (5.3). An open fd keeps working on unix, so a read in progress completes (F H6 case 6). Permission errors set `state='active'` with a backoff, a counter and a log line every N minutes, never `missing`. Retention (30-day default, A) and `claude purge` can remove a file mid-tail: the committed rows are then the only copy, which is the point of D-1 (A retention note).

## 6. Torn tails

Rule: a producer consumes ONLY complete lines. It reads `[offset, EOF-as-read)`, finds the last `\n`, and commits `offset' = offset + last_newline_index + 1`. If there is no `\n` in the bytes read, it consumes nothing and returns without error. The remainder is re-read whole next time. `file_gen.size_seen - offset` is exposed as `tail_pending_bytes`; a live gen never consumes an unterminated fragment. A closed gen (rotated, section 5.4) stores its fragment once as `parse_status='torn'`, because no completion can arrive (OP-18 asks whether to also do this for gens quiet for a long time; default: no).

The bug to avoid, VERIFIED in code: `for_each_json_line` adds each `read_until` result to `consumed` BEFORE checking that the line ended with `\n`, then silently skips a line that fails to parse (lib.rs:1392-1418). A partial last line is therefore counted as consumed. `parse_transcript` returns that count as `file_size_bytes` and the cold scan records it as the offset (log_reader.rs:183-300 via `state_after`), so the later-completed line would be read from the middle and misaligned forever. `read_lines_from` is already correct (`rposition(b'\n')`, log_reader.rs:667-675), and is the behavior to keep; `for_each_json_line` is NOT reused. Measured exposure is low (0 of 300 files torn at one instant, T Q8), which is exactly why a test must force it (TS-6).

## 7. Large lines, invalid UTF-8, dead letters

### 7.1 Sizes

Measured (T Q6, D-DAT-7): max line 4.4 MiB, 300 lines over 1 MB, 42 over 1 MB in the 20 largest files, largest file 545,835,794 bytes. Today's `read_to_end` of the whole tail into one buffer (log_reader.rs:667-675, F H3) is replaced by chunked reads (1 MiB buffer) that assemble one line at a time.

| limit | initial value | behavior above it |
|---|---|---|
| `MAX_PARSE_BYTES` | 16 MiB (3.6 times the measured max; a parsed `Value` is 2-4 times the line) | raw stored whole, `parse_status='oversize'`, no derived rows, `ingest_error(kind='oversize_parse')` |
| `MAX_RAW_LINE` | 64 MiB (the spill file maximum, E5; the OTLP body cap) | stored as a marker row `{truncated, bytes, head: first 1 MiB}`, `ingest_error(kind='oversize_truncated')`, logged loudly |
| batch | at least one line, whatever its size; a line over the batch byte cap is its own batch (F H2, H7) | |

F H7 suggested a 256 MiB hard cap; 64 MiB is chosen because a producer assembling a line and the part writer holding it can each hold a copy, and the memory budget (D-16, D-ENG-9, 120-330 MB of allocator overhead above `memory_limit`) cannot absorb 2 x 256 MiB. At most 2 oversize assemblies are allowed in flight, and a Parquet backend caps its row group by BYTES, not only rows, so a few multi-MiB lines cannot inflate a 512-row group (R1-D1). The static memory budget of the writer spec sums to 2,226 MiB against today's 2,048 MiB cap (R1-BUDGET), so producer memory is counted inside that sum and the startup budget check requires the interim 4,096 MiB cap (D-13, itself a plan, R1-D13) or a smaller sum after the bench. Numbers are initial values for SPEC-method-bench (OP-19); the release gate is that `oversize_truncated` is zero on the real corpus.

### 7.2 Invalid UTF-8

Stored as BLOB; `parse_status='invalid_utf8'`; derived none (section 2.2). Frequency on the real corpus is not measured (T did not count): OP-20, one `grep`-class pass, expected zero.

### 7.3 Dead letters (database-level failure)

With no ENUMs, no PKs on display tables, and staging then `INSERT ... SELECT` (never the Appender where uniqueness matters, F H7), the remaining ways a batch can fail are defects. Policy (F H7, fail loud): a transaction that fails twice is bisected to the offending line; that line is written to `ingest_error(file_id, gen, byte_off, kind, error, line_head BLOB 1 KiB, ts_ms)` with its raw bytes still stored; the offset advances past it in the same transaction; a counter is exposed in `/api/server-stats`. A permanent poison line is a visible defect, never a hang. Parse failures of section 2.2 are NOT dead letters. An out-of-memory error in DuckDB is fatal to the instance (D-ENG-2) and is a process-level event, not a per-line one. Release gate: `ingest_error` is empty on the real corpus (F H29).

## 8. Backfill

### 8.1 Work set and order

The work set is derived from the index, never cached: every `file_gen` whose `offset < size_seen`, plus every discovered file with no row. Order: first files modified within the last 7 days (the burn windows, F H18), then the rest; within a class by `min(mtime, now)` descending (a future mtime from a clock error or `touch` is clamped), ties by path. This is newest-first (D decisions) with the caveat from F H18, accepted: mtime can be wrong (`cp -a`, restored backups), which only changes how soon an aggregate becomes complete, never its correctness. Resumable by construction: a crash loses at most the uncommitted batch; the next start recomputes the work set from `file_gen`.

### 8.2 Threads and lanes (D-7, F H12)

LIVE producers (watcher-driven reads and the NDJSON tailer) run at NORMAL QoS; only BACKFILL producers run at background QoS (R1-D7, correcting D-7: background QoS is about 30 times slower under load, measured in E1b, which is unacceptable for the data a user is looking at right now). No producer ever holds a DuckDB transaction or connection; only the writer thread, at normal QoS, touches the write connection. Reason, measured in this repo: a commit's fsync at background I/O priority is throttled and request threads then wait behind it (priority inversion, log_reader.rs:1440-1447, F H12). The LIVE lane (watcher-named files, OTEL tail, retention chunks) is drained first; a BACKFILL job is one time-budgeted batch (about 50 ms of expected work, adaptive from the last batch, F H2), and the writer re-checks LIVE between batches. Backfill batches of different files are produced in parallel by at most `backfill_producers` threads (initial 2).

`/api/clear` as a watermark (R1-D10, **PENDING R2/E7 - OPEN**: the likely replacement is today's meaning, drop the OTEL spans and rebuild the derived data) is the working text: it records `meta.clear_epoch` and a timestamp T; every read hides data older than T; nothing is deleted or rebuilt, so ingest has no clear race to handle and no in-flight batch is ever dropped on account of a clear (this removes the epoch-drop rule of D-8; the offset CAS remains).

### 8.3 CPU budget (measured figures, not wall time at background QoS)

E1b/E1 showed that wall time under background QoS and load is meaningless (30 times inflation at load average about 190; the CPU work was identical) and that CPU seconds per GB are load independent. The raw-path cost depends on the R1-D1 backend, so it is listed per backend (E1b and the decision log, VERIFIED figures): **(D)** zstd column inside DuckDB: about 22 CPU-s/GB (D-1 text); **(C2)** Rust parquet crate: 5.4 CPU-s/GB direct, **7.0-8.2 CPU-s/GB through staging** (0.50-0.59 s per part); **(C1)** DuckDB `COPY`: 5.8 CPU-s/GB direct, staged cost not measured (E1b "C2 5.4 vs C1 5.8"). For the 18.7 GB corpus the raw store alone is therefore about 131-153 CPU-s (C2 staged), 108 CPU-s (C1 direct) or about 410 CPU-s (D). **JSON parse plus derivation CPU-s/GB is NOT measured anywhere in the DUCKPLAN reports**: OP-21, to be measured by SPEC-method-bench on a fixed 1 GB sample (`getrusage`), not estimated. Total backfill cost is `18.7 * (raw + P)` CPU-s, and wall time is that divided by the core budget.

Mechanism: a `backfill_cpu_cores` budget (initial 0.5, F H18) enforced by a token bucket on thread CPU time (`getrusage(RUSAGE_THREAD)` deltas per batch, rolling 10 s window) across BACKFILL producers plus the writer's backfill batches; producers sleep to hold the average at or below the budget. LIVE work is not throttled by it. Backfill yields completely while the LIVE lane is non-empty, and backs off geometrically when the last writer commit took longer than `backfill_commit_latency_ms` (initial 250 ms). No burst exceeds the budget by more than one batch. All initial values are for the bench (OP-19).

### 8.4 Partial-corpus flag

Until backfill completes every aggregate response carries `{complete: bool, backfill: {files_done, files_total, bytes_done, bytes_total}, complete_for_window: bool}` (F H18), from the view `v_ingest_progress` over `file_gen`: `complete` iff one full discovery sweep finished since boot and no gen has `offset < size_seen` (excluding `tail_pending_bytes` of live gens); `complete_for_window(since_ms)` iff every file with `mtime >= since_ms` is complete, which newest-first makes true long before `complete`. Lifetime totals are not trustworthy until `complete`; window functions are trustworthy as soon as `complete_for_window` is true. The golden diff and the release gate run only when `complete` (F H18). `meta.ingest_catchup_complete_ms` is set the first time `complete` holds.

## 9. Hooks: legacy cards and OTEL

### 9.1 Legacy cards import hook (LEG)

LEG's orphan test is "no node with natural key K after a COMPLETE transcript catch-up" (LEG 1.2). Ingest provides: (a) `meta.ingest_catchup_complete_ms` (section 8.4) as the gate; the importer must not run before it, or every card of a not-yet-ingested transcript would be imported as an orphan; (b) the adoption hook at node creation: when a transcript is ingested for a natural key already held by a legacy node, node creation finds it through `node_key`, ADOPTS the same `nk`, sets `file_id` and flips `node.origin` from `legacy` to `live` while `node.source` keeps the agent source (R1-ORIGIN; LEG section 4 and UX-6 are to be aligned, they currently say `source` flips); (c) `/api/import` nodes (F H16) have `file_id NULL` and `origin='import'` and are outside ingest. The legacy importer and the transcript ingest share one natural-key table and never allocate the same key twice (`nk` allocation only on the writer thread, serialized).

### 9.2 OTEL NDJSON tailing (R1-D6, correcting D-6)

The span NDJSON stays the write-ahead log and DuckDB tails the segment files as a log with its own offsets. Correction by R1-D6: today the OTLP handler acks BEFORE the flush, which runs within about 5 s, so up to 5 s of spans can be lost on SIGKILL; that is unchanged by this design and owned by card S1, not by ingest. Files (spanstore/src/writer.rs, VERIFIED): `<utc-day>.ndjson` flushed in batches (about one fsync per second at peak), sealed days (strictly before today) gzip to `<utc-day>.ndjson.gz` with the plain copy deleted only after verification, and a late span after sealing appends to a fresh plain `<day>.ndjson` so both forms exist (writer.rs:513-545, 619-717).

- A day segment is a slot (`kind='otel_segment'`); the current plain file is tailed through the same scheduler, CAS and torn-tail rules, on the LIVE lane at NORMAL QoS (R1-D7).
- **The tailer offset GATES sealing** (R1-D6): the gzip step runs only when the tailer's committed offset equals the file size, and retention and clear never remove a day file the tailer has not finished. This needs a change in the span store's seal and retention code (it must read the tailer's offset from the index or a file the tailer publishes): OP-23, owner card S1 / FND-05.
- **gzip reads are supported**: offsets are in UNCOMPRESSED bytes, so a day that was sealed while DuckDB was down, or is imported historically, is tailed from its `.gz` by gunzip with the offset skip (the compressor verified the gz byte-equal to the plain bytes, writer.rs:195-217). A plain file that reappears next to an existing gz is a separate slot `<day>#late`.
- Raw archival is not done: the WAL is the raw and has its own retention; `otel_span` and `otel_span_attr` carry full attribute values (CAT NS-8, FND-05).
- **`otel_span` is unique on `(trace_id, span_id)`**, bounded by the 30-day retention (R1-D6), so duplicate deliveries do not double rows; the existence mechanism is bounded by retention and follows the E6 outcome for its index choice. This resolves the earlier open question about exporter-retry duplicates.
- Retention key is `received_ms`, not `start_ms` (F H15: a backlog delivered a day late keeps its 30 days today). The tailer sets `otel_span.received_ms` from the record's `receivedAt` (writer.rs:113-136 order: `receivedAt`, `startTime`, `endTime`).
- The `gen_ai.output.messages` overlay (`inject_span_attribute`) is an in-RAM overlay today and has no WAL record, so a restart loses it (F H15, writer.rs:381-415): persisting it as `otel_span_attr` rows needs a new WAL record type in the span store (OP-23).
- Historical import: the last 30 days of day files are tailed from offset 0, newest day first, on the BACKFILL lane at background QoS with the same CPU budget.

### 9.3 Backup and recovery hooks (R1-ENG6)

The index (plus parts) becomes the only copy of deleted transcripts and legacy cards, and the bundled DuckDB build commits with a plain fsync that does not flush the drive cache, so a power loss can reorder writes (R1-ENG6, extending D-ENG-6). Ingest's obligations toward that design: (1) it publishes events for the backup scheduler: `backfill_complete` (the first time `v_ingest_progress.complete` holds) and a periodic quiescent point, on which the owner of backups takes a CHECKPOINT plus an APFS clone snapshot into a rotating set of 3 (daily and after backfill); (2) re-ingest from a snapshot is safe: a snapshot contains `file_gen.offset` and `ctx` committed together with the rows they cover, so after restoring a snapshot the normal producers re-read only bytes at or after those offsets, and the per-row rules of rule 2 apply unchanged; (3) transcripts deleted since the snapshot cannot be re-ingested, which is a loss window the backup cadence bounds, not something ingest can repair; (4) the startup integrity check falls back to the newest snapshot plus re-ingest, never to an empty database (the policy lives in the open/recovery spec; ingest only guarantees (2)).

## 10. Tests (real files, real DuckDB, no mocks; fixtures are synthetic line shapes, never real transcript content)

Each test names the mutation that must make it fail (F H29: an assertion that cannot fail is not a test).

| id | test | asserts | fails if |
|---|---|---|---|
| TS-1 | per-source golden fixtures (Claude main, Claude sub, Claude wf, Codex, Copilot CLI, Chat delta, Chat json, OpenCode db, OTEL segment) | exact row sets per table for a hand-written minimal file per source, one case per row in sections 2-4 | any column mapping changes |
| TS-2 | **differential vs `build_result`** on 300 corpus files (read-only, stratified 100 main, 100 subagent, 50 workflow, plus the fork pair, a sibling pair, a Task-spawning session, a compaction session, three mixed-speed sessions), the oracle built with the 4096 collection cap and the 2000-entry timeline cap lifted | every field of the section 2.4 table equals the old card, EXCLUDING the deltas below | a field is derived wrongly or a new undocumented delta appears |
| TS-3 | documented deltas are asserted, not hidden | ING-D1 (usage-less first row), ING-D2 (cap eviction not reproduced), ING-D3 (last row wins, with CAT D1), ING-D4 (sibling global dedup, CAT D2), ING-D5 (workflow parent and journal/aside skipped, CAT D3/D4), ING-D6 (span ordinals unique not contiguous) each have a fixture whose NEW value is asserted and whose old value is shown different | a delta stops being a delta |
| TS-4 | ctx equivalence property | for each fixture, ingest in one pass and split at EVERY line boundary (restart between): identical table checksums | ctx loses or double-applies state |
| TS-5 | ctx size bound | serialized ctx for the 20 largest corpus files is at most 8 KiB (Chat fixture at its cap) | ctx grows with the file |
| TS-6 | torn tail | a partial line is never consumed; completed later it is parsed once at the right offset; a no-newline file consumes zero; a closed gen stores the fragment as `torn` | offset moves past a partial line (reintroduces the `for_each_json_line` bug) |
| TS-7 | poison line | a failpoint makes the writer reject line N: bisect, `ingest_error` row, offset advances, other lines committed; exit gate counter nonzero | file stalls or retries forever |
| TS-8 | unparsable, non-object, invalid UTF-8, blank, unknown `type`, oversize, 4.4 MiB line | statuses recorded in the raw index, bytes round trip byte-exact, no derived rows, offset advances | any of them is dropped or fatal |
| TS-9 | sibling duplicates | two subagent files sharing 100 assistant rows: `api_call` count 100 (not 200), tokens counted once, display rows present in both, swapping ingest order leaves corpus totals identical | tokens double count |
| TS-10 | workflow parents | `wf_<id>/agent-*.jsonl` gets the right parent; `journal.jsonl` makes no node but its raw is stored | parent missing or journal becomes a node |
| TS-11 | fork pair | uuid, message.id, requestId equal, `sessionId` rewritten: second file's `api_call` rows insert nothing, both nodes exist | fork counted twice or second node missing |
| TS-12 | last-row-wins, same file only | rows with growing `output` for one id in one file: stored output is the LAST row's; re-applying the batch is a no-op; a row of ANOTHER file with a larger output does NOT update the call (R1-D4(c)); probe the 1,736 corpus groups for the OP-4 assumption | first row wins again, or a cross-file update fires |
| TS-12b | sibling disagreement probe | over the 1,134 sibling file groups of the real corpus, count message ids whose usage differs between siblings (read-only); the count and a verdict are written to the test output | a nonzero count is silently accepted (OP-25) |
| TS-13 | rotation by rename-prune (R1-D4(b)) | file replaced by a pruned rewrite (new inode, missing middle, new tail): the new generation is ingested as new rows, display reads show only `gen = file.gen`, the archived-lines view shows the pruned lines, the node rollup is recomputed from current-generation rows when the new generation reaches EOF (deferred before), `api_call` rows re-asserted move to the new `gen` and add no tokens, per-generation census `read = stored + dead` | pruned lines lost, tokens added twice, or rollup not recomputed |
| TS-14 | truncate-and-regrow in place | same inode, smaller then larger: detected by size or fingerprint | misaligned read |
| TS-15 | set-aside and drain | live file renamed to `.orphaned-` with an unread tail, new file created at the old path: tail drained from the aside path, aside is not a second slot, new gen reads from 0 | tail lost or aside becomes a node |
| TS-16 | moved directory, copy, delete | move rebinds path with zero re-read; `cp -a` copy adds a slot but no tokens; delete keeps rows and sets `missing`; reappearance resumes | duplicate ingest on move |
| TS-17 | two producers on one file, and clear (R1-D10) | the second commit rolls back on the CAS; `/api/clear` records the watermark, reads hide data older than T, ingest continues and no batch is dropped, no row deleted | offset moves backward, or clear deletes |
| TS-18 | kill -9 x50 at failpoints between read and commit, and between part write and registration | restart gives table checksums equal to a clean single pass; independent census (newline count by a separate counter, not offsets) equals `Sum(raw rows)` per file | duplicates or gaps |
| TS-19 | Codex | cumulative snapshots: last wins; shed of cached from input; turns by `last_token_usage`; out-of-order bytes after restart still equal single pass | sum instead of last |
| TS-20 | Copilot CLI | multiple `session.shutdown` events sum; active session has output but no input and is `tokens_partial` | shutdown missed or double counted |
| TS-21 | Copilot Chat | push then set `completionTokens` then set `result`: final row from the set; split across restart equals single pass; kind 0 with `requests` is the OP-14 case | set does not beat push |
| TS-22 | OpenCode | a session counter and a part status updated WITHOUT changing `time_created` are picked up (negative test for a `time_created`-only cursor); unchanged rows write nothing; versions append | cursor is `time_created` |
| TS-23 | spill | text and `.jpg` spill files reassemble byte-exactly from 1 MiB chunks; ref parse; deleted spill keeps rows | chunk or ref error |
| TS-24 | OTEL segments | plain to gz transition mid-tail drains the remainder; late plain beside a gz; torn tail; `received_ms` from `receivedAt` | span lost across sealing |
| TS-25 | backfill | newest-first order; resumable after kill; CPU token bucket holds the budget within one batch (thread CPU, not wall); partial flag transitions and `complete_for_window` | burst or wrong flag |
| TS-26 | legacy hook | importer blocked before `ingest_catchup_complete_ms`; adoption keeps `nk` | orphan test runs too early |
| TS-29 | raw backends (R1-D1) | the same fixtures through every built backend (D, C1, C2): identical `read` bytes, index rows and census; kill between temp-write and rename, and between rename and index commit: startup reconcile leaves no lost or doubled part; the offset never passed a non-durable line | a backend loses or doubles bytes |
| TS-30 | NDJSON sealing gate (R1-D6) | the span store does not gzip a day file whose tailer offset is below its size; retention and clear leave an unfinished day file; a `.gz` is tailed by uncompressed offset | a span lost across sealing |
| TS-31 | snapshot restore (R1-ENG6) | restore a snapshot taken mid-backfill: ingest resumes from the snapshot offsets and ctx, final tables equal a clean pass | duplicates or gaps after restore |
| TS-27 | memory | a 4.4 MiB line and 16 concurrent producers stay within the producer budget; no `collect()` of a whole file | RSS growth |

Release gate additions: `ingest_error` empty on the real corpus; `oversize_truncated` zero; `count(raw_line)` equals an independent newline census (6.30M lines, 27.7k files at the time of T) per file; `v_ingest_progress.complete` true before any golden diff.

## 11. Contract deltas created by this spec (seed for CONTRACT-DELTA.md)

| id | change | evidence | relation to CAT |
|---|---|---|---|
| ING-D1 | a usage-less first row of a message does not block a later usage row | lib.rs:850-857, F H5 | new |
| ING-D2 | the 4096-entry caps (`seen_message_ids`, `pending_*`, `sub_agents`) are gone; a message id evicted in a very long session is no longer counted twice | lib.rs:46, 313-322, F H5, H25 | new |
| ING-D3 | last row of a message wins | T Q2 | CAT D1 |
| ING-D4 | (rule PENDING R2/E7) `api_call` unique on `(source, message_id)` with same-file-only updates (R1-D4(c)); sibling and fork nodes can show fewer calls than their files contain; a call first ingested from an incomplete sibling row is never corrected by the other sibling | T Q9, R1-D4 | CAT D2 |
| ING-D5 | workflow agents get a parent; `journal.jsonl`, `.orphaned-` and `.superseded-` files are raw-only | T Q5, Q16 | CAT D3, D4 |
| ING-D6 | `span_id` ordinals are unique per node, not contiguous across generations | section 2.4 | new |
| ING-D7 | partial last lines are never consumed (no more offset past a torn tail) | lib.rs:1392-1418 | new |
| ING-D8 | subagent node natural key is path-qualified; bare-stem collisions no longer overwrite | D-DAT-5, F H3 | new, needs OP-1 |
| ING-D10 | (PENDING R2/E7) a replaced or pruned file's old generation is hidden from display and viewable in an archived-lines view; the node rollup counts current-generation rows only (OP-26) | R1-D4(b) | new |
| ING-D11 | (PENDING R2/E7) `/api/clear` is a watermark, not a delete (affects the old clear behavior of re-reading everything) | R1-D10 | new, owned by the clear card |
| ING-D9 | OpenCode child sessions: unchanged (not ingested), but listed because the owner decision is open | opencode.rs | OP-16 |

## 12. OPEN items

| id | question | needed by |
|---|---|---|
| OP-1 | alias lookup from legacy bare `agent-<hex>` card keys to path-qualified `node_key` (section 1.2) | LEG |
| OP-2 | schema additions requested by this spec: raw index columns `entry_type, ts_ms, parse_status, line_hash`; `event.uuid, parent_uuid, msg_key, msg_first, span_ord`; `api_call.source, message_id, kind, counted, owner file_id, first ts_ms, upd_ts_ms`; `file.gen` and `file_gen.rollup_deferred`; `node.origin` (R1-ORIGIN); `file_gen.ctx` colocated with the CAS row (D-9 says a separate ctx row; one statement is simpler, UX-1) | schema spec (not yet written) |
| OP-3 | `event.text_head` size against bench and read-api needs | SPEC-method-bench, SPEC-read-api |
| OP-4 | last row by `byte_off` carries maximum `output` in all differing groups | TS-12 probe |
| OP-5 | whether burn windows exclude `kind='cumulative'` rows | operation catalog C08 |
| OP-6 | `compactMetadata` sub-field names (INFERRED from CAT column names) | one-off probe |
| OP-7 | contents and use of `agent-<id>.meta.json` | probe |
| OP-8 | exact grammar of the `<persisted-output>` block | probe |
| OP-9 | aside files for Codex or Copilot (none observed) | none urgent |
| OP-10 | store scratch-path harvest per tool row (NS-5) | NS-5 owner |
| OP-11 | Copilot Chat turn cap and measured chat sizes (not scanned in T) | probe |
| OP-12 | source of `node.conversation_id` (CAT cites a line that does not exist in logscan codex.rs) | FND-01 |
| OP-13 | identical Copilot CLI lines | probe on local session-state |
| OP-14 | Copilot Chat `kind=0` re-snapshot with `requests` | probe |
| OP-15 | OpenCode `time_updated` presence in the installed version, and DB size | probe |
| OP-16 | OpenCode child sessions as spawn children | owner decision |
| OP-17 | `F_NOCACHE` benefit for backfill reads | bench |
| OP-18 | flush a torn fragment after long quiescence of a live gen | owner decision |
| OP-19 | all initial numeric limits (LIVE_MAX_BYTES 8 MiB, 50 ms batch, 16 MiB / 64 MiB line caps, 0.5 core, 250 ms, 2 producers, 64-entry ring) | SPEC-method-bench |
| OP-20 | count of invalid UTF-8 lines in the corpus | probe |
| OP-21 | parse plus derive CPU-s/GB (UNMEASURED, section 8.3) | SPEC-method-bench |
| OP-22 | resolved by R1-D6: `otel_span` unique on `(trace_id, span_id)`, bounded by retention; only the index mechanism follows E6 | E6 |
| OP-24 | do all rows of one `message.id` share an exact `timestamp`? (decides whether a timestamp-restricted anti-join is sound, R1-D4-ART) | probe, E6 |
| OP-25 | do sibling subagent files ever disagree on the usage of a shared message id? (a first-ingested incomplete row is never corrected) | TS-12b, owner |
| OP-26 | `gen` added to the same-file update guard (R1-D4(c) writes `byte_off` only); node rollup (current generation) vs `api_call` windows (all generations) after a bump | owner |
| OP-28 | R2/E7 replacement of R1-D4(b)(c): largest-usage-wins, owner fixed at first insert, staging join for old values, `api_call` never gen-filtered; confirm and then simplify section 3.3 and 5.3 | R2 |
| OP-29 | R2/E7 confirmation of the identity decision table (section 5.4) and the exact relocation comparison | R2 |
| OP-30 | R2/E7 `/api/clear` meaning: watermark (R1-D10) or today's drop-OTEL-and-rebuild; the ingest consequence is only that a rebuild would re-derive from raw through the section 2.7 `read_range` | R2 |
| OP-27 | raw backend D, C1 or C2 (R1-D1 OPEN): the ingest is written for all three; per-backend staged CPU of C1 not measured | Rust bench |
| OP-23 | span store changes: tailer-offset-gated sealing and retention (R1-D6) and a WAL record type for the span attribute overlay | spanstore, FND-05, card S1 |
