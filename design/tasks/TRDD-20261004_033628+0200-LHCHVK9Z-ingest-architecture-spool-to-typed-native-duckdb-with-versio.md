---
trdd-id: LHCHVK9Z
title: Ingest architecture - spool to typed native DuckDB with versioned per-topic producer schemas
column: design
status: tasked
created: 2026-10-04T03:36:28+0200
updated: 2026-10-04T03:58:15+0200
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
---

# Ingest architecture - spool to typed native DuckDB with versioned per-topic producer schemas

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-04T03:58:01+0200

NEXT ACTION: build step 1: generate the JSON schema set + index for the current Claude Code version and show it to the owner.
OWNER items open: wrong-typed line policy; NOT NULL for required fields.
Related: TRDD-9VX3WTGU (memory cap; Amendment 7), TRDD-HH1NP0KD (hook binary; owns build step 7).



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

## Approval log

- 2026-10-04T03:36:28+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-04T03:58:15+0200 — column → design by main-agent@agentlenspro. design recorded; owner items open (wrong-typed policy, NOT NULL); child slice card carries the implementation
