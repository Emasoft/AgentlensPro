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
**Memory is the open half:** RSS 15,034 MB at 481k spans — ~31 KB/span if that MB is decimal
(10^6), ~33 KB/span if it is MiB; the bench's own unit is unverified, so treat the figure as
"~30 KB/span, order of magnitude". The TS server sits at ~1.5 GB on the same data.

> **SETTLED 2026-08-29, and the answer is the bad one: REAL DATA LOSS.** A 20 s re-run with a
> drain posted **863,520** spans, appended **500,000**, on disk 500,000 — **42.1% dropped, with
> HTTP 200 returned for every one of them** (`reports/bench/20260829_072821+0200-span-gap.md`).
> Cause, verified in code: `agentlens-spanstore/src/writer.rs:475` evicts the OLDEST buffered span
> whenever `pending_count > PENDING_FAILSAFE_MAX` (100k). That guard exists for a FAILING DISK and
> was unreachable while the HTTP path flushed per payload; **`ae513a4` made the 5 s tick the only
> flush, so any burst above 100k spans per tick now evicts real data.** A regression introduced by
> this card's own sibling (HFV4AIT7 root cause 1), not a pre-existing defect.
> Fix in flight with the rc3 agent: back-pressure (flush at a high-water mark under the same lock)
> instead of eviction; the failsafe stays reachable only when a flush actually failed;
> `dropped_on_failure == 0` becomes the assertion. **Every throughput figure measured before that
> fix was measured while 42% of the work was being thrown away and must be re-taken.**
>
> **There is currently NO stated headroom figure, because neither axis has a valid denominator.**
> The spans axis is blocked on the gap above. The request axis has no measured comparand at all:
> dividing 949 req/s by the 26 spans/s peak (TRDD-DMWOBWFH) is req/s ÷ spans/s — a category error,
> and its implicit premise (one POST per span) is false, since `src/telemetryConfig.ts:156` sets
> `OTEL_TRACES_EXPORT_INTERVAL: '1000'`, i.e. ~one POST per second per exporting session. The
> honest denominator is observed OTLP POSTs/s on this machine; `counters.traces_payloads` already
> counts them (`lib.rs:116,698`) but `/api/server-stats` does not expose it — one line of exposure
> plus two samples over a known interval settles it. Do not quote a multiple until then.

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
   **`alsummarize` cannot do this as it stands** (`src/bin/alsummarize.rs`, one straight path, no
   flag and no early return) — the measurement needs a small `--stop-after-load` flag added first.
   THREE confounds to state in the result: the file is read into a `String` that stays in scope for
   all of `main`; mimalloc rarely returns freed pages, so run 2's max-RSS is a high-water mark, not
   a steady state; and the load path materialises a full `Vec<Value>` and THEN collects a second
   `Vec<Arc<Value>>`, so run 1's peak includes a transient copy the server never holds — the one
   that moves the decision number.

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
