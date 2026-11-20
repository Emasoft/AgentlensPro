---
trdd-id: 87HO5IFJ
title: Drop the unused MCP SDK runtime dependency and clear the open Dependabot alerts
column: dev
status: tasked
created: 2026-11-20T02:12:15+0100
updated: 2026-11-20T05:28:29+0100
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
approval-datetime: 2026-11-20T02:12:15+0100
implementation-commits: [7d5fde63, 773883b2]
---

# Drop the unused MCP SDK runtime dependency and clear the open Dependabot alerts

On 2026-11-20 the push to main reported 56 open Dependabot alerts (3 critical, 17 high, 30 moderate, 6 low). Exposure checked against the 2.34.0 package: (1) Rust crate zip 6.0.0 (alerts 75 critical, 77, 78 high) is a build-dependency of the locked libduckdb-sys 1.10506.0 (its Cargo.toml line 144, [build-dependencies.zip]), so it runs during builds and is not linked into the shipped alcore and alstore binaries. (2) npm: @modelcontextprotocol/sdk ^1.29.0 is a declared runtime dependency (alerts 56, 60, 63, 74) and pulls in proxy-addr (57 critical), body-parser, zod, fast-uri and ip-address (high). The shipped bundle standalone/cli.js requires only @duckdb/node-api, sql.js and Node built-ins, and no shipped source imports any of these packages; the SDK is used only by src/mcpServer.ts, which is not in any bundle. So every user install downloads these vulnerable packages and never loads them. (3) shell-quote (55 critical) and js-yaml (34, 44 high) are development-only. Fix: move @modelcontextprotocol/sdk out of dependencies (devDependencies if a test needs it, else remove), bump the remaining dev packages to their patched versions, update the lockfiles, and confirm the Dependabot list after the push. Acceptance: npm pack --dry-run shows no change in shipped files; the open critical and high alerts on main are zero or each one is recorded with a reason.

## Approval log

- 2026-11-20T02:12:15+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-20T05:28:29+0100 — column → dev by main-agent@agentlenspro. implemented on branch fix/deps-87ho5ifj (7d5fde63, 773883b2); awaiting push and CI

## Process log

2026-11-20 step 1 (uncommitted in the working tree, worker report reports_dev/87HO5IFJ/20261120_023707+0100-sdk-devdep.md): @modelcontextprotocol/sdk moved to devDependencies at ^1.32.2 (resolved 1.32.2). Lockfile versions now at or above the patched version: proxy-addr 2.0.8 (alert 57, critical), fast-uri 3.1.9 (29, 35, 36, 38, 39, 47), ip-address 10.7.6 (30), body-parser 2.4.0 (66), the SDK 1.32.2 (56, 60, 63, 74). Still vulnerable: zod resolved to 3.25.76 (was 4.4.3); GHSA-mrhx-c7xc-m3w5 covers zod < 4.6.6, so alert 70 stays open, now in development scope only; js-yaml 4.3.0 (alert 44 needs 4.3.2) and shell-quote 1.9.0 (alert 55 needs 1.11.0) are development-only and still open. The lockfile also bumped express 5.3.0, hono 4.13, content-disposition 2, jose and qs; only tsc covers them so far, and the 15 test files that reference mcpServer or the SDK are being run one at a time.
2026-11-20: SDK move committed as 376dd76f on branch fix/drop-mcp-sdk-runtime-dep (not merged; goes in the release after 2.34.0). Still open: zod 3.25.76 below 4.6.6, js-yaml and shell-quote dev bumps, CHANGELOG entry.
2026-11-20: the lockfile diff also adds a supports-color@8.1.1 peer context to express, express-rate-limit, body-parser, router, send and finalhandler. Inferred side effect of pnpm re-resolving the SDK's peer graph after its zod moved to 4.6.7; no package version changed in those entries (debug was already 4.4.3(supports-color@8.1.1)).
2026-11-20: branch fix/deps-87ho5ifj (worktree builds_dev/wt-deps-87ho5ifj, based on main 6934e941) carries 7d5fde63 (SDK to devDependencies) and 773883b2 (overrides: shell-quote >=1.11.0, js-yaml >=4.3.2 <5, SDK-scoped zod >=4.6.6 <5; CHANGELOG [Unreleased]). The CHANGELOG line was checked byte-exact against the reviewed text plus the appended fix-route sentence. Open: zod 3.25.76 under chromium-bidi 16.0.1, split to TRDD-4G1TZBSW. Not pushed yet: waiting for PR #30 to merge so the deps PR diff carries only these two commits. Then: push, PR, CI, merge, re-read the Dependabot list (acceptance).
