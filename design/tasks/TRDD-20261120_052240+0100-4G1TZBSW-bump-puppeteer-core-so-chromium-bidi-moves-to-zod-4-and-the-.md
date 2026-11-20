---
trdd-id: 4G1TZBSW
title: Bump puppeteer-core so chromium-bidi moves to zod 4 and the last zod alert closes
column: approval
status: tasked
created: 2026-11-20T05:22:40+0100
updated: 2026-11-20T05:45:41+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: security
min-approval-requirement: user
scope: project
project-id: agentlenspro
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: false
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-20T05:22:40+0100
unblock-when: [decision: owner chooses between a chromium-bidi trustPolicyExclude and dismissing the dev-only alert or waiting for provenance]
labels: []
pre-block-column: dev
---

# Bump puppeteer-core so chromium-bidi moves to zod 4 and the last zod alert closes

## Approval log

- 2026-11-20T05:22:40+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-20T05:29:40+0100 — column → dev by main-agent@agentlenspro. worker dispatched on branch fix/deps-87ho5ifj for the puppeteer-core 25.17.0 bump
- 2026-11-20T05:40:26+0100 — column → blocked by main-agent@agentlenspro. zod-4 chromium-bidi has no trusted-publisher evidence; bump needs an owner decision on trustPolicyExclude (fleet-ask)
- 2026-11-20T05:44:26+0100 — column → approval by main-agent@agentlenspro. the only route that clears the alert weakens pnpm's trust policy; the owner (min-approval-requirement user) picks one of three options

## Problem

Dependabot alert GHSA-mrhx-c7xc-m3w5 (zod < 4.6.6, zod 3.x has no patch) stays open for zod 3.25.76 under chromium-bidi 16.0.1, pulled by puppeteer-core 25.3.0 (dev only, used by the browser smoke test). Follow-up of TRDD-87HO5IFJ, which moved only the MCP SDK's zod to 4, because a global zod override breaks chromium-bidi 16.0.1: its parse-failure path reads zod 3's error.errors, and on zod 4.6.7 parseCloseParams({}) throws TypeError 'reading map' (measured by the 87HO5IFJ worker, report reports_dev/87HO5IFJ/20261120_051222+0100-dev-dep-bumps.md).
Fix route, checked with npm view on 2026-11-20: puppeteer-core@latest is 25.18.1 and depends on chromium-bidi 157.0.8090-0, whose dependencies declare zod ^4.6.5. So bumping puppeteer-core to 25.18.1 moves chromium-bidi to zod 4 and the alert can close. Not yet checked: the release-age gate (minimum-release-age in .npmrc) for 25.18.1, and whether puppeteer-core 25.18.1 changes any API the browser smoke test uses.
SUPERSEDED 2026-11-20: the 25.18.1 target above is replaced by 25.17.0 (release-age gate, see Process log), and the bump is now blocked by pnpm's trust policy (see Process log). The release-age unit (minutes, 7200 = 5 days) is pnpm's documented convention for minimumReleaseAge, taken from pnpm's docs, not checked in this session; npm itself does not enforce it (it warns 'Unknown project config minimum-release-age').

## Acceptance

- [ ] puppeteer-core bumped to a version whose chromium-bidi declares zod >=4.6.6; pnpm-lock.yaml has no zod 3.x left (or each remaining zod 3.x is named with its reason).
- [ ] The '@modelcontextprotocol/sdk>zod' scoped override in pnpm-workspace.yaml is replaced by a plain zod override or removed, and its comment updated.
- [ ] The browser smoke test file passes once, run singly under scripts/test-data-cap.sh (needs Chrome and an alcore binary; it starts its own isolated alcore with its own DATA_DIR, never the live server).
- [ ] CHANGELOG [Unreleased] entry names the bump and the closed alert.

## Corrections

2026-11-20: commit 03ec0028's message says a global zod override 'would break the browser smoke test'. That is INFERRED, not measured: the only measurement is parseCloseParams({}) throwing a TypeError on zod 4.6.7 (87HO5IFJ worker report). Nobody checked whether dashboardSmoke.test.ts reaches that parse-failure path.
2026-11-20: source of 'puppeteer-core 25.3.0': pnpm-lock.yaml in the fix/deps-87ho5ifj worktree, lines 1427 (puppeteer-core@25.3.0) and 3232 (its chromium-bidi: 16.0.1). npm view also shows chromium-bidi 159.0.8128-2 (first 159.x) declares zod ^4.6.5, so the 87HO5IFJ comment 'chromium-bidi 159.x does' was accurate; 157.0.8090-0 is only the earliest version that puppeteer-core latest pulls in.

## Process log

2026-11-20: target is puppeteer-core 25.17.0, not 25.18.1. The repo's minimumReleaseAge is 7200 minutes (.npmrc line 6, pnpm-workspace.yaml line 9); 25.18.1 was published 2026-11-17T16:28Z and is under 5 days old, so the gate would refuse it. 25.17.0 (2026-11-10) also depends on chromium-bidi 157.0.8090-0 (published 2026-10-07), whose zod is ^4.6.5 (npm view). Worker dispatched on the same branch fix/deps-87ho5ifj; it replaces the SDK-scoped zod override with a plain one and runs the browser smoke test file once.
2026-11-20 BLOCKED on an owner decision. pnpm install --ignore-scripts with puppeteer-core ^25.17.0 failed: ERR_PNPM_TRUST_DOWNGRADE for chromium-bidi@157.0.8090-0 (trustPolicy no-downgrade: earlier versions had a trusted publisher, this one has none). The worker queried all 194 chromium-bidi versions published since 2026-05-12 (_npmUser, provenance, dependencies.zod): 3 (16.0.1, 17.0.1, 17.0.2) are published by GitHub Actions with SLSA provenance and declare zod ^3.24.1; 2 (157.0.8080-0, 157.0.8081-0) are published by the chrome-devtools-npm account without provenance and declare zod ^3.24.1; 189 (157.0.8082-0 .. 159.0.8154-29) are published by chrome-devtools-npm without provenance and declare zod ^4.6.5. So no chromium-bidi version has both zod 4 and trusted-publisher evidence. Reports: reports_dev/4G1TZBSW/20261120_053228+0100-puppeteer-bump.md and its two addenda.
2026-11-20: the only route that clears the zod alert is an exclude entry for chromium-bidi in trustPolicyExclude (pnpm-workspace.yaml), which weakens a supply-chain gate: an UNREVIEWED trust downgrade (no tarball, source or provenance comparison done), so it is the owner's decision. Options for the owner: (a) exclude chromium-bidi 157.0.8090-0 (dev only, used by the browser smoke test) and take zod 4 everywhere; (b) keep zod 3.25.76 flagged under chromium-bidi 16.0.1 (dev only, never shipped) and dismiss the alert with that reason; (c) wait for chromium-bidi to publish with provenance again. The worker's edits (package.json ^25.17.0, plain zod override) are kept in git stash 'TRDD-4G1TZBSW blocked: ...' of the worktree builds_dev/wt-deps-87ho5ifj; the worktree is back at 773883b2 and pnpm install --frozen-lockfile reports 'Already up to date'.
2026-11-20: notes on the block. (1) The fleet-ask label was added only because 3P-KAN-06 refuses a move to blocked without blocked-by or a park form; this card waits on an owner decision, not on another card, and no card in this corpus used the label before; its exact ai-maestro meaning was not checked. (2) The stash does NOT hold option 1 ready to apply: it holds puppeteer-core ^25.17.0 and the plain zod override, without any trustPolicyExclude entry. (3) The 189-of-194 count is from the worker's scan of chromium-bidi versions published since 2026-05-12 (raw list in the worker's scratchpad, not read by the main agent); pnpm's ERR_PNPM_TRUST_DOWNGRADE was observed only for 157.0.8090-0, and refusal of the others is inferred from the policy.
2026-11-20: moved from blocked to approval. lint refused blocked without blocked-by (BLOCKED-WITHOUT-BLOCKER), and 'approval' is the column for a card waiting on the approver named by min-approval-requirement (now: user), which is what this card waits on. The fleet-ask label was removed. unblock-when stays as a record of the decision being asked.
2026-11-20: approved and mandate set to false. trddgrep new had stamped approved: true and mandate: true by 'none', which lint reports as MANDATE-FORGED once the floor is user; nobody with user rank has approved this card.
2026-11-20: lint still reports MANDATE-FORGED on this card. trddgrep refuses both 'set mandate false' and a guarded edit ('mandate: is written only by the create/approve code paths'), and 'fix' finds nothing to repair. The stamp came from 'trddgrep new' (mandate: true, mandated-by: none); it is a tool limitation, not an approval. approved is now false.
