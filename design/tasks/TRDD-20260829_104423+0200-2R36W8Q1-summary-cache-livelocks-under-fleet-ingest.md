---
trdd-id: 2R36W8Q1
title: The summary cache is keyed on a version that moves faster than a rebuild completes, so the UI path livelocks under fleet ingest
column: dev
created: 2026-08-29T10:44:23+0200
updated: 2026-08-29T10:44:23+0200
current-owner: main-session
task-type: bugfix
scope: project
project-id: agentlenspro
parent-trdd: YU8QPU89
relevant-rules: []
implementation-commits: []
---

# Summary cache livelocks under fleet ingest

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-29

- **Measured, profile-confirmed.** Not a hypothesis. Evidence is in this card's
  "Measurement" section; the `sample` output is `/tmp/soak-sample.txt` (ephemeral —
  the numbers are transcribed below because that file will not survive).
- **Ingest is NOT affected and was verified separately**: `/v1/traces` answered
  HTTP 200 in 0.3 ms while `/api/server-stats` was timing out. Do not let a later
  reading of this card turn "the server wedges" into "ingestion is broken" — the
  two paths were measured independently and only the READ path fails.
- **NEXT ACTION**: the advisor verdict on the fix ordering was requested
  (bounded-staleness vs lower span cap vs incremental summarizer vs attacking the
  per-span `IndexMap<String, Value>` attribute lookup). Apply the fix it endorses,
  then re-run the fleet soak and require `/api/server-stats` to answer in under
  1 s at 2,600 spans/s.
- **DO NOT build/test while a soak is running** — `cargo build` contends for the
  same cores and invalidates the measurement in flight.

## Symptom

Under a 100-session fleet soak (`scripts_dev/soak-fleet.sh`, 2,600 spans/s =
100 sessions x 26 spans/s, this machine's measured per-session peak):

| path | result |
| --- | --- |
| `POST /v1/traces` | HTTP 200 in **0.3 ms** — healthy |
| `GET /api/server-stats` | **no response at 20 s** — curl exit, zero bytes |
| process CPU | **101.9%** — exactly one core |
| process RSS | **17.9 GB** |
| spans dropped | **0** |

The soak's own per-minute sampler shows the same thing from the outside: minutes
1-2 carry `mem=`/`store=` columns, minutes 3-6 carry none, because its 10 s
`curl` to `/api/server-stats` timed out on four consecutive samples.

## Measurement

`/usr/bin/sample <pid> 6`, top-of-stack, all frames inside the summary rebuild:

```
IndexMap::get_index_of                      843
core::hash::sip::Hasher::write              500 + 208
summarize::claude::build_interaction_card   202
IndexMap::insert_full                       178
summarize::helpers::nano_to_ms              110
summarize::helpers::attr_value               92
summarize::summarizer::summarize_spans       55
summarize::helpers::parse_iso_ms             44
__psynch_mutexwait                          2540
```

(`__psynch_cvwait` 55,997 is the parked tokio worker pool, not work.)

## Mechanism (read from source, not inferred)

- `ui.rs::summary_now` fast path reads `st.data_version` and asks
  `st.summary_cache.current(version)`. A miss takes the process-global
  `rebuild_gate()`, re-checks, snapshots the window, runs
  `CoreState::summary_from` off-lock, and stores under `inputs.version`.
- `st.data_version += 1` fires on **every ingest** — `lib.rs:247`, `:554`,
  `:603`, `:737`.
- The window is capped at 1,000,000 spans (`span_window.rs::max_spans_default`).

So the cache KEY moves ~130x/second while ONE rebuild over ~1M spans takes over
20 s. The hit rate is approximately zero under sustained load: every request
misses, every rebuild is already stale when it stores, and the server rebuilds
continuously at 100% of one core forever.

**The single-flight gate (commit `463f4802`) is working exactly as designed** —
it is why only ONE core is pegged instead of N. It bounds rebuild CONCURRENCY.
It cannot bound rebuild COST, and cost is what fails here. Do not read this card
as evidence the gate was wrong.

**The span-count ceiling (commit `f106e493`) is also working** — RSS went flat at
17.05 GB across minutes 5 and 6, which is where the 1M cap binds (predicted 6.4).
It bounds MEMORY. It does not bound rebuild LATENCY, and at 1M spans that latency
is over 20 s.

`ui.rs` already names the intended upgrade in its own comment: *"a rebuild is
still the WHOLE window — and the upgrade is still an incremental summarizer, not
more locking."*

## Candidate fixes (ordering pending the advisor verdict)

1. **Bounded staleness** — keep the last-good summary with a `built_at_ms` and
   serve it from the fast path even when `data_version` moved, provided it is
   younger than N ms. Turns "rebuild per request" into "rebuild per N ms".
   Open question this card must not paper over: at 1M spans a rebuild takes
   over 20 s, so a 1-2 s tolerance may still leave a core pegged continuously
   and the summary >20 s stale. It may need a lower span cap to mean anything.
2. **Adaptive cadence** — rebuild at most once per previous-rebuild-duration, so
   the summarizer can never consume more than a fixed share of one core.
3. **Attack the per-span cost** — `IndexMap<String, Value>` attribute lookup with
   SipHash per key is the dominant leaf. Interning, or extracting the needed
   fields once at ingest, changes the constant rather than the cadence.
4. **Incremental summarizer** — the real fix named in the code, and the largest.

## Trap to check before shipping any of these

`summary_now` returns `(version, Arc<Value>)` and `stripped_cache` is keyed on
that same version. Returning a summary whose version is older than
`data_version` must not let a stale body be stored under, or served as, a newer
version.

## Acceptance

- [ ] `/api/server-stats` answers in under 1 s while ingesting 2,600 spans/s.
- [ ] `/v1/traces` stays at HTTP 200 with p99 unchanged (no ingest regression).
- [ ] Zero spans dropped (`droppedOnFailure: 0`).
- [ ] A mutation-verified test: revert the fix and the test must fail.
- [ ] RSS bounded — record the number, do not assert a target that was not measured.
