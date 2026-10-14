---
trdd-id: TYOQA14F
title: setup checks the revive brake and kill-switch in the process-env data dir, and its environment probe accepts any server on the UI port
column: todo
status: tasked
created: 2026-10-14T22:22:03+0200
updated: 2026-10-14T22:22:48+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-14T22:22:03+0200
---

# setup checks the revive brake and kill-switch in the process-env data dir, and its environment probe accepts any server on the UI port

## Approval log

- 2026-10-14T22:22:03+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Findings (2026-10-14)

Split from TRDD-V2HFI30L, whose core bug (adopting and SIGTERMing a foreign server) is fixed in 973aead7 and 29ec567a.
reviveBraked() and agentlensDisabled() read the process-env data dir, not ctx.dataDir, so a setup run whose data dir comes from options checks the revive brake (the reviveBraked() call in stepServer, src/cli/setup.ts) and the kill-switch (the agentlensDisabled() call in stepServer) in the wrong place.
The UI probe of the environment step (its /api/server-stats httpJson call, src/cli/setup.ts) accepts any 200 response, whatever server answers on the UI port.
The `pre && !preOurs` refusal branch of stepServer in src/cli/setup.ts is untested and reachable only in a race, because the port chooser refuses a foreign port first.
One run of setupOwnership on a pre-973aead7 HEAD failed at an earlier setup step for an unexplained reason. If it recurs in a release-gate run, triage it; do not re-roll.
