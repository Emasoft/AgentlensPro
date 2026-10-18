---
trdd-id: KBM09XHB
title: Nothing is stored in RAM — every answer is a short or paginated DuckDB result, discarded immediately
column: todo
created: 2026-09-07T19:26:54+0200
updated: 2026-10-18T07:32:01+0200
current-owner: main
task-type: refactor
parent-trdd: 7YPQWKPG
min-approval-requirement: none
priority: high
severity: high
blocked-by: []
npt: [WKLD508O, DKBGT7MQ]
eht: []
implementation-commits: []
project-id: agentlenspro
scope: project
labels: [rust, memory, alcore, duckdb]
---

# Nothing is stored in RAM — every answer is a short or paginated DuckDB result

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-08

**ACCEPTANCE #4 CANNOT PASS AS THIS CARD STANDS — see TRDD-DKBGT7MQ (new NPT, 2026-09-08).**
Eight production DuckDB instances each carry their OWN buffer-pool limit (the budget is
per-instance; this repo's `agentlens-store/tests/memory_limit_scope.rs` proves it does not cross
instances) and they sum to **19.25 GB permitted** — one of them, `body_archive.rs:135` via
`DEFAULT_MEMORY_LIMIT`, permits **8 GB by itself**, 4× the whole process cap. Deleting `SpanWindow`
cannot make a 2 GB boot scan pass while those ceilings stand. Criteria 1-3 of this card can all go
green with #4 still failing. Land DKBGT7MQ first.

**NOT STARTED.** Carded the moment the owner issued the directive so it cannot be forgotten.
Deliberately NOT dispatched concurrently with TRDD-WKLD508O (the 2 GB hard cap): both edit
`lib.rs::prune_window`, and WKLD508O's guard call sits inside the very function this card
rewrites. WKLD508O is therefore an NPT — land it, then start here.

**Do not start this before reading `span_window.rs` in full.** The structure being deleted has
measured reasons to exist (see "The tension" below). A previous card demanded its deletion without
recording why those reasons no longer apply, and that card's acceptance grep failed on merge
because the deletion never happened.

## WHY

OWNER DIRECTIVE, verbatim (2026-09-07): *"nothing can be stored in ram, everything must came from
duckdb in form of short answers or paginated results, used to diagnose and immediately discarded."*

Earlier, same card lineage: *"haven't i told you to make duckdb the only memory of agentlenspro?
why there are things kept in memory and not written down in parquet files? why there are persistent
data structures in ram instead of just the small query results from duckdb???"*

The owner has now made this ruling twice. It is a design ruling, not a performance target — it
holds regardless of what any memory measurement says.

## What is still resident after TRDD-FSMISF5K and TRDD-TOIM26HP merged

Measured on `main` at 2026-09-07 after both merges:

- **`SpanWindow` is still live.** `lib.rs:163` holds it as `pub window` on the state struct;
  `lib.rs:571` constructs it. It carries `spans: Vec<Arc<Value>>` with `max_spans` defaulting to
  **1,000,000**. FSMISF5K's ledger row promised three deletions — `SpanWindow`, `boot_load`, and
  the rebuild loop — and landed only `boot_load`.
- **`cold_scan` (`log_reader.rs:199-214`) `collect()`s the whole corpus** of finished cards into one
  `Vec<ScannedFile>`, and `start_sweeper` hands all 27,532 of them to `ingest_scanned` in a single
  call. Surfaced as the NEXT ACTION on TRDD-HUGZNKXY, which refused the SQL rewrite but named this.
  Parity-free, needs no SQL, and nobody has picked it up.

Live process at the time of writing (pid 30984, 5h uptime): physical footprint **5.4 GB**
(3.6 G resident-dirty + 1.8 G swapped), 8.8 G resident, 17.3 G virtual. The owner's cap is 2 GB, so
the current process is ~2.7× over.

## The tension this card must resolve, not ignore

`SpanWindow` is not cruft. Its own source records why each part exists:

- `Arc<Value>` per span rather than `Value`, so the summary rebuild can snapshot the window off the
  state mutex — with plain values the snapshot is a deep clone of every span under the lock.
- `max_spans` sized against a measured wedge point (~1.5M spans observed wedging).
- `apply_memory_pressure` halves the window while RSS is over budget.

Deleting it means a store query per dashboard request. That is a real latency-vs-residency
tradeoff, and the owner has now decided it in favour of residency — twice, explicitly. Implement
the ruling; record the latency cost as a measurement, and raise it only if the measurement shows it
is severe.

**RETRACTED (2026-09-08): the 397-span reading does NOT exonerate the window.** This card
previously argued that because the live server self-reported **397 spans in memory**, replacing
the window with a query was "unlikely to be the thing that saves 3 GB". That inference is wrong
and must not be repeated. 397 is an *instantaneous* count of a structure with a **1,000,000**
ceiling and an active `apply_memory_pressure` shrink path, sampled 5 h into the process's life.
The same process reports **7.9 G peak footprint against 5.4 G current** — i.e. ~2.5 G was
allocated and released. mimalloc's decommit branch is disabled in the vendored source, so
released pages stay in the process's footprint forever. A window that briefly held hundreds of
thousands of spans during the boot scan and was then halved back to 397 produces **exactly this
signature**. The observation cannot tell "the window was never big" apart from "the window was
big and shrank", and the second is the outcome the pressure valve exists to produce.

Corroborating: `ui.rs:277-282`'s own comment records this path was previously capable of
"84% of a core and **8.7 GB of mimalloc churn**" under continuous ingest, and the 2026-09-07 CPU
profile (`reports/alcore-cpu/20260907_201607+0200-cpu-profile.md`) found `rebuild_once`'s
`serde_json::Value` churn dominating self-time in both sample windows.

What may be said: the window holds no large *live* object set right now. What may not be said:
that it did not put the footprint there. This card is the fix for the DESIGN RULING and remains a
live candidate for the cap.

## Acceptance

1. `! grep -rqE 'struct SpanWindow' rust-core/crates/agentlens-core/src/` — the resident span vector
   is gone, not merely bounded.
2. `cold_scan` streams; no `collect()` of the whole corpus into one `Vec`. A test asserts the peak
   number of simultaneously-held `ScannedFile`s is bounded by a constant, not by corpus size.
3. Every dashboard-facing read is a short or paginated DuckDB query whose result is dropped after
   the response is written. A test asserts pagination is actually applied (a query over N rows with
   page size P issues ceil(N/P) fetches and never materializes N rows at once).
4. With TRDD-WKLD508O's hard cap set to its 2048 MB default, the server completes a full boot scan
   over the real corpus **without the guard firing**. This is the acceptance that matters; 1-3 are
   structural proxies for it.

Record RSS, physical footprint, and peak footprint together, at a stated settling point (boot scan
complete plus one full ingest cycle — evidenced by a log line or card count, never a timer). A peak
figure read promptly after restart measures a process that has not done anything yet.

## Derived risks

- Deleting the window removes `apply_memory_pressure`, the existing soft valve. WKLD508O's hard cap
  must be landed FIRST or there is a window with no memory protection at all.
- The `boot_load` doc-comment at `session_summary_sql.rs:5` already describes a function that no
  longer exists; deleting more symbols will strand more comments. Sweep them in the same change.
- A latency regression on the dashboard is the expected cost. Measure it; do not discover it.

## Findings (2026-10-18)

2026-10-18: measured relevance to the RSS crash loop — the ~1.8-2.0 GB startup baseline is present with no body files, and CardStore.parsed (card_store.rs:236) holding every card in RAM is the INFERRED main holder. Evidence: reports/rss-crash-loop/20261018_070119+0200-isolated-empty-bodies-run.md
