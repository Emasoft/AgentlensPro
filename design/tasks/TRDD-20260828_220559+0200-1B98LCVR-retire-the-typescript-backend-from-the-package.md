---
trdd-id: 1B98LCVR
title: Retire the TypeScript backend from the package so Rust is the only server that ships
column: todo
created: 2026-08-28T22:05:59+0200
updated: 2026-08-28T22:05:59+0200
current-owner: claude-agentlenspro
task-type: refactor
project-id: agentlenspro
parent-trdd: DMWOBWFH
blocked-by: []
npt: [VHH7FXGC]
---

# Retire the TypeScript backend from the package

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
