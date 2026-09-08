---
trdd-id: YGEV6QDD
title: The hot-path latency test revives a real alcore daemon on the canonical ports and never stops it
column: todo
created: 2026-09-08T22:41:51+0200
updated: 2026-09-08T22:41:51+0200
current-owner: main
task-type: bugfix
min-approval-requirement: none
priority: high
severity: high
blocked-by: []
npt: []
eht: []
implementation-commits: []
project-id: agentlenspro
scope: project
labels: [test, ops, server, leak]
relevant-rules: []
---

# The hot-path latency test revives a real alcore daemon on the canonical ports and never stops it

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-08

NEXT ACTION: pin explicit isolated ports for the test's temp HOME, and stop any revived
server (by pidfile) in `finally`. Not yet started.

## Why

`src/test/cliHotPathLatency.test.ts` exercises the CLI hot-path recipes against a temp HOME,
but the `agentlenspro hook` recipe found no server registered for that HOME and revived one
using the DEFAULT canonical ports (4318/3000/4316) instead of isolated ones — so the revived
process collides with, and can be mistaken for, the real canonical instance, and nothing in
the test stops it. Per `~/.claude/rules/plugin-tests-are-the-plugins-job.md`, "every resource
opened during the suite is closed before the suite returns" is the test's job, not the
harness's. Per this repo's CLAUDE.md: "EXACTLY ONE server may own a data directory — and
changing ports does NOT isolate an instance" — an un-ported revive is exactly the scenario the
project's own single-instance guard exists to prevent leaking into.

## Evidence

- `src/test/cliHotPathLatency.test.ts` (~line 139): creates temp HOME `al-lat-*`, runs CLI
  hot-path recipes; one recipe (`agentlenspro hook`) triggers `hookHandlers.ts`'s
  spool+revive path.
- Revived process: `bin-native/darwin-arm64/alcore serve --data-dir <tmp>/.agentlens
  --otlp-port 4318 --ui-port 3000 --mcp-port 4316` — the default canonical ports, detached
  under launchd.
- Measured 2026-09-08: pid 850 started 15:38, still serving at 22:30, phys_footprint 742 MB;
  `/api/server-stats` reported `canonical:true` with the temp data dir; temp dir held 126 MB
  of captured data. Every hook/OTEL capture 15:38–22:38 went there instead of `~/.agentlens`.
- The test's `finally` only does `fs.rmSync` on the temp HOME — it never stops the server it
  caused to spawn.
- Orchestrator SIGTERMed pid 850 at 22:38:29 during an unrelated memory-verification task; the
  leak was discovered only incidentally.

## Acceptance

- [ ] The test pins explicit isolated ports (`MCP_PORT`/`UI_PORT`/`OTLP_PORT`) for its temp HOME
      so any revive cannot bind the canonical ports.
- [ ] The test's `finally` reads `<tmp>/.agentlens/server.pid` (if present) and stops that pid,
      regardless of which recipe caused the revive.
- [ ] A runner-level check confirms the process table after the suite has no `alcore` process
      whose `--data-dir` is under `os.tmpdir()`.
- [ ] `pnpm run test:unit` (or the relevant mocha invocation) passes with the fix in place.

## Approval log

