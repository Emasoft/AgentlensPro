---
trdd-id: DMWOBWFH
title: Rewrite the server core in Rust with optimized SQL — TypeScript remains only for the UI
column: dev
created: 2026-08-18T17:00:52+0200
updated: 2026-08-18T17:45:00+0200
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

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-18 (v2)

- **P1 COMPLETE and LIVE.** `agentlens-spanstore` reads the real segment format with a rayon
  parallel walk; `alscan` CLI; the TS server EXECS it for every call-events scan on this machine.
- **Wiring (src/rustScan.ts + otelCallIndex.ts head):** two explicit opt-in channels — env
  `AGENTLENS_ALSCAN=/path` (per-process, wins, routes unconditionally) and the durable install
  `~/.agentlens/bin/alscan` (`dataPath('bin','alscan')` — presence IS the opt-in; applies ONLY
  when spansDir is not overridden, so fixture-driven tests keep testing the TS path on machines
  that have the binary). A failed exec THROWS — no silent TS fallback once opted in. Deployed:
  binary installed, bundle rebuilt, server restarted, and the live server was OBSERVED exec'ing
  `~/.agentlens/bin/alscan ~/.agentlens/spans --since 0 --until … --json` (child of the server pid).
- **Tests:** `rust-core/…/tests/parity.rs` (4 golden fixtures: string-int OTLP values incl.
  full attr set query_source/speed/effort/agent.name, time precedence, gz≡plain, mid-compression
  dedupe, windowing, corrupt tail) + `src/test/rustScan.test.ts` (cross-engine deepStrictEqual
  vs the TS scan on a fixture store — field-for-field, and the routing test; 🐌-gated on the
  local cargo build, PENDING on CI which has no Rust). Suite 2403 passing.
- **Benchmarks (real 5.5M-span store, 31 segments, 240,729 events)** — table in the body below.
  Headline: 32.7s single-core TS → 1.1s at 667% CPU (14 threads) ≈ 29× wall.
- **PARITY PROVEN on the real store (17:08):** key-normalized diff of 240,482 co-visible events —
  zero real divergence (23 only-ts were post-run live growth). Diff trap: serde_json alphabetizes
  keys vs JSON.stringify insertion order — always key-normalize both sides before comm.
- **P2 IN PROGRESS — the Claude transcript parser is PORTED and PARITY-PROVEN.** Crate
  `agentlens-logscan` (+ `allogscan` bin): faithful port of `_claudeOnEntry`/`_buildCard`/
  `_buildSubAgentCards`/timelineRetention — usage dedup per message.id, UTF-16 length parity in
  the retention accounting (JS .length is UTF-16 units, NOT bytes — utf16_len/utf16_slice, never
  str::len), bounded collections with insertion-order eviction (IndexMap.shift_remove), Rc-shared
  timeline entries so late tool_results mutate evicted entries harmlessly, `<synthetic>` model
  guard, single-tool_result toolUseResult attribution gate, worktree/subagents parent linkage.
  ONE-SOURCE-OF-TRUTH SPLIT (deliberate, keep it): Rust emits `blendTurns`/`genFiles`/
  `lastTimestampMs`; the TS wrapper `src/rustLogScan.ts::finishRustTranscript` owns accountId
  (live registry), speedBlendedCostUsd (pricing.ts is the ONE table — never grow a Rust rates
  mirror), attachGeneratedFiles (fs heuristics), hot-age strip (Date.now).
  **PARITY: fixture tests (mixed-speed, caveat/api, async Agent + sync Task, astral chars) AND a
  99/99 real-corpus sweep — 3 newest transcripts of EVERY project on this machine, deepStrictEqual
  on the JSON wire shape, zero mismatches.** Boot-scan measure: 13,110 files → 12,928 cards in
  5.6s at 462% CPU (`allogscan --dir ~/.claude/projects`).
- **P2b WIRED AND MEASURED.** `_scanClaude` fans never-seen (cold) files to ONE `allogscan
  --files-from` exec (argv would exceed ARG_MAX at 13k paths); live tails stay TS-incremental;
  fileState seeded from the binary's `fileSizeBytes` with a stale-mtime poison when the file grew
  mid-scan (conservative-safe: mismatch → reparse). The binary hot-age-strips cold parent
  timelines itself (`--strip-older-than-ms`) — the unstripped corpus NDJSON measured **1.2GB**
  (ENOBUFS through any pipe); stripped it pipes fine, and it is the same TRDD-66IXMIGN parse-time
  strip the TS parser applies (child cards keep their ≤1-entry timelines, parent only, and the
  stripped card carries `timelineRetainedBytes: 0` exactly as TS stripTimeline leaves it).
  Real-corpus cold boot through the REAL `_scanClaude`: **12,932 sessions + 4,241 child cards in
  6.7s** (binary 4.1s on 14 threads) vs **27.0s single-core TS** — identical result counts both
  engines. NOTE: ordinary server restarts take the "Fast restart — skipping cold rescan" path
  (persisted offsets import into fileState), so the Rust path fires exactly on the expensive
  case: true cold boots — fresh installs, offset-store loss, the original incident class.
- **P2c: CODEX PORTED AND PARITY-PROVEN.** `codex.rs` (openai-shaped buckets — cached ⊂ input
  shed at construction; reasoning folds into output; lastTimestamp advances only on event_msg;
  LATEST cumulative total_token_usage wins). `allogscan --codex` selects the grammar;
  `_scanCodex` wired with the same cold-fan-out + `_recordRustColdScan` shared tail (one copy of
  the fileState-seeding contract). Parity: fixture + **7/7 real codex transcripts** deepStrictEqual.
- **NEXT ACTION (one step):** P2d — port the copilot parsers (3 file shapes:
  `_parseCopilotFile`, `_parseCopilotVSCodeFile`, `_parseCopilotVSCodeJsonFile`, ~700 TS lines);
  opencode (SQLite read) deliberately WAITS for P3's duckdb-rs. Then P3 (OTLP ingest +
  bodies→DuckDB, SQL-owned aggregation), P4 (HTTP/MCP in Rust, TS server retired).
- Gotchas encoded: OTLP intValue arrives as number OR string; dedupe covers mid-compression dual
  segments; corrupt tail lines skip; the TS OtelCallEvent carries speed/effort/agentName —
  a --parity-json requestId/ts/sessionId diff does NOT prove full field parity (the
  cross-engine deepStrictEqual test does).
- Companion mitigations SHIPPED separately ([[TRDD-7I5805QM]], v2.29.0): call-events sidecar
  index (still the no-binary path), get_cache_event_log default 24h, DuckDB threads
  machine-scaled (4 → 12 here).

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

## P1 benchmark table (real store: 5.5M spans, 31 segments, 240,729 api_requests — 2026-08-18)

| Path | Wall | CPU | Notes |
| --- | --- | --- | --- |
| TS scan, all history (pre-index, the incident) | 32.7s | ~100% one core | per call, minutes of pegged core under load |
| TS + sidecar index, all history ([[TRDD-7I5805QM]]) | 3.9s | one core | sealed days cached, live day parsed per call |
| **Rust `alscan`, all history** | **1.1s** | **667% (14 threads)** | whole store, cold sidecar-free |
| End-to-end `get_cache_event_log` window 0 (live server → alscan) | 3.5s | — | includes bodies scan + MCP round-trip |
| End-to-end `get_cache_event_log` default 24h | 0.69s | — | segment day-selection skips sealed history |

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
