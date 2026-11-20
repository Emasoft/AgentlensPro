---
trdd-id: 87HO5IFJ
title: Drop the unused MCP SDK runtime dependency and clear the open Dependabot alerts
column: todo
status: tasked
created: 2026-11-20T02:12:15+0100
updated: 2026-11-20T02:12:15+0100
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
---

# Drop the unused MCP SDK runtime dependency and clear the open Dependabot alerts

On 2026-11-20 the push to main reported 56 open Dependabot alerts (3 critical, 17 high, 30 moderate, 6 low). Exposure checked against the 2.34.0 package: (1) Rust crate zip 6.0.0 (alerts 75 critical, 77, 78 high) is a build-dependency of the locked libduckdb-sys 1.10506.0 (its Cargo.toml line 144, [build-dependencies.zip]), so it runs during builds and is not linked into the shipped alcore and alstore binaries. (2) npm: @modelcontextprotocol/sdk ^1.29.0 is a declared runtime dependency (alerts 56, 60, 63, 74) and pulls in proxy-addr (57 critical), body-parser, zod, fast-uri and ip-address (high). The shipped bundle standalone/cli.js requires only @duckdb/node-api, sql.js and Node built-ins, and no shipped source imports any of these packages; the SDK is used only by src/mcpServer.ts, which is not in any bundle. So every user install downloads these vulnerable packages and never loads them. (3) shell-quote (55 critical) and js-yaml (34, 44 high) are development-only. Fix: move @modelcontextprotocol/sdk out of dependencies (devDependencies if a test needs it, else remove), bump the remaining dev packages to their patched versions, update the lockfiles, and confirm the Dependabot list after the push. Acceptance: npm pack --dry-run shows no change in shipped files; the open critical and high alerts on main are zero or each one is recorded with a reason.

## Approval log

- 2026-11-20T02:12:15+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
