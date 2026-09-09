---
trdd-id: YGEV6QDD
title: The hot-path latency test revives a real alcore daemon on the canonical ports and never stops it
column: dev
created: 2026-09-08T22:41:51+0200
updated: 2026-09-09T12:06:43+0200
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

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-09 12:06

Root cause, verified: `runSetup()`'s `hooks`/`final-test` steps exec the registered hook via
`execRegisteredCommand` (`src/cli/setup.ts:285-311`), which spreads `process.env` (`:287`) and
pins HOME/AGENTLENS_DATA_DIR/AGENTLENS_UI_URL but NOT UI_PORT/MCP_PORT/OTLP_PORT. On a failed
POST the hook's `reviveDaemonDetached()` (`src/cli/hookHandlers.ts:138-232`, brake at `:166`)
spawns `alcore serve` with `alcoreServeArgs()` reading ports from env → DEFAULT ports
3000/4316/4318 with the FIXTURE's `--data-dir`. Measured leak: pid 68584 (`al-setup-OYnBpx`),
started 22:43 during a full mocha run, still the only listener on 3000 at 11:32 on 2026-09-09,
holding ~100 MB of REAL diverted capture (tracked for recovery in TRDD-81BW1CS9). This test
file's own `baseEnv()` had the same hole (no NO_REVIVE) — pid 850 (`al-lat-wUTURr`, 123 MB) was
an earlier squatter, origin unknown.

Fix on disk (uncommitted; per-suite brake + `src/test/helpers/noSurvivingServer.ts` landed by
the finalization worker, types/eslint/compile 0): `AGENTLENS_NO_REVIVE: '1'` added to the env in
this test file + `src/test/setupVerb.test.ts`, plus a ps-snapshot tripwire
`assertNoSurvivingServer`.

Adversarial review (2026-09-09) accepted the brake and found:
- the root-level `suiteSetup` brake in `setupVerb.test.ts` was RUN-scoped not file-scoped —
  being fixed: convert to a per-suite brake + shared helper (worker in flight).
- the tripwire only fails when the POST race actually fires — it is not a regression test of
  the brake itself, only a symptom detector.
- the product-side recommendation to add NO_REVIVE inside `execRegisteredCommand` was
  REJECTED — on a real HOME a revive from the self-test is a working collector; the real
  defect is the missing port pins (a real setup with custom ports would still revive on
  default ports). That is a separate follow-up, not this card.

Coordinator's acceptance re-run 2026-09-08 23:00: 15 passing / 8 failing, every failure
`spawnSync /bin/sh ETIMEDOUT` in the `hooks` step at load 20–37; the worker's own idle run was
23/23. Load is the INFERRED cause of the timeouts; a re-run on an idle machine is still
pending.
- review 3 (2026-09-09) asked whether the "server probe distinguishes DOWN from UNRESPONSIVE"
  suite (`setupVerb.test.ts:394`) needs the brake: VERIFIED no — it calls `runSetup` only with
  `dryRun: true` (:413/:431/:444/:461) and both `execRegisteredCommand` sites sit behind
  `if (ctx.dryRun) return` (`src/cli/setup.ts:567`, `:967`). `brakeReviveForThisSuite()` is the
  first line of the other four suites (:135, :242, :314, :365).

NEXT ACTION: scoped mocha on an idle machine (load < 8; 19.5 at 12:01), then commit the three
test files by name; pid 68584 is stopped only inside the 5JZQFVO8 deploy after the
TRDD-81BW1CS9 decision.

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

