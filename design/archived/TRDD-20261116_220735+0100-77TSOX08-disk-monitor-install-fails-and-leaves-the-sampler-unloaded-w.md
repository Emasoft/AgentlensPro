---
trdd-id: 77TSOX08
title: disk-monitor install fails and leaves the sampler unloaded when the resident job is running
column: complete
status: archived
created: 2026-11-16T22:07:35+0100
updated: 2026-11-16T22:49:43+0100
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
implementation-commits: [c00f6491]
---

# disk-monitor install fails and leaves the sampler unloaded when the resident job is running

## Symptom (measured 2026-11-16 21:59)
`agentlenspro disk-monitor install`, run to redeploy over a RUNNING resident sampler, failed with "launchctl bootstrap ... Bootstrap failed: 5: Input/output error". Afterwards `launchctl print` answered "Could not find service com.agentlens.disk-sample": the sampler was unloaded and nothing sampled until a second install, which succeeded. The walk job kept its old registration because the loop threw before reaching it.

## Cause (code read in src/cli/diskLaunchd.ts lines 121-123; mechanism INFERRED)
install runs `bootout` and immediately `bootstrap`. `bootout` returns before launchd has finished removing a service whose process is still alive, and `bootstrap` of the same label then fails with error 5. Before e7a74ebb the volumes job ran a few seconds per minute, so it was almost never alive at reinstall time; the KeepAlive resident job is always alive, so the race is now the common case. Not measured: how long the removal takes.

## Fix
After `bootout`, wait until `launchctl print <domain>/<label>` fails (service gone), polling every 200 ms for at most 15 s, then `bootstrap`. If the service is still there after 15 s, fail with a message that says so and do not call bootstrap. Injectable sleep so the test needs no real waiting.

## Acceptance
- [x] unit test: with an injected launchctl whose print succeeds twice and then throws, bootstrap is called only after print threw
- [x] unit test: when print never throws, install fails with the "still loaded" message and never calls bootstrap
- [x] live: `disk-monitor install` over the running resident sampler succeeds on the first try and the sampler is running afterwards

## Approval log

- 2026-11-16T22:07:35+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-16T22:49:43+0100 — COMPLETE by main-agent@agentlenspro. all three acceptance boxes ticked; fix in c00f6491; live re-install passed first try 2026-11-16 22:47.

## STATE

2026-11-16 — FIXED in commit c00f6491. reloadJob in src/cli/diskLaunchd.ts: bootout, then poll launchctl print every 200 ms (limit 15 s) until it fails, then bootstrap, up to 3 tries 500 ms apart.
MEASURED in /var/log/com.apple.xpc.launchd/launchd.log for the failed install: bootout 21:58:58.182939; bootstrap refused 21:58:58.187732 with 37 Operation already in progress (4.8 ms after the bootout); service removed 21:58:58.194286 (6.6 ms after the refusal). launchctl printed Bootstrap failed 5 Input/output error for that refusal. This replaces the INFERRED mechanism in the Cause section.
LIVE CHECK 2026-11-16 22:47:39: disk-monitor install over the running resident sampler (pid 22653) exited 0 on the first run; afterwards launchctl print exit 0 for both jobs, sampler pid 89478 state running, walk pid 89555.
KNOWN LIMITS (accepted): if a job is still loaded 15 s after bootout the install throws and that job stays unloaded until install is run again (the error says so); when the first job fails, the later job is not reached and keeps its old registration. launchctl print exit 113 means the label is missing, exit 0 means loaded.
TESTS in src/test/diskLaunchd.test.ts: line 112 (bootstrap only after print fails), line 125 (never goes away: still loaded error, no bootstrap), line 133 (bootstrap retried once), line 104 (not loaded: one print, no sleep). 7 passing on 2026-11-16.
