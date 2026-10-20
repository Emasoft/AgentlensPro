---
trdd-id: T0G38TZ4
title: corpus_bytes scans the whole card corpus and OOMs the 256 MiB pool under the state lock
column: todo
status: tasked
created: 2026-10-20T20:57:37+0200
updated: 2026-10-20T20:57:37+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: user
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-20T20:57:37+0200
---

# corpus_bytes scans the whole card corpus and OOMs the 256 MiB pool under the state lock

## Symptom

`CardStore::corpus_bytes` (rust-core/crates/agentlens-core/src/card_store.rs:756) runs
`SELECT count(*), COALESCE(SUM(strlen(card)), 0)::BIGINT FROM cards` — a full scan of the card TEXT
— under the state lock, inside a 256 MiB DuckDB buffer pool (MEMORY_LIMIT, card_store.rs:77).
On a corpus of ~84 MB of card text this exceeds the pool and the live server logs
`card corpus UNAVAILABLE: Out of Memory Error` (chores.rs:555) on every 30 s composition tick.

## Why it matters

This is the ONE memory defect that survives in the current source (the Oct 3 panic that poisoned
the mutex is already fixed by f9e0742e / TRDD-KMF02UEX). It is a diagnostics-only metric — the
metric is lost, the tick is not — but it runs every 30 s under the state lock, so each failure
adds an OOM abort to the hottest path in the process.

## Root cause

The aggregate is the wrong tool: the card text need never be read to know its size. The table
already carries `timeline_len` per row, and the resident parsed layer (`CardStore::parsed`)
holds every card. A byte total can be TRACKED on the write paths instead of computed by a scan.

## Proposed fix (measure first)

Track `card_bytes` as a running counter on `CardStore`, updated on every write path:
`put_arc` (replace: subtract the old card length, add the new), `demote_cold` (subtract the
stripped card, add the pre-demotion length), `clear` and `discard_cards` (reset to 0), and the
`load_resident` rebuild (accumulate the parsed length). `corpus_bytes` then returns
`(self.parsed.len(), self.card_bytes)` with no DuckDB statement at all.

INVARIANT to assert in a test: the tracked counter equals the DuckDB aggregate on a corpus
small enough to scan. A counter that drifts from the table is the failure this introduces, and
the test is what keeps it honest.

## Acceptance

- [ ] `corpus_bytes` issues no DuckDB statement (assert with a counter or by removing the
      connection from its signature).
- [ ] A test asserts the tracked byte total equals `SELECT COALESCE(SUM(strlen(card)),0) FROM cards`
      on a populated store, after a put, a demotion, a clear and a reopen.
- [ ] The composition tick no longer logs `card corpus UNAVAILABLE` on the live server after
      the deploy.
- [ ] `cargo clippy --all-targets -D warnings` is clean.

## Notes

- MEASURED: the live OOM message is `card corpus UNAVAILABLE: Out of Memory Error`; the corpus
  is ~84 MB of card text; the pool is 256 MiB (card_store.rs:77).
- The caller is chores.rs:753 (the composition probe), under the state lock, every 30 s.
- The competing explanation — that the OOM is a transient ingest spike rather than the scan —
  is settled by the fact that the aggregate reads the WHOLE table regardless of size, and
  the pool is 3x the corpus, so the scan itself is the load. NOT yet measured: whether a
  `SUM(strlen(card))` over 84 MB genuinely exceeds 256 MiB, or whether the abort is a
  separate limit. MEASURE before choosing the fix shape.

## Approval log

- 2026-10-20T20:57:37+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
