---
trdd-id: 6B7VV2Z7
title: A current-version card store refusal imports offsets ahead of a stale snapshot and loses idle cards
column: blocked
status: tasked
created: 2026-10-15T04:28:04+0200
updated: 2026-10-16T00:45:54+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T04:28:04+0200
project-id: agentlenspro
npt: [A2KNXCNH]
blocked-by: [USSG465Q]
pre-block-column: todo
blocker-probe: [trddgrep, why, 6B7VV2Z7]
blocker-holds-if: not-match:READY
unblock-when: [trdd:A2KNXCNH terminal, trdd:0BDOV3WC terminal, trdd:USSG465Q terminal]
---

# A current-version card store refusal imports offsets ahead of a stale snapshot and loses idle cards

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-15
**PLAN 2026-10-15 (revision 2, reviewed round 2 of 2): B' plus per-chunk progress replaces option C (C is now backburner card 53Y38MXJ).**
- MOVED 2026-10-15 to TRDD-A2KNXCNH (workable there; this card is blocked): Commit 1 (next; independent of the owner): `DurableState::ingest_chunk` appends each flushed chunk's read positions with `append_changed` right after that chunk's cards are put (both ingest closures, plus the boot remainder and the full-sweep remainder; targeted sweeps keep saving on the 60 s tick). The version-stale branch of `restore_from_snapshot` tombstones both logs and stamps the version before the cold rescan. The appends are added to the persistence counters. Lands after card 0R0NGVK6. Split out 2026-10-15 as card A2KNXCNH. (corrected 2026-10-15: A2KNXCNH tombstones log-offsets only; the log-sessions tombstone is this card's own fix, see below)
  - MOVED 2026-10-15 to TRDD-A2KNXCNH: Commit 1 must also: derive each record key exactly as `export_file_state` does (`PathBuf::from(&s.file).to_string_lossy()`), or the next save tombstones and re-appends every key; append only on the lock's Ok arm (a poisoned lock puts nothing and appends nothing); rebuild T3 with more than SCAN_CHUNK generated files (precedent tests/log_reader_parity.rs:168-200), a simulated death after chunk 1, and the mutation 'append once after the sweep instead of per chunk'; add T7 (after appends, a forced tick with no change writes 0 offsets bytes and the version stamp is current). Narrow claim: no `Drop` in agentlens-core/src/*.rs saves state (subfolders unchecked; dropping a DuckDB connection checkpoints without changing content). Other readers of the three files (checked by main 2026-10-15): log-delta-version.json is read and written only by DurableState (log_reader.rs:832); standalone/cli.js references none of the three file names and contains no deltaLog symbol; server_stats.rs:500-501 reads only disk sizes.
- This card's own fix (B': a refused reuse imports no read positions and rewrites log-offsets empty before mark_restore_complete): sequenced after TRDD-0BDOV3WC (owner decision a) and after TRDD-USSG465Q (re-upsert and regrow measured 2026-10-15, below). It changes 6 import-count asserts in tests/log_reader_parity.rs (:418 :460 :750 :857 :907 :929); :460 and :907 must move to the reuse path or a direct import_file_state call to keep their skip coverage. This fix also owns the eager log-sessions tombstone on the version-stale branch (self.cards.save(&{}) before the stamp), moved here from A2KNXCNH because it is safe only when a refusal imports no positions.
  - Re-upsert and regrow measured 2026-10-15 (reports_dev/6b7vv2z7-reupsert-growth.md, reports_dev/0bdov3wc-regrow-test.md): a full re-upsert of timeline-free cards grows the file by about 220 MB per pass but leaves the boot-read floor at 80 MiB; repeated whole rewrites of the 31 timeline cards raise it (88 → 136 MiB after 10 rounds, 352 MiB after 30, DuckDB 1.5.6). B' re-puts every re-parsed card un-stripped, timelines included, and demote_cold then rewrites the cold ones, so a B' rescan likely leaves a large old version for nearly every re-parsed card and raises the floor (INFERRED, untested); about 220 MB per refusal is a lower bound on file growth. Commit 2 is therefore sequenced after TRDD-USSG465Q and must compact after its own rescan.
**CORRECTIONS (review 2026-10-15):** the B' crash loop: mechanism VERIFIED by main on 2026-10-15 (the startup sweep persists no read positions until it returns); whether a cap death lands inside a full rescan is UNMEASURED. Frequency: IF TRDD-0BDOV3WC turns an out-of-memory boot read into a stop (owner decision a, pending) — not 'after'. Facts marked VERIFIED in reports_dev/6b7vv2z7-facts.md were checked by the investigation agent unless this block names main.
**RESIDUALS:** a death during the restore phase keeps no progress; per-chunk positions are a subset of the export (positions with no card are saved by the next tick); a resumed rescan runs on the sequential incremental path (INFERRED slower); clear-rescan progress is card YNKNLNO5.
Evidence (local, gitignored): reports_dev/6b7vv2z7-optionC-measure.md, reports_dev/6b7vv2z7-rev2-measure.md.

- FACTS (reports_dev/6b7vv2z7-facts.md, read-only investigation; file:line evidence there): an offset record is `{bytesRead, mtimeMs, ino, size}` keyed by file path, with no session id; cards carry no source path or bytes read, so no sound per-file freshness test exists (option A, filter offsets by the snapshot's cards, is unsound for present-but-stale cards). One Claude file yields 1 + N cards (parent plus synthetic subagent children); an OpenCode db yields many cards.
- SECOND ENTRY TO THE SAME HOLE (VERIFIED by the investigation): `restore` marks restore_complete (log_reader.rs:965) before the boot sweep and does not rewrite log-offsets, so a process killed during the boot sweep makes the NEXT boot reuse the snapshot-built store and import the old, ahead-of-snapshot offsets (restore_reused, :1021).
- OPTION B' (load the snapshot cards, import no offsets, cold-rescan every file): correct, keeps cards of gone files, but a full re-parse of about 40.9k files at boot; on this machine 1,056 of 1,334 boots since 2026-09-27 died at the RSS hard cap within 5 minutes even after tiny incremental scans, so a cold rescan per refusal risks a crash loop under the current memory profile (TRDD-9VX3WTGU, TRDD-7YPQWKPG).
- SUPERSEDED 2026-10-15 (see PLAN above): RECOMMENDED OPTION C: at each FULL card save, after cards.save succeeds, also persist the offsets exported at that moment (a watermark delta log); on a current-version refusal import the watermark set (or nothing, once, when no watermark exists yet), and rewrite log-offsets to that set before mark_restore_complete. Files changed since the last full card save re-read from byte 0, so missing and stale cards are rebuilt; gone-file cards survive; OpenCode included. Cost: a delta log appended every 5 min with changed offset records only (check against the SSD write budget).
- FREQUENCY: after TRDD-0BDOV3WC turns out-of-memory into a stop, this path fires only on a CARD_SCHEMA_VERSION bump, an incomplete restore, a clear in progress, or corruption. Option C adds a permanent write path for a rare event; the section-0 ordering fix is needed regardless.
- SUPERSEDED 2026-10-15 (see PLAN above): NEXT: proposal for option C plus the ordering fix, with the test recipe in the facts report section 4 (stale snapshot, grown and new transcripts, fresh-store boot, kill-in-boot-sweep reboot, gone-file control, no-watermark fallback).
2026-10-15: A2KNXCNH landed in 15eb1ff0. B' must also close its residual: after a version bump plus an early death or refused reuse, no stale-version card may be restored for an existing file; add a test for it.

## Problem
When the card store refuses to reuse cards.duckdb with a CURRENT ingest version (out-of-memory, a card-schema version mismatch, missing meta, restore_complete != 1, clear_in_progress, open or configure failure, unreadable count or scan, invalid JSON or row), `restore_from_snapshot` restores cards from the NDJSON snapshot and then imports the offsets unconditionally (log_reader.rs:940). Offsets are newer than the snapshot, and the sweep skips every file whose offset record matches (`unchanged()`), so a card missing from or staler in the snapshot is never rebuilt until its file changes. A LOG_INGEST_VERSION bump is NOT affected (a CARD_SCHEMA_VERSION bump IS: it refuses with the log-delta version current): a version-stale restore returns before importing offsets and cold-rescans (log_reader.rs:873-882, verified by MEASURE 2026-10-15). Evidence: reports_dev/0bdov3wc-facts.md Q4, reports_dev/0bdov3wc-measure2.md section 6.

## Fix direction
On a current-version refusal, drop the offsets of files whose card is absent from the snapshot (or re-read them), so the sweep rebuilds them.

## Acceptance
- [ ] A test: cards in the store, offsets saved, snapshot stale; force a current-version refusal; after restore plus one sweep every card is present.

## Approval log

- 2026-10-15T04:28:04+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-15T07:12:10+0200 — column → blocked by main-agent@agentlenspro. B' waits for the per-chunk progress card, 0BDOV3WC and USSG465Q

## Notes and lessons learned

2026-10-15: once TRDD-0BDOV3WC revision 3 lands, an out-of-memory error no longer refuses (it stops the server), so it leaves this card's list; the hole stays for every other current-version refusal reason, including a CARD_SCHEMA_VERSION bump.
2026-10-16: 0BDOV3WC landed: an OOM refusal no longer goes through the snapshot path (a lossless rewrite instead), so this card's exposure shrinks to the other current-version refusal reasons (schema bump, missing meta, interrupted restore or clear, corruption); `reused()` is now true after a rewrite.
