---
trdd-id: 0BDOV3WC
title: A DuckDB out-of-memory read at boot makes the card store delete cards.duckdb and can lose cards
column: todo
status: tasked
created: 2026-10-15T01:29:03+0200
updated: 2026-10-15T04:32:27+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T01:29:03+0200
project-id: agentlenspro
---

# A DuckDB out-of-memory read at boot makes the card store delete cards.duckdb and can lose cards

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-15

- STATUS: revisions 1 and 2 were reviewed (the limit of the propose-then-review protocol); revision 3 folds in round 2 and the second measurement but is itself UNREVIEWED, and WAITS FOR THE OWNER's decision on the three open points. No code written.
- MECHANISM (verified, reports_dev/0bdov3wc-facts.md, read by the main agent at card_store.rs:185-318): try_reuse (count) and load_resident (one `SELECT session_id, card FROM cards ORDER BY seq`) both report "the cards table is unreadable"; open then deletes cards.duckdb and the restore rebuilds from the NDJSON snapshot while importing the newer offsets, so idle sessions missing from the stale snapshot are never re-read. 8 of the last 10 refusals were out-of-memory; 250 to about 10,900 cards were absent after each.
- MEASURED on a COPY of the live cards.duckdb (reports_dev/0bdov3wc-measure2.md): 41,819 cards, 80.8 MB text, file 547 MB plus a 14.7 MB WAL. The one-shot boot read PASSES at 256 MiB and FAILS at 224 MiB: today's corpus sits just under the limit, consistent with intermittent refusals as it grows. The cost is INFERRED to come from file bloat: an upsert of the indexed last_active_ms is a delete plus an insert, so every update appends a physical row, and the scan of the tail loads deleted versions of large hot cards (INFERRED for the live file; VERIFIED on a churned probe: 5,000 live rows, 100,000 physical).
- MEASURED designs: a seq-only list (`SELECT seq FROM cards ORDER BY seq`, passes at 32 MiB) plus 2,000-row pages (`WHERE seq >= ? AND seq <= ?`) passes at 128 MiB on the live copy, about 2x headroom, but fails at 64 MiB on the physical tail. A strlen/octet_length length column costs most of what the one-shot costs (fails at 128 MiB, passes at 192; the one-shot fails at 224) (octet_length does not even bind on VARCHAR), so byte-bounded pages are dropped.
- REVISION 3 (for the owner): (1) `try_open(dir, limit_mib) -> Result<CardStore, OpenRefusal{OutOfMemory, Inconsistent}>`; out-of-memory (any reuse-gate error containing "Out of Memory Error:") and a failed row-count consistency check never delete; only the pre-existing reasons (meta, versions, restore_complete, clear, invalid JSON, unreadable row) still refuse-and-rebuild. (2) `open` panics on those two, naming the knob; it is boot-time on the main thread, so no lock is poisoned, and the revive backoff applies. (3) The boot read is the seq-only list plus 2,000-row pages, sorted by seq in Rust, row totals checked. (4) Distinct messages for the count and page sites. (5) Tests in-process: t1 (5k corpus bulk-built through a raw connection; precondition: the one-shot errors with the prefix at L on a connection configured like `configure`; try_open at L reuses, compared with a default-limit reopen, not with cards()), t2 (a limit at which paging fails; Err(OutOfMemory) with the prefix, file size unchanged, then a default-limit reopen reuses), t3 (invalid JSON in a non-first page still rebuilds), t4 (a duplicate seq across a page boundary stops, not deletes); mutations for each.
- OPEN POINTS FOR THE OWNER: (a) Stop-instead-of-delete turns a silent loss into an outage (revive loop under backoff; OTLP refused while down) until the limit is raised: accept? (b) The knob: AGENTLENS_CARDS_MEMORY_LIMIT_MIB reaches a hook revive only through Claude Code's environment (INFERRED: that Claude Code passes its env block to hook children is not verified) (the "env" block of ~/.claude/settings.json) and a `server start` only from the shell that runs it; or a setting file in the data dir that every spawn reads. Which? (c) Paging buys about 2x; the bloat keeps growing. Add a compaction step (rewrite the table) now, or as its own card? Its benefit is unmeasured: the live file has only 2,422 deleted rows, so its size may be mostly free blocks. Context for (a): the live copy passes at 256 MiB today, so stop-instead-of-delete would trigger rarely now; its value is protection as the corpus grows.
- DERIVED: TRDD-6B7VV2Z7 (a current-version refusal imports offsets ahead of a stale snapshot; a LOG_INGEST_VERSION bump imports NO offsets and is not affected (log_reader.rs:873-882), but a CARD_SCHEMA_VERSION bump is affected (card_store.rs:97-101)), TRDD-WCG7I5D8 (the snapshot lags by days: RSS-cap exits precede the first 300 s card save; the hard-cap exit saves spans only), TRDD-USSG465Q (cards.duckdb bloat: upserts append a physical row per update).
- LIVE: unchanged. The live copy's one-shot boot read PASSED at 256 MiB (also on a first open with WAL replay), so a restart now most likely reuses the database, with a thin margin (224 MiB fails) that shrinks as catch-up ingest grows the corpus; the full-set backup still comes first. The fix protects the live collector only after the new binary is deployed to bin-native (codesign that copy, no in-place cp): back up, then deploy, then restart. Scratch copies of the live database (about 0.6 GB, one copy) are in the session scratchpad m0b/ for verifying the implementation.

## Problem
At boot, `try_reuse`/`load_resident` read the cards table at the 256 MiB DuckDB memory limit. When that read hits DuckDB out-of-memory, the store logs "card store NOT reusing cards.duckdb (the cards table is unreadable: Out of Memory ...)", DELETES the database and rebuilds it from the NDJSON snapshot plus delta. That snapshot can lag the offsets (offsets save every 60 s and cards every 5 min (log_reader.rs:833-834, read); recent runs died at 5-11 min under the RSS hard cap (per the facts fork)), so the rebuild can lose cards whose files read as unchanged.

## Evidence (main-agent reads of server.log and the code, plus reports_dev/poison-fix-facts.md, 2026-10-15)
- VERIFIED by the main agent (server.log read 2026-10-15): 8 of the last 10 "NOT reusing" decisions were out-of-memory (2026-10-03 16:43 through 2026-10-14 14:13); the other two (2026-10-03) were a missing meta table.
- VERIFIED by the main agent: at 11:00:39 the store reused 42,637 cards; the 11:06:04 refusal was followed by "restored 41,619 session cards" at 11:08:08, and the 14:13:14 refusal again by "restored 41,619 session cards" at 14:14:27, the same count both times, so the NDJSON fallback had apparently not advanced between those restores (equal counts do not prove equal content) (why is INFERRED: runs dying before their first 5-minute cards save).
- INFERRED: that those cards were lost rather than legitimately pruned, and that the cause is the snapshot lagging the offsets. TRDD-9VX3WTGU's ordering contract protects only the REUSE path, not this fallback.
- INFERRED: which statement hit the OOM (`try_reuse` count or `load_resident` scan); both emit the same message.

## Fix direction (to be proposed and reviewed)
- Treat a DuckDB out-of-memory error as transient, never as corruption: do not delete a database that failed to READ for lack of memory.
- Avoid the SQL `ORDER BY seq` over the whole table at boot (sort by seq in Rust, or stream).
- TRDD-DA0GN1CS commit 2 (exit on any panic) must not land before this card: every restart re-runs this path.

## Acceptance
- [ ] The failing statement is identified from a reproduction, not inferred.
- [ ] An out-of-memory read never deletes cards.duckdb; a test forces the OOM (small memory_limit) and asserts the file survives and the next boot reuses it.
- [ ] A test proves no card is lost across an OOM refusal.

## Approval log

- 2026-10-15T01:29:03+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
