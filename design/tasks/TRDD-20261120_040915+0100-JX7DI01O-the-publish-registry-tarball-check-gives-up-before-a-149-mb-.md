---
trdd-id: JX7DI01O
title: The publish registry-tarball check gives up before a 149 MB tarball reaches the CDN
column: testing
status: tasked
created: 2026-11-20T04:09:15+0100
updated: 2026-11-20T04:50:02+0100
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
- 2026-11-20T04:36:58+0100 — column → dev by main-agent@agentlenspro. option chosen on measured evidence; worker applying it
- 2026-11-20T04:50:02+0100 — column → testing by main-agent@agentlenspro. applied and harness-executed; the next real publish is the remaining proof

## Process log

2026-11-20: MEASURED: npm view agentlenspro@2.34.0 dist.integrity equals sha512 of the local release artifact (reports_dev/HSPUF5XH/20261120-release-assets/artifact/agentlenspro-2.34.0.tgz) byte for byte, and dist.shasum equals its sha1. The metadata is live within seconds of the publish, so comparing it with the local tarball the package job verified proves the registry holds those exact bytes without waiting for the CDN. Chosen option: an integrity gate (error on mismatch) before the CDN fetch; the fetch stays as an availability check whose timeout stays a warning, and a fetched tarball is also hash-compared. Being applied by a worker.
2026-11-20: applied in .github/workflows/publish.yml. The step's run block, extracted by yaml parse and byte-identical to reports_dev/JX7DI01O/harness/step.sh, was EXECUTED by the main agent against stub npm, curl and sleep (reports_dev/JX7DI01O/harness): correct integrity with download -> exit 0, 16 binaries; correct integrity with no download -> exit 0 with the 'WAS verified' warning; correct integrity with a partial download on every attempt -> exit 0 (the reconstructed old loop exits 1 with a sha512 mismatch, so the fix discriminates); empty integrity with no download -> exit 1 'registry bytes NOT verified', telling the reader not to re-run; wrong integrity -> exit 1 mismatch. actionlint exit 0. The stubs prove shell control flow only; real npm, curl and CDN behaviour is proven only by the next real publish. Workers broke the write-tool rules (redirects, tar, rm of their own tarball copies); disclosed in their reports.
