---
trdd-id: WKLD508O
title: alcore exits with a culprit log rather than exceed a 2 GB memory cap
column: dev
created: 2026-09-07T19:36:46+0200
updated: 2026-09-07T19:36:46+0200
current-owner: main
task-type: feature
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
labels: [rust, memory, alcore, guard]
---

# alcore exits with a culprit log rather than exceed a 2 GB memory cap

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-07

**IN FLIGHT, uncarded until now.** A background lean-worker was dispatched at ~19:20 to build
`rss_guard.rs` (`AGENTLENS_RSS_HARD_CAP_MB`, default 2048, exit(1) plus a culprit log). The card
is being written after the dispatch, which is the defect this file corrects — the board showed
work in flight with no card for roughly twenty minutes.

**The worker holds `rust-core/crates/agentlens-core`.** Do not edit that crate, and in particular
do not touch `lib.rs::prune_window`, until it reports. TRDD-KBM09XHB rewrites the same function
and is deliberately parked at `todo` behind this card.

**UNANSWERED, and it changes what the worker should ship:** does the first deploy go straight to
2048 MB and take the crash loop, or run once at a raised cap to capture a culprit log first? Put
to the owner at ~19:30; no answer yet. The worker was told to build the 2048 default, so the
question is currently about deploy policy, not code.

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
