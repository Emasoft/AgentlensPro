---
trdd-id: 5JZQFVO8
title: The collector crash-loops at boot because the card store 256 MB DuckDB pool overflows during the boot sweep upsert
column: dev
created: 2026-09-08T22:41:53+0200
updated: 2026-09-08T22:41:53+0200
current-owner: main
task-type: bugfix
min-approval-requirement: none
priority: critical
severity: critical
blocked-by: []
parent-trdd: 7YPQWKPG
npt: []
eht: []
implementation-commits: []
project-id: agentlenspro
scope: project
labels: [rust, duckdb, card-store, boot, crash-loop, memory]
relevant-rules: []
---

# The collector crash-loops at boot because the card store 256 MB DuckDB pool overflows during the boot sweep upsert

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-08

NEXT ACTION: read the background investigator's root-cause report under
`reports/card-store-oom/` (still being written as of card authoring time), then propose the
minimal fix (bounded batches/commits per chunk in the boot sweep, or a spilling store) for
adversarial review BEFORE implementing. Do NOT raise the 256 MB memory_limit — TRDD-DKBGT7MQ
already shows per-instance limits summing to 19.25 GB across running instances on this
machine, so raising a per-instance cap compounds a known problem rather than fixing this one.

## Why

On the real `~/.agentlens` store (4,382,419 spans / 31 segments, ~33k session cards) every
hook-revive boot dies within ~6–20 s because the card store's DuckDB connection pool
(`memory_limit='256MB'`, `threads=2`, `card_store.rs` ~81-131) runs out of memory while
upserting session cards during the boot sweep. This is a crash LOOP, not a one-off: each
hook invocation revives the server, the server OOMs during its boot sweep, and the process
exits — repeating on every subsequent hook fire.

## Evidence

- Panic: `thread 'log-sweeper' panicked at crates/agentlens-core/src/card_store.rs:168:14:
  upsert a session card: DuckDBFailure(... "Out of Memory Error: could not allocate block of
  size 256.0 KiB (255.8 MiB/256.0 MiB used)")`, followed by `alcore: log-sweeper died during
  the boot sweep`, then process exit.
- 1,155 hook-revive boots logged in `~/.agentlens/server.log` today; first OOM at log line
  538148.
- Card store pool config: `SET memory_limit='256MB'; SET threads=2` (`card_store.rs` ~81-131).
- Deployed binary: `bin-native/darwin-arm64/alcore` from the 2026-09-07 22:21 deploy (commit
  482f38d6).
- The crash loop was MASKED until 22:38 because a leaked test server (see TRDD-YGEV6QDD) was
  squatting the canonical ports, so hook fires were routed to it instead of triggering a real
  revive-and-crash cycle.
- A background investigator is writing a root-cause report under `reports/card-store-oom/`
  (path only — content not yet available at card-authoring time).
- Related open cards: TOIM26HP, DKBGT7MQ, FSMISF5K, WKLD508O.

## Acceptance

- [ ] Root-cause report read from `reports/card-store-oom/`.
- [ ] A minimal fix proposed (bounded batch/commit sizing in the boot sweep, or a spilling
      DuckDB config) — NOT a raised `memory_limit`.
- [ ] Fix passes adversarial review (per `~/.claude/rules/propose-then-review-then-implement.md`)
      before implementation.
- [ ] A hook-revive boot against the real `~/.agentlens` store completes the boot sweep without
      an OOM panic.
- [ ] `cargo test --workspace` (excluding known-hanging `tldr coupling` per project memory)
      passes on the affected crate.

## Approval log

