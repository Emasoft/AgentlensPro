---
trdd-id: DKBGT7MQ
title: Eight independent DuckDB instances each carry their own buffer-pool limit and they sum to 19.25 GB against a 2 GB process cap
column: todo
created: 2026-09-08T10:02:32+0200
updated: 2026-09-08T23:11:14+0200
current-owner: main
task-type: bugfix
parent-trdd: 7YPQWKPG
min-approval-requirement: none
priority: high
severity: high
blocked-by: []
npt: []
eht: []
implementation-commits: []
project-id: agentlenspro
scope: project
labels: [rust, memory, alcore, duckdb]
---

# DuckDB instance budgets sum to 19.25 GB against a 2 GB process cap

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-08 23:11

**23:11 — THE PLAN EXISTS: `reports/dkbgt7mq/20260908_231114+0200-single-2gb-budget-plan.md`.**
Inventory of every DuckDB open/limit site in non-test code (agent-VERIFIED by reading; the
coordinator has first-hand verified only A and the restore path): A `card_store.rs:122`
(const `:82` 256MiB, file-backed, the ONLY resident instance); B `statusline_store.rs:230-238`
(2GB, per-call, every 60 s); C `transcript_sql.rs:401-404` (2GB, per MCP call); D
`transcript_sql.rs:572-576` (2GB, burn_seismic); E `bodies_evidence.rs:70-86` (2GB, 4 MCP
tools); F `agentlens-store/src/lib.rs:138-178` `open_store(dir, limit, threads)` used by F1
`chores.rs:288` (2GB, bodies pass), F2 `body_archive.rs:133-136` (**8GB** via
`DEFAULT_MEMORY_LIMIT`, `lib.rs:42` — and it DOES run inside the resident server:
`ui.rs:1979/1987` bodies export/purge; that settles the open question below), F3 `alstore.rs:105`
(8GB, separate process); G `session_summary_sql.rs:122-127` (1GB, DEAD code). The "sum to
19.25 GB" framing stays withdrawn: only A is resident, the rest are per-call.
**Shape chosen: (a) one process-wide instance** = the card store's file instance configured once
(`memory_limit='2GiB'`, threads=2, `temp_directory=''`) and installed as a root every other site
`try_clone()`s through one `agentlens_store::connect()`, per-call stores isolated with TEMP
tables. (b) stores-as-schemas rejected (Parquet stores are fileless by measurement); (c) sum of
separate instances rejected (DuckDB has no cross-instance budget). Phases 0–4, ≤5 files each,
each with the test that fails on current code, are in the report.
**Two facts that bound this card:** the single budget ALONE is not shown to stop the boot panic
(open-transaction charge k×64 MB with k ∈ [4, 75) — whether under 2 GiB is UNDETERMINED), so the
chunked restore of TRDD-5JZQFVO8 is required regardless; and a 2 GiB DuckDB budget plus the Rust
heap exceeds WKLD508O's 2048 MB RSS cap by construction — cap = budget + Rust floor, or budget
below the cap, is an OWNER decision not taken here. Correction to the paragraph below: the boot
count "1,155" is unsupported (whole-log, undated); measured: 138 OOM panics.
NEXT ACTION: after 5JZQFVO8 deploys and the real-corpus footprint is measured, put Phase 1 through
adversarial review, then implement phase by phase.

**OWNER RULING 2026-09-08 22:41 (verbatim: "256mb limit? duckdb memory limit should be 2Gb").**
This settles the "size the cap and the budgets together" question below: there is ONE DuckDB
memory budget and it is the process cap, **2 GB**. DuckDB is the process's memory (parent
TRDD-7YPQWKPG); per-store pools of 256 MB / 1 GB / 8 GB are neither the design nor the ceiling.
`memory_limit` is per DuckDB *instance*, so one budget means one instance (one database with the
stores as schemas, or the store files ATTACHed to one connection) — the split-the-budget shape is
already ruled out in acceptance #3 ("the concurrent set is UNBOUNDED"). What triggered the ruling:
the live collector on `~/.agentlens` is crash-looping at boot — the log-sweeper panics at
`card_store.rs:168` with DuckDB out-of-memory at the card store's 256 MB pool during the boot
sweep upsert (1,155 hook-revive boots logged 2026-09-08; root-cause report pending under
`reports/card-store-oom/`). **NEXT ACTION:** plan the single-instance shape (which stores, one
`SET memory_limit='2GB'`, no `temp_directory=''` masking, how `body_archive`'s 8 GB site folds in)
and put it through adversarial review before any code; the crash-loop card records the interim.

**⚠️ THIS CARD WAS AUTHORED REDUNDANTLY AND ITS ORIGINAL FRAMING WAS THE RETRACTED ONE.** Read
TRDD-WKLD508O's STATE section *"THE CAP AND THE DuckDB BUDGETS CANNOT BOTH BE 2048 MB — but
'unreachable by construction' over-claimed it"* first; it is the authority and it is better
calibrated than the body below. I wrote this card after a compaction, from a summary, without
reading WKLD508O's STATE block — the exact failure the compaction warning names.

**What WKLD508O already established, and what I published anyway:**

- WKLD508O: *"What is proven is the absence of a BOUND, not the presence of a BREACH."* I led my
  report to the owner with "found where the 2 GB cap actually breaks" — the retracted stronger form.
- WKLD508O: *"Exactly ONE connection is resident — `CardStore.conn` at 256 MiB. Every 2 GB site is
  per-call or per-pass, so the 4 GB figure needs two transient connections to coincide, which I
  inferred from 'both exist' and never showed happens."* A 19.25 GB **sum** is that same inference,
  eight-fold. **The sum is not a quantity this process can hold; it is the total of ceilings that
  are mostly never concurrent.** Do not quote it.
- WKLD508O: `card_store.rs:131` is `Connection::open(cards.duckdb)` — a FILE-backed connection, and
  the only resident one. My table called it `open_in_memory()`. Wrong on the single most important
  row.
- WKLD508O also records the honest limits I omitted: a `memory_limit` is a **ceiling, not a
  reservation**, and it governs DuckDB's **buffer manager**, not every allocation DuckDB makes.

**The measured breakdown, which this card ignored and which does NOT point at DuckDB** (WKLD508O,
first-hand, live pid 30984): footprint **10.9 GB**, peak **11.3 GB**, growing **~0.37 GB/h** — not
the 5.4 GB this card was written against. Of the dirty bytes: IOAccelerator **2.8 GB = the Rust
mimalloc heap**; MALLOC_SMALL+LARGE live **2.2 GB** = the C/C++ side; MALLOC_* **(empty) 1.44 GB
holding no live object at all**. WKLD508O states explicitly: *"NOT established: that the C/C++
2.2 GB is DuckDB — the system malloc zones catch every non-Rust allocation."* The largest single
identified share is the **Rust** heap, and the cheapest GB is the 1.44 GB of empty allocator pages.

**What survives from this card, and it is ONE row:** `body_archive.rs:135` calls
`open_store(…, agentlens_store::DEFAULT_MEMORY_LIMIT, threads)` where `agentlens-store/src/lib.rs:42`
is `pub const DEFAULT_MEMORY_LIMIT: &str = "8GB"`. That site is **not in WKLD508O's seven-row table**,
and 8 GB is 4× the proposed cap in a single ceiling. Whether `body_archive` runs inside the resident
alcore server (as `chores.rs:288` does) is **NOT established here** and must be checked before the
row means anything.

**The card remains open as a work item** — "size the process cap and the DuckDB budgets together"
is real, and WKLD508O says so too (*"the cap and the DuckDB limits have to be sized together, or
the guard fires on correct, in-spec behaviour"*). What is withdrawn is the framing that this is
where the memory IS.

## WHY

OWNER DIRECTIVE (2026-09-07): *"alcore must not use more than 2 gb of ram."*

## The measurement

Every `Connection::open_in_memory()` opens a **separate DuckDB instance**, and this repo's own
test proves the budget does not cross instances:
`rust-core/crates/agentlens-store/tests/memory_limit_scope.rs` —
*"CONCLUSION: memory_limit is scoped PER-CONNECTION, not shared"*, with the falsifier
`SET SESSION memory_limit` rejected as *'option "memory_limit" cannot be set locally'*.

So these limits **sum**; they do not cap each other.

| site | configured limit |
|---|---|
| `agentlens-core/src/card_store.rs:82` | 256 MiB |
| `agentlens-core/src/session_summary_sql.rs:127` | 1 GB |
| `agentlens-core/src/statusline_store.rs:235` | 2 GB (env `AGENTLENS_DUCKDB_MEMORY_LIMIT`) |
| `agentlens-store/src/transcript_sql.rs:402` (`query`) | 2 GB |
| `agentlens-store/src/transcript_sql.rs:574` (`DuckSession::open_in_memory`) | 2 GB |
| `agentlens-store/src/bodies_evidence.rs:76` (`with_duck`) | 2 GB (env) |
| `agentlens-core/src/chores.rs:288` (`open_store`) | 2 GB |
| `agentlens-core/src/body_archive.rs:135` (`open_store`, `DEFAULT_MEMORY_LIMIT`) | **8 GB** |

**Sum: 19.25 GB permitted. The process cap is 2 GB.**

Six of the eight individually permit ≥1 GB. Five individually permit 2 GB — the *entire* process
budget, each. `body_archive.rs` permits **8 GB in one instance**, four times the whole cap, and it
runs inside alcore (`agentlens_store::DEFAULT_MEMORY_LIMIT` at `agentlens-store/src/lib.rs:42`).

## Why this is the ceiling that matters and `SpanWindow` is not

397 spans cannot be more than single-digit MB. A 5.4 GB footprint with a nearly-empty span window
means the bytes are somewhere with a multi-GB allowance. These eight sites are the only structures
in the process that carry one.

This does not prove DuckDB holds the 5.4 GB. It proves the cap cannot be enforced while the
configuration permits 19.25 GB, whatever the heap attribution turns out to say.

## The fix

ONE shared budget constant, sized so the WORST-CASE SUM of concurrently-live instances fits under
the process cap — not a per-site limit that each independently equals or exceeds it.

Do NOT simply set every site to 2 GB; that is the present bug. Do NOT set every site to
`cap / 8` blindly either — the sites have different lifetimes (`card_store` is long-lived;
`bodies_evidence::with_duck` is per-call and its own doc-comment says a resident instance would
"hold RSS for nothing"), so the budget must be allocated against *concurrent* residency, which
must be established, not assumed.

## Acceptance

1. `agentlens_store::DEFAULT_MEMORY_LIMIT` is no longer 8 GB, and no production call site passes a
   limit ≥ the process cap.
2. ~~A test asserts the SUM of the limits of all simultaneously-live instances is under the process
   cap.~~ **UNWRITABLE AS STATED — superseded by #2′ below.** The set it sums is not finite; see #3.
2′. A test asserts that **no more than N DuckDB instances can be live at once**, N × per-instance
   limit is under the process cap, and the N+1th caller BLOCKS or is REJECTED rather than opening
   instance N+1. A sum-of-sites assertion cannot catch this bug and would pass while the process
   holds unbounded instances.
3. **DONE 2026-09-08 — and it invalidates the premise of #1/#2.**
   `reports/duckdb-budget/20260908_101604+0200-concurrent-residency.md`, spot-verified first-hand.
   **The worst-case concurrent set is UNBOUNDED, not eight.** Four sites — `transcript_sql.rs:401`
   (`run_transcript_sql`), `transcript_sql.rs:572` (`burn_seismic`), `bodies_evidence.rs:71`
   (`with_duck`, reached by 4 MCP tools) and `body_archive.rs:135` (`bodies_export`/`bodies_purge`,
   **8 GB**) — are reached from MCP/HTTP handlers that `spawn_blocking` per request with **no lock
   spanning the DuckDB work**, and each call opens its own `Connection::open_in_memory()`. Nothing
   serialises them against each other OR against themselves, so residency grows with request
   concurrency, bounded only by tokio's default 512 blocking threads (INFERRED — no
   `max_blocking_threads` override exists).

   Verified first-hand, not taken from the report: `body_archive.rs` contains **zero** locks of any
   kind (`grep -cE "Mutex|acquire_pass_lock|\.lock\("` → 0); `acquire_pass_lock` appears ONLY at
   `chores.rs:270`, so the chore is guarded and the 8 GB export path over the *same store dir* is
   not; and the state lock at the MCP sites is released before `spawn_blocking` **deliberately** —
   `ui.rs:2938` carries the comment "spawn_blocking with the state lock released first".

   Also corrected by that measurement: `card_store.rs` is `Connection::open()` — **file-backed**,
   not in-memory (TRDD-TOIM26HP moved it, deliberately, for this exact residency reason); and two
   sites are **dead code** with no production caller (`session_summary_sql.rs`, and
   `statusline_store.rs`'s `query_statusline` — its sibling `seal_one` keeps `open_duck` live).

   **Therefore the fix is NOT a budget split.** You cannot divide a fixed pie among an unbounded
   number of instances. It is admission control — one shared semaphore bounding concurrent DuckDB
   instances process-wide, plus a per-instance limit sized so N × limit fits the cap. Whether the
   N+1th caller queues or fails fast is a behavioural choice for the owner, not an agent.
4. An over-limit query still fails LOUDLY. Every site currently sets `temp_directory=''`
   deliberately (a persistent `.duckdb` measured 300× write amplification; spilling would quietly
   write gigabytes to the SSD). Shrinking the budgets must not be paid for by turning spill on.

## Derived risks

- **Shrinking a budget converts a slow query into a failing one.** Sites without `temp_directory`
  fail rather than spill — that is deliberate, and it means an under-sized budget is a functional
  regression, not just a slow one. Measure the actual peak per site before choosing its share.
- `body_archive` and `chores` both open a store; if both can be live at once their shares must be
  disjoint, not each sized against the full cap.
- TRDD-WKLD508O's hard cap will fire on any site that exceeds its share, which is the desired
  behaviour — but it will name `prune_window` (where the check ticks) rather than the DuckDB
  instance that allocated. The culprit diagnostic must be able to distinguish them or it points at
  the wrong code.

## Effect on the sibling cards

- **TRDD-KBM09XHB acceptance #4** ("full boot scan without the guard firing") cannot pass while
  these ceilings stand, regardless of whether `SpanWindow` is deleted. This card is effectively an
  NPT for it.
- **TRDD-WKLD508O** (the 2 GB hard cap) is still correct to land first — it is the enforcement.
  This card is the reason enforcement alone is not enough.

## Approval log

- 2026-09-08T22:42:39+0200 — OWNER RULING (USER, Tier 3): the DuckDB memory limit is 2 GB — one
  budget equal to the process cap, DuckDB as the only memory. Recorded by main from the user's
  message "256mb limit? duckdb memory limit should be 2Gb".
