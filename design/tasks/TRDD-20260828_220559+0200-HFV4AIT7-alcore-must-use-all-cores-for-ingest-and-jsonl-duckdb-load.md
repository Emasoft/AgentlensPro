---
trdd-id: HFV4AIT7
title: Measure and guarantee that alcore uses all CPU cores for telemetry and hook ingest and for the JSONL to DuckDB load
column: todo
created: 2026-08-28T22:05:59+0200
updated: 2026-08-28T22:05:59+0200
current-owner: claude-agentlenspro
task-type: audit
project-id: agentlenspro
parent-trdd: DMWOBWFH
blocked-by: []
---

# alcore must use all CPU cores

USER goal (2026-08-28): *"test that it actually uses all cpu cores when ingesting all the data
from claude code telemetry and hooks and when loading the data from the jsonl via the duckdb."*
The reason the Rust rewrite exists at all (USER, same day): *"the typescript was unable to use all
16 cores, and the async loading of the data from the jsonl and the duckdb was stalling the
system."* So this is not a nice-to-have benchmark; it is the acceptance test of the migration's
purpose.

## What to measure (not infer)

Three load paths, each driven at a rate well above the real peak (26 spans/s measured; see
DMWOBWFH STATE) on an ISOLATED instance (own `DATA_DIR`, own ports — never the live :3000):

1. **OTLP ingest** — N parallel POSTers to `/v1/traces`.
2. **Hook events** — N parallel POSTers to `/api/hook-events` + the spool drain.
3. **Cold JSONL → DuckDB load** — boot against a copy of this machine's real `~/.claude/projects`
   (15 282 offsets / 25 900 cards, the numbers VHH7FXGC recorded) with `--no-log-scan` OFF.

For each: per-core utilisation over the run (`ps -o %cpu` is one number — use `top -l` samples or
`powermetrics`/`sample` so the answer is "how many cores were busy", not "how much CPU"), wall
time to drain, and the tokio worker count actually configured. Read the runtime construction in
`alcore.rs` and the ingest/log-scan task structure FIRST: a single `Mutex<CoreState>` around the
hot path serialises every path onto one core no matter how many workers exist, and that is the
most likely finding.

## Acceptance

- [ ] a reproducible script under `scripts/` (or `rust-core/…/benches`) drives all three paths and
      prints cores-busy + throughput; its output is committed as a report path in this card
- [ ] each path shows ≥ (cores − 2) cores busy under saturation, or the card records the exact
      lock/queue that prevents it and the fix lands as an NPT of this card
- [ ] the cold JSONL load does not stall the UI: `/api/summary` p99 latency during the load is
      recorded and stays under 1 s

## Notes and lessons learned
