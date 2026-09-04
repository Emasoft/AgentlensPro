---
trdd-id: H5G9RRF3
title: The alcore RSS guard has bottomed out at its window floor and memory keeps climbing
column: todo
created: 2026-09-04T15:32:08+0200
updated: 2026-09-04T15:32:08+0200
current-owner: main-session
task-type: bugfix
project-id: agentlenspro
priority: high
severity: HIGH
min-approval-requirement: none
created-by: main-session
npt: []
eht: []
blocked-by: []
related: [34B9JAZK, 2R0AXCKL, 2R36W8Q1]
---

# The alcore RSS guard has bottomed out and memory keeps climbing

## Measured on the LIVE server, 2026-09-04 15:25–15:32 (pid 37180, uptime 6h22m)

| field | value | source |
|---|---|---|
| `spans.configuredWindowMs` | **86,400,000** (24 h) | `/api/server-stats` |
| `spans.windowMs` (effective) | **300,000** (5 min) | `/api/server-stats` |
| `SUMMARY_WINDOW_FLOOR_MS` | `5 * 60_000` = **300,000** | `span_window.rs:23` |
| `memory.rssMb` | **15,085** | `/api/server-stats` |
| RSS ~7 min earlier | **14,305** | `agentlenspro server status` |
| `rss_budget_bytes()` default | **4,096 MB** | `lib.rs:634-641` |
| `spans.inMemory` | 418,018 | `/api/server-stats` |

**The effective window equals the floor exactly.** The guard has not merely fired — it has
exhausted its only lever. `apply_memory_pressure` (`span_window.rs:100-111`) halves
`effective_ms` while `rss > budget`, floored at `SUMMARY_WINDOW_FLOOR_MS`; going 86,400,000 →
300,000 is eight consecutive halvings into the floor. RSS is **3.7× the budget** and rose ~780 MB
in the seven minutes between the two readings above.

So the degradation path is spent and memory is still growing. There is no second lever.

## Why this is HIGH, in the author's own words

`lib.rs:628-633`, the doc on the budget itself:

> *"Chosen against measurement, not taste: the TS server sat at ~1.5 GB on this machine's real
> corpus, and **an alcore flood reached 10.25 GB before wedging**. 4 GB leaves generous headroom
> over normal operation while cutting in well before the window can take the process down. A budget
> this guard never reaches would be decoration."*

The live process is at **15.1 GB — 47% ABOVE the figure this comment records as the wedging
point.** TRDD-34B9JAZK is the three-silent-kills card for this component; `serverRuntime.ts`'s RSS
instrumentation exists because those kills were invisible.

If the process dies, the in-memory span window is lost (418,018 spans, 2 pending at last read).
The machine is also at **96% disk** with 91 GB free and `never_free_space` in force, so recovery
options are narrow.

## What is ESTABLISHED vs what is NOT

**Established** (each read from source or measured on the live server):
- The guard's only response to `rss > budget` is halving the summarization window
  (`span_window.rs:100-111`). Nothing else is triggered.
- The window is at its floor, so that response is exhausted.
- RSS is 3.7× budget and rising.
- The guard IS wired: `lib.rs:663` calls `apply_memory_pressure(rss_bytes(), rss_budget_bytes())`
  on the flush tick, and the narrowing is announced on stdout ("alcore: memory pressure —
  summarization window now …").

**NOT established — do not assume:**
- **WHY RSS is 15 GB.** A leak, the DuckDB native arena, the segment index, the log-events sink
  (2,067 MB on disk), or simply a large legitimate working set are all live candidates. None
  measured.
- **Whether the process is at imminent risk.** The machine has 64 GB total, so 15 GB is 23% of
  RAM — the 10.25 GB "wedging" figure is one recorded incident, not a threshold anyone has
  characterised.
- **Whether the floor is the right floor.** A 5-minute floor may be correct and the budget wrong,
  or vice versa.

## A hypothesis this measurement KILLED, recorded so nobody re-runs it

The obvious story was: high RSS → `underPressure()` true → `compressSealedSegments` pauses →
sealed segments never compress. **Falsified on disk:** `~/.agentlens/spans` holds **30 `.gz`
segments and 1 plain**, and the plain one is today's active segment, which
`compressSealedSegments` deliberately never touches (`if key >= todayKey { continue }`). The sweep
is working.

The reason it is working is the deeper correction: `rssPressure()` and `compressSealedSegments`
are **TypeScript** (`src/serverRuntime.ts`, `src/segmentedSpanStore.ts`), and the live server is
the **Rust** `alcore` binary. The 4096 MB constant in the TS code and the 4096 MB
`rss_budget_bytes()` in Rust are different guards that happen to share a number. Conflating them
is what made "the sweep must be stalled" look obvious; it is wrong.

This also means the seven `segmentedSpanStore` gzip test failures on TRDD-2R0AXCKL are NOT
explained by the live server's RSS — those tests run in their own mocha process. That remains
open there, and this card does not claim it.

## Acceptance

- [ ] The cause of the 15 GB RSS is identified by measurement (heap profile, allocator stats, or
      a component-by-component accounting), NOT by inference from the number.
- [ ] A decision is recorded on whether the guard needs a second lever once the window floor is
      reached, or whether the floor/budget pair is simply mis-set for this corpus.
- [ ] `/api/server-stats` exposes whether the window is at its floor as an explicit signal — today
      a reader must know `SUMMARY_WINDOW_FLOOR_MS` and compare by hand to tell "degraded to the
      floor" from "configured that way".

## Notes and lessons learned

- **The reported "5m window" is a DEGRADED value, and nothing says so.** `agentlenspro server
  status` prints `spans: … (5m window)` with no indication that the configured value is 24 h and
  the process has been cut 288-fold. I read that line earlier in this session and took it for
  normal operation. That is what acceptance box 3 is for.
- This card exists because a reviewer pointed out that I had observed `rss=14305MB`, declined to
  file it, and declined to investigate it — citing an earlier criticism about "enumerating instead
  of fixing" as the reason. That criticism was about filing *testable* hypotheses instead of
  testing them; inverting it into a reason to do neither is worse than the original error, because
  it arrives dressed as a lesson learned.
