---
trdd-id: JX7DI01O
title: The publish registry-tarball check gives up before a 149 MB tarball reaches the CDN
column: todo
status: tasked
created: 2026-11-20T04:09:15+0100
updated: 2026-11-20T04:09:15+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: infra
min-approval-requirement: none
scope: project
project-id: agentlenspro
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-20T04:09:15+0100
---

# The publish registry-tarball check gives up before a 149 MB tarball reaches the CDN

Publish run 44657500944 (2.34.0): the publish-npm step Verify the REGISTRY tarball retried 30 x 20 s, then took its warning path because the tarball was still not fetchable after 10 min; the step exits 0 by design (TRDD-IXMB2JVD). The tarball was fetchable later (HTTP 200, 148959179 bytes). Effect: CI reports green while the registry tarball was never checked, so the step verifies nothing on a release of this size. Options to compare: verify through the npm registry API instead of the CDN edge, run the check from a later job or a scheduled follow-up, or record the unverified state where a human sees it. Not a blocker: the release was verified by hand.

## Approval log

- 2026-11-20T04:09:15+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
