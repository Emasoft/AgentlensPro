---
trdd-id: DKBGT7MQ
title: Eight independent DuckDB instances each carry their own buffer-pool limit and they sum to 19.25 GB against a 2 GB process cap
column: todo
created: 2026-09-08T10:02:32+0200
updated: 2026-09-08T10:02:32+0200
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

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-08

**NOT STARTED.** Carded the moment the arithmetic was verified.

This card exists because TRDD-KBM09XHB and TRDD-WKLD508O were both aimed at `SpanWindow`, and
`SpanWindow` is measurably NOT where the memory is (the live process self-reported **397 spans**
while holding **5.4 GB** of physical footprint). This card names the ceiling that makes 5.4 GB
possible.

**What is VERIFIED here is a CEILING, not a measurement.** The limits below are what the code
PERMITS. Nothing in this card proves DuckDB is currently holding those bytes — that still needs
heap attribution. The verified claim is narrower and sufficient to act on: *nothing in the current
configuration prevents a 2 GB breach, and one instance alone is permitted 4× the whole cap.*

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
2. A test asserts the SUM of the limits of all simultaneously-live instances is under the process
   cap. It must fail if any single site is raised past its share — a per-site assertion does not
   catch the bug this card is about.
3. The concurrent-residency set is established by measurement (which instances are alive at once
   during a boot scan + one ingest cycle), and the budget split is derived from it, recorded in
   this card.
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
