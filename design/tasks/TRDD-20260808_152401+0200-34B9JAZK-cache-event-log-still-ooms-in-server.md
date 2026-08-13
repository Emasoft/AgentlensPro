---
trdd-id: 34B9JAZK
title: get_cache_event_log still OOMs the server under real load after the partial fix
column: todo
created: 2026-08-08T15:24:01+0200
updated: 2026-08-12T13:35:00+0200
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

## 2026-08-12 — why it was never established, and the number that was missing

**The mechanism is still NOT established. What follows narrows it and removes a false lead; it does
not close the card.**

Measured first-hand on the healthy live server (pid 40460, 41 min uptime):

| | |
|---|---|
| heap | **860 MB** / 6240 MB cap |
| RSS | **2624 MB** |
| off-heap share | **~67 %** |

Two consequences, both verified rather than reasoned-from-memory:

1. **`--max-old-space-size=6144` bounds V8's old space, not RSS.** At steady state two thirds of this
   process's footprint is native — DuckDB's arena, buffers, the segment index — and none of it is
   visible to the heap number.
2. **`requests.log` recorded heap ONLY** (`src/serverRuntime.ts:116`, and a sample line confirms:
   `... 11b heap=920MB /api/statusline-samples`). So the incident evidence in this card — heap
   852 → 872 → **1768** MB — was never evidence about the thing that kills a process. 1768 against a
   6144 cap looks comfortable, which is precisely why three sightings produced no mechanism.

**A false lead this removes:** "the server hit its heap limit" is not supported. A V8 heap OOM is
self-announcing — the out-of-process run in the section above died with a visible
`FATAL ERROR: Ineffective mark-compacts near heap limit`. The server instead went **silent for 68
seconds and came back as a fresh pid**, which is the signature of an external `SIGKILL`, and an
external kill acts on **RSS**. That shifts weight onto candidate 2 (resident state + concurrent
ingestion leaving far less headroom than 6 GB suggests) and onto native allocation, and away from JS
heap exhaustion. It does **not** prove it: nothing here rules out candidate 1, and no kernel-level
kill record was recovered for pid 37104 (the sighting is four days old).

**Done about it:** `RequestLogEntry` now carries `rssMb` and every logged line reads
`heap=…MB rss=…MB` (one `process.memoryUsage()` call for both, so the pair can never be sampled at
different instants and report the impossible `rss < heap`). Falsified on behaviour: with the `rss=`
segment removed the new test fails on the actual line content.

## 2026-08-13 — SECOND live occurrence, and the owner's directive

It happened again, observed in real time: pid 40460 served its last request at **01:51:26Z**
(`heap=1002MB` of 6144 — looks perfectly healthy), then **silence, no V8 banner** (`server.log`
mtime untouched), and a fresh pid (51370) spawned at 01:52:27Z. The load at the time was a burst of
**diagnostic queries** — four `get_cache_break_timeline` raw-body scans, `get_session_detail`, four
`run_diagnostics_sql` snapshot loads — i.e. exactly the read-path family this card suspects, not
OTLP ingest. The `rss=` instrumentation from bd7b59f was **not deployed at the moment of death**
(the deploy had been withheld), so once again the kill happened with the one decisive number
unrecorded; it was deployed into the forced restart window at 01:54 (pid 60646) and every request
line now carries `rss=` — first live readings: `heap=1350MB rss=2547MB` during the boot scan.

**Owner directive (2026-08-13, verbatim intent):** "it should never happen that the server is
stopped unexpectedly" — the fix is ordered, not optional. Planned shape (session task #16): a
scratch-`DATA_DIR` repro driving the timeline/forensics query path while reading the `rss=` trend;
an RSS-pressure gate for heavy handlers (`heapPressure()` exists but keys on heap, which is blind
to the ~67% off-heap footprint); and a bound on the timeline's raw-body materialization.

**NEXT ACTION (unchanged in spirit — reproduce, do not guess):** re-run
`agentlenspro get_cache_event_log` with no `--window` against a **scratch `DATA_DIR` and `HOME`**,
never this machine's live server, and read the `rss=` trend in the new log. That trend is now capable
of showing the approach to the wall; the heap trend never was. If RSS climbs toward physical limits
while heap stays flat, candidate 1's `scanCacheCreationEvents` over raw body files is the first place
to look, because it is the one materialization the QK3L5QAS fix did not touch.

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
