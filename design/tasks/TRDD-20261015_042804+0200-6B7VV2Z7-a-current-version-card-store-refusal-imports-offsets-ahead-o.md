---
trdd-id: 6B7VV2Z7
title: A current-version card store refusal imports offsets ahead of a stale snapshot and loses idle cards
column: todo
status: tasked
created: 2026-10-15T04:28:04+0200
updated: 2026-10-15T04:36:12+0200
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
---

# A current-version card store refusal imports offsets ahead of a stale snapshot and loses idle cards

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-15

- FACTS (reports_dev/6b7vv2z7-facts.md, read-only investigation; file:line evidence there): an offset record is `{bytesRead, mtimeMs, ino, size}` keyed by file path, with no session id; cards carry no source path or bytes read, so no sound per-file freshness test exists (option A, filter offsets by the snapshot's cards, is unsound for present-but-stale cards). One Claude file yields 1 + N cards (parent plus synthetic subagent children); an OpenCode db yields many cards.
- SECOND ENTRY TO THE SAME HOLE (VERIFIED by the investigation): `restore` marks restore_complete (log_reader.rs:965) before the boot sweep and does not rewrite log-offsets, so a process killed during the boot sweep makes the NEXT boot reuse the snapshot-built store and import the old, ahead-of-snapshot offsets (restore_reused, :1021).
- OPTION B' (load the snapshot cards, import no offsets, cold-rescan every file): correct, keeps cards of gone files, but a full re-parse of about 40.9k files at boot; on this machine 1,056 of 1,334 boots since 2026-09-27 died at the RSS hard cap within 5 minutes even after tiny incremental scans, so a cold rescan per refusal risks a crash loop under the current memory profile (TRDD-9VX3WTGU, TRDD-7YPQWKPG).
- RECOMMENDED OPTION C: at each FULL card save, after cards.save succeeds, also persist the offsets exported at that moment (a watermark delta log); on a current-version refusal import the watermark set (or nothing, once, when no watermark exists yet), and rewrite log-offsets to that set before mark_restore_complete. Files changed since the last full card save re-read from byte 0, so missing and stale cards are rebuilt; gone-file cards survive; OpenCode included. Cost: a delta log appended every 5 min with changed offset records only (check against the SSD write budget).
- FREQUENCY: after TRDD-0BDOV3WC turns out-of-memory into a stop, this path fires only on a CARD_SCHEMA_VERSION bump, an incomplete restore, a clear in progress, or corruption. Option C adds a permanent write path for a rare event; the section-0 ordering fix is needed regardless.
- NEXT: proposal for option C plus the ordering fix, with the test recipe in the facts report section 4 (stale snapshot, grown and new transcripts, fresh-store boot, kill-in-boot-sweep reboot, gone-file control, no-watermark fallback).

## Problem
When the card store refuses to reuse cards.duckdb with a CURRENT ingest version (out-of-memory, a card-schema version mismatch, missing meta, restore_complete != 1, clear_in_progress, open or configure failure, unreadable count or scan, invalid JSON or row), `restore_from_snapshot` restores cards from the NDJSON snapshot and then imports the offsets unconditionally (log_reader.rs:940). Offsets are newer than the snapshot, and the sweep skips every file whose offset record matches (`unchanged()`), so a card missing from or staler in the snapshot is never rebuilt until its file changes. A LOG_INGEST_VERSION bump is NOT affected (a CARD_SCHEMA_VERSION bump IS: it refuses with the log-delta version current): a version-stale restore returns before importing offsets and cold-rescans (log_reader.rs:873-882, verified by MEASURE 2026-10-15). Evidence: reports_dev/0bdov3wc-facts.md Q4, reports_dev/0bdov3wc-measure2.md section 6.

## Fix direction
On a current-version refusal, drop the offsets of files whose card is absent from the snapshot (or re-read them), so the sweep rebuilds them.

## Acceptance
- [ ] A test: cards in the store, offsets saved, snapshot stale; force a current-version refusal; after restore plus one sweep every card is present.

## Approval log

- 2026-10-15T04:28:04+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes and lessons learned

2026-10-15: once TRDD-0BDOV3WC revision 3 lands, an out-of-memory error no longer refuses (it stops the server), so it leaves this card's list; the hole stays for every other current-version refusal reason, including a CARD_SCHEMA_VERSION bump.
