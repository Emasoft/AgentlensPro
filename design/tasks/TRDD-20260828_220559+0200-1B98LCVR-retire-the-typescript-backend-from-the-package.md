---
trdd-id: 1B98LCVR
title: Retire the TypeScript backend from the package so Rust is the only server that ships
column: testing
created: 2026-08-28T22:05:59+0200
updated: 2026-09-02T01:11:53+0200
current-owner: claude-agentlenspro
task-type: refactor
project-id: agentlenspro
parent-trdd: DMWOBWFH
blocked-by: []
npt: [VHH7FXGC]
implementation-commits: [eec7bb36, 952357e8, 48a154a, d58d6e1, 6c6c7f49, d7684513, 567fc5c2]
---

# Retire the TypeScript backend from the package

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-02

**BOX 4 LANDED AND GATED (2026-09-02).** `standalone/server.ts`, the `src/**` modules only it
imported, the esbuild `server` target and `findServerJs` are gone (`567fc5c2`); every spawn path
is alcore-only. The 2.33.2 gate ran ONCE, on the FINAL binary (the spool-backpressure port
`d1e6e08d` included — `bin-native/darwin-arm64/alcore` sha `d93d698c…` == `rust-core/target/release/alcore`):
full unit suite **2536 passing / 0 failing / 9 pending, 14 min** (`/tmp/full5.txt`, summary at
2026-09-01 23:20). On the same tree: `check-types` 0, `check-no-mirrors` OK (121 shared exports),
`check-dist-contents` OK (25 files, no source). The live server (pid 73156) runs that binary.
CI is ready for the push — read from the workflow files, not from the older note below: `ci.yml`
has a `build-alcore` job the node job `needs`, and `publish.yml` downloads `bin-native-linux-x64`
and `chmod +x`es all four binaries BEFORE `pnpm run test:unit`. Last CI (`f8b7560e`) green in 8 min.

**SETTLING RUN 2026-09-02 01:00–01:10 (`/tmp/full6.txt`, EXIT CODE OBSERVED — the review fork
caught that the gate above had none):** `timeout 1500 pnpm run test:unit` → **EXIT=2 in 10m23s**,
2535 passing / 2 failing / 8 pending. Both failures are TIMEOUTS in the two 🐌 real-machine tests
that read `~/.agentlens/otel-bodies` (`cacheBreakTimeline.test.ts:697`, 120 s load-scaled;
`forensicsIndex.test.ts:465`, 180 s) — both `this.skip()` when that dir is absent (`:698`,
`:470`), so CI never runs them; both PASSED in full5 40 min earlier. Everything CI actually runs
passed in both runs. What differed: a foreign `cargo build` (vectrace, another project) was
saturating the CPU during full6, and the live alcore (7.4 GB RSS) was working the same bodies dir.
Tracked as TRDD-2R0AXCKL; NOT a release blocker.
The 90-min post-summary linger seen after full5 did NOT recur: full6's process exited within seconds
of its summary. INFERRED, unmeasured: the open handle belongs to those two real-corpus tests
COMPLETING (they timed out here, so nothing was left open) — which would also mean CI, where they
skip, never sees it. The first CI on the pushed tree is the only measurement; if its node job
(15-min cap) times out, the leak is real and `mocha --exit` would be the mask, not the fix.

**NEXT ACTION**: the release. `git push origin main` (10 ahead, 0 behind) → CI green →
`git tag -a v2.33.2 -m "…" <sha> && git push origin v2.33.2` → monitor `publish.yml` → verify
`npm view agentlenspro@2.33.2 _npmUser dist.attestations.url` + 16 exec entries in the tarball →
`npm install -g agentlenspro@2.33.2` (replaces the dev link; NEVER 2.33.1, it predates the RSS-wall
fix `d7684513`) → `agentlenspro server restart` → box 5. **The push needs the USER's go** (standing
rule: never push unless told); everything before it is done.

**DMWOBWFH box 3 deliberately NOT ticked** (see box 6): it claims the remaining TS "serves only the
UI (and the CLI shell)", but `src/database/*`, `sessionRepository.ts`, `vscodeCompat.ts` and their
importers `otlpCollector.ts` / `exportData.ts` survive as TEST-ONLY code — 0 mentions of
`SessionRepository` / `DatabaseWriter` / `vscodeCompat` in `standalone/cli.js`. True of the shipped
package, false of the repo; that residue is DMWOBWFH's own pass, not this card's.

**SUPERSEDED — do NOT carry forward:** the 2026-08-29 "NOT ready to execute" verdict, and the box-4
HARD PRECONDITION that CI runs `test:unit` with no Rust build — both closed (see the CI paragraph
above). The 2026-08-29 block below is history.

## ⏵ STATE (history) — 2026-08-29

**A scoping pass ran 2026-08-29. It found ONE real blocker, and the card is NOT ready to execute
until that blocker is closed.** Full evidence:
`reports/lean-worker-retire-ts-server/20260829_120022+0200-scope.md`.

- **VERIFIED BLOCKER — an endpoint exists only in the TS server.** `/api/debug/capture-activity`
  is served at `standalone/server.ts:3622` and has **zero** occurrences anywhere in `rust-core/`
  (checked by grep on both trees, by me, not taken from the worker's summary). Two tests call it:
  `src/test/serverEndpoints.test.ts:127` and `:131`. So retiring the TS server today would remove
  a live endpoint and break those tests — this must be ported to alcore FIRST, or the endpoint and
  its tests deliberately retired with it.
- Scope surface measured: **~20 file:line references** to `server.js`/`server.ts`, **12 test
  files**, and **2 TS-only spawn sites** that the report calls undocumented — those spawn sites
  are the ones most likely to bite, because they are not reachable by grepping for the filename
  alone.
- `src/rustBinResolve.ts` falls back to the TS server whenever the platform binary is missing OR
  present-but-not-executable. Removing the fallback converts both of those from "degraded but
  working" into "hard failure at spawn", so the fallback cannot be deleted before the four-platform
  binaries are proven to ship executable — which v2.32.0's packaging gate now asserts inside the
  tarball (16 entries, `-rwxr-xr-x`).

**BLOCKER CLEARED 2026-08-29 (`eec7bb36`).** `/api/debug/capture-activity` is ported to alcore —
and it needed a real capture-liveness clock, not just a route: `CoreState.last_ingest_activity_ms`,
bumped in `ingest_parsed` under exactly the TS condition (`server.ts:2161` `if (count > 0)` →
`if !spans.is_empty()`), initialised to 0 so "never ingested" stays distinguishable from "just
ingested". Mutation-verified: deleting the bump fails the test.

**A SECOND TS-ONLY GAP WAS FOUND AND CLOSED WHILE HERE (`952357e8`, TRDD-Q8ZW00CI):** alcore had
NO boot-provenance line and NO `NO_REVIVE` brake WARN at all — zero grep hits for `NO_REVIVE` /
`STARTED_BY` under `rust-core/` — while the CLI had been stamping `AGENTLENS_STARTED_BY` onto the
alcore spawn the whole time (`serverControl.ts:218-220`). The stamp was arriving and being dropped.
**The lesson generalises to the rest of this card: the scope report's endpoint list is a FLOOR, not
a complete inventory.** Grep for BEHAVIOUR that exists only in `standalone/server.ts` (log lines,
guards, env reads), not only for routes — two of the two gaps found so far were of that shape, and
the second was invisible to an endpoint-diff.

**BOX 1 IS DONE (`48a154a`, 2026-08-29).** `alcoreBin()` now separates the three cases the single
`null` used to conflate, because only ONE of them is a fault:

| situation | answer | why |
|---|---|---|
| platform not in `SHIPPED_TARGETS` (win32) | `null` | a documented gap — TS is the only option there |
| `bin-native/` absent entirely | `null` | a dev checkout or pruned install; throwing would break every fresh clone |
| `bin-native/` present, this platform's binary missing or non-executable | **throws**, naming platform + path + repair | an incomplete install, and the silent downgrade is how the live backend got regressed to TS |

`SHIPPED_TARGETS` is not exported, so "is this platform shipped at all" is answered by probing
`npmPlatformBin` with an `exists` that always returns true — that makes a `null` mean exactly one
thing. Cheaper than exporting the set and keeping two copies of the answer in sync.
`npmPlatformBin` itself is deliberately untouched: alscan/allogscan/alstore keep optional-tool
semantics, and the hard error belongs only where the server ENGINE is chosen. 3 new cases in
`src/test/alcoreCutover.test.ts` cover every branch; `check-types` and `compile-tests` exit 0 and
the `alcore cutover seam` suite is 9/9.

**BOXES 2+3 DONE (2026-09-01, `d58d6e1` + `6c6c7f49`).** Nothing TS ships (`files` + FORBIDDEN
gate), and the suite boots alcore BY DEFAULT — all 14 parity gaps of TRDD-465EXTJ6 closed, full
suite 2531 passing / 0 failing under the default. The esbuild `server` target and `findServerJs`
survive only as the no-Rust-binary fallback (CI, fresh clones).

**NEXT ACTION**: box 4 — delete `standalone/server.ts` + the `src/**` modules only it imports +
the esbuild `server` target + `findServerJs`. HARD PRECONDITION discovered while flipping box 3:
CI (`ci.yml` node job, `publish.yml:83`) runs `test:unit` with NO Rust build, so today it silently
falls back to `server.js`; deleting server.ts without first making CI build release alcore (or
download the bin-native artifact) before `test:unit` turns every CI server test into a spawn
error. Order: (1) CI builds/provides alcore before test:unit, (2) verify CI green — REQUIRES
PUSHING the ~34 unpushed commits, which the USER has not yet authorized, (3) then delete. **And
re-read the behaviour-not-routes lesson above before deleting**: grep for log lines, env reads,
guards that exist only in server.ts, not just for filenames.

**Do NOT treat this card as blocked on nothing.** `blocked-by:` is empty in the frontmatter but the
endpoint gap is a genuine prerequisite; it is recorded here rather than as a fabricated card id.

USER goal (2026-08-28): *"complete the migration of the backend to rust+sql, keeping the ui
frontend in typescript like it is now. verify the migration is done correctly."* This card is the
first half — **make Rust the only backend that ships** — and closes TRDD-DMWOBWFH box 3 by
DOING it rather than re-deciding it.

## Where it stands

With VHH7FXGC done, `alcore` serves everything the dashboard and the CLI need. The package still
ships BOTH `standalone/server.js` (1.9 MB) and the Rust binaries, and `serverControl.ts` still
falls back to `node server.js` when `alcoreBin()` is null. Every published install now carries
the binaries (2.30.1+), so the fallback path is dead weight on supported platforms and a silent
downgrade on any other.

## Work

- [x] `alcoreBin()`: the Rust core is the default on every platform `bin-native/` covers; a
      missing/non-executable binary is a **boot error** naming the platform, not a fallback to TS
      (fail-fast; no second server to drift against). — `48a154a`; the two legitimate `null` cases
      (unsupported platform, absent `bin-native/`) are preserved deliberately, see the STATE table.
- [x] Remove `standalone/server.js` from `package.json` `files`; `check-dist-contents` asserts the
      bundle is ABSENT from the tarball (FORBIDDEN regex) — `d58d6e1`. The esbuild target and
      `findServerJs` are RETAINED deliberately: they are the test/CI fallback when no Rust binary
      exists (CI runs `test:unit` with no cargo build), so they can only go with box 4.
- [x] Every test that boots `server.js` boots `alcore` instead: `AGENTLENS_TEST_ENGINE` now
      DEFAULTS to alcore (`6c6c7f49`), after the full suite ran green under it — 2529 passing,
      0 engine failures (the only 2 reds were undated sonnet-5 promo-pricing tests that the
      2026-09-01 scheduled rate change correctly flipped; pinned in the same commit). Re-run
      after the flip: 2531 passing, 0 failing, exit 0. `=ts` opts out; no-binary still falls back.
- [x] `standalone/server.ts` is deleted only after the above is green; the `src/**` modules it alone
      imported go with it (`scripts/check-no-mirrors.js` and `check-types` stay green). —
      `567fc5c2`; gated 2026-09-02 on the final binary: full suite 2536 passing / 0 failing,
      `check-types` 0, `check-no-mirrors` OK, `check-dist-contents` OK (STATE block has the detail).
- [ ] `agentlenspro setup` / `server start|restart|status|stop` verified against the installed
      package on this machine, both Claude sessions that depend on the server unaffected.
- [x] CHANGELOG + version bump — `6f74b51f` (2.33.2) + the backpressure line `6b878638`.
      DMWOBWFH box 3 is NOT ticked from here: its wording is false of the repo while test-only
      persistence TS remains (STATE block, "deliberately NOT ticked"); DMWOBWFH owns that residue.

## Verification the USER asked for

"verify the migration is done correctly": the acceptance is the P9 browser smoke suite passing
against `alcore` (every tab renders live data), the MCP tool surface answering from Rust for all
53 tools (P4x lists 21 of 53 ported — the remaining 32 are NPTs of this card, not optional), and
`npm pack --dry-run` showing no `standalone/server.js`.

## Notes and lessons learned
