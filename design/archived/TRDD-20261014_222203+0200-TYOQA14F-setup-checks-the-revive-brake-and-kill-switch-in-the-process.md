---
trdd-id: TYOQA14F
title: setup checks the revive brake and kill-switch in the process-env data dir, and its environment probe accepts any server on the UI port
column: complete
status: archived
created: 2026-10-14T22:22:03+0200
updated: 2026-10-15T00:15:36+0200
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
implementation-commits: [c24058ce]
---

# setup checks the revive brake and kill-switch in the process-env data dir, and its environment probe accepts any server on the UI port

## Approval log

- 2026-10-14T22:22:03+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
(retroactive) The checklist and the move to complete were made after the work landed and was reviewed (gate review of c24058ce).
- 2026-10-15T00:15:36+0200 — COMPLETE by main-agent@agentlenspro. archived → complete.

## Findings (2026-10-14)

Split from TRDD-V2HFI30L, whose core bug (adopting and SIGTERMing a foreign server) is fixed in 973aead7 and 29ec567a.
reviveBraked() and agentlensDisabled() read the process-env data dir, not ctx.dataDir, so a setup run whose data dir comes from options checks the revive brake (the reviveBraked() call in stepServer, src/cli/setup.ts) and the kill-switch (the agentlensDisabled() call in stepServer) in the wrong place.
The UI probe of the environment step (its /api/server-stats httpJson call, src/cli/setup.ts) accepts any 200 response, whatever server answers on the UI port.
The `pre && !preOurs` refusal branch of stepServer in src/cli/setup.ts is untested and reachable only in a race, because the port chooser refuses a foreign port first.
One run of setupOwnership on a pre-973aead7 HEAD failed at an earlier setup step for an unexplained reason. If it recurs in a release-gate run, triage it; do not re-roll.
reviveBraked() (src/cli/killSwitch.ts) checks only the NO_REVIVE file in the data dir, not the AGENTLENS_NO_REVIVE env that tests set. So a setup run in an empty HOME with free default ports, as on CI, could spawn a detached alcore even though the test meant to brake it (reasoned from killSwitch.ts, not observed). Found in the review of gate run B2.
Resolved in c24058ce: resolveCtx now uses the shared resolver (AGENTLENS_DATA_DIR, then DATA_DIR, then <home>/.agentlens); it had ignored AGENTLENS_DATA_DIR, so setup started servers in ~/.agentlens for users who set it. stepServer reads the kill-switch and the revive brake in ctx.dataDir. The environment-step squatter heuristic uses portHeldByOurs. stepServer's foreign-server branch has a direct test; that branch already existed in 973aead7, so the test covers it rather than regression-testing this commit.
Decision recorded in code: explicit setup honours the NO_REVIVE FILE brake, not the AGENTLENS_NO_REVIVE env, which brakes automatic revives only.
Correction to the reviveBraked/CI line above: since 42017224 no hot-path verb runs the launch self-heal, and the one test that does (cliDispatch test 2) sets the FILE brake and free ports (7c422ae1), so the CI spawn risk described there does not arise from the current suite.
The earlier-step setupOwnership failure seen once on a pre-973aead7 HEAD did not recur: all setupOwnership tests passed in gate runs A1, B1, B2, C1 and C2. Closed as not reproducible.
Release note: users who set only AGENTLENS_DATA_DIR may have a stray server in ~/.agentlens from the old behaviour. After upgrading, setup refuses once, naming it and the exact `AGENTLENS_DATA_DIR='<dir>' agentlenspro server stop` command.

## Acceptance

- [x] setup resolves its data dir with the shared resolver and honours AGENTLENS_DATA_DIR (c24058ce)
- [x] the server step reads the kill-switch and revive brake in ctx.dataDir (c24058ce)
- [x] the environment-step squatter heuristic recognises only our own server (c24058ce)
- [x] stepServer's foreign-server refusal branch has a direct test (c24058ce)
- [x] the unexplained earlier-step failure is triaged: not recurred in 5 gate runs
