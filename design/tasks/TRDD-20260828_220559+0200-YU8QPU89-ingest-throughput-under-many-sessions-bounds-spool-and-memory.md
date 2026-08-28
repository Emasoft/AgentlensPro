---
trdd-id: YU8QPU89
title: Verify alcore ingest keeps up with many parallel Claude Code sessions without filling the spool or growing memory
column: todo
created: 2026-08-28T22:05:59+0200
updated: 2026-08-28T22:05:59+0200
current-owner: claude-agentlenspro
task-type: audit
project-id: agentlenspro
parent-trdd: DMWOBWFH
blocked-by: []
eht: []
---

# Ingest throughput vs spool and memory under parallel sessions

USER goal (2026-08-28): *"verify that the speed of ingestion in rust even when running many
claude code sessions in parallel is enough to avoid filling the spool and using too much memory."*

## Two numbers, both already suspicious

- **Spool**: `<dataDir>/hook-spool` is where hook events wait when the server is behind. The
  question is drain rate vs arrival rate at N sessions, and what happens at the boundary — a
  spool that grows without bound is the failure the USER names.
- **Memory**: VHH7FXGC measured `alcore` at **~8.0 GB RSS** steady state (5.33 → 7.72 → 7.92 →
  7.99 GB over 16 min, flattening) against ~1.5 GB for the TS server, on the same data. Nobody has
  measured where it plateaus over hours or what it is (the 24 h span window resident in memory is
  the guess, not a finding).

## Method

Isolated instance (own `DATA_DIR`/ports). A generator replays this machine's real hook + OTLP
traffic shape at 1×, 4×, 16× and 32× concurrent-session rates (derive the per-session rate from
the live statusline/hook-events history, not from a guess). Sample every 10 s for ≥ 1 h at the
highest rate: spool file count + bytes, RSS, spans/s ingested, `/api/summary` latency.

## Acceptance

- [ ] at 32× the spool stays bounded (steady-state file count does not trend up over the hour)
- [ ] RSS plateaus and the plateau is EXPLAINED (which structure holds it, measured — heap profile
      or a size accounting of the span window), with a cap or eviction if it is not the window
- [ ] the numbers and the generator are committed (report path recorded here); any fix is an NPT

## Notes and lessons learned
