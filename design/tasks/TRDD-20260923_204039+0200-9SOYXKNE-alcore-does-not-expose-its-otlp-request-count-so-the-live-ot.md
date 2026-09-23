---
trdd-id: 9SOYXKNE
title: alcore does not expose its OTLP request count so the live OTLP request rate cannot be measured
column: todo
created: 2026-09-23T20:40:39+0200
updated: 2026-09-23T21:07:29+0200
current-owner: main-session
created-by: main-session
task-type: feature
min-approval-requirement: none
assignee: main-session
mandate: true
mandated-by: none
approved: true
approval-judge: main-session
approval-datetime: 2026-09-23T20:40:39+0200
---

# alcore does not expose its OTLP request count so the live OTLP request rate cannot be measured

## Approval log

- 2026-09-23T20:40:39+0200 — MANDATE issued by main-session (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Body

TRDD-EQCGAVGV's OTLP arm must match the live OTLP REQUEST rate (data_version bumps once per ingest_parsed call - measured for single-resource /v1/traces payloads only), but /api/server-stats exposes only spans.store.totalSpans. alcore already counts payloads internally: traces_payloads, logs_payloads, metrics_payloads (Counters struct, rust-core/crates/agentlens-core/src/lib.rs:123-125), incremented at lib.rs:889, lib.rs:893, lib.rs:922; Counters (lib.rs:121-128) derives only Default, not Serialize.
Add those counts to /api/server-stats (server_stats.rs, spans object built ~line 637-649, admission object at line 703) under a new otlp object, exactly otlp.tracesPayloads / otlp.logsPayloads / otlp.metricsPayloads (the flood tool, the sampler and EQCGAVGV read these names); they count ACCEPTED payloads (incremented inside ingest_parsed), not rejected POSTs, so a before/after read gives requests/s.
Acceptance: [ ] one POST each to /v1/traces, /v1/logs and /v1/metrics on an isolated instance raises only its own counter, by exactly 1; [ ] the field appears in /api/server-stats; [ ] the rust-core crate's targeted tests pass (never the full cargo test -p agentlens-core, which revives a real alcore on canonical ports - TRDD-YGEV6QDD). related: [EQCGAVGV, C19SUVPH].
