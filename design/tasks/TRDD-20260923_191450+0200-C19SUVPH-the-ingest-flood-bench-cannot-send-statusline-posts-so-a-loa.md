---
trdd-id: C19SUVPH
title: The ingest flood bench cannot send statusline POSTs so a load arm cannot vary statusline alone
column: todo
created: 2026-09-23T19:14:50+0200
updated: 2026-09-23T19:27:48+0200
current-owner: main-session
created-by: main-session
task-type: infra
min-approval-requirement: none
assignee: main-session
mandate: true
mandated-by: none
approved: true
approval-judge: main-session
approval-datetime: 2026-09-23T19:14:50+0200
---

# The ingest flood bench cannot send statusline POSTs so a load arm cannot vary statusline alone

scripts/bench/alcore-ingest-flood.mjs drives OTLP only. TRDD-EQCGAVGV's isolated run needs arms that vary statusline and OTLP independently, so the tool must: send POST /api/statusline-samples with a realistic payload at a configurable rate (including low rates, e.g. 1 per 10 s); pace OTLP independently; target a given port set (UI/API and OTLP) so it never touches the live collector's canonical ports by default.

Acceptance: [ ] statusline-only and OTLP-only modes (the zero-load baseline is simply not running the tool); [ ] rate flags verified by the target's own counters (statusline receivedSinceBoot, admitted_total) over 5 min; [ ] refuses to run against the canonical ports unless an explicit flag says so. related: [EQCGAVGV].

## Approval log

- 2026-09-23T19:14:50+0200 — MANDATE issued by main-session (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Evidence

The statusline POST handler is agentlens-core/src/ui.rs:1426-1444 (POST /api/statusline-samples); payload shape is any JSON object with an optional statusline_stream:"subagent" field (ui.rs:1439), not a fixed schema struct on this path. No per-route auth/header check on this handler; it relies on the global CSRF Origin gate (ui.rs:6-14,548-569) applied to every non-GET/HEAD request.
