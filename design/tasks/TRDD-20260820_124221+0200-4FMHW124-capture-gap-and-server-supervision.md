---
trdd-id: 4FMHW124
trdd-id-full: 4FMHW124
title: Raw-body capture has silent multi-hour holes and the server has no supervision
column: todo
created: 2026-08-20T12:42:21+0200
updated: 2026-08-22T22:20:00+0200
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

### AMENDED 2026-08-22 — "no supervision" is wrong, and the real defect is worse

Measured first-hand while working TRDD-8TM7I49X, so recorded before it is lost:

| fact | value |
|---|---|
| server pid at 21:09 | 52197, uptime 12m ⇒ started ~20:57 |
| server pid at 22:16 | **5644**, uptime 24m26s ⇒ started **21:51:43** |
| who restarted it | **not this session** — no restart was issued |
| `~/.agentlens/.daemon-revive.lock` | written **22:15:05**, one minute before the reading |
| `~/.agentlens/server.log` mtime | **20:57** — the 20:57 generation's own boot |

**Two findings, and the second is the one that matters.**

1. **Something DOES restart the server.** A `.daemon-revive.lock` is being written every
   ~minute, and the process was replaced between 21:09 and 21:51 with no human or session
   action. So the section above ("pid 73022 dies, it stays dead until a human notices") is not
   the current behaviour. **Do not design the `--supervise` opt-in until the EXISTING reviver is
   located** — installing a LaunchAgent beside an unidentified reviver is how you get two
   supervisors fighting over one process.
2. **The current server generation writes NOTHING to `server.log`.** The log stops at 20:57
   while the running process started at 21:51. Every log-based conclusion is therefore about
   *previous generations*, and the live process is unobservable through the file everyone reads.
   This is a **capture hole in the observability layer itself** — the same shape as this card's
   subject, one level up — and it silently invalidates "the log is quiet, so nothing happened"
   for any reader who does not check the mtime against the uptime.

**Neither is diagnosed.** Candidates deliberately not ranked: the reviver may be the janitor's
global daemon, `agentlenspro setup` running from a hook, or a `server restart` inside a test; the
log gap may be a redirect that a re-exec did not inherit, a rotated file, or a generation that
never opened it. Establish WHICH before designing anything — this card's neighbour
(TRDD-8TM7I49X) cost three wrong causes by reasoning from a symptom.

Relevant to **TRDD-ZFX0MPYZ** too: its evidence is an 8-hour uptime, and if the process is being
replaced roughly hourly, that sample may no longer be reproducible at all.

## Acceptance

- [ ] Capture down while sessions are active raises a signal within minutes, on stats + alerts.
- [ ] Sink path preconditions verified and reported at boot and per pass tick.
- [ ] `investigate_burn` coverage distinguishes "scanned everything present" from
      "everything present, but the corpus has a hole here".
- [ ] Supervision lands only behind an explicit opt-in.
- [ ] **The EXISTING reviver is identified before any supervisor is designed** (see the 2026-08-22
      amendment). Two supervisors on one process is a worse failure than none.
- [ ] **A server generation that writes nothing to `server.log` is caught.** The log's mtime was
      54 minutes behind the running process's start time and nothing said so; `server status`
      knows the uptime and could compare the two.

## Notes and lessons learned

Related but distinct from [[C5L779YI]]: that card is about bodies captured-then-lost (reclaim
not draining); this one is about bodies **never captured at all**. Both end as missing data —
different mechanisms, and conflating them would send the fix to the wrong layer.
