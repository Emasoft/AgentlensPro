---
trdd-id: YQZ9P8IL
title: Account-state timeline — per-request subscription-mode attribution, SSD-frugal buffered writes
column: published
created: 2026-07-11T09:55:06+0200
updated: 2026-07-11T10:51:00+0200
published-version: 2.3.0
published-at: 2026-07-11T10:50:30+0200
current-owner: orchestrator-agentlenspro
priority: 2
severity: MEDIUM
effort: M
labels: [diagnostics, storage, cache, correctness]
task-type: feature
release-via: publish
test-requirements: [unit, integration, lint, typecheck]
npt: [VY1IUVUM]
blocked-by: []
implementation-commits: [7fe8b97]
---

# Account-state timeline — attribute every request to the subscription mode active then

## ⏵ STATE — READ THIS FIRST ON RESUME — 2026-07-11 (COMPLETE — awaiting tag → published)

- **Current state**: DONE on `feat/account-state-timeline`, commit `7fe8b97` (VY1IUVUM unblocked
  it — now published as v2.2.0). `src/accountStateTimeline.ts` = the change-detected buffered writer
  + `resolveStateAt` binary search + `buildAccountStateRecord`; plan/mode/regime helpers MOVED here
  from mcpServer (single source of truth). `get_account_state_at` MCP tool added. Sampled on the
  standalone 4s burn tick; flushed on 60s timer / 32-record / SIGTERM. Gates green (tsc 0, eslint 0,
  mirrors OK, esbuild OK, **mocha 849/0/4**). **Live-verified**: 7s of ticks produced exactly ONE
  ndjson record (ipazia / Max 5x / subscription / 60min doc-matrix — change-detection proven), and
  get_account_state_at resolved it.
- **NEXT ACTION**: merge feat → main `--no-ff`; deploy; tag `v2.3.0` (push → OIDC publish); flip this
  TRDD `complete → published`.
- **SUPERSEDED — do NOT carry forward**: the `blocked-by: [VY1IUVUM]` state (VY1IUVUM shipped).

## Requirement (USER 2026-07-11)

Every LLM/API request must be pinpointable to the subscription state active AT THAT TIME
(account, mode subscription/usage-credits/api, plan Max-5x/20x/Pro, cache-TTL regime,
optionally 5h/7d fill). BUT: writing per-request would hammer the SSD (finite write cycles),
so buffer the log in memory and flush on an interval — long enough to spare the SSD, short
enough to bound crash/power-loss data loss. Find the right value.

## Design — a change-detected state TIMELINE, not per-request rows (the SSD win)

The subscription state is a SLOWLY-CHANGING dimension: `mode`/`plan` almost never change;
`account` changes on rotation (~minutes, when the 5h window fills); only 5h/7d % move
continuously. So the correct, write-frugal model is an append-only **state timeline** keyed
on the DISCRETE dims, written ONLY when they change:

- File: `~/.agentlens/account-state.ndjson` (append-only, same dir/segment discipline as the
  span store). One record per STATE CHANGE:
  `{ts, accountId, email, mode, plan, authRegime, ttlMinutes, ttlSource}`.
- **Change-detection key = the discrete dims** (accountId + mode + plan + authRegime +
  ttlMinutes). The continuously-moving 5h/7d % are DELIBERATELY EXCLUDED from the key — they
  are queried live (get_account_status) or bucketed coarsely, never per-delta, or the
  timeline would write constantly. (Optional: also emit a record when 5h% crosses a 25%
  bucket boundary — cheap, still rare.)
- **Answer "mode at request time T"**: binary-search the timeline for the last record with
  `ts <= T`. Exact, and needs ZERO per-request write. Each span/request already carries a
  timestamp (and can carry accountId for a direct join); the timeline is the authoritative
  mode-at-time source.

This alone reduces writes from thousands/hour (per-request) to a FEW/hour (per state change)
— the biggest SSD lever is the model, not the buffer.

## The write buffer + flush interval — the "right value"

On top of change-detection, an in-memory buffer coalesces bursts and bounds loss:

- **Flush triggers (whichever first):** (1) a **60-second** timer, (2) buffer ≥ **32 records
  OR ~16 KB**, (3) **graceful shutdown (SIGTERM)** — the existing server already flushes the
  span store on SIGTERM; piggyback the timeline flush there so a clean stop never loses it.
- **Why 60 s:** with change-detection, actual enqueues are a few/hour, so the 60 s timer
  almost always flushes 0-1 records — negligible SSD traffic (a tiny NDJSON append a handful
  of times/hour; modern SSD endurance is hundreds of TBW, so this is ~nothing). The 60 s
  window bounds worst-case crash/power-loss to ≤ 60 s of state changes — and since state
  changes are rare, a crash typically loses ZERO real transitions. Longer (e.g. 5 min) saves
  no meaningful SSD (writes are already rare) while widening the loss window; shorter (e.g.
  5 s) buys almost nothing and risks write-amplification on burst rotations. **60 s is the
  balance**; expose it as `AGENTLENS_ACCOUNT_STATE_FLUSH_MS` (default 60000) so it is tunable.
- **Crash-safety:** append + `fs.fsync` on flush (atomic append; NDJSON is recovery-robust —
  a torn final line is discardable). NO per-record fsync (that is the SSD killer).
- Reuse the span-store's existing flush timer if one exists (verify) so there is ONE write
  cadence, not two competing timers.

## Acceptance

- A rotation (account change) appends exactly ONE timeline record; a run with no state change
  appends ZERO (change-detection proven by a no-op test).
- `get_account_status` (or a new `get_account_state_at --ts <T>`) resolves the state active
  at an arbitrary past timestamp from the timeline.
- Buffer flushes on 60 s / 32-record / SIGTERM; a kill-9 mid-window loses ≤ the last window's
  changes and never a flushed record (test: enqueue, SIGTERM, reopen, assert persisted).
- No per-request disk write introduced anywhere (grep-proof); SSD write frequency measured
  ≤ a few/hour in a normal session.
- Suite grows, zero regressions; docs + CHANGELOG.

## Notes

Depends on VY1IUVUM (which builds the account-state VALUES: resolveAuthRegime, getTtlContext,
the get_account_status mode/plan/ttl fields). Build this AFTER that merges — the timeline
logs what that computes.
