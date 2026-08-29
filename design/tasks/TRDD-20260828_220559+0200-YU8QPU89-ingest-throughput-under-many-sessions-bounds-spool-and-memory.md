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

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-08-29

**Measured so far (HFV4AIT7's benches, isolated instances, 14 cores):** ingest 131 → **949 req/s**;
hook events 17k req/s. Spool behaviour under N parallel sessions is still UNMEASURED.
**Memory is the open half:** RSS 15,034 MB at 481k spans (~31 KB/span in decimal GB), vs ~1.5 GB
for the TS server on the same data.

> **The spans/s figure is UNSETTLED and must not be quoted until it is.** The flood posted
> 41,689 × 20 = **833,780** spans with 0 non-2xx, but `spansAppendedDelta` read **481,200** (57.7%)
> — 42% unaccounted. Either the counter was sampled before the run drained (throughput is
> *understated*, ~19k spans/s) or spans are silently dropped by the transform (a data-loss bug).
> One re-run with a 10 s drain decides it; measurement in flight. The headroom claim rests on this,
> so it is stated only on the axis that is settled: **949 req/s vs a real machine peak of 26
> spans/s ⇒ ~36× on the request axis** (400× on the spans axis, if the larger reading holds).

**Advisor verdict (Fable 5) — do NOT refactor the span representation on that number:**
1. **The 31 KB/span figure conflates window and derived state.** Per rebuild, `lib.rs` produces a
   full summary with per-session `timeline` arrays, clones those entries again into
   `otel_attribution`, keeps a third derivative in `stripped_cache`, and the off-lock rebuild holds
   the OLD summary alive while building the NEW one — 3-4 span-sized copies plus a transient 2×, on
   top of the window. macOS malloc also rarely returns freed pages.
2. **Ship the guard the port DROPPED, first.** `span_window.rs:9-11` records that the TS's
   `effectiveWindowMs` halving under memory pressure was deliberately not ported — so alcore has
   LESS protection than the TS it replaced. ~20 lines: sample `server_stats::rss_bytes()` (already
   exists, and it is PORTABLE — proc_pidinfo on macOS, /proc on Linux — which matters because the
   package ships Linux binaries) on the 5 s tick, halve `effective_ms` over budget, step back under
   it; `prune()` already evicts, and `windowMs` is already in `/api/server-stats`, so the cut is
   visible rather than silent.
3. **The ONE measurement before any Value/struct refactor** (macOS-native, no heaptrack): run
   `alsummarize` under `/usr/bin/time -l` twice on the same 481k-span file — once stopping right
   after the `Vec<Arc<Value>>` is built, once after `summarize_spans`. Run 1 minus file size =
   window cost; the delta = derived-state cost. If run 1 is ~3-5 KB/span, shrinking the span
   representation is dead on arrival.
   **`alsummarize` cannot do this as it stands** (`src/bin/alsummarize.rs` is 25 lines, one
   straight path, no flag and no early return) — the measurement needs a small `--stop-after-load`
   flag added first. Two confounds to state in the result: the file is read into a `String` before
   parsing (its bytes are in RSS too), and mimalloc rarely returns freed pages, so run 2's max-RSS
   is a high-water mark, not a steady state.

**NEXT ACTION:** settle the 42% span gap (in flight) — it decides whether the throughput half is
answered or a data-loss bug is open. Then the pressure guard (2), then the two-run measurement (3,
after adding the flag), then the spool half of this card's Method under 32× session load.

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
