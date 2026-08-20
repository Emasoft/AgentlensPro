---
trdd-id: 4FMHW124
trdd-id-full: 4FMHW124
title: Raw-body capture has silent multi-hour holes and the server has no supervision
column: todo
created: 2026-08-20T12:42:21+0200
updated: 2026-08-20T12:42:21+0200
current-owner: AgentlensPro session
task-type: infra
severity: MEDIUM
priority: 3
effort: M
labels: [bodies, spool, observability, supervision]
approval-tier: 0
relevant-files: [standalone/server.ts, src/spoolBackpressure.ts, src/cli/setupCli.ts]
release-via: none
blocked-by: []
---

# Capture has silent holes, and nothing keeps the server alive

## The measured hole

| dir | files | span |
|---|---|---|
| `/Volumes/AgentLensSpool/otel-bodies` | 568 (0.37GB) | 2026-08-20 09:24 → 12:37 |
| `~/.agentlens/otel-bodies` | 1467 (0.51GB) | 2026-08-16 17:49 → **2026-08-18 20:40** |

The home dir froze the moment `OTEL_LOG_RAW_API_BODIES` was repointed at the spool. Between
**2026-08-18 20:40 and 2026-08-20 09:24 — ~37 hours — no bodies exist in either location.**
That window covers real work (an account rotation and a fleet restart), so it is not idle time.

## Why it is silent, and why agentlenspro cannot currently catch it

The sink is a path handed to **Claude Code's own OTEL exporter**. When the path is not
writable — volume unmounted, volume full — the exporter drops the body. `src/spoolBackpressure.ts`
already documents that the write is not ours to intercept. So a capture outage produces
**no error anywhere**; it produces an absence, and an absence looks exactly like "no traffic".
That is the same honesty failure the store's BLIND contract exists to prevent, one layer up.

## What to build (proposal, not yet designed)

1. **A capture-liveness signal.** The server already knows sessions are active (spans, hook
   events, statusline samples arriving) — if those advance while the body dirs receive nothing
   for N minutes, capture is DOWN. Surface it on `/api/server-stats` and as a burn alert.
   This is the piece that turns a 37h absence into a same-minute alert.
2. **A mount precondition check** at boot and on each pass tick: sink path configured →
   exists → writable. Report it; never silently succeed.
3. **Coverage honesty downstream.** `investigate_burn` says "full coverage of the window" while
   scanning dirs that may have a hole in them. It should report a capture GAP as a gap
   (it already discloses file-cap hits — same mechanism, different cause).

## Server supervision (the second half)

`~/Library/LaunchAgents/com.agentlens.spool.plist` supervises the **spool volume**. There is
**no LaunchAgent for the server process** — pid 73022 dies, it stays dead until a human
notices, and every capture consumer degrades quietly meanwhile. `agentlenspro setup` is the
natural home for an opt-in `--supervise` that installs/verifies a server LaunchAgent, since it
already owns idempotent convergence + verification per step.

**Installing a LaunchAgent is persistent system state — it needs the USER's explicit go-ahead
before it ships as a default.** It is proposed here, not assumed.

## Acceptance

- [ ] Capture down while sessions are active raises a signal within minutes, on stats + alerts.
- [ ] Sink path preconditions verified and reported at boot and per pass tick.
- [ ] `investigate_burn` coverage distinguishes "scanned everything present" from
      "everything present, but the corpus has a hole here".
- [ ] Supervision lands only behind an explicit opt-in.

## Notes and lessons learned

Related but distinct from [[C5L779YI]]: that card is about bodies captured-then-lost (reclaim
not draining); this one is about bodies **never captured at all**. Both end as missing data —
different mechanisms, and conflating them would send the fix to the wrong layer.
