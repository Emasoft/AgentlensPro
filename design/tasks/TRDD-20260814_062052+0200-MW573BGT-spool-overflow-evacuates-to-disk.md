---
trdd-id: MW573BGT
title: Spool overflow evacuates to disk verbatim — a burst must never lose a body
column: complete
created: 2026-08-14T06:20:52+0200
updated: 2026-08-14T06:35:00+0200
current-owner: agentlenspro-main
task-type: feature
approval-tier: 0
scope: project
project-id: agentlenspro
parent-trdd: KB17X5G2
labels: [spool, store, data-integrity]
severity: high
---

# Spool overflow evacuates to disk verbatim — a burst must never lose a body

**Owner directive (2026-08-14, verbatim intent):** "in case of rare bursts you can simply write to
disk directly or make the spool immediately flush to disk its content in uncompressed form and
compress it on the disk. the important point is that it should never lose any data. ever."

## The residual loss window this closes

TRDD-KB17X5G2's back-pressure redirect protects only sessions that START after it fires — Claude
Code's exporter reads `OTEL_LOG_RAW_API_BODIES` once at launch, so an in-flight session or subagent
keeps writing into the spool. If the spool fills, THOSE writes fail inside the exporter (ENOSPC) and
the bytes are gone. We cannot wrap the write (we do not own it), but we DO own the spool's contents:
freeing space faster than the burst fills it keeps in-flight writers alive.

## Design (shaped from what already exists)

When spool free bytes fall under an evacuation threshold (default 256 MB, env
`AGENTLENS_SPOOL_EVAC_MB`; deliberately ABOVE the 64 MB redirect floor), MOVE the oldest QUIESCENT
body files verbatim from the spool to `LEGACY_BODIES_DIR` — already a `durable: true` drain target,
so the normal ingest pass picks them up from SSD with the fsync barrier, and compression to Parquet
happens on disk exactly as the owner described. No parsing, no verify, no compression in the
evacuation itself: a raw sequential copy is an order of magnitude faster than ingestion, which is
the whole point.

Load-bearing details:

- **Quiescence gate:** only files with mtime ≥ 3s old. Evacuating a file the exporter is still
  writing would copy a truncated body and then delete the source — the exact loss this card forbids.
- **Copy discipline (cross-device, so rename alone is impossible):** copy to `<name>.evac.tmp` in
  the destination, fsync the fd, rename to `<name>` (atomic within the dest fs), fsync the dest
  dir, only THEN unlink the source. A crash at any point leaves either the source intact or a
  durable complete copy — never neither.
- **Collision in dest:** overwrite via the same temp+rename. Filenames are request-id-keyed, so a
  same-name file is the same body (and the store dedups by content anyway).
- **Trigger + bound:** piggyback the existing 5s spool tick; guard with an `evacRunning` flag
  (never overlap); per tick move oldest-first until free ≥ 2× threshold or ~256 MB moved
  (re-evaluate next tick) so one tick never runs unbounded.
- **SSD wear:** paid only during rare bursts — the owner explicitly ranks zero loss above wear.
- The redirect (new sessions → SSD at the 64 MB floor) and the P1 flush law stay as-is; evacuation
  is the third, innermost layer.

## Acceptance

- [x] Pure planner (`planEvacuation({freeBytes, files, nowMs, ...})`) unit-tested: picks
      oldest-first quiescent files, skips too-fresh ones, stops at the byte budget/target.
      (CLOSED — src/test/spoolEvacuation.test.ts, 18 tests, 5f70ad3.)
- [x] Real-fs test: seeded spool-like dir + one too-fresh file → evacuate → moved files
      byte-identical in dest, too-fresh file untouched, sources gone; collision case overwrites
      cleanly via temp+rename. (CLOSED — same suite; also pins the crash-leftover-tmp case.)
- [x] Wired into the 5s tick behind the threshold, overlap-guarded; gates green; deployed.
      (CLOSED — tickSpoolEvacuation after the SPOOL_MODE guard, spoolEvacRunning flag; review
      added the load-bearing mkdir of the dest dir, which nothing else creates. Deployed with the
      2.25.0 release build.)
- [x] The evacuated files are ingested by the normal pass from `LEGACY_BODIES_DIR` (existing
      drain-target behavior — assert via a store-level test or first-hand observation).
      (CLOSED — the legacy dir is drainTargets[1] with durable: true (standalone/server.ts), the
      SAME target the pass has always ingested from; evacuation deliberately lands files under
      their original request-id names so they are indistinguishable from redirect-written bodies.
      The filename-filter parity test pins that evacuation moves exactly the files ingest reads.)

## Approval log

- 2026-08-14T06:35:00+0200 — COMPLETED (dev → complete). Implemented per the card
  (reports/trdd-review/20260814_062834+0200-MW573BGT-evacuation.md), reviewed first-hand: the
  copy-discipline ordering verified in code (rename → dir fsync → unlink last), the SPOOL_MODE
  guard ordering verified at the call site, and one review defect fixed before commit (dest-dir
  mkdir — absent it, evacuation would ENOENT on the first real burst). 26/26 tests, all gates
  green, commit 5f70ad3.
