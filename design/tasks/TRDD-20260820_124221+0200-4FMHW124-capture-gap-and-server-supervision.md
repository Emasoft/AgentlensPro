---
trdd-id: 4FMHW124
trdd-id-full: 4FMHW124
title: Raw-body capture has silent multi-hour holes and the server has no supervision
column: todo
created: 2026-08-20T12:42:21+0200
updated: 2026-08-23T00:05:00+0200
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

### DIAGNOSED, same evening — one reviver, and the log gap is a defect in it

### CORRECTED — `--supervise` ALREADY EXISTS, and finding 1 below asserted a negative it had not earned

The section below concluded the reviver is the hook path, "Not the janitor, not launchd, not a
test", and added an acceptance box to *identify the existing reviver before designing
`--supervise`*. **`--supervise` is a shipped feature of this repo**, so the box asked to design
something that is already built:

- `src/cli/serverControl.ts:1` — the file's own header: `server start|stop|restart|status [--supervise]`
- `src/cli/serverControl.ts:529` — `// ── Supervisor (absorbed from scripts/agentlens-supervise.js, TRDD-PJC8N1HO spec 1)`
- `src/cli/serverControl.ts:534` — "the embedded plist that **`daemon install`** writes"
- `src/cli/serverControl.ts:555` — "**launchd immediately brought back**"
- `src/cli/main.ts:226` — "**`daemon start --supervise` is what launchd runs**"

And the "Server supervision (the second half)" section above — *"There is no LaunchAgent for the
server process — pid 73022 dies, it stays dead until a human notices"* — describes an
**uninstalled** feature, not a missing one. That is a materially different card.

**What survives, because it was measured rather than inferred:** on THIS machine the only
installed plist is `com.agentlens.spool` (`RunAtLoad`, `agentlenspro spool ensure`, no
`KeepAlive`) — verified via `launchctl list` and the plist's own `ProgramArguments`. So launchd is
not supervising the server here, and the hook path remains the best explanation for the 21:51
restart. The conclusion about this machine stands; the general claim did not.

**The error, stated plainly because it is the third of its kind tonight:** I found one positive
(the hook reviver) and published a negative ("not launchd") without searching for the others. A
negative claim needs a search, not a discovery. Also incomplete: any CLI path calling
`ensureServer` (`serverControl.ts:661,668`, `main.ts:230`, `diagnosticsCli.ts:672`) restarts a
dead server too, so "hooks" was never the whole list even among the paths I did find.

**1. The reviver is OUR OWN HOOK PATH, and it is deliberate.** *(True of this machine; NOT the
only revival path in the product — see the correction directly above.)*
`reviveDaemonDetached()` — `src/cli/hookHandlers.ts:109-142`. `forwardHookEvent` fires it on ANY
delivery failure (server down, timeout, a 503 shed under load), so the event is spooled and the
server resurrected; a short-TTL mtime lock (`.daemon-revive.lock`) collapses a burst of hooks into
one spawn, and the server's pidfile guard rejects a second canonical instance if two race. Not the
janitor, not launchd, not a test. It already has two brakes — `AGENTLENS_NO_REVIVE=1` and an
on-disk flag (`agentlenspro server stop --stay-down`), the latter existing because a hook inherits
the AGENT's env, so an env var alone cannot stop a runaway from an operator's shell.

So the proposed `--supervise` LaunchAgent would be a **second** supervisor over a process that
already has one. Design it, if at all, as a replacement with the hook revive disabled — not
alongside.

**2. The log gap is caused by that revive, at one line: `stdio: 'ignore'`
(`src/cli/hookHandlers.ts:139`).** A hook-revived server's stdout and stderr go to `/dev/null` by
construction, which is why `server.log` stopped at the 20:57 generation while the 21:51 one runs
silently.

The project already knows this is wrong — the OTHER spawn site says so, about itself:

> `src/cli/serverControl.ts:128-133` — *"stdout/stderr go to a log file, NOT /dev/null — when the
> server dies at boot (port conflict, corrupt store) the reason must be readable, or every failure
> looks like 'did not become ready'. … the old code sent the streams to /dev/null and then told
> the user to 'check server.log'. They would find an empty file and no reason, which is the one
> outcome the log exists to prevent."*

`server start` opens the log and even RECORDS WHY if it cannot. The revive path discards
everything. **Two spawn sites, opposite policies — and the silent one is the path taken precisely
when the server has just died**, i.e. exactly when the reason is worth having. A server that dies
under a hook is resurrected with no record that it died, no record of why, and no record from the
generation that replaced it.

**Fix shape** (small): give the revive the same `fs.openSync(serverLogPath(), 'a')` treatment the
start path uses, falling back to `'ignore'` on failure exactly as `serverControl.ts` does. The
resurrection is the event most worth a log line, and it currently produces none.

**Still NOT established:** *why* the 20:57 generation died at ~21:51. The reviver only spawns when
delivery fails, so a death did occur; nothing recorded it, for the reason above. That is the
question the log fix makes answerable.

Relevant to **TRDD-ZFX0MPYZ** too: its evidence is an 8-hour uptime, and if the process is being
replaced roughly hourly, that sample may no longer be reproducible at all.

## Acceptance

- [ ] Capture down while sessions are active raises a signal within minutes, on stats + alerts.
- [ ] Sink path preconditions verified and reported at boot and per pass tick.
- [ ] `investigate_burn` coverage distinguishes "scanned everything present" from
      "everything present, but the corpus has a hole here".
- [ ] Supervision lands only behind an explicit opt-in.
- [x] **The EXISTING revival paths are identified before any supervisor is designed.** THREE, not
      one: (a) `reviveDaemonDetached()` (`src/cli/hookHandlers.ts:109-142`), fired by
      `forwardHookEvent` on any delivery failure, with `AGENTLENS_NO_REVIVE=1` and an on-disk flag
      as brakes; (b) every CLI path calling `ensureServer` (`serverControl.ts:661,668`,
      `main.ts:230`, `diagnosticsCli.ts:672`); (c) **launchd, via the plist `daemon install`
      writes** — `serverControl.ts:529,534,555`, `main.ts:226`. Not installed on this machine
      (only `com.agentlens.spool` is), which is why the hook path explains the 21:51 restart here.
- [ ] **This card's `--supervise` proposal is REWRITTEN or CANCELLED**, since the feature it
      proposes exists (`server|daemon start … [--supervise]` + `daemon install`). The real
      questions left are whether it should be installed BY DEFAULT, and how it coexists with the
      hook revive — not whether to build it.
- [ ] **A hook-revived server no longer discards its output.** Cause found:
      `src/cli/hookHandlers.ts:139` spawns with `stdio: 'ignore'`, while `serverControl.ts:128-133`
      opens `server.log` and documents /dev/null as "the one outcome the log exists to prevent".
      The silent path is the one taken when the server has just died. Fix = the same
      `fs.openSync(serverLogPath(), 'a')` with the same fallback.
- [ ] **Why the 20:57 generation died at ~21:51 is answered** — unanswerable today, because of the
      box above. Not a separate investigation; it is what the log fix makes possible.

## Notes and lessons learned

Related but distinct from [[C5L779YI]]: that card is about bodies captured-then-lost (reclaim
not draining); this one is about bodies **never captured at all**. Both end as missing data —
different mechanisms, and conflating them would send the fix to the wrong layer.
