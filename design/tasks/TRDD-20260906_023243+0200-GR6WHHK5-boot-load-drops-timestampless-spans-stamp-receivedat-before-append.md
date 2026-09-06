---
trdd-id: GR6WHHK5
title: Boot load evicts timestamp-less codex spans within 5 s because receivedAt is stamped after writer.append
column: todo
created: 2026-09-06T02:32:43+0200
updated: 2026-09-06T02:32:43+0200
current-owner: agentlenspro-b2
task-type: bugfix
priority: normal
min-approval-requirement: none
scope: project
project-id: agentlenspro
parent-trdd: 7YPQWKPG
npt: []
eht: []
relevant-files: [rust-core/crates/agentlens-core/src/lib.rs, rust-core/crates/agentlens-core/src/span_window.rs, rust-core/crates/agentlens-core/src/writer.rs, rust-core/crates/agentlens-core/src/summarize/codex.rs]
labels: [rust-core, memory, span-window, boot-load]
---

# Boot load evicts timestamp-less codex spans within 5 s because receivedAt is stamped after writer.append

Follow-up card from the TRDD-YILE6N3T review (finding (1)), review report:
`reports/review-fork/20260906_023053+0200-f2572740-yile6n3t-prune.md`.

## SYMPTOM

After the YILE6N3T prune fix (unconditional retain by cutoff, no longer gated on
`spans.first()`), a restart drops every span whose `startTime`/`endTime` is the literal string
`"0"` — 602 of 432,335 spans in today's segment (0.14%), all `codex.api_request` — from the
window on the very first 5 s chores tick after boot.

## CAUSE

`rust-core/crates/agentlens-core/src/lib.rs` ingest path (≈lines 875–889) calls
`state.writer.append(span, now)` in one loop BEFORE `state.window.add(span, now)` in a second
loop. `add` is what stamps `receivedAt` (`span_window.rs:74-77`); the disk copy written by
`append` predates that stamp and never carries it. `load_range` (`writer.rs:360`) then admits
these records on boot using the `now_ms` fallback for the missing timestamp — so on the very
next prune tick, `span_timestamp_ms(o, i64::MIN)` (post-YILE6N3T) resolves them to a value at or
before the cutoff and they are evicted. `summarize/codex.rs` (lines 48, 56) also reads
`receivedAt` downstream, so the same records were already silently mis-summarized before eviction.

## FIX

Stamp `receivedAt` (arrival ms, i.e. `now`) on each span BEFORE `writer.append` — a one-line
reorder on the shared ingest path in `lib.rs`, so the disk copy and the in-memory copy agree.
Once `receivedAt` is on disk, `load_range`, `prune`, and `summarize/codex.rs` all resolve these
spans honestly. The 602 existing on-disk records predate the fix and stay unresolvable —
evicting them is the honest outcome, not a regression to chase. This also retires the YILE6N3T
worker's noted load_range follow-up.

## ACCEPTANCE

- [ ] New records written to disk carry a resolvable `receivedAt`.
- [ ] A span ingested with `startTime`/`endTime` == `"0"`, followed by a restart, is still
      present in the window after 10 s (not evicted on the first prune tick).
- [ ] Existing tests green (`--lib span_window`, `--test span_window`,
      `--test span_window_memory_guard`, plus `summarize/codex.rs` tests).

## Notes and lessons learned

## Approval log

- 2026-09-06T02:32:43+0200 — Authored into `todo` (Tier 0 bugfix, derived from the YILE6N3T
  review's finding (1); no approval required).
