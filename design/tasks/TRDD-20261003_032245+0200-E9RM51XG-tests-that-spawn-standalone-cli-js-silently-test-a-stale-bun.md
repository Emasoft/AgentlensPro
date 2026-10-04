---
trdd-id: E9RM51XG
title: Tests that spawn standalone/cli.js silently test a stale bundle
column: backburner
status: tasked
created: 2026-10-03T03:22:45+0200
updated: 2026-10-04T11:58:25+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-03T03:22:45+0200
---

# Tests that spawn standalone/cli.js silently test a stale bundle

The mocha suite compiles src to out/ but some harnesses spawn the esbuild bundle (src/cli/serverControl.ts:1220 resolves standalone/cli.js; src/cli/hookHandlers.ts:328 spawns `server revive`). On 2026-10-03 hookSpool.test.ts 'a live revived child is reaped' failed deterministically because standalone/cli.js (built Oct 1 18:31) predated 78bd6cac, which added the 'revive' verb (error: server expects start|stop|restart|status (got "revive")). Done when: such a test either builds the bundle first or fails fast with "bundle older than source" naming both mtimes.

## Approval log

- 2026-10-03T03:22:45+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
2026-10-04: on a machine where the installed bundle predates the server revive verb, a hook that finds the collector dead cannot revive it (unit test "a live revived child is reaped" fails for that reason; reports/ingest-redesign/20261004_102654+0200-revive-test-failure.md). Remedy is node esbuild.js plus a server restart, which is a deploy and the owner's decision.
