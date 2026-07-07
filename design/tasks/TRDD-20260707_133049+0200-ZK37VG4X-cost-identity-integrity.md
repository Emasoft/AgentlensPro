---
trdd-id: ZK37VG4X
title: Cost + identity integrity — no silent $0, no duplicate sessions, honest sampling
column: planned
created: 2026-07-07T13:30:49+0200
updated: 2026-07-07T15:25:00+0200
current-owner: null
assignee: null
priority: 1
severity: HIGH
effort: M
task-type: bugfix
parent-trdd: TRDD-TKN5VALS
approval-tier: 2
relevant-rules: []
release-via: none
target-branch: fix/logreader-large-jsonl
test-requirements: [typecheck, lint, unit]
impacts: []
external-refs: [PRICING_SOURCES.md]
---

# TRDD-ZK37VG4X — Cost + identity integrity

## ⏵ STATE — APPROVED 2026-07-07 (USER: "go" after the P1-P6 evaluation) — queued for dispatch
Approval log: 2026-07-07T15:25:00+0200 — APPROVED by USER ("go"). Moved to design/tasks, column planned.

## Why (all four defects verified live, 2026-07-07)
1. **Silent $0 pricing**: `claude-sonnet-5` is ABSENT from `src/pricing.ts` (sonnet-4/4-5/4-6
   present) → 14 sessions ranked `avgCostUsd: 0` in get_efficiency_report. An unknown model
   silently bills $0 — the exact opposite of a cost-accuracy tool's contract (fail-fast rule).
2. **Duplicate session double-count**: efficiency worstSessions listed TWO ids
   (`55f9679cc5bea882`, `0ca3718286b47699`) with byte-identical cacheCreate=367,621 — one real
   session counted twice. Plus `synth-*` ids for OTEL sessions the collector could not tie to a
   real session id → attribution fragments across cards.
3. **SLI junk rows**: worstSessions includes `model:""` entries with 0 tokens/0 cache data —
   no-data sessions ranked as "worst cache health".
4. **Sampling opacity**: `find_context_hogs` scanned 25 of 340 log-backed sessions (13,993
   considered) — numbers reported but not tunable; easily misread as a global truth.

## Spec
1. Add `claude-sonnet-5` (+ audit every current model id against PRICING_SOURCES.md) to BOTH
   hand-synced tables (`src/pricing.ts`, `media/src/pricing.ts`). For any UNKNOWN model:
   never $0 — mark the session `unpriced: true`, surface an "UNPRICED MODEL <id>" badge on the
   card + an Alerts entry, and exclude it from cost aggregates (labeled) instead of deflating them.
2. Session identity: correlate OTEL `session.id` / jsonl sessionId / synth fallback ids; merge
   duplicates at read time (SessionRepository) with a deterministic winner (OTEL-wins rule) and
   record `mergedFrom:`. A synth-* card that later gains a real id is re-keyed, not duplicated.
3. SLI hygiene: rankings (worst cache health, leaderboards) exclude sessions lacking the metric's
   underlying data; excluded count reported.
4. Sampling honesty: `find_context_hogs` (and any bounded scan) accepts a `maxSessions` param,
   and its response carries an explicit `coverage` disclaimer string when partial.

## Acceptance
- sonnet-5 sessions show real cost; a fixture with an unknown model shows the UNPRICED badge and
  does not deflate averages; the duplicate pair collapses to one card; worstSessions contains no
  empty-model rows; hogs response carries coverage info + honors maxSessions. Unit tests for the
  merge + unpriced paths. check-types+lint+esbuild clean.
