---
trdd-id: 1B98LCVR
title: Retire the TypeScript backend from the package so Rust is the only server that ships
column: dev
created: 2026-08-28T22:05:59+0200
updated: 2026-08-29T15:38:00+0200
current-owner: claude-agentlenspro
task-type: refactor
project-id: agentlenspro
parent-trdd: DMWOBWFH
blocked-by: []
npt: [VHH7FXGC]
---

# Retire the TypeScript backend from the package

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-08-29

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

**NEXT ACTION**: `alcoreBin()` — make a missing or non-executable binary a boot ERROR naming the
platform instead of a silent fallback to TS. That is the first Work box and the one that makes
every later removal safe; v2.32.0's packaging gate already proves all 16 `bin-native` entries ship
`-rwxr-xr-x` inside the tarball, which was its precondition.

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

- [ ] `alcoreBin()`: the Rust core is the default on every platform `bin-native/` covers; a
      missing/non-executable binary is a **boot error** naming the platform, not a fallback to TS
      (fail-fast; no second server to drift against).
- [ ] Remove `standalone/server.js` from `package.json` `files`, the `server` esbuild target, and
      `findServerJs`; `check-dist-contents` asserts the bundle is ABSENT from the tarball.
- [ ] Every test that boots `server.js` (the P9 browser smoke, `spawnServerWithRetry` users) boots
      `alcore` instead — the smoke suite then IS the end-to-end proof the USER asked for.
- [ ] `standalone/server.ts` is deleted only after the above is green; the `src/**` modules it alone
      imported go with it (`scripts/check-no-mirrors.js` and `check-types` stay green).
- [ ] `agentlenspro setup` / `server start|restart|status|stop` verified against the installed
      package on this machine, both Claude sessions that depend on the server unaffected.
- [ ] CHANGELOG + version bump; DMWOBWFH box 3 ticked with this card as evidence.

## Verification the USER asked for

"verify the migration is done correctly": the acceptance is the P9 browser smoke suite passing
against `alcore` (every tab renders live data), the MCP tool surface answering from Rust for all
53 tools (P4x lists 21 of 53 ported — the remaining 32 are NPTs of this card, not optional), and
`npm pack --dry-run` showing no `standalone/server.js`.

## Notes and lessons learned
