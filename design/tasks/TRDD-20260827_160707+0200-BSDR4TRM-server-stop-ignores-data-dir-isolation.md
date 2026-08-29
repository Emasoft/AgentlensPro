---
trdd-id: BSDR4TRM
title: server stop from an isolated DATA_DIR stopped the LIVE server
column: complete
created: 2026-08-27T16:07:07+0200
updated: 2026-08-29T15:30:00+0200
implementation-commits: [2853862, a38c959, ba345e9]
last-test-result: pass
last-test-at: 2026-08-27T19:18:00+0200
eht: [99HUNXJS]
current-owner: main
task-type: bugfix
severity: HIGH
priority: 2
labels: [server, lifecycle, isolation]
relevant-rules: []
created-by: TRDD-8VGQK9L9 ai_review live verification
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-27

**Reproduced first-hand at 17:57 on `113d24a` and the CAUSE is now VERIFIED — it is not what the
Observation below says.** Scratch env exactly as the recipe (`AGENTLENS_DATA_DIR=DATA_DIR=HOME=
<scratch>`, ports 39001–3, `AGENTLENS_MCP_URL=:39002`, brake armed): `server start` spawned child
61378, which bound :39002 and logged `started-by=server start brake=PRESENT data=<scratch>`, and the
brake was cleared — yet the CLI printed `pid 92105 — an already-running server won the
single-instance race`, and `server status` in the same env printed the live server. Live pidfile
unchanged before/after; the child was ended with a direct `kill -TERM`. `stop` was NOT run.

**Mechanism (`file:line`):** `findServerPid()` (`src/cli/serverControl.ts:378`) asks
`/api/server-stats` FIRST, and `apiRequest` resolves that REST route through `uiBaseUrl()` =
`AGENTLENS_UI_URL || http://localhost:3000` (`src/cli/cliCore.ts:30`). The isolation recipe sets the
server-side `UI_PORT` but nothing sets the client-side `AGENTLENS_UI_URL`, so the first lookup hits
the LIVE server on :3000, which reports its own `process.pid`, and the data-dir-keyed pidfile is
never consulted. Not "a data-dir-blind port lookup" — an env split between what the server binds
(`UI_PORT`) and what the CLI dials (`AGENTLENS_UI_URL`). `stopServer()` (`:406`) inherits it.

**IMPLEMENTED 18:07 (fable-advisor consulted; its four file:line claims re-read before acting):**

| component | state |
|---|---|
| `cliCore.ts::mcpEndpoint/uiBaseUrl/dashboardUrl` | defaults derive from `MCP_PORT`/`UI_PORT` — the SAME vars the server binds; explicit `AGENTLENS_*_URL` still wins. Fixes every REST caller, not just the pid lookup |
| `serverControl.ts::findServerPid()` | lock FIRST, judged by the server's own `lockTakeoverVerdict` (a recycled pid is not the server); REST fallback accepted only when `stats.dataDir` resolves equal to `dataDir()`; `lsof` rung deleted (a port never says whose data dir) |
| `stopServer()` | unchanged — inherits the resolver |
| `src/test/serverSingleInstance.test.ts` | 4th test: two real servers, CLI in-process with UI/MCP pointed at A while asking about B → B's pid; B's lock removed → null (never A); `stopServer()` ends B, A alive. Mutation-verified: disabling the lock rung fails exactly this test |
| bare command | `agentlenspro server start/status/stop` in the isolated recipe: child pid reported, child stopped, live pidfile identical before/after |

**Gates on `2853862`:** `pnpm run compile` exit 0 (both tsconfigs, mirrors 121/0, pricing,
identities, guards, platform pins, esbuild); full mocha **2489 passing / 8 pending / exit 0**.
Review-fork (adversarial) found no code defect.

**ROUND 1: PASS with findings** (`reports/code-review/20260827_182432+0200-trdd-BSDR4TRM-ai-review-round1.md`).
All addressed in `a38c959`; full suite **2492 passing / 8 pending / exit 0**, `pnpm run compile` 0.

| finding | disposition |
|---|---|
| IMPORTANT-1 — reverting `defaultUiUrl()` left the suite GREEN (surviving mutation M4) | `src/test/cliCoreUrls.test.ts`, 3 asserts; that revert now fails it |
| IMPORTANT-2 — `server status` reported a FOREIGN server for this data dir | three-state verdict (ours / foreign / unknown). Unknown is NOT collapsed into ours: reaching that line proves only that a port answered |
| MINOR-1 — stop resolved by data dir, confirmed by PORT | confirms with the same resolver; the timeout message now names process death, since a large flush can legitimately outlast 10 s |
| MINOR-3 — a malformed port env threw `Invalid URL` / `8080/evil` injected a path | reused the validator that already existed inside `alcoreServeArgs` → `cliCore.envPort`, one definition |
| NIT-1/-2/-3 | stale prose; the test now clears an inherited `AGENTLENS_DATA_DIR` BEFORE spawning |
| MINOR-2, MINOR-4 | accepted limits, below |

Defect I introduced and the review fork caught: `path.resolve(undefined)` THROWS, so the first
cut of the IMPORTANT-2 guard crashed `server status` against a server that omits `dataDir` —
breaking the very fallback known-limit 1 cites. `ServerStats.dataDir` is now `?: string`, because
declaring it required made tsc bless the throwing call.

**ROUND 2: PASS with findings** (`reports/code-review/20260827_185610+0200-trdd-BSDR4TRM-ai-review-round2.md`).
All 8 round-1 findings verified fixed or explicitly accepted; both required mutations KILLED. Four
new findings, addressed in `ba345e9`; clean full suite **2494 passing / 8 pending / exit 0**.

| finding | disposition |
|---|---|
| NEW-1 — the foreign line asserted "Nothing serves this data dir." on PORT evidence, which `findServerPid()` could contradict in the same process | states only the measured half, then asks the resolver: names the lock owner, or says nothing holds the lock |
| NEW-2 — the three-state verdict and the stop-confirmation had ZERO tests (reverting either left the suite green) | extracted `statsOwnership()`; 3 asserts; mutation `unknown→ours` KILLED |
| NEW-3 — a foreign server's 8 stat lines printed unlabelled under our data dir | non-`ours` stops after the headline + lock owner + `data:` |
| NEW-4 — server (`parseInt`) / setup (`Number`) / CLI (`envPort`) parse ports by three rules | **NOT fixed here** → [[TRDD-99HUNXJS]]. It changes server+setup behaviour, and `alcoreServeArgs`'s own comment already says it belongs in its own diff; refuse-vs-fallback must be decided first |

A 1-failure full run preceded the clean one: a 10 s mocha timeout in
`cacheBreakTimeline` under concurrent load (the reviewer's own suites). That file is 67/67 in 55 s
alone. The first isolation attempt was itself invalid — `--no-config` drops `.mocharc.cjs`'s
`timeout: 10000` for mocha's 2 s default, which manufactured a second "failure"; pass
`--timeout 10000` when running one file.

**ROUND 3: PASS** (`reports/code-review/20260827_193309+0200-trdd-BSDR4TRM-ai-review-round3.md`).
NEW-1 and NEW-3 fixed and verified live on the same recipe; NEW-4's deferral legitimate and the
tree not worse. NEW-2 was only PARTIAL — two residuals, both now closed:

| residual | fix |
|---|---|
| R3-2 — the normalisation assert was a TAUTOLOGY: `path.join` already normalises, so dropping both `path.resolve` calls in `statsOwnership` still passed | the input is now built by CONCATENATION (`mine + '/sub/../'`), which only `path.resolve` collapses. Mutation `reported === mine` → **KILLED** |
| R3-3 — reverting `stopServer`'s confirmation to `init()` still passed the whole suite | new test: a FOREIGN server answers the port while B is the stop target, so the old port-based confirmation times out where the data-dir-keyed one succeeds. Mutation → **KILLED** |

Both mutations were re-run independently by main before accepting the worker's report; `out/`
restored byte-identical after each.

**NEXT ACTION:** ai_review round 4 on the residual-closing commit.

**Known limits, accepted:** (1) a server predating both the pidfile and the `dataDir` stats field
is invisible to the CLI (`stop` prints "already stopped") — both landed in `82d3776` (2026-07-10,
verified by `git log -S`), so it is ONE condition, not two; `status` now says it cannot confirm
ownership instead of implying it. (2) The REST rung compares `path.resolve`, not realpath — a
genuine owner is missed only when its lock is ALSO missing AND the operator spelled the data dir
differently (a symlink) than the server received it: a double fault, same env string in every
real recipe. (3) `legacy-kill0-only` (a bare-numeric lock, or no `ps`) plus a recycled pid can
still name a stranger — a double fault, and strictly better than the pre-fix bare `kill(pid,0)`.

## Observation (measured 2026-08-27, during TRDD-8VGQK9L9 round-2 verification)

Env: `AGENTLENS_DATA_DIR=DATA_DIR=HOME=<scratch>`, `UI_PORT=39001 MCP_PORT=39002 OTLP_PORT=39003`,
`AGENTLENS_MCP_URL=http://127.0.0.1:39002/mcp`, NO_REVIVE armed in the scratch dir.

1. `node standalone/cli.js server start` → exit 0, brake cleared (the C1 fix works). The CLI
   printed "an already-running server won the single-instance race (pid 16838)" — the LIVE server on
   the DEFAULT data dir. **That verdict was FALSE**: the child (pid 92016) was still running 2 min
   later, bound to :39001/:39002/:39003 with `data=<scratch>` (its own server.log shows it
   ingesting). The guard did its job; the PARENT misreported, because `findServerPid()`
   (`serverControl.ts:377`) resolves a server by process/port lookup that is data-dir-blind and so
   found the live pid instead of the child it had just spawned. Its `raceWinnerPid()`/`startupVerdict`
   logic then declared a lost race that never happened.
2. `node standalone/cli.js server stop` in the same env → "FAIL: server (pid 16838) did not stop
   within 10s". `stopServer()` (`:398`) uses the same `findServerPid()`, so it SIGTERMed the LIVE
   server (established: the message names the pid). Inferred, not read from an exit reason: the
   graceful flush of a 1.8 GB process exceeded the CLI's 10 s wait, 16838 exited, and a hook revived
   it as 92105 (`started-by=hook-revive` in ~/.agentlens/server.log, born ≈ the stop). Other spawns
   that day (a killSwitch test at 15:58, the round-1 reviewer's `server start`) predate 16838's
   successor by ~20 min and are ruled out on timing only.
3. The scratch child was stopped by `kill -TERM 92016` directly — the CLI could not have.

Round-1 review of 8VGQK9L9 had already flagged `stopServer()` (`serverControl.ts:398-410`)
resolving its target by port/name rather than data dir, as pre-existing and out of that card's scope.

## Why it matters

The documented isolation recipe ("give it its own DATA_DIR and HOME") is what every test and every
scratch verification relies on. If `start` loses the race to a foreign data dir and `stop` kills a
foreign server, isolation is a claim, not a property — and a unit/live check can take down the
developer's real collector (it did).

## Acceptance

- [x] `findServerPid()` resolves the server of the data dir it is invoked for (the `server.pid`
      lock the guard writes is already keyed on DATA_DIR — read it FIRST, never fall through to a
      port/name lookup that can return a foreign server). — lock first; lsof rung removed.
- [x] `stopServer()` resolves its target from the SAME data dir it was invoked for; refuses to
      signal a pid whose data dir differs (verify via the boot-provenance line / lock file owner).
      — via the resolver: a REST pid is accepted only on a `dataDir` match.
- [x] A test: two data dirs, two servers, `stop` in one never touches the other.
      — `serverSingleInstance.test.ts`, mutation-verified.
- [x] Re-run the exact recipe above; expect: child stays up on :39002, brake cleared, `stop` stops
      ONLY it, live server pid unchanged. — measured 18:07 through the bare `agentlenspro`.

## Not in scope

The brake semantics (8VGQK9L9). The port-isolation caveat in CLAUDE.md is correct as far as it goes;
this card is about the guard/stop not honouring the data-dir key it documents.

## Approval log

- 2026-08-29T15:30:00+0200 — COMPLETE. Independent verification pass: all 4 acceptance boxes MET,
  7/7 targeted tests pass. The load-bearing claim was re-checked BY HAND rather than accepted from
  the verifying agent: `findServerPid()` (`src/cli/serverControl.ts:410-424`) reads the
  data-dir-keyed pidfile FIRST (`:416`) and returns its pid only after `lockTakeoverVerdict`
  confirms a live owner; the REST probe is the fallback (`:426`). That is exactly the inversion the
  bug required. Evidence: `reports/lean-worker-bsdr4trm-verify/20260829_152747+0200-verify.md`.
  Closed by the project session under the USER's explicit 2026-08-29 delegation ("complete all
  pending tasks and TRDDs, decide by yourself, base your decisions on verified facts and tests").
