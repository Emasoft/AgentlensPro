---
trdd-id: 4G1TZBSW
title: Bump puppeteer-core to 25.18.1 so chromium-bidi moves to zod 4 and the last zod alert closes
column: backburner
status: tasked
created: 2026-11-20T05:22:40+0100
updated: 2026-11-20T05:23:54+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: security
min-approval-requirement: none
scope: project
project-id: agentlenspro
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-20T05:22:40+0100
---

# Bump puppeteer-core to 25.18.1 so chromium-bidi moves to zod 4 and the last zod alert closes

## Approval log

- 2026-11-20T05:22:40+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Problem

Dependabot alert GHSA-mrhx-c7xc-m3w5 (zod < 4.6.6, zod 3.x has no patch) stays open for zod 3.25.76 under chromium-bidi 16.0.1, pulled by puppeteer-core 25.3.0 (dev only, used by the browser smoke test). Follow-up of TRDD-87HO5IFJ, which moved only the MCP SDK's zod to 4, because a global zod override breaks chromium-bidi 16.0.1: its parse-failure path reads zod 3's error.errors, and on zod 4.6.7 parseCloseParams({}) throws TypeError 'reading map' (measured by the 87HO5IFJ worker, report reports_dev/87HO5IFJ/20261120_051222+0100-dev-dep-bumps.md).
Fix route, checked with npm view on 2026-11-20: puppeteer-core@latest is 25.18.1 and depends on chromium-bidi 157.0.8090-0, whose dependencies declare zod ^4.6.5. So bumping puppeteer-core to 25.18.1 moves chromium-bidi to zod 4 and the alert can close. Not yet checked: the release-age gate (minimum-release-age in .npmrc) for 25.18.1, and whether puppeteer-core 25.18.1 changes any API the browser smoke test uses.

## Acceptance

- [ ] puppeteer-core bumped to a version whose chromium-bidi declares zod >=4.6.6; pnpm-lock.yaml has no zod 3.x left (or each remaining zod 3.x is named with its reason).
- [ ] The '@modelcontextprotocol/sdk>zod' scoped override in pnpm-workspace.yaml is replaced by a plain zod override or removed, and its comment updated.
- [ ] The browser smoke test file passes once, run singly under scripts/test-data-cap.sh (needs Chrome and an alcore binary; it starts its own isolated alcore with its own DATA_DIR, never the live server).
- [ ] CHANGELOG [Unreleased] entry names the bump and the closed alert.
