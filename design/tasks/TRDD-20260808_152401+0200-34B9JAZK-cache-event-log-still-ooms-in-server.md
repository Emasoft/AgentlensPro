---
trdd-id: 34B9JAZK
title: get_cache_event_log still OOMs the server under real load after the partial fix
column: todo
created: 2026-08-08T15:24:01+0200
updated: 2026-08-08T15:24:01+0200
current-owner: agentlenspro-main
task-type: bugfix
severity: high
scope: project
project-id: agentlenspro
parent-trdd: QK3L5QAS
labels: [server, stability, cache-ledger, duckdb]
---

# get_cache_event_log still OOMs the server under real load after the partial fix

Residual of `TRDD-QK3L5QAS`, which was **closed prematurely**. That card's fix is real and still
verified — it is simply not sufficient.

## What is fixed, and what is not

**Fixed (still true):** `SegmentedSpanStore.loadRange` materialized every span in the window into one
array while the cache-ledger scan kept only `api_request`/`compaction` spans. `forEachInRange` now
visits instead. Out-of-process, `buildCacheEventLog({})` **completes in ~90 s** where it previously
aborted with `FATAL ERROR: Ineffective mark-compacts near heap limit` at ~4 GB. Re-confirmed
2026-08-08 against the current tree.

**Not fixed:** the same command still kills the **server**.

## Evidence

A CLI audit ran `agentlenspro get_cache_event_log` (no `--window`) against the FIXED bundle:

- exit 1, `FAIL: cannot reach http://localhost:4316/mcp: socket hang up`, wall **59.9 s**
- server pid **83918 → 37104**
- `~/.agentlens/requests.log`: heap **852 → 872 → 1768 MB** in the seconds before the call, then a
  **68-second gap** with nothing logged, then a fresh process at **478 MB** — an OOM-kill plus
  supervisor-restart signature

Verified first-hand rather than taken on the report: the live pid **is** 37104, started **15:14:10**
(mid-audit), and the bundle that process loaded contains `forEachInRange` (bundle mtime 00:12:20,
process start well after). So the fix was live and the server died anyway.

## The open question — do NOT guess it

**The mechanism is not established.** 1.7 GB before the call, against the server's
`--max-old-space-size=6144`, does not by itself explain reaching the cap. Candidates, none confirmed:

- a SECOND unbounded materialization on the same request path — `buildCacheEventLog` also calls
  `scanCacheCreationEvents` over the raw **body** files, which the QK3L5QAS fix did not touch;
- the server's resident state (≈70 k spans in memory, the segment index) plus concurrent ingestion
  leaving far less headroom than the 6 GB cap suggests;
- the MCP response serialization of a large result.

Guessing here is what closed the parent card early. Instrument the running server (heap sampling
across the call, or `--heapsnapshot-near-heap-limit`) and attribute the growth before changing code.

## Acceptance

- [ ] The mechanism is identified with evidence — a named allocation site, not a hypothesis.
- [ ] `agentlenspro get_cache_event_log` (no `--window`) completes against the live server, on this
      machine's real store, **10 consecutive times**, with the pid unchanged. One passing run is
      what produced the premature close; the count is the point.
- [ ] Peak server heap during the call is measured and reported, not inferred.
- [ ] A regression test that fails against the current code. If the honest shape is again a
      measurement rather than a unit test, say so explicitly rather than shipping a test that
      cannot fail.

## Workaround until fixed

Pass `--window`. Also note a separate UX defect found in the same audit: `--window` accepts a bare
number of minutes only — `--window 5m` is rejected with `FAIL: --window expects a number, got "5m"`.

## Lesson already recorded

One passing live run is not a general claim. The 00:12 run was true (exit 0, 36 s, pid unchanged,
184,212 calls) and insufficient — which is exactly what a premature close looks like from the
inside. Captured in the parent's `## Approval log`.
