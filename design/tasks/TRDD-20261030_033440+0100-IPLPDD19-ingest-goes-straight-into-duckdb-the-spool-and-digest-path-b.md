---
trdd-id: IPLPDD19
title: Ingest goes straight into DuckDB - the spool and digest path becomes the only path
column: design
status: tasked
created: 2026-10-30T03:34:40+0100
updated: 2026-11-01T02:40:02+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: refactor
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-30T03:34:40+0100
parent-trdd: 7YPQWKPG
---

# Ingest goes straight into DuckDB - the spool and digest path becomes the only path

## WHY

Parent: TRDD-7YPQWKPG (DuckDB is the memory). PLAN v3 step 8 there said "ingest straight into DuckDB" in one line; the ingest inventory of 2026-10-30 found the existing spool and digest path covers a fraction of what that needs, so step 8 is its own design card.

OWNER DIRECTIVE RE-ISSUED 2026-10-30 (verbatim, from TRDD-7YPQWKPG WHY): *"it should not hit the memory limit. it should digest all data via duckdb at very high speed without allocating nothing. all must be handled by duckdb. duckdb will digest and save to disk. nothing will stay in memory. this is the task i gave you but you failed it. so we stopped agentlenspro since it is too slow now."*

OWNER RULING 2026-10-30 on the memory budget (verbatim): *"yes, 2gb is the limit combined when digesting. when diagnosticating an issue or analyzing due to a cli command, it can grow to 4gb, but still using duckdb mostly. the rust code should allocate only the answer."*

The owner rulings D-A to D-I quoted in TRDD-LHCHVK9Z (per-topic versioned tables, millisecond loads, "no computation time at all" at load, precompiled mappings, no autodetection, no Python) bind this card unchanged.
OWNER DIRECTIVE 2026-10-30 (verbatim, from TRDD-7YPQWKPG WHY), answering the open plan questions; it makes the 2 GB figure an indicative target and adds the CPU bound: *"decide yourself. base your deisions on verified facts. keep the memory as low as possible, no matter what. make sure to write all data ingested into duckdb database compressed tables, not keeping anything in memory. do not follow an exact rule. 2gb is indicative. but cpu core usages is also essential and must be kept below 100% per core. the system must never become unresponsive. so design well. you planned a lot last time. did you found some good solution? if not try again. but be sure to make certain that no process become too cpu consuming to prevent other processes."*

## CURRENT STATE

- The digest path spools 5 sources: hooks, status line, OTLP telemetry events, OTLP spans, and API bodies (bodies off by default). Source list: `rust-core/crates/agentlens-core/src/spool_tap.rs` ALL_SOURCES and DEFAULT_SOURCES.
- It spools NO transcripts (Claude, Codex, Copilot JSONL, OpenCode SQLite) and no OTLP metrics.
- It is opt-in (`alcore serve --ingest-manifest --aldigest-bin`, passed by the CLI only with AGENTLENS_INGEST=on) and additive: the in-process card path still runs beside it.
- It has never run against a real data directory, and nothing in alcore reads `events.duckdb`; only `aldigest query` and two TypeScript tests do.
- It is a raw-field store by owner ruling D-C: every derived card field (cost, cache tiers, subagent tree, timeline, the log-or-telemetry merge rule) has no SQL counterpart yet.
- The OTLP tap sits BEFORE the agentlens-ingest transform (`lib.rs` handle, between parse_payload and the state lock), so it spools pre-transform records.
- `aldigest collect` runs as a child process every 60 s, at most 10 files per run; one collect has been measured near 730 MiB (`spool_tap.rs` header).

## GAPS

1. Transcript producers: no schema, spool writer, offset ledger or dedup for Claude, Codex, Copilot JSONL or OpenCode SQLite. Owner: TRDD-LHCHVK9Z (no child card) — needs a card.
2. Card derivation as SQL: per-session aggregates, pricing as a table, 1h cache tier, subagent tree, tool and file counts, outcome, timeline, loop signals. Needs a card.
3. OTEL session derivation as SQL over the telemetry span and event tables (today `summarize/*` over SpanWindow). Owner: TRDD-FSMISF5K (human_review; its title says the span window is deleted, but `lib.rs` still fills and reads it).
4. The merge rule (log wins for Claude, OTEL elsewhere; `feed_merge.rs`) as SQL. Needs a card.
5. OTLP transform state: codex prompt grouping (unbounded normalizer maps), claude_code. re-prefix, gen_ai content injection, account pairs, body pointers and the dropped-event gate are lost because the tap spools pre-transform records. Needs a card (decision below).
6. Three unfixed tap defects from the TRDD-LHCHVK9Z review of 2026-10-04 (rejected lines share the bounded writer queue; two key shapes in rejectedByTopic; rejected-file cap checked pre-write only). Owner: TRDD-LHCHVK9Z.
7. API bodies: off by default, no de-dup design, large daily volume. Owners: TRDD-TC8HW857, TRDD-U50JCH0J, TRDD-TXRRF34L, TRDD-IFOQAQYV, TRDD-JK4I9MFY, TRDD-IGPWXZ1M (user approval), TRDD-Y1M56VMY.
8. Readers: every reader (dashboard, statusline-history, last-compact, cache-state, cache-expired, burn, MCP) must read the digest tables. Owners: TRDD-LHCHVK9Z step 9; PLAN v3 steps 3 and 4 (TRDD-Q9WD3K5R, TRDD-KBM09XHB).
9. Database topology: `events.duckdb` is written by a child process while TRDD-DKBGT7MQ wants one process-wide instance; DuckDB allows one read-write process at a time. Owners: TRDD-DKBGT7MQ, TRDD-LHCHVK9Z (decision below).
10. Switch-on and packaging: aldigest and alspool are not in the npm tarball for the 4 platforms; switch-on is an owner decision. Owner: TRDD-LHCHVK9Z.
11. Hook transport still goes through the Node CLI. Owner: TRDD-HH1NP0KD.
12. Load-failure policy: one wrong-typed line fails its whole sealed file; the tap reject amendment is proposed, not ruled. Owner: TRDD-LHCHVK9Z (owner item).
13. Dedup: transcripts replay message ids, and old and new paths overlap during a transition. Owner: TRDD-LHCHVK9Z Open (decision below).
14. CPU bound: digest runs THREADS=1 by design. The owner directive of 2026-10-30 supersedes the TRDD-HFV4AIT7 goal of (cores - 2) busy cores: no core at 100 percent and no process starving others, so the load runs on bounded pools at background QoS with bounded batches and a duty cycle (PLAN v3 step S amendment d: the DuckDB threads setting alone does not cap the process). Owner: TRDD-HFV4AIT7.
15. Duplicate span storage: the span store segments, the telemetry span tables and SpanWindow would hold the same spans; one must remain. Needs a card (TRDD-FSMISF5K nearest).

## DECISIONS NEEDED

**Gap 9, topology.** Three options:
- (a) Collect in-process: the digest loader runs as a library inside alcore on the one DuckDB instance, on a bounded connection (threads, sealed-file size cap). One writer, one budget, readers never wait on a foreign lock. Costs: reverses the Cargo rule that alcore never depends on agentlens-digest (it exists for crash isolation and to keep the load memory out of alcore); a loader fault takes the collector down.
- (b) alcore reads between collects: the child holds the write lock only while collecting and alcore opens read-only between runs. Costs: reads stall during every collect; two processes with two buffer pools, so the combined 2 GB cap must count both; readers see data up to 60 s old.
- (c) aldigest serves queries: alcore forwards every query to a long-running aldigest. Costs: a second resident process, inter-process traffic on every page query, the budget split across two processes, the largest rewrite.
- **Recommendation: (a)**, because the owner rulings set ONE combined 2 GB budget and "all must be handled by duckdb"; one process with one instance and one memory limit is the only option where the budget is bounded by construction and no reader waits on another process. Conditions: PLAN v3 step S must show that a file-backed instance holds its limit; the Cargo rule is changed on purpose, with this reason recorded at the change.

**Gap 5, tap placement.** Before the transform (today): the spool keeps raw OTLP, which honours D-C, but the per-record mappings and the stateful codex grouping must be rebuilt in SQL. After the transform: a bounded Rust transform stays at ingest, which is computation at ingest and conflicts with D-C. **Recommendation: keep the tap before the transform** and express the per-record mappings (re-prefix, gen_ai injection, account pairs, body pointers) as SQL views; the codex prompt grouping becomes a window query by session and prompt id and needs a spike first, because it is the one stateful transform. Owner to confirm, since it reads D-C.

**Gap 13, dedup.** Options: a unique key with INSERT OR IGNORE (an index whose memory cost TRDD-2HRA270Y measured as large); query-time dedup (QUALIFY row_number over the message id; no index, a read cost per query); a producer offset ledger that spools only new bytes, as the log tail offsets already do. **Recommendation: the offset ledger at the producer plus query-time QUALIFY as the backstop, no unique index.** Not ruled by the owner.
Step S findings 2026-10-30 that bind this card (reports_dev/7ypqwkpg/20261030_034335+0100-stepS-duckdb-bound.md): one process owns the database file (a second process cannot open it at all, read-only included, while one holds it read-write), which decides gap 9 for option (a), collect in-process; no PRIMARY KEY or ART index for dedup (1,297-1,400 MB under a 1 GB limit, out of memory under 512 MB), so gap 13 dedups by an anti-join insert into key-sorted tables (within 512 MB + 300 MB, lookups 0.4-1.4 ms) behind the producer offset ledger; text columns are stored with zstd on STORAGE_VERSION v1.2.0 or later (the default storage version keeps card JSON uncompressed, 120 MiB vs 14.2 MiB); memory_limit does not bound the process, so every ingest batch is bounded by size and its peak footprint is measured.

## ORDER

1. Gap 9 decision, after PLAN v3 step S reports.
2. Gap 6, the three tap defects (small, already owned).
3. Gap 1 and gap 13 for Claude transcripts first.
4. Gap 2 for Claude cards, pinned unchanged by `claude-expected.json`, `log-reader-expected.json`, and the spawntree, loop and pricing fixtures (pricing becomes a DuckDB table).
5. Gap 3 pinned by `summarize-expected.json`; gap 4 pinned by `feed-merge-expected.json`; gap 5 per its decision.
6. Gap 15 and gap 8, together with PLAN v3 steps 3 and 4.
7. Codex, Copilot and OpenCode producers and derivations, pinned by their expected JSON.
8. Gaps 14, 11, 12, 10, then 7.

Parity rule: a digest-built card is serialised to the Card shape and compared with the existing expected JSON fixtures under `rust-core/crates/agentlens-core/tests/fixtures/`, unchanged. Nothing pins the digest tables against them today (agentlens-digest tests pin loading only).

## ACCEPTANCE

- [ ] The gap 9 topology is decided and recorded on this card with the PLAN v3 step S measurement it rests on.
- [ ] The three tap defects are fixed, each with a test that fails before its fix.
- [ ] Claude transcripts are spooled and loaded; re-reading the same file adds zero rows.
- [ ] Digest-built Claude cards equal `claude-expected.json` and `log-reader-expected.json` after serialisation to the Card shape.
- [ ] OTEL sessions built from the digest tables equal `summarize-expected.json`, and the merge equals `feed-merge-expected.json`.
- [ ] Codex, Copilot and OpenCode cards equal their expected JSON.
- [ ] The in-process card path (logscan build_result into put_arc; ingest_parsed into SpanWindow) is deleted: no code path in alcore builds a Card in Rust from a whole file.
- [ ] Spans are stored in exactly one place.
- [ ] On a frozen copy of a real data directory, a cold load of every transcript keeps the whole process, children included, near the indicative 2 GB footprint target, sampled every second: crossing it throttles ingest and never exits (only a machine-protecting signal exits); peak Rust live memory on a copy with twice the transcripts is within 10 percent of the 1x copy.
- [ ] During the cold load no core of the process sits at 100 percent, ingest threads run at background QoS, and a dashboard page answers within 200 ms p95.
- [ ] The npm tarball carries every binary the path needs for the 4 platforms, and `pnpm run check-dist-contents` passes.

## Relevant cards

TRDD-7YPQWKPG (parent), TRDD-LHCHVK9Z, TRDD-VXD881R6 (archived, slice 1), TRDD-HFV4AIT7, TRDD-FSMISF5K, TRDD-DKBGT7MQ, TRDD-KBM09XHB, TRDD-Q9WD3K5R, TRDD-2HRA270Y, TRDD-2JOIAH2G, TRDD-HH1NP0KD, TRDD-TC8HW857, TRDD-U50JCH0J, TRDD-TXRRF34L, TRDD-IFOQAQYV, TRDD-JK4I9MFY, TRDD-IGPWXZ1M, TRDD-Y1M56VMY.

## Notes and lessons learned

## Approval log

- 2026-10-30T03:34:40+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
