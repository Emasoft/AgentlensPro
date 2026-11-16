---
trdd-id: KBM09XHB
title: Nothing is stored in RAM — every answer is a short or paginated DuckDB result, discarded immediately
column: blocked
created: 2026-09-07T19:26:54+0200
updated: 2026-11-01T09:50:31+0100
current-owner: main
task-type: refactor
parent-trdd: 7YPQWKPG
min-approval-requirement: none
priority: high
severity: high
blocked-by: [2HRA270Y]
npt: [WKLD508O, DKBGT7MQ, 2HRA270Y]
eht: []
implementation-commits: [6c50142a, 4b408081]
project-id: agentlenspro
scope: project
labels: [rust, memory, alcore, duckdb]
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-22T13:05:17+0200
status: tasked
pre-block-column: dev
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

## Owner directive 2026-10-22

OWNER DIRECTIVE, verbatim (2026-10-22): "optimize the code so it stays under 2gb . it must only allocate the answers from duckdb and one or 2 paginations of data for the dashboard anyway. all memory usage is done by duckdb queries. it cannot use more memory than 2gb. but duckdb on the other hand can. luckily is optimized and it never use much memory."
Reading of it (main agent, to confirm with the owner where it changes behaviour): the 2 GB cap binds alcore's own heap (Rust/mimalloc allocations), not DuckDB's buffer pools; alcore holds only query answers and at most one or two dashboard pages at a time. Consequence: the RSS guard, which today measures whole-process phys_footprint (DuckDB included), measures the wrong quantity under this directive.
Measured 2026-10-22 against this target (isolated clones): resident card layer 573 MB of Rust heap at boot (docs_dev/20261022-card-resident-measure.md); on an idle server with log scan off, Rust heap reaches 3.4 GB live / 4.1 GB committed by 60 s with no ingest and one summary build (docs_dev/20261022-post-boot-attribution.md); that idle growth is the largest single item and is being attributed (bodies watcher discriminator, docs_dev/20261022-bodies-discriminator.md).
OWNER DIRECTIVE, verbatim (2026-10-22, second message): "i told you a million times to make every function an sql function, and every piece of memory a duckdb table. never allocate anything, just print the answer from duckdb. the whole server mus6t be a thin layer wrapper over duckdb. it has all the power you need."
Governing rule from this point (supersedes any narrower reading above): every computation that today walks resident Rust structures (cards, summary, sessions, burn, timelines) becomes an SQL query over DuckDB tables; every piece of state alcore keeps becomes a DuckDB table; alcore's Rust heap holds only the bytes of the answer being written to the socket, plus at most one or two dashboard pages. Resident trees are defects, not caches.
Conversion order (each step one commit, measured on an isolated clone against the 2 GB alcore-heap target before the next): (1) the idle post-boot growth (3.4 GB live by 60 s, owner under measurement: docs_dev/20261022-bodies-discriminator.md); (2) the resident card layer (573 MB): cards stay rows, every reader becomes a query; (3) the resident summary tree: /api/summary and the dashboard read paginated SQL; (4) the remaining resident structures, inventoried from the 60 s composition line; (5) the RSS guard measures alcore's own heap, not DuckDB's pools.

## Approval log

- 2026-10-22T13:05:17+0200 — column → dev by main-agent@agentlenspro. owner directive 2026-10-22: thin layer over DuckDB; conversion started
- 2026-10-22T13:22:17+0200 — column → blocked by main-agent@agentlenspro. open NPT 2HRA270Y (idle RSS climb) must finish before the conversion continues

## STATE refresh 2026-10-22

This section supersedes the 2026-09-08 STATE block above where they disagree: the card is in dev, conversion started under the owner directives of 2026-10-22.
NPT WKLD508O (the 2 GB hard cap): deployed and enforcing since before 2026-10-22; the WKLD508O card itself is in human_review, and what the cap measures is still open (step 5 below).
NPT DKBGT7MQ (one shared DuckDB instance at about 1.5 GB, owner choice): kept as step 0 of the conversion order. The 2026-10-22 directive lets DuckDB exceed 2 GB, which weakens its original reason, but per-instance limits summing to 19.25 GB permitted (the DKBGT7MQ card title) still matter for the machine; not retired without the owner.
Step 1 (idle growth) is carded as TRDD-2HRA270Y; it is an NPT of this card's remaining steps.
Step 5 (guard measures alcore's own heap, not DuckDB) is PENDING owner confirmation: asked in chat 2026-10-22, not yet answered.
'Resident trees are defects, not caches' in the governing-rule line is the main agent's reading, not the owner's words.
