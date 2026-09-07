---
trdd-id: WKLD508O
title: alcore exits with a culprit log rather than exceed a 2 GB memory cap
column: dev
created: 2026-09-07T19:36:46+0200
updated: 2026-09-07T21:09:12+0200
current-owner: main
task-type: feature
parent-trdd: 7YPQWKPG
min-approval-requirement: none
priority: high
severity: high
blocked-by: []
npt: []
eht: []
implementation-commits: [466775af, f9776548]
project-id: agentlenspro
scope: project
labels: [rust, memory, alcore, guard]
---

# alcore exits with a culprit log rather than exceed a 2 GB memory cap

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-07 21:15

**CODE LANDED, NOT DEPLOYED.** `466775af` (worker's implementation) + `f9776548` (two defects I
found by reading the 244 lines I had committed after reading ~60). The worker has finished and
released the crate. 8/8 tests green. Deploy still needs `cargo build --release` → copy into
`bin-native/darwin-arm64/` → `codesign -s - --force` → `agentlenspro server restart`.

**THE FINDING THAT CHANGES THIS CARD'S PREMISE — measured on the live collector (pid 30984),
`vmmap -summary` + `footprint`, 2026-09-07 21:0x:**

`phys_footprint` **6265 MB**, peak **8375 MB**. Per-region `dirty + swapped` (footprint charges
compressed/swapped pages; DIRTY alone does not, which is why a dirty-only reading understates the
C++ side by ~2×):

| region | dirty + swapped |
|---|---|
| IOAccelerator = **the Rust heap** (mimalloc tags its mmaps VM tag 100; macOS names tag 100 `VM_MEMORY_IOACCELERATOR`) | **~0.96 G** |
| MALLOC_LARGE (93 M resident, **2.3 G swapped**) | ~2.39 G |
| MALLOC_SMALL | ~2.05 G |
| MALLOC (empty) + metadata | ~0.66 G |
| | Σ ≈ **6.05 G** vs footprint 6.265 G |

**So ~5.1 G of 6.3 G is the C/C++ (DuckDB) allocator and ~0.96 G is the Rust heap — about 5:1.**
The consequence for this card: **zeroing the entire Rust heap does not reach 2048 MB.** Deleting
`SpanWindow` (TRDD-KBM09XHB), shrinking the card store, or narrowing the window all operate on the
~0.96 G. Whether that 5.1 G is *reducible by Rust-side work* is a separate, open question — the
bytes live in the C++ allocator, but the Rust code decides how many queries, appends, and parquet
readers create them. Do not read "the bytes are in DuckDB" as "no Rust change can shrink them".

**Corollary: the guard fires on its first tick at the 2048 default**, and peak 8375 MB says it
would have fired at any point today.

**Also measured, and it retires an inference this card previously rested on:** the soft valve has
narrowed the window **750 times** this uptime (`grep -c "memory pressure — summarization window"
~/.agentlens/server.log`; last two lines `337500ms` → `300000ms` against a configured
`86400000ms`). So `spans.inMemory = 317` is the *valve's output*, not evidence that the span
window is naturally small. Every argument of the form "only 317 spans are resident, so the memory
is not span-shaped" is reading the guard, not the structure.

**UNANSWERED, and now better informed:** straight to 2048 (fires immediately, collector down, but
the culprit log lands) or a raised cap for one cycle? Put to the owner ~19:30. The 5:1 split above
is the number that was missing when the question was first asked.

**OPEN DEFECT — the backstop stands in front of what it backs.** The two thresholds are keyed
on DIFFERENT counters and ordered backwards: the soft valve compares **RSS** against
`rss_budget_bytes()` = **4096 MB**, while the hard cap compares **phys_footprint** against
**2048 MB**. Footprint runs BELOW RSS here (6265 vs 6590–7930), so a process growing from cold
crosses footprint 2048 well before RSS 4096 — the hard cap fires before the valve has narrowed
once, and `rss_guard.rs`'s own module doc ("this is the backstop" to a valve that "already
narrows the window as RSS climbs") describes a sequence the shipped defaults prevent. Needs a
decision, not an edit: put both on the same counter, or set the cap above the valve's budget.

**LEAD THAT FALSIFIES "no Rust-side work reaches 2048" — DuckDB has a `memory_limit`.** It is a
connection setting the Rust code owns; nothing in the tree appears to set it. `SET
memory_limit='...'` is Rust-side work that bounds the C++ side directly. Related and already
measured: ~8,459 live parquet `FileMetaData`/`SchemaElement`/`ColumnChunk` sets against ~1,587
sealed files — a retention ratio, and retention is a Rust-side decision (readers not closed, a
pool unbounded, re-globbing). Plus ~619 MB in `MALLOC_*(empty)` free-list retention. So the
correct claim is the narrower one: **zeroing the Rust HEAP does not reach 2048; Rust-side
changes that reduce what DuckDB is asked to hold are untried and are the next thing to try.**

**NOT worth doing:** a restart with `MIMALLOC_SHOW_STATS=1` — those stats print at process **exit**,
so a restart yields nothing about the state under investigation, and it would destroy a 6.6-hour
specimen. `mi_process_info` (already linked by `466775af`) reads the same numbers live.

## WHY

OWNER DIRECTIVE, verbatim (2026-09-07): *"alcore must not use more than 2 gb of ram. if it ever
uses more than that, it must exit with error and a log that will allows to identify the culprit,
so we will fix the code."*

The existing valve is `SpanWindow::apply_memory_pressure`, called from `lib.rs::prune_window`
against `AGENTLENS_RSS_BUDGET_MB` (default 4096). It only NARROWS the span window — it cannot
stop growth anywhere else in the process, and it never fails loudly. The live process sat at a
5.4 GB physical footprint with that valve active.

## Measured starting point

Live collector, pid 30984, ~5 h uptime, measured 2026-09-07:

| metric | value |
|---|---|
| physical footprint | 5.4 GB (3.6 G resident-dirty + 1.8 G swapped) |
| resident | 8.8 GB |
| virtual | 17.3 GB |
| spans in the 5-minute window | 397 |
| largest vmmap region | `IOAccelerator` 4.5 G resident / 2.2 G dirty |

The `IOAccelerator` attribution to the mimalloc heap came from an UNOPENED memory-note title and
is **not verified**. It is 51% of resident and 61% of dirty, so it is the single largest lead and
nothing should be concluded about the cap's reachability until it is identified.

## The trap this card must not fall into

**The culprit log must not report counters for things already measured to be tiny.** A log that
prints "397 spans, small card store, 5.4 GB" leaves the owner exactly where they started and
fails the directive's own stated purpose. The diagnostic must carry an allocator/region
breakdown — at minimum `task_vm_info`'s `phys_footprint`, `internal`, `compressed` and
`external`, plus malloc-zone sizes.

**Which counter the cap is keyed on is a real decision, not a detail.** Physical footprint is
what macOS charges against jetsam and what Activity Monitor shows; RSS includes resident-but-clean
pages the OS reclaims for free, so an RSS-keyed guard can kill a healthy process and then indict
clean pages nobody needs to fix. Portability is the counter-argument — `phys_footprint` is
macOS-only via `task_info`/`TASK_VM_INFO` and Linux has no equivalent. Resolution: footprint on
macOS, RSS on Linux, and the log line names which one it measured.

## Acceptance

1. The guard fires deterministically in a test that allocates past a low cap set by env, and the
   process exits non-zero.
2. The culprit log is written, flushed and `fsync`ed to a known file path BEFORE the exit. stderr
   is not a destination — a prior startup crash on this project left `server.log` empty, which is
   exactly the failure mode that makes the directive unserved.
3. The log names the counter it measured and carries a region/zone breakdown, not just aggregate
   counters.
4. The guard's tick interval is stated, and the card records that a tick is a detector, not a
   guarantee: a fast allocation reaches the OOM killer first.

## Derived risks

- **Crash loop.** At a 5.4 GB footprint against a 2 GB cap the process breaches immediately,
  exits, restarts, breaches. The owner's observability product is then down and collecting
  nothing. This is the foreseeable outcome of shipping the 2048 default today, and it is the
  subject of the unanswered question above. `AGENTLENS_RSS_HARD_CAP_MB` is an env var, so the
  decision is reversible without a rebuild — that makes it cheap, not unimportant.
- **Torn writes.** An abrupt exit mid-append can leave a span segment half-written. `cards.duckdb`
  is a spill file replaced at boot and is safe; appended segments are not obviously so.
- Landing this REMOVES nothing, but TRDD-KBM09XHB later deletes `apply_memory_pressure` along
  with `SpanWindow`. This card must land first or that change leaves a window with no memory
  protection at all.
