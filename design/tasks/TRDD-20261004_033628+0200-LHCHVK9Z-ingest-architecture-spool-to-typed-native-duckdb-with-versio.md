---
trdd-id: LHCHVK9Z
title: Ingest architecture - spool to typed native DuckDB with versioned per-topic producer schemas
column: todo
status: tasked
created: 2026-10-04T03:36:28+0200
updated: 2026-10-05T01:57:58+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-04T03:36:28+0200
npt: [VXD881R6]
implementation-commits: [69b7d406, 6085ee91, 6f8d1d16, fdb7996c, c594c472, e9cc75cf, 125bd44b, 22299b2f, 301d7947, 9cca67b4, 6f9e2727, 8b25ab4a, 852ae3ca, a7cefe42, b8baf734, f97b191b]
---

# Ingest architecture - spool to typed native DuckDB with versioned per-topic producer schemas

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-04T11:04:03+0200

NEXT ACTION: owner decisions (section "Owner decisions pending"). No work is in flight. READ the section "Review findings 2026-10-04" at the end of this card (after the Approval log): three confirmed, unfixed defects in the tap rejection path of d8de334d, and its test evidence is not re-verified. Verified since: a real alcore started by the CLI with the ingest flags, with a real collect and views run (src/test/ingestEndToEnd.test.ts); the full agentlens-core suite (a worker run, 119 result lines, no failure). Still NOT verified: writerDead after a real writer panic. Nothing is deployed. Known gap: no test asserts that AGENTLENS_INGEST=on with no resolvable alcore still shows the caller's own error.
BUILT: crates agentlens-digest (aldigest) and agentlens-spool (alspool), 98 producers; opt-in alcore tap (e9cc75cf, 301d7947, 8b25ab4a) writing hooks, status line, telemetry events and spans, API bodies off by default; CLI opt-in AGENTLENS_INGEST=on in source only (9cca67b4; the installed bundle standalone/cli.js is stale and ignores it until node esbuild.js runs). NOT deployed: the running collector has no tap. No real alcore has been started by the CLI with these flags. Real saved data was loaded through test converters for hooks, telemetry and API bodies; the status line was only compared with its stored flattened columns.
NOT covered by any schema: telemetry metrics (nothing captures them), transcripts, and the raw nested status-line JSON (never observed on disk).
SUPERSEDED body sections (kept for history, do NOT act on them): "Design (follows proposal v9 ...)" where it says the collector lives inside alcore and seals to ready/ (the writer seals; the collector is the aldigest binary); "Build order" steps 1-6 (done differently, see "What is built"); the two "OWNER:" bullets and the "How a hook names its producer_type" bullet under "Open" (decided under D-I, see "Decisions"); in "Agent reading" the bullet about a collector-assigned _meta_event_id joining topic tables (the join key is (_meta_ingest_id, _meta_record_ordinal)).
Related: TRDD-VXD881R6 (first slice, done inside the crate), TRDD-HH1NP0KD (hook binary; alspool now exists and is the writer it should call), TRDD-9VX3WTGU (memory cap).
Sections before the Approval log: "Switch-on procedure for this machine (owner decision, NOT done)" and "Owner decisions pending (2026-10-04)".





## Owner decisions (verbatim)

Extracted byte-for-byte from user-role entries of the session transcript of 2026-10-04 (outside git).

D-A (2026-10-04), in reply to the agent's suggestion to tolerate unknown keys:
> no, if there are changes to the response bodies a new "producer_type" must be created with a new json schema reflecting the new changes. the previous data tables will stay available as different tables, and an index will contain the informations about the tables timelines (lifecycle from when introduced to when was superseeded). All you need to do to ensure those data is still parsed is to make all sql functions aware of the versions and tables lifelines, and integrate in the same query the data from multiple versions of the tables. behind the scenes the content is split in many tables, but the sql functions will make appear them as one single long lived table. this is easier than you think, because 1) the raw dumps of the responses is already split in multiple tables divided by topics/scope (json fields/arrays/sub-fields related to eache other must be grouped in the same table, like skills, agents, rules, costs, errors, tools, etc. each in its own table. so changes to a schema of a single table will affect only that topic/category table timeline, not all. and 2) the queries are usually done on specific fields, so even if some new field is suddenly added to an api response, the existing fields will still be give solid responses to the queries. removing fields is rare, but even if they do them, all we need to do is to write the new json schema in a way to make clear that a field is the replacement of an old field now removed. in this way the functions will be able to return the right values in all queries, even across multiple versions of the tables. Also for everything else i strongly advise to follow my proposal unless impossible. and implement this asap.

D-B (2026-10-04):
> the necessity of having fixed json schema for each producer is due to the need for speed. we cannot process the json data when digesting it, because the sql call must run in few milliseconds. otherwise 400 sql queries per second appending data will make the system unresponsive.

D-C (2026-10-04):
> the duckdb sql function to digest the specific producer (hook, raw bodies, logs, statusline, etc) must already knows where each json field must go in the row. no computation time at all.

D-D (2026-10-04):
> the mapping between schema entries and columns must be precompiled in the sql function to digest each producer.

D-E (2026-10-04):
> the only way is to let me inform you of changes and asking you to update the codebase. no autodetection of changes, since those can only be a recipe for errors. you cannot distinguish a official api change from a temporary bug caused by unique circumstances. any anomalous behaviour must be considered an error. of course unknown fields must be ignored if not present in the json schema of the current agentlenspro version.

D-F (2026-10-04):
> only those in the json schema must be parsed. the others must be ignored.

D-G (2026-10-04):
> no, keep my proposal into docs_dev. because it is only a prototype. the true rust hooks and sql functions are still to be decided and built. you don't want to use python for such time critical thing, don't you? all must be small rust digesters, each ultrafast and a ligh wrapper around duckdb sql queries. a set of json schemas for the current hooks and telemetry output must be generated from the current claude code version and a index must be written to let those rust digesters pick the right json schema for each producer. once the final system is built, then that will be written down as specs.
D-H (2026-10-04):
> examine all the telemetry saved files and the raw dumps of the api responses and the json of the statusline and that of each hook. create a schema of each one of them. then create a rust program that read the schema, generates the tables as in the prototype, and bind each schema to the generated table. then write the rust code and the sql functions necessary to ingest each type and pass it to duckdb as new row of a set of tables. then plan the sql functions that can map the fractured sequence of tables making the queries go automatically to the right tables and produce a query result that was as if the tables where one table only.
D-I (2026-10-04):
> be sure to complete the task by yourself. decide the rest by yourself based on tests and verified facts. do not stop until you completed the new ingestion system. you are in charge. remember to use tldr-code skill, fastedit skill, jgrep skill and quicksilver to save tokens.

## Agent reading (NOT part of the ruling; correct it if the owner disagrees)

- D-A: version unit = one topic table. producer_type = source + topic + version. A change to one topic starts a new timeline row for that table only.
- Each topic table keeps nested LIST/STRUCT for its own arrays. A collector-assigned _meta_event_id joins one event across topic tables. All topic inserts for a spool file plus its ledger row commit in ONE transaction.
- Unknown keys are ignored, never quarantined (D-E/D-F). failed/ is only for a sealed file whose load raises.
- D-E/D-F settle drift handling (owner's ruling): NO automatic detection of schema changes and no automatic versioning. Only fields in the JSON schema of the installed agentlenspro version are parsed; unknown fields are ignored (this is read_ndjson's measured default with explicit columns). A new schema version is written only when the owner reports a change and asks for the codebase to be updated. Anomalous input is an error, not a schema change.
- Proposal section 9.3's separate strict per-line validation pass is dropped per D-C/D-E/D-F.
- Query side: generated views or table macros per source+topic that integrate all versions using the timeline index; a schema marks a replaced field with "x-replaces": "<old pointer>".
- D-C (third message): the digest SQL for each producer_type is generated ONCE when the schema is registered and already maps every JSON field to its column and topic table; the collector does no per-line parsing, validation or splitting of its own — DuckDB reads the sealed file with the fixed types.
- D-D (fourth message): the field-to-column mapping lives inside a stored SQL function per producer_type, created once at schema registration. Agent's proposed mechanism (not stated by the owner): one DuckDB table macro per producer_type and topic, e.g. digest_<producer>_<topic>(path), whose body is a fixed SELECT of each JSON field into its column over read_ndjson(path, columns={explicit types}); the collector only runs INSERT INTO <topic table> SELECT * FROM digest_...(sealed_file) for each topic, as prepared statements, inside the one transaction with the ledger row. DuckDB table macros are SELECT-only, so the INSERT wrapper is a prepared statement, not part of the macro.
- D-G: the proposal stays in docs_dev/ as a prototype; no Python in the pipeline. Every producer is digested by a small Rust digester that is a light wrapper around DuckDB SQL. A set of JSON schemas for the current hook and telemetry outputs is generated from the current Claude Code version, and an index lets each digester pick the right schema for its producer. Specs are written only after the final system is built. Agent's reading of "digester": the collector-side component that runs the precompiled digest SQL for one producer_type; the hook-side writer only appends to the spool (a hook process opening DuckDB itself was measured to lose events under concurrency).
- D-H/D-I: the owner orders the build and delegates the remaining decisions to the agent, to be settled by tests and verified facts. The new crate is named agentlens-digest because rust-core/crates/agentlens-ingest already exists (the OTLP ingest crate). Agent defaults in force: digester runs collector-side; schema chosen by producer name; a file whose load raises goes to failed/; hook lines are wrapped as {"ts_ns", "payload"}.

## Design (follows proposal v9 — docs_dev/duckdb-native-ingest-proposal/, gitignored, this machine only)

- Producers append one JSON line to a spool file under <dataDir>/ingest/inbox/<producer_type>/; no DuckDB, no socket, no ack.
- One collector inside alcore is the only writer of <dataDir>/ingest/events.duckdb: seal to ready/, one pre-generated SQL statement per producer_type (read_ndjson with explicit STRUCT/LIST types, selecting each JSON field straight into its topic table column), rows + _ingest.files ledger in one transaction, then done/ (600 s retention) or failed/.
- Producers issue no SQL. The collector runs one pre-generated bulk load per sealed file, so the SQL rate is batches per minute, not events per second. Our workload: hooks + status line under 1 event/s (the proposal was sized for 400/s).
- No PK/unique indexes on event tables. Ordering columns _meta_recorded_at_ns, _meta_ingest_id, _meta_record_ordinal.
- Deviations (form does not fit here): (1) Rust only; the proposal's Python scripts are a prototype, kept as a reference for the spool protocol and the ledger transaction. (2) Hooks are single-shot processes: one spool file per session; each append takes an EXCLUSIVE flock, re-checks the inode after locking (reopen on mismatch), single write; the collector holds its exclusive lock through the rename; sealing by size or age, not idleness. (3) Transcripts (owned by Claude Code, never sealed) use a byte-offset ledger committed with the rows, with per-session dedup at rollup/query time.

## Measured on this Mac (reports/ingest-redesign/20261004_032952+0200-plan-premises-measure.md; gitignored, this machine only)

- DuckDB 1.5.6 read_ndjson with explicit columns silently IGNORES an undeclared key (top-level and nested) and gives NULL for a missing declared key; it has no strict option. A wrong type raises an error by default; ignore_errors=true turns it into a row of NULLs, so it must never be used.
- Under D-C a field Claude Code adds is ignored while existing fields keep loading, and nothing in the load reports it. The owner accepts this (D-E): he reports changes himself.
- Optional keys are the norm: 13 hook events show 40 distinct key sets (SessionStart alone 11) from optional keys appearing and disappearing; schemas must declare them as optional/nullable columns, not as versions.
- 18 hook events are wired; 15 use `agentlenspro hook` (capture), the rest are gate/review hooks. Hook lines: median 642 B, max 27 KiB. Status-line payload about 2 KiB.
- Existing pieces to reuse: hook events already land as daily NDJSON files (hook_events.rs); the status-line store already goes NDJSON WAL -> parquet parts read with UNION ALL BY NAME (statusline_store.rs:223); a hook-spool directory already exists; fs2 (flock) is already a dependency; no JSON Schema crate is in the workspace.
- 22 concurrent processes x 200 single O_APPEND writes of 8 KiB and 64 KiB lines produced no interleaving on this APFS volume (one trial per cell).
- UNION ALL BY NAME views: extra columns and extra STRUCT fields become NULL for old rows; a renamed column works via explicit select lists; a field retyped BIGINT->VARCHAR silently widens; STRUCT vs scalar fails at query time.
- A table macro taking the file path as an argument works with a prepared-statement parameter in DuckDB 1.5.6 (INSERT INTO t SELECT * FROM digest(?)), and a NOT NULL top-level column makes a file with a missing required field raise a constraint error. Measured 2026-10-04 in an in-memory database.

## Build order (one card + one commit each; child ids are listed in this card's npt/eht, never as parent-trdd)

1. Schema set and index: JSON schemas for every current hook event and telemetry output, generated from the current Claude Code version (official hook input documentation plus key names observed on this machine), and the index that maps each producer to its schema version. The owner reviews the schemas (he owns schema changes, D-E).
2. Thin end-to-end slice on ONE hook event (SessionEnd), using the SessionEnd schema from step 1: one fixed schema, one digest table macro, collector load + ledger + timeline row, one view queried. Child card: TRDD-VXD881R6. The status line follows once the mechanism exists (it needs a raw-payload capture first and has an existing WAL->parquet store to reconcile).
3. Memory budget for events.duckdb inside the 2048 MB cap (prerequisite of the collector going live).
4. Generalise: manifest, timeline index, view generator, and a generator that turns a JSON schema into the table DDL and the digest macro (the generator is the agent's mechanism; hand-written SQL per producer would also satisfy D-C/D-D) (tests must include a retyped field and an x-replaces case with data in both versions).
5. Collector crash tests: kill before commit; after commit before rename; producer killed mid-write.
6. Load-error handling: a sealed file whose load raises (wrong type) goes to failed/ with an error file and is reported; no ignore_errors.
7. Hook binary and wiring: owned by TRDD-HH1NP0KD. Gate hooks (burn-gate, review-gate) stay synchronous. settings.json change shown to the owner before applying.
8. Producers, one card each: telemetry receiver; request bodies; transcripts (offset ledger + dedup).
9. Port readers (dashboard, statusline-history, last-compact, cache-state, cache-expired); both paths write until each reader is ported.
10. Acceptance run on this Mac at our workload.

## Open (undefined, to settle in the slice)

- Deduplication (per session, at rollup/query time) is the agent's conclusion from measurements; the owner has not ruled on it.
- How a hook names its producer_type at append time; a spool file holding two shapes after a Claude Code update.
- Schema identity across installs (shipped vs locally authored): content-addressed by schema hash.
- Backfill of existing hook, status-line and transcript data.
- review-supervisor matches the literal command string "agentlenspro".
- Shipping a new binary for four platforms (bin-native, check-dist-contents, verify-bin-native, codesign).
- events.duckdb memory_limit is per database instance and is not process RSS; set it and budget the sum with cards.duckdb before the collector goes live.
- Reader latency: spool-then-batch delays "now" reads (cache-state, statusline-history); readers may need to read the open spool.
- Tests: crash tests must kill the real collector; the concurrent-hook test must parse every line with payloads above 4 KiB; the collector reads a sealed file only after the rename under its lock.
- Disk is 97% full on this machine (64 GB free); advisor agent was unavailable in the planning session.
- OWNER: one wrong-typed line makes DuckDB fail the whole sealed file, so its good lines are withheld in failed/ too. Halt that producer, or keep going with other files (current reading)?
- OWNER: a missing declared key loads as NULL silently. Proposed: required fields are NOT NULL columns so a missing required field raises (an error per D-E).




## Evidence on this Mac (gitignored paths, this machine only)

- reports/hook-binaries/: spool append 6.8 ms CPU/event vs 237 ms Node; shared DuckDB file loses events under 22 concurrent hooks.
- scripts_dev/duckplan-e6, duckplan-e7: PK/unique indexes hit fatal OOM at a 512 MB limit.

## What is built (2026-10-04)

- 69b7d406 agentlens-digest: generator (JSON schema to DuckDB schema + events table + stored digest macro), catalog `_ingest.producer_types` (binding and timeline), ledger `_ingest.files`, `aldigest describe|register|collect`. Layout as in the prototype setup script: one DuckDB schema and one `events` table per producer_type, top-level payload fields as columns, nested objects STRUCT, arrays LIST, no key or index.
- 6085ee91 agentlens-spool: `alspool append|seal`, 512 KB, no DuckDB.
- 6f8d1d16 loader fixes: null payload is an error; layout version; rehash; reserved names.
- fdb7996c telemetry events, spans, API bodies.
- c594c472 corrections from real data; writer seals at 4 MiB; `aldigest spools`.
- Producers (98): hook 33, statusline_main 14, statusline_subagent 2, telemetry_event 27, telemetry_span 15, api_request 4, api_response 3.
- Line format every producer writes: {"ts_ns": <unix ns, set by alspool under the file lock>, "payload": <native JSON, verbatim>}. API bodies: payload = {"link": {body_id, request_id, message_id, message_uuid, session_id, query_source, model}, "body": <the body>}.
- Tests: agentlens-digest 47, agentlens-spool 16, clippy -D warnings clean (re-run by the main agent at each commit).
- Binary sizes, append timings and the mutation results are the building workers' measurements; the main agent re-ran tests and clippy at each commit, not the real-data loads.

## Checked against real saved data (reports under reports/ingest-redesign/, gitignored, this machine only)

- Hooks (20261004_070249+0200-hook-schemas-vs-real-data.md): 11 of 13 event spools in the 3 newest files loaded n/n, 20,049 rows. hook_stop and hook_pre_tool_use failed on a missing required `cwd`: 1 Stop line of 10,176 and the only PreToolUse line. 20 of 33 hook events have no saved sample; their schemas rest on the Agent SDK types alone.
- Status line (20261004_073924+0200-statusline-schemas-vs-stored.md): compared with 1,023,625 main and 222,329 subagent stored rows (flattened parquet). 10 of 14 main topics supported with compatible types (prompt_cache.miss_causes is stored today as six columns because alcore flattens it; the schema declares the raw object); pr, vim, worktree, rate_limits.spend_limit and subagent effort have no evidence. The raw nested payload is not on disk.
- Telemetry and API bodies (20261004_074054+0200-telemetry-bodies-vs-real-data.md and docs_dev/20261004_080733+0200-digest-final-pass-report.md): after the corrections, 81 files, 31,878 rows, 0 failed; no observed type differs from the declared one; request joins response on link.body_id 400 of 400. 15 telemetry event names and telemetry_span_hook have no saved sample.
- Speed (D-B): collect steady state 2.9 ms per file (200 files of 5 hook lines), 15 ms per 500-line file; a 20-line status-line file across 14 topic tables 3-4 ms; one alspool append 7.05 ms wall, 3.59 ms CPU, against a 6.33 ms process-spawn floor.

## Decisions made by the agent under D-I (each from a test or a measurement; the owner may overrule any)

1. Schemas describe what Claude Code emits (hook payload, status-line payload, telemetry attributes, API body), not the formats AgentlensPro saves today.
2. Topic tables (D-A): producers that share a spool read the same file, each with a schema of its own topic; rows join on (_meta_ingest_id, _meta_record_ordinal). One scan per topic table: staging in a temp table is no faster for small files and about 2x faster only on a 2 MB body (20261004_070821+0200-scan-strategy-timing.md).
3. The digester is the `aldigest collect` process; a producer only appends a line with `alspool`. A hook opening DuckDB itself lost events under concurrency (reports/hook-binaries/).
4. A producer picks its spool by name; `aldigest spools` lists the current one per source+topic. A new schema version gets a new producer_type AND a new spool, so one file never holds two shapes.
5. A file whose load raises goes to failed/ whole, with an error file and a ledger row; other files keep loading. One bad line therefore withholds its file (measured: one Stop line withheld 10,175 good lines of a file the test converter built from three days of saved data). The writer seals at 4 MiB, which bounds that loss; failed files are kept for a human.
6. NOT NULL only for top-level fields the Agent SDK types mark required (hooks). Status line, telemetry and API bodies are all nullable: measured records lack fields the docs call always present. `cwd` stays required for Stop and PreToolUse (2 anomalous lines of about 20,000).
7. A line with no payload is an error; a payload of {} is not (every optional field may be absent).
8. No autodetection (D-E): unknown keys are ignored, the schema files in the crate are edited by hand when the owner reports a change, `aldigest rehash` rewrites the hashes, and an edited schema is refused for a producer_type already installed in a database.
9. Telemetry line shape, a contract the future receiver must write: flat attribute object with the names as emitted; spans add `_span` with the OTLP JSON names. Metrics are deferred: nothing captures them.
10. Skills, agents and rules (named by the owner as topics) are not fields of an API body; they are text inside system and messages. Extracting them at load time would break D-B and D-C; they are left to queries.
11. One open spool file per producer (inbox/<spool>/current.ndjson), not per session: the loader routes by directory, and the writer seals by size.
12. memory_limit stays 256 MB: at that limit the densest real bodies load up to 14.6 MiB per file and fail at 21.9 MiB; the writer keeps files at about 4 MiB.

## Query unification plan (D-H part 4: a PLAN, not built; specs are written after the system is built, D-G)

Goal (owner, D-A and D-H): behind the scenes a topic is split over one table per schema version; queries must see ONE long-lived table and go only to the tables they need.
Evidence: reports/ingest-redesign/20261004_073237+0200-unified-view-sql-tests.md (DuckDB 1.5.6, synthetic, 3 versions x 2,000,000 rows with DISJOINT time ranges; gitignored, this machine only). Claims marked (measured) come from it; everything else is design.

### SQL objects, all generated from the catalog
Schema `u`. Names use a double underscore between source and topic, and a source or topic name may not contain a double underscore, so names cannot be ambiguous.
1. `u.<source>__<topic>`: one VIEW per source+topic. One explicit SELECT per installed version, combined with UNION ALL BY NAME (measured correct on 2M rows per version). Each branch selects the four ordering columns, every payload column under its CANONICAL name and type, and the constants `_meta_version` and `_meta_producer_type`.
2. `u.<source>__<topic>_between(t_from, t_to)`: a TABLE MACRO, the same branches with `_meta_recorded_at >= t_from AND _meta_recorded_at < t_to` in each. It carries NO validity dates: a row of an old version recorded after the next version appeared (a session still running the old Claude Code, a file collected late) must still be returned. It is a convenience with the same result as the view plus a time filter.
3. `u.<source>__all`: for a source split over several topic tables, a VIEW that joins the topic views on the UNION of their (_meta_ingest_id, _meta_record_ordinal) keys, so an event is kept even when one topic has no row for it. Ordering columns and a payload name present in several topics (session_id) are taken from the first topic, by name, that has a row for the event; each topic contributes its own payload columns.
4. `_ingest.table_timeline` (exists): which version of a topic was current when. `valid_from` is the date the owner gives when he reports a Claude Code change (D-E); null means since the beginning. It DESCRIBES the lifeline; it never filters rows. `superseded_by IS NULL` marks the current version.

### How one schema change is declared (schema keywords, written when the owner reports the change)
- Rename: `"x-replaces": "<old name>"` on the new property (exists; stored in replaces_json).
- Anything that is not a pure rename: a mapping expression, kept in a separate tracked file `schemas/mappings.json` keyed by producer_type and column, OUTSIDE the schema hash. Each one is a single scalar SQL expression over the older version's columns, validated by binding it against the old version's table. The generator puts the expression in that version branch. This covers a unit change (`duration_s * 1000`), an enum value renamed (CASE), a field split or merged, a STRUCT restructured, and a JSON column that became typed. Without a declaration a same-named field is unioned as is: a meaning change the owner did not report is invisible to the system, by ruling D-E (no autodetection).
- A field that moved to another topic is declared the same way (an entry in `schemas/mappings.json`) with the other topic view as the expression source; it is resolved in `u.<source>__all` with COALESCE. A topic that was split or merged gets a new topic name; its link to the old topic is declared in the same mapping file. Both are the hard cases and are listed as open below.
- Canonical type of a column: the type of the newest version, EXCEPT that when any version holds it as VARCHAR or JSON the canonical type is that wider type, because a STRUCT-versus-VARCHAR union binds and then fails at run time for rows it cannot convert, and casting text to a STRUCT fails (both measured). A retype inside a STRUCT or a LIST needs a mapping expression in `schemas/mappings.json`; the generator must refuse to emit a view it cannot type rather than leave it to the union.
- A canonical-name collision (a rename target that an older version already used for a different field) is a generation error.

### How a query reaches only the right tables
- With a time predicate, DuckDB dropped the versions whose tables hold no row in the range at PLAN time, from column min/max statistics, and scanned one table: 245,760 rows scanned for 86,400 returned, 1.1 ms against 0.9 ms on the table directly (measured, with disjoint time ranges). When ranges overlap the view is still correct: an overlapping table is scanned and filtered, so pruning is lost, not rows.
- `WHERE _meta_version = 2` folds the other branches away: 5.8 against 5.7 ms at one thread, 2.0 against 1.7 ms at 14 (measured).
- No predicate: every version is scanned, as it must be. Aggregating 6,000,000 rows through the view cost 0.95-1.00x one physical table at threads=1 and 1.2-1.7x at 14 threads (measured).
- Cross-topic join, no index, hash join: 2M x 2M rows in 137 ms warm (152 ms fresh) at threads=1, 26 ms at 14; one ingest id in 1-2 ms (measured, two tables). Memory under a 256 MB limit: no spill, peak 212-239 MB on fresh connections, and one warm 14-thread run reported 326 MB, above the limit, so the limit does not bound that metric. A 14-way status-line join is unmeasured. Wide joins must be filtered by time or ingest id first.
- Time semantics: `_meta_recorded_at` is the moment the line was appended to the spool. For telemetry and API bodies the event time is a payload column; a query on event time filters that column and gets no pruning guarantee.

### Generation
- One SQL statement over `_ingest.producer_types` and `duckdb_columns()` produced the CREATE VIEW text for a topic, verified equal to the hand-written view for a one-hop rename and a scalar retype (measured). The client executes the text.
- A separate command `aldigest views` regenerates ALL `u` objects on every run, topics first and `__all` views after, so a generator fix reaches an existing database; a bad mapping fails that command and never blocks installing a schema. The cost of regenerating about 90 views is unmeasured.
- Every producer gets a topic view: hooks, status line, telemetry, API bodies.

### Open, to settle when built
- Rename chains longer than one hop; rename plus retype in one step.
- Field moved between topics, topic split, topic merge: declared as above, untested.
- `SELECT *` column order follows names, not positions, and changes when a version is added; readers must name columns.
- No row key spans versions: `_meta_event_id` is per table. The key is (_meta_ingest_id, _meta_record_ordinal).
- Prepared statements bound to a view whose shape changed must be re-prepared.
- Deduplication (transcripts replay message ids; a producer writing to old and new spool during a transition): a per-source rule, not designed here.
- Derived topics the owner named (skills, agents, rules) are text inside the API-body system and messages columns: views over `u.api_request__system` and `u.api_request__messages`, not ingest-time tables (D-B, D-C).

### Acceptance checks for the build
A topic with three versions and data in each: a rename, an added field, a scalar retype, a mapping-expression unit change, and a STRUCT-versus-VARCHAR retype; assert every row and value through the view, assert the generator refuses an untypable column, assert a late old-version row is returned by view and macro, and assert with EXPLAIN that a time predicate scans one table when ranges are disjoint.

Reviewed twice by adversarial forks on 2026-10-04; open after review: the timeline describes versions but does not route queries (routing is by table statistics); a 14-table status-line join is unmeasured.

## Open after the build of 2026-10-04

- OWNER go-ahead needed: wiring. Changing the live hooks and status line means editing settings.json (through safeConfigEdit) and changing the running collector.
- Not built: the OTLP receiver that writes telemetry lines; the body writer that builds {link, body}; a seal and collect schedule; the `u` views of the query plan; readers ported to the new tables; backfill of saved data; transcripts and their deduplication; metrics.
- Measured, not explained: one `aldigest collect` over 400 real bodies peaks at about 730 MiB process RSS at the 256 MB DuckDB limit, the same for 1, 5 or 25 bodies per file, while a single file alone peaks at 86-173 MiB. Until explained, run the collector as its own short-lived process, not inside alcore (2048 MB cap, TRDD-9VX3WTGU).
- The raw status-line JSON has never been observed; capture one payload when wiring.
- valid_from is null for all 98 producers (all are version 1).
- The 22-process concurrency test does not go red when the append inode re-check is removed; only the deterministic spool test does. The 100-attempt retry bound and the torn-line message are untested.
- Shipping aldigest (41.5 MB) and alspool for four platforms; no rust-core CI job yet (TRDD-NDKKOABG).
- No advisor agent existed in the building session; adversarial review forks stood in for it.
- alspool exit code 2 means the line WAS appended and only the due seal failed: a caller must not retry it. After a failed auto-seal the next append retries the seal, so a ready file can exceed the threshold by more than one line.
- A producer needs the manifest (or the output of `aldigest spools`) to know its spool name; - A producer needs the manifest (or the output of `aldigest spools`) to know its spool name; how that reaches the hook side is part of the wiring.
- 2026-10-04 later: the tap, the source switch and the collect bound are built (see "Built after the first review"); the 730 MiB collect peak is explained (DuckDB growth per committed body file) and bounded.

## Built after the first review (2026-10-04)

The alcore tap (commit e9cc75cf), opt-in:
- Switch: alcore serve --ingest-manifest PATH --aldigest-bin PATH [--ingest-sources LIST]. Without both flags nothing changes (a test asserts no file or directory is created); half a configuration is a startup error; if aldigest register fails, alcore boots with the tap disabled and /api/ingest-status says why.
- Taps sit where the item is still whole: hook events verbatim (exact POST or spooled bytes), status line (nested payload before flattening, minus the two CLI-added keys, also on the legacy route), telemetry events and spans (one line per record from the parsed OTLP body, before ingest_parsed, outside the state lock), API bodies (after the store accepted the file).
- File writes go to the blocking pool, one lock per spool per POST (agentlens_spool::append_many). An item whose name has no spool in the manifest is counted and reported, never written; a failed tap write is counted and never fails capture.
- Schedule: every 60 s seal, then aldigest collect as a child process under its own lock, --max-files 10 per process, repeated within a tick. Shutdown seals only.
- Also added: aldigest query (read-only) and aldigest collect --max-files.
- Checks: clippy -D warnings exit 0 for the five packages; tests core 749 (13 new), digest 49, spool 19, store 52, ingest 4. Not deployed: the running collector is untouched.

Measurements (reports/ingest-redesign/, gitignored):
- Disk budget, 20261004_091622+0200-ingest-disk-budget.md: median day hooks 35.0 MB, telemetry events 26.5 MB, spans 29.8 MB, status line 0.16 GB (estimated), API bodies 22.61 GB.
- Collect RSS growth, 20261004_092653+0200-collect-rss-growth.md: 65 to 687 MiB over 72 body files, DuckDB itself, bounded by --max-files 10 per process.
- Tap overhead (commit e9cc75cf, isolated release instance): about +0.65 ms median on a 100-record OTLP logs POST, +0.04 ms on a hook POST, RSS unchanged after 2000 POSTs.
- View generator, 20261004_091832+0200-view-generator-sql.md: 323 ms for the 98 producers, 19 assertions pass.
- Backfill tool, 20261004_092052+0200-backfill-tool.md: one day, 71 files, 32,528 rows, 0 failures, a re-run loads 0.

Decision: API bodies are not spooled by default. Estimated from measured ratios: 22.61 GB on the median day for bodies against tens of MB for the other sources, and the typed tables store each request history again without de-duplication (about 7 GB/day of spool and 16 GB/day of database growth).

Decision: collect runs as a child process, 10 files per process. Measured reason: one collect process grows with every committed body file (65 to 687 MiB over 72 files, DuckDB itself) and stays under 300 MiB at about 10 files.

Decision: done/ retention is off by default and opt-in (an automatic delete is the owner's call); when on it is ledger-checked. Known ceiling: with retention on, every tick reads all complete ledger rows older than the retention, including rows whose file is already deleted; the result grows with the ledger.

Decision: tap writes go through one bounded writer thread; a full queue drops from the spool only, counted. Reason: per-write blocking tasks could reorder lines and pile up without bound.

Backfill tool: scripts_dev/digest-backfill/backfill.py (gitignored), proven on one day, never run against the real data directory.

- 125bd44b + 22299b2f: aldigest views (schema u rebuilt in one transaction; 57 digest tests).
- 301d7947: hook and status-line tap writes left the state lock (a held spool lock stalled every POST; test t14).
- 9cca67b4: CLI opt-in AGENTLENS_INGEST=on, never stops capture when aldigest is missing.
- 852ae3ca: AGENTLENS_INGEST_SOURCES is split, trimmed and rejoined; docs and card follow the tap as built.
- a7cefe42: a panicked spool writer sets writerDead at once; the retention age is computed in SQL on two absolute instants (completed_at is TIMESTAMPTZ; test t20 under TZ=Pacific/Kiritimati); spool_tap tests 20 of 20 with --test-threads=2 (one fully parallel run failed during development; four later parallel runs passed 20 of 20, so the cause was not established; possibly flaky: the failing test name and assertion text were not captured, so record them at the next failure; report docs_dev is gitignored, the result lines are: default parallel x4 exit 0, --test-threads=2 exit 0).
- 8b25ab4a: tap writes go through one bounded writer thread (4096 batches, 64 MiB; a refused batch is dropped from the spool only and counted, `droppedQueueFull` and `writerDead` in /api/ingest-status); `aldigest views` runs once per process after a collect; optional done/ retention (`ALCORE_INGEST_DONE_RETENTION_SECS`, off by default, deletes only files the ledger lists complete and that old). This replaces the bullet above that says file writes go to the blocking pool.
- Found while testing, unrelated to this work: (a) standalone/cli.js on this machine is stale and lacks server revive (unit test "a live revived child is reaped" fails at HEAD too; report reports/ingest-redesign/20261004_102654+0200-revive-test-failure.md); (b) rustOpenCode real-db parity test fails: native and JS truncate resultSummary differently at a multi-byte character. Both already have a card (see below).
- Unrelated findings already carded: rustOpenCode truncation parity is TRDD-YVQI5DYD; the stale CLI bundle cause is TRDD-E9RM51XG.
- 2026-10-04: src/test/ingestEndToEnd.test.ts runs a real collect and a real aldigest views through an alcore started by the CLI path (ensureServer, AGENTLENS_INGEST=on, isolated data dir and ports): the ledger holds complete rows, the unified hook and status-line views return exactly the posted rows, done/ keeps the files. This closes the "no real alcore started by the CLI" and "collect path under the CLI start" gaps; still NOT deployed.
- 2026-10-04 finding: /api/hook-events answers 2xx for a hook event that lacks a field its schema requires (cwd, transcript_path, source or reason by topic), and the collect then fails the WHOLE spool file, so every other event in that file goes to failed/ with it. Real Claude Code hooks carry those fields; a malformed or foreign client can still poison a file. Owner ruling D-D says anomalies are errors, so the load failing is intended; that one bad line takes the file with it is a consequence to decide on (reject at the tap, or load the valid lines and report the bad one).
- 2026-10-04: hook transport measured (reports/ingest-redesign/20261004_141111+0200-hook-transport-bench.md): alspool append 4.24 ms CPU median per event, 0 of 1980 events lost with 66 concurrent writers, against 105 ms CPU for a bare node start. Adopting it means rewriting hook commands in the user settings: owner.








## Switch-on procedure for this machine (owner decision, NOT done)

1. Free disk space first: the volume is 98% full (about 50 GB free) and rust-core/target alone is about 51 GB of regenerable build output.
2. `cargo build --release --manifest-path rust-core/Cargo.toml -p agentlens-core -p agentlens-digest` (`alspool` is not needed: the tap links the spool library).
3. Stop the server first (`agentlenspro server stop`), then copy `alcore` into `bin-native/darwin-arm64/`, then `codesign -s - --force bin-native/darwin-arm64/alcore` (without it macOS kills the binary before main); check `./bin-native/darwin-arm64/alcore --version` exits 0.
4. `aldigest` is run from `rust-core/target/release/` (or the path in `AGENTLENS_ALDIGEST_BIN`): `aldigest --help` exiting 0 only shows the binary can start at all. A kill when alcore spawns it shows only in `/api/ingest-status`, as a failed register (tap disabled at start), collect or views record; sign it with the same codesign command if that happens.
5. `node esbuild.js` (the CLI bundle `standalone/cli.js` on this machine dates from 2026-10-01 and lacks the `server revive` verb, so the hook revive of a dead collector is broken today regardless of this work), then confirm which `agentlenspro` is on PATH: `ls -ld "$(readlink -f "$(which agentlenspro)")"`.
6. Start with `AGENTLENS_INGEST=on agentlenspro server start`. Read from the code by a worker, not run: no server was started with these flags. `server restart`, the hook revive verb `server revive` (both in `serverCommand`) and `server start` all call `ensureServer`, and `ensureServer` spawns alcore with `alcoreServeArgs(process.env, ...)`; so all three pass the ingest flags whenever the variable is in the environment of the process that runs them. The `--supervise` loop and `setup` call `alcoreServeArgs` too.
7. A hook-spawned revive inherits Claude Code's environment, not the shell's (`reviveDaemonDetached` in hookHandlers.ts passes the hook's own environment to the `server revive` child), so the variable must be exported where Claude Code is launched. Re-check `/api/ingest-status` after any revive: a revive without the variable restarts alcore with the tap off, silently.
8. Watch `GET /api/ingest-status`: lines per spool, unknown names, write errors, last collect, `views`, `droppedQueueFull` and `writerDead` (`writerDead` must stay false; `droppedQueueFull` and `droppedWriterDead` must stay 0), and the size of `<dataDir>/ingest/`.
9. Roll back by unsetting the variable and restarting. That leaves `ingest/inbox`, `ingest/ready`, `ingest/done` and `events.duckdb` on disk, inert: nothing deletes them, and they are loaded again if the path is re-enabled. Disk with the default sources and done/ retention off (`ALCORE_INGEST_DONE_RETENTION_SECS` unset): `done/` grows by about 0.13 GB per day (spool of hooks, status line, events and spans, median day) and nothing prunes it; the database grows by about 0.12 GB per day (16.3 + 15.5 + 17.0 + 67.8 MB by source), about 0.25 GB per day together. All figures are estimates from reports/ingest-redesign/20261004_091622+0200-ingest-disk-budget.md. Leave `ALCORE_INGEST_DONE_RETENTION_SECS` unset at first; never set `ALCORE_INGEST_QUEUE_MAX_BYTES` (test knob).

## Owner decisions pending (2026-10-04)

- Packaging `aldigest`/`alspool`/schemas into the npm tarball (checklist: reports/ingest-redesign/20261004_091628+0200-packaging-and-deploy-survey.md; about 41 MB more per platform uncompressed).
- Switching the path on (procedure above).
- Enabling done/ retention.
- Running the backfill (`scripts_dev/digest-backfill/backfill.py`, gitignored, proven on one day) against the real data directory.
- API bodies through this path need a de-duplicating design first.
- The opt-in variable name and whether it should become a config setting.
- done/ retention reads every old complete ledger row on each tick; before switching retention on for long, add a purged mark to the ledger or an anti-join against the done/ listing (unmeasured with a large ledger).

## Approval log

- 2026-10-04T03:36:28+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-04T03:58:15+0200 — column → design by main-agent@agentlenspro. design recorded; owner items open (wrong-typed policy, NOT NULL); child slice card carries the implementation
- 2026-10-04T06:32:53+0200 — column → dev by main-agent@agentlenspro. owner ordered the build, D-H/D-I
- 2026-10-04T08:11:58+0200 — column → human_review by main-agent@agentlenspro. built and checked against real data; wiring needs the owner's go-ahead
- 2026-10-05T01:29:30+0200 — column → todo by main-agent@agentlenspro. review in the owner's stead 2026-10-05: three confirmed unfixed defects in the tap rejection path (d8de334d); not dev, because nobody is working on it

## Review findings 2026-10-04

- VERIFIED by reading `reject` and `enqueue`: rejected lines go through the same bounded writer queue as valid lines, so a flood of invalid events can fill the queue and valid lines are then dropped and counted in droppedQueueFull. Not fixed. Options: a separate small channel for rejected lines, or refuse rejected lines first when the queue is near its bound.
- VERIFIED: `statusline` calls `reject(spool, spool, ...)`, so rejectedByTopic keys are the spool name for the status line and `source/topic` for hooks and telemetry: two key shapes in one map. Not fixed.
- VERIFIED: `write_rejected` checks the file size before the write only; `reject` always enqueues exactly one line, so the overshoot past REJECTED_FILE_MAX_BYTES is at most one line (which for a hook payload can be several MiB). Not fixed.
- VERIFIED, harmless: `ts_ns` is taken before the line is queued, so rejected lines can be slightly out of order in the file.
- REFUTED for the schemas as they stand (measured with jq over schemas/manifest.json on 2026-10-04): the review said the shared-spool union of required fields could reject valid lines. The four spools with more than one producer (api_request 4, api_response 3, statusline_main 14, statusline_subagent 2) have NO `required` list in any of their 23 schemas, so the union is empty and cannot reject anything today. LATENT: it becomes live the day one of those schemas gains a top-level `required` field; and two producers that disagree on Scalar versus Array for the same field are resolved by HashMap iteration order.
- REFUTED for the schemas as they stand: the review said `Shape::Any` for a field with `x-duckdb-type` misses object/array failures. Only 6 required fields carry `x-duckdb-type`, all of them `JSON` with no `type`; a JSON column accepts an object or array, so presence-only checking is right for them. LATENT if a required field ever gets a scalar `x-duckdb-type`.
- NOT VERIFIED: the evidence for d8de334d. The review says each test passed once in separate runs at load 60 to 150 and that test t23 was only seen red on a timeout, never on its assertion. System load at 16:26 on 2026-10-04 was 146, so no test was re-run. Still owed, when load is under about 20: the two new tests plus t2 and t11 with `--test-threads=1`, and one mutation (disable `invalid_fields`) that must turn t23 red on its assertion.
- CORRECTION (second review of these findings): a rejected line that is dropped because the writer queue is full is counted in droppedQueueFull, not in rejectedNotStored, so the rejected counters under-report what was not stored.
- CORRECTION: "a JSON column accepts an object or array" was inferred, not measured in this session. Also unmeasured: a required field whose schema type is "object" gets presence-only checking, and nobody counted such fields or tested what a scalar value there does to the file.
- CORRECTION: "several MiB" for the size-cap overshoot is taken from a code comment about hook payloads, not measured. The test names t2, t11 and t23 come from the earlier review and were not confirmed against the test file.
- NOTE: `body()` (API request and response spools) never calls `invalid_fields`, so those spools are outside the rejection check altogether.
- SCOPE: "Not fixed" in the bullets above is the agent's record of the state of the code, not an owner decision to leave it. No card exists yet for fixing the three confirmed defects.

## Review 2026-10-05 (in the owner's stead)

- Verdict: returned to todo. This verdict rests on the reading of spool_tap.rs recorded in the section "Review findings 2026-10-04", not on a fresh review: three defects were confirmed there and are unfixed (rejected lines share the writer queue with valid lines; rejectedByTopic has two key shapes; the rejected-file cap is checked before the write only).
- Owed before this card can be accepted: fix or explicitly accept each of the three defects with a test; re-run the tap rejection tests serially at low load and show by a mutation that the rejection test fails on its assertion when invalid_fields is disabled.
- Unchanged and still the owner's: switching the ingest path on, packaging aldigest and alspool into the npm tarball, the backfill against the real data directory (section "Owner decisions pending").
- CORRECTION to step 5 of the section "Switch-on procedure for this machine": the claim that the stale bundle "lacks the `server revive` verb, so the hook revive of a dead collector is broken today regardless of this work" is not supported. The bundle of 2026-10-01 does lack that verb, but its own hook revive spawns alcore directly and does not use it (read in standalone/cli.js on 2026-10-05). Rebuilding the bundle is still needed for AGENTLENS_INGEST to reach the CLI and for the source-compiled hookSpool revive test to pass.
