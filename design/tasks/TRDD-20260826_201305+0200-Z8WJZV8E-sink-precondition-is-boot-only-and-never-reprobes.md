---
trdd-id: Z8WJZV8E
title: The bodies-sink status can be stale for a full pass interval, which is one hour outside spool mode
column: backburner
created: 2026-08-26T20:13:05+0200
updated: 2026-08-26T21:05:00+0200
current-owner: main
task-type: bugfix
severity: LOW
priority: 4
labels: [bodies, operator-surface, stale-state]
relevant-rules: []
---

## Symptom

`agentlenspro server status` reports, indefinitely:

```
capture: 3238 live file(s), newest 1s ago | SINK: /Volumes/AgentLensSpool/otel-bodies not
writable: ENOSPC: no space left on device, open '…/.sink-probe'
```

while the volume is, at that same moment, **writable with 652 MB free**. Measured
2026-08-26 20:07-20:10:

| check | result |
|---|---|
| `touch /Volumes/AgentLensSpool/otel-bodies/.sink-probe` (the exact probe path) | succeeds |
| `df -h /Volumes/AgentLensSpool` | 394M used, 1.7G avail, 20% |
| `df -i` | inodes 1% used |
| `server status` | still ENOSPC |

## CORRECTION — this card's first version was WRONG about the cause

**It claimed the probe "runs at boot and its result is cached for the process lifetime … nothing
re-probes". That is false, and reading the source disproves it in one place:**
`standalone/server.ts:775-782` re-probes on EVERY pass tick and logs
`bodies sink precondition recovered` on the transition back. The recovery path exists and works —
confirmed by observation: ~50 minutes after boot the `SINK:` clause was gone from `server status`
on its own, with no restart.

The claim came from seeing a stale value twice within three minutes of a server start and
concluding "never" from "not yet". That is the identical mistake this project's own doctrine warns
about, made while writing a card about someone else's stale state.

## What is actually true

The staleness window is **one pass interval**, and that interval is the finding:

```
standalone/server.ts:926
const BODIES_PASS_INTERVAL_MS = SPOOL_MODE ? 60_000 : 3600e3
```

- in spool mode: 60 s — fine, nobody will misread a minute-old probe;
- otherwise: **3,600,000 ms — one hour.**

So outside spool mode the operator surface can assert a dead sink for up to an hour after it
recovered, and — the direction that actually costs something — can assert a healthy sink for up to
an hour after it died. The boot probe narrows only the first tick; it does not change the interval.

## Why it is still worth something (much smaller than first claimed)

A status line an hour behind reality is a line whose reader cannot tell "now" from "some time in
the last hour". That is tolerable for a slow-moving condition and misleading for the fast one it
is most needed for — a volume that just filled. Whether an hour is the right coupling is a real
question; "it never re-probes" was not.

## Acceptance

- [ ] Decided and recorded whether the sink probe should stay coupled to `BODIES_PASS_INTERVAL_MS`
      (one hour outside spool mode) or get its own shorter cadence — with the reason, either way.
- [ ] If it stays coupled, the served value carries its AGE so a reader can tell "dead now" from
      "was dead when we last looked, up to an hour ago". A timestamp is cheaper than a faster probe
      and removes the ambiguity that motivates this card at all.
- [ ] A test pinning whichever is chosen, so the next person to change the pass interval finds out
      they also changed how fresh the sink status is.

## Not in scope

The volume's own sizing. Also NOT in scope: the "never re-probes" defect this card was opened for —
it does not exist (see the correction above), and nothing should be built to fix it.
