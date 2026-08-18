---
trdd-id: 9NAUEUUR
title: Span walk must prefilter before parse and yield while walking
column: completed
created: 2026-08-13T22:22:27+0200
updated: 2026-08-18T12:45:00+0200
current-owner: agentlenspro-main
task-type: bugfix
approval-tier: 0
scope: project
project-id: agentlenspro
parent-trdd: 34B9JAZK
created-by: 34B9JAZK delegated review + in-scan trail experiment
labels: [server, stability, span-store, performance]
severity: high
effort: medium
---

# Span walk must prefilter before parse and yield while walking

Derived (EHT) from TRDD-34B9JAZK's named mechanism, measured 2026-08-13 ~23:00 with the in-scan
rss trail (commit c622c76): `scanOtelCallEvents`' walk over 5.4M spans JSON.parses EVERY span line
into an object graph and discards almost all of them (only `claude_code.api_request` /
`claude_code.compaction` are kept) — ~2GB of transient heap per GC cycle, rss sawtoothing
2.6→4.7GB, kills = a sawtooth peak meeting macOS memory pressure. The same synchronous walk blocks
every listener for its whole duration (74.7s measured), which is what makes `server status` report
NOT RUNNING against a healthy, working server.

## The two changes

1. **Prefilter before parse.** `forEachInRange` (or a name-filtered variant) gains a cheap
   line-level prefilter: a substring test for the wanted span names BEFORE `JSON.parse`. The churn
   is dominated by parsed-then-discarded objects; most spans are neither api_request nor
   compaction, so the transient allocation drops by roughly the non-matching fraction. The
   prefilter must be conservative (a substring FALSE NEGATIVE loses data — test with names
   embedded in attribute values, escaped quotes, and both span kinds).
2. **Yield while walking.** The walk must periodically let the event loop breathe (an async
   variant driven segment-by-segment / N-lines-per-tick, or a worker thread). Decide the shape
   against the sync-by-design constraint in ndjsonLines' header — the async ripple is exactly what
   was avoided before, so this needs a deliberate design pass, not a drive-by `await`.

## Acceptance

- [x] Red-first: a test (or measured trail) demonstrating parsed-span count >> kept-span count
      before, and parsed ≈ candidate count after the prefilter.
      (CLOSED 2026-08-13 22:45 — prefilter landed 3a71bde and DEPLOYED; the live no-window rerun's
      trail is the measurement: baseline fired 11 samples at the 500k-parsed interval (5M+ parses);
      post-prefilter it fired ZERO — fewer than 500k lines parsed across the whole 5.4M-span store,
      i.e. >90% of JSON.parse calls eliminated. Wall 74.7s → 61.2s, exit 0, identical output shape.)
- [x] The no-window `get_cache_event_log` trail shows materially lower rss peaks than the
      2026-08-13 baseline (4714MB peak at units=4M) on a comparable store.
      (CLOSED with a disclosed caveat: the sampler's unit is PARSED spans, so post-prefilter the
      whole walk sits under one sampling interval and produced no in-walk rss readings — the
      absence proves the churn source collapsed, but peak rss during the walk is now unsampled.
      The yield half must ALSO re-key the sampler to raw LINES (or drop the interval to 50k) so
      the trail keeps watching.)
- [x] `server status` answers during a no-window scan (the yield half — still observed failing
      live at 22:44: pid 7186 alive and healthy, status probe DROPped during the walk), OR the
      card records the explicit decision to defer the yield with its reason.
      (CLOSED 2026-08-14 02:35 — landed 3c3ae12 and MEASURED LIVE on pid 75481: a real no-window
      `get_cache_event_log` (source otel, exit 0) ran while 8/8 `server status` probes answered
      RUNNING at 02:05:37–02:07:41; the pre-fix baseline was every probe DROPped. server.log shows
      span/log-event INGEST lines interleaved between the walk's own rss samples — the loop is
      genuinely served mid-walk, not just at the probe endpoint. Shape chosen: an async driver
      (`forEachNdjsonLineAutoYielding`, `forEachInRangeYielding`) over the SAME chunk generators
      the sync exports use — sync-by-design preserved for sync callers, one read logic, awaits
      setImmediate per chunk (poll phase runs between checks, so pending sockets are accepted).
      A worker thread was rejected: rss is per-process so it buys no memory, and it costs a build
      target + serialization. The sampler is re-keyed to RAW lines and fired 20 samples on the
      live walk (units=2.5M/3.0M/3.5M…, rss 3.0–3.3GB vs the 4.7GB pre-prefilter sawtooth).)
- [x] No span loss: prefilter false-negative cases pinned by tests (attribute-value collision case
      + gz-transparency case, both green in segmentedSpanStore.test.ts; conservative-safety
      argument written at the call site: a JSON name field's value necessarily appears as a
      substring of its own line, so only false POSITIVES are possible and the `s.name` check
      absorbs those).

## Baseline evidence

TRDD-34B9JAZK "2026-08-13 ~23:00" section (the sampled trail, verbatim) and
`~/.agentlens/server.log`'s rss-sample lines from that run.

## Approval log

- 2026-08-18T12:45:00+0200 — ARCHIVED by USER batch directive ("complete all TRDD"); validity re-verified: src/segmentedSpanStore.ts:361 exports forEachInRangeYielding, src/ndjsonLines.ts:279 exports forEachNdjsonLineAutoYielding, both wired at src/otelCallEvents.ts:161.
