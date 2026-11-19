---
trdd-id: 6MG5N1ZF
title: The Docker image still copies and runs the retired standalone server bundle
column: testing
status: tasked
created: 2026-11-19T01:23:56+0100
updated: 2026-11-19T01:57:44+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T01:23:56+0100
---

# The Docker image still copies and runs the retired standalone server bundle

Split out of TRDD-YL3EWT6N (its OPEN item "the Dockerfile repair") on 2026-11-19 as a release blocker of TRDD-HSPUF5XH. Facts (harness measure 2026-11-19): .github/workflows/docker.yml runs on every v* tag push (lines 3-6); Dockerfile line 39 copies /app/standalone/server.js and line 65 runs `node standalone/server.js`; git ls-files lists neither standalone/server.js nor standalone/server.ts (the TypeScript server was retired in 567fc5c2). That the image build fails or ships a broken image is INFERRED; the build was not run. HSPUF5XH line 211 also names a missing target-platform alcore build, media/index.html and sidebar.js in the image.

## Acceptance
- [ ] The Dockerfile builds and starts alcore (the only server) for the image platform, with the dashboard assets it serves.
- [ ] A local `docker build` of the release tree succeeds, and the container answers on its UI and OTLP ports (or the reason a local build cannot run here is recorded and CI docker.yml is run by workflow_dispatch instead).
- 2026-11-19T01:37:23+0100 main agent notes: (1) The local check (W74) builds linux/arm64 natively while docker.yml will ship linux/amd64 only, so the amd64 image (TARGETARCH amd64, bin-native/linux-x64) is UNVERIFIED until docker.yml runs; run it by workflow_dispatch before the tag. (2) Why not stage the prebuilt bin-native binaries of publish.yml (named by two harness reviews of W72): docker.yml is a separate workflow started by the same tag, and a workflow run cannot download another run's artifacts without a cross-run artifact lookup that neither workflow has; compiling in the image keeps docker.yml self-contained. (3) The docs gate owes one CHANGELOG/README line: the image is linux/amd64 only until TRDD-6J96UCTJ. (4) The user rule github.md asks to update outdated action versions in a touched workflow: the action pins of docker.yml are to be checked (gh api releases/latest per action, then pinact) before this card closes.

## Approval log

- 2026-11-19T01:23:56+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T01:51:16+0100 — column → dev by main-agent@agentlenspro. Dockerfile, .dockerignore and docker.yml written by W72, W74, W76, W77 and verified by the main agent
- 2026-11-19T01:51:16+0100 — column → testing by main-agent@agentlenspro. box 2 waits on an OTLP probe and the docker.yml workflow_dispatch run before the tag

## Notes and lessons learned

2026-11-19 correction: the earlier reason (a run cannot download the artifacts of another run) is wrong; actions/download-artifact v4 accepts run-id and github-token. The real obstacle is order: docker.yml and publish.yml start on the same tag at the same time, so the publish.yml binaries may not exist yet when docker.yml needs them, and waiting on publish.yml needs a workflow_run trigger, a larger change than compiling alcore in the image.
2026-11-19 verified by the main agent reading actions/download-artifact action.yml at ref v4: the inputs run-id and github-token exist (github-token is required for a download from a different workflow run). Waiting on publish.yml could use a workflow_run trigger, or a manual workflow_dispatch after publish.yml finishes with its run id passed as a new input; either way docker.yml gains a download step plus a trigger or an input, so compiling alcore in the image stays the choice for this release.
2026-11-19 box 1 met on linux/arm64: W74 built the image natively (exit 0, 461 s; cargo 439.5 s) and the container started alcore, healthy, with HTTP 200 on the UI root at 25 s, and stopped with exit code 0 (report reports_dev/cheap-worker/20261119_w74-docker/report.md and its exitcode.txt, read by the main agent). Box 2 stays open: the OTLP port was mapped and alcore logged OTLP listening, but no request was sent to it, and the amd64 image (the only platform docker.yml now ships) is unbuilt until docker.yml runs by workflow_dispatch before the tag. Note (4) done: five action pins updated to the commits of their latest releases, resolved by the main agent with gh api releases/latest and gh api commits/TAG (checkout v7.0.1, setup-qemu v4.4.0, setup-buildx v4.4.1, login v4.8.0, build-push v7.4.0); metadata-action v6.2.0 was already the latest. The setup-qemu step is unused by an amd64-only build and is kept for TRDD-6J96UCTJ. W74 removed its own smoke container w74 under step 5b of the main agent prompt, which conflicted with the no-delete rule (an error in the main agent prompt); image agentlenspro:w74 (426 MB) is left on the host for the owner.
2026-11-19 correction (harness review): box 1 is unticked again. The W74 evidence holds for linux/arm64 and for the UI root page only (one HTTP 200 on /, no dashboard bundle requested), while docker.yml now ships linux/amd64 alone. Box 1 is ticked only after the amd64 image is shown to start and serve the dashboard bundles.
2026-11-19 run history, read by the main agent with gh run list: docker.yml succeeded on every tag from v2.29.0 to v2.33.1, and neither v2.33.0 nor v2.33.1 contains 567fc5c2 (git merge-base), so those images still carried the TypeScript server. The commit message of 30c7a54a says every v* tag pushed an image that could not start; that is wrong. The break applies only to the next tag cut from the current tree, and even that is INFERRED: the old Dockerfile was not built on it.
2026-11-19 decision on box 2, owner may veto: no workflow_dispatch run before the tag. A dispatch run pushes ghcr.io/emasoft/agentlenspro:sha-SHORTSHA (the type=sha rule of docker.yml), a public image of an unreleased commit, and needs the branch pushed; push is lifted for the release only. A local amd64 build is not run because it compiles alcore under QEMU on this host, far heavier than the 461 s native arm64 build. So the amd64 check is the docker.yml run of the release tag: a red run publishes no image, and publish.yml (npm) does not wait on docker.yml. Box 2 stays open until that run is green, plus one OTLP request to a container of the published image; both are post-release checks of TRDD-HSPUF5XH.
2026-11-19 the five pin bumps are minor or patch releases; compatibility rests on semver only, their release notes were not read, and pinact was not run (the SHAs were resolved with gh api). The move todo to dev to testing passed through dev in one step: the work was done by workers before the card moved.
2026-11-19 limit of the box 2 decision (harness review): docker.yml fails only when the build fails. An amd64 image that builds but does not start (a runtime library missing on amd64, for example) is still pushed as latest and as the semver tags. Post-release check added for TRDD-HSPUF5XH: pull ghcr.io/emasoft/agentlenspro at the release version for linux/amd64, start it with its own ports, and probe the UI root, one dashboard bundle and one OTLP request; if it fails, move latest back or yank the tags and reopen this card.
