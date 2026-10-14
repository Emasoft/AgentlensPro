---
trdd-id: V2HFI30L
title: setup's server step adopts any server on the UI port and SIGTERMs one whose data dir differs
column: todo
status: tasked
created: 2026-10-14T21:05:56+0200
updated: 2026-10-14T21:18:40+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-14T21:05:56+0200
---

# setup's server step adopts any server on the UI port and SIGTERMs one whose data dir differs

## Approval log

- 2026-10-14T21:05:56+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Findings (2026-10-14)

(a) The port chooser's ownership callback at src/cli/setup.ts:1334 is `async () => (await serverStats(ctx)) !== null`: ANY server answering /api/server-stats on ctx.uiPort counts as ours, whatever data dir it reports. serverStats (setup.ts:211) returns any 200 JSON. Found while isolating cliDispatch test 2, whose first-run launch setup ran on the default ports 3000/4316/4318 against the live collector.
(b) The server step then SIGTERMs that server. healthy (setup.ts:1212) is false when the reported dataDir differs from ctx.dataDir, and the ACT path sends process.kill(stopPid, 'SIGTERM') at setup.ts:1234 to pre.pid. This runs BEFORE every spawn gate (agentlensDisabled at :1246, the revive brake at :1255, the binary lookup), and then a detached alcore is spawned (child.unref() at :1285). Reachable from `agentlenspro setup` with a custom DATA_DIR on the default ports, and from the launch self-heal's first-run full setup (autoSetup.ts defaultFullSetup passes no ports). server start, the hook revive and server stop already refuse a foreign server: findServerPid compares data dirs (src/cli/serverControl.ts:571), and statsOwnership (serverControl.ts:729) is the reusable comparison. setup.ts is the only place with this path. In this session the live collector survived at least six runs of cliDispatch test 2, and why is UNVERIFIED (most consistent with code: serverStats returned null under load, so ours() was false and the OTLP refusal stopped the step before the kill).
(c) httpJson (setup.ts:151-171) arms only req.setTimeout(5000) at :167, an IDLE-socket timeout, so a server that trickles bytes is unbounded; the MCP rpc helper next to it has the same shape with 10 s (:197). The CLI's apiRequest has a total deadline (PROBE_TIMEOUT_MS, src/cli/cliCore.ts:290).
(d) Fix direction (from the review of the first proposal): decide ownership with statsOwnership plus the pidfile identity (<ctx.dataDir>/server.pid naming the live pid that holds the port), not with a bare 200. A data-dir MISMATCH refuses and never kills. Define the outcome when no data dir is reported (an older server, the normal case right after an upgrade): prefer the pidfile identity, else today's behaviour, never a blanket refusal that breaks every upgraded user's setup. Put ownership in ONE shared predicate for setup, server start and revive, not a setup-only callback. Add a TOTAL deadline of at least 5 s to httpJson (and the rpc helper), checked against every caller's retry loop, so load cannot turn a slow healthy server into a false failure. Trace what the launch self-heal does when the server step now fails for a second-instance user (a notice on every launch? a retry?) before landing.
(e) Required tests: a server reporting a DIFFERENT data dir is rejected and never SIGTERMed; a positive control where the same data dir written with a trailing slash or through a symlink is ACCEPTED; the no-data-dir case pinned to the chosen outcome; a trickle server (one byte every few seconds, never finishing) makes httpJson return within the deadline, which fails on today's code (a silent server already trips the idle timeout, so it would not discriminate). Interim mitigation already in place: cliDispatch test 2 pins free ports and pre-sets the revive brake, so the suite no longer reaches the live collector (TRDD-CS2W7E77).
(f) Verified 2026-10-14: the MCP rpc helper in setup.ts arms only req.setTimeout(10_000) (about :197), an idle timeout, the same shape as httpJson. Residual until this card lands: cliDispatch test 2 pins free ports, but a port another process takes first (a second suite in another worktree, say) and that answers /api/server-stats would be adopted and SIGTERMed; do not run two test suites at once until this lands. Release prerequisite: TRDD-CS2W7E77's two-run count restarts when this lands.
