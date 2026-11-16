---
trdd-id: 77TSOX08
title: disk-monitor install fails and leaves the sampler unloaded when the resident job is running
column: todo
status: tasked
created: 2026-11-16T22:07:35+0100
updated: 2026-11-16T22:07:35+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-16T22:07:35+0100
---

# disk-monitor install fails and leaves the sampler unloaded when the resident job is running

## Symptom (measured 2026-11-16 21:59)
`agentlenspro disk-monitor install`, run to redeploy over a RUNNING resident sampler, failed with "launchctl bootstrap ... Bootstrap failed: 5: Input/output error". Afterwards `launchctl print` answered "Could not find service com.agentlens.disk-sample": the sampler was unloaded and nothing sampled until a second install, which succeeded. The walk job kept its old registration because the loop threw before reaching it.

## Cause (code read in src/cli/diskLaunchd.ts lines 121-123; mechanism INFERRED)
install runs `bootout` and immediately `bootstrap`. `bootout` returns before launchd has finished removing a service whose process is still alive, and `bootstrap` of the same label then fails with error 5. Before e7a74ebb the volumes job ran a few seconds per minute, so it was almost never alive at reinstall time; the KeepAlive resident job is always alive, so the race is now the common case. Not measured: how long the removal takes.

## Fix
After `bootout`, wait until `launchctl print <domain>/<label>` fails (service gone), polling every 200 ms for at most 15 s, then `bootstrap`. If the service is still there after 15 s, fail with a message that says so and do not call bootstrap. Injectable sleep so the test needs no real waiting.

## Acceptance
- [ ] unit test: with an injected launchctl whose print succeeds twice and then throws, bootstrap is called only after print threw
- [ ] unit test: when print never throws, install fails with the "still loaded" message and never calls bootstrap
- [ ] live: `disk-monitor install` over the running resident sampler succeeds on the first try and the sampler is running afterwards

## Approval log

- 2026-11-16T22:07:35+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
