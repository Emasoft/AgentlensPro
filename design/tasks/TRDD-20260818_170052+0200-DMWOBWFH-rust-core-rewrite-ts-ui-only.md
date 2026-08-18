---
trdd-id: DMWOBWFH
title: Rewrite the server core in Rust with optimized SQL — TypeScript remains only for the UI
column: todo
created: 2026-08-18T17:00:52+0200
updated: 2026-08-18T17:00:52+0200
current-owner: AgentlensPro session
task-type: refactor
severity: HIGH
priority: 1
effort: XL
labels: [performance, rust, architecture, migration]
approval-tier: 3
relevant-files: [standalone/server.ts, src/segmentedSpanStore.ts, src/logReader.ts, src/store, src/otelCallEvents.ts]
release-via: publish
---

# Rust core rewrite — GOAL SET BY THE USER (2026-08-18)

USER directive, verbatim intent: "Goal set: rewrite all in optimized rust and sql. I need the
agentlenspro server to be blazing fast. Leave typescript only for the ui." Tier-3 approval is the
directive itself; this card records the goal and the migration order. Not to be re-litigated.

## Why (measured, not assumed)

Every observed 100%-of-one-core incident traced to single-threaded TypeScript hot loops, not to
DuckDB: the 5.5M-span store walk (fixed for its recurring case by [[TRDD-7I5805QM]]), the
21k-file log-session boot scan, JSONL parsing at ingest. Node cannot parallelize these without
worker-thread plumbing that Rust gets natively (rayon, memory-mapped IO, zero-copy JSON). DuckDB
was on 4 threads (fixed — now machine-scaled).

## Target architecture

- **`agentlens-core` (Rust binary)**: OTLP/HTTP ingest (4318), segmented span store (same on-disk
  NDJSON/gz format — drop-in over existing data), log readers (claude/codex/copilot/opencode),
  the call-events index, ingest→DuckDB bodies pipeline (duckdb-rs), HTTP/JSON API (the existing
  `/api/*` message protocol, unchanged shapes from `src/shared/`), MCP server (4316).
- **TypeScript keeps**: `media/src/**` (Preact dashboard — unchanged), the thin CLI shell may
  remain TS initially (it is not hot) and port last.
- **Parity law**: the wire protocol (`/api/*` + MCP tool schemas) and the on-disk formats are the
  compatibility boundary — the dashboard and existing data must work unmodified against either
  core. `src/shared/` types become the generated/mirrored schema contract.

## Phases (each independently shippable, benchmarked, behind `agentlenspro server --engine`)

1. **P1 — span store + call-events scan in Rust** (the proven hottest path): read/write parity
   over the existing segment format, parallel segment walk, criterion benchmarks vs the TS scan
   on a copy of the real 5.5M-span store. Ship as a sidecar the TS server can exec for scans.
2. **P2 — log-session boot scan** (21k files): parallel parse, same SessionSummaryCard JSON out.
3. **P3 — OTLP ingest + bodies→DuckDB pipeline** (duckdb-rs; SQL owns aggregation — no JS-side
   materialization anywhere a SQL GROUP BY can answer).
4. **P4 — HTTP/API + MCP surface** in Rust; TS server retired; CLI port; the `--engine` flag dies.
- Acceptance per phase: byte/shape parity tests against the TS implementation on real data,
  benchmark table (cold/warm, 1-thread vs N), full existing unit-suite green against the mixed
  engine, deployed + soaked on this machine before the next phase starts.
- Per the standing phased-execution rule: report at each phase boundary before starting the next.

## Acceptance (whole card)

- [ ] No `/api/*` or MCP consumer changed; dashboard unmodified; existing data dirs readable.
- [ ] Every previously-measured single-core incident class has a benchmark proving multi-core or
      indexed behavior in the Rust core.
- [ ] TypeScript remaining in the repo serves only the UI (and, temporarily, the CLI shell).

## Approval log

- 2026-08-18T17:00:52+0200 — Card authored at `todo` under the USER's explicit goal directive.
  Immediate mitigations already landed separately: [[TRDD-7I5805QM]] (call-events index + DuckDB
  machine-scaled threads; all-history 32.7s-per-call → 3.9s indexed).

## Notes and lessons learned
