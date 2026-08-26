---
trdd-id: Z8WJZV8E
title: The bodies-sink precondition is checked once at boot and never re-probed, so status reports a volume that has since recovered
column: backburner
created: 2026-08-26T20:13:05+0200
updated: 2026-08-26T20:13:05+0200
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

## Cause (named, from the log)

`~/.agentlens/server.log`:

```
[AgentLens] bodies sink precondition FAILED at boot: /Volumes/AgentLensSpool/otel-bodies not
writable: ENOSPC … (TRDD-4FMHW124)
```

The probe runs **at boot** and its result is cached for the process lifetime. The volume was
genuinely full at that instant; it drained afterwards (2.0 GB volume, 76% → 20% within minutes
as reclaim ran). Nothing re-probes, so the operator surface keeps asserting a condition that
stopped being true, and it can only be cleared by restarting the server.

## Why it is worth fixing rather than ignoring

A status line that is wrong in the SAFE direction is worse than no line: it trains its reader to
discount it. This one says a sink is dead while bodies are being written to it. The next time
the sink really is dead, the message will read identically to the false one that has been sitting
there for hours.

Note the inverse is also unhandled: a sink that was writable at boot and fills later is never
re-probed either, so that failure is invisible until something else notices.

## Acceptance

- [ ] The sink status reflects a probe no older than one pass tick, not the boot result — or the
      cached value is labelled with its age so a reader can tell "dead now" from "was dead at 04:12".
- [ ] A sink that recovers clears the condition without a server restart; a sink that fails after
      boot raises it without one.
- [ ] A test that fails if the probe result is cached for the process lifetime — the shape of the
      defect, not the specific ENOSPC string.

## Not in scope

The volume's own sizing — see [[TRDD-6SPXOV0P]]. This card is only about the staleness of the
report.
