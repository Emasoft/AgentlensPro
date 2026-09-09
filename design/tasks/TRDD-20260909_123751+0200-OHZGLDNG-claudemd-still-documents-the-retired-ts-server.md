---
trdd-id: OHZGLDNG
title: CLAUDE.md still documents the TypeScript server retired in 567fc5c2
column: todo
created: 2026-09-09T12:37:51+0200
updated: 2026-09-09T12:37:51+0200
current-owner: main
task-type: docs
min-approval-requirement: none
project-id: agentlenspro
scope: project
labels: [docs, claude-md, alcore, stale-doctrine]
blocked-by: []
npt: []
eht: []
implementation-commits: []
relevant-rules: []
related: [4EV3OJ19, 5JZQFVO8, 1B98LCVR]
---

## Why

Commit 567fc5c2 (2026-09-01, "feat!: retire the TypeScript server — alcore is the only
backend", TRDD-1B98LCVR box 4) deleted `standalone/server.ts` (4,177 lines) and the
`scripts/dev-server.js` / `src/updatePayload.ts` / `src/autoConfigNode.ts` it fed. CLAUDE.md at
HEAD still describes that server in present tense. Two distinct defects:

1. **A deleted file is named as live.** Lines 133 (`standalone/server.ts` as a source of the
   `standalone/**` layer, bundled with `cli.ts`), 135 (the `/api/*` shim "on
   `standalone/server.ts`"; "`esbuild.js` builds **four** separate targets"), 151 (`sql.js`
   "resolved from `node_modules` at runtime … `standalone/server.ts`"), 270 (the single-owner
   data-dir guard "in `standalone/server.ts`").
2. **A fallback that no longer exists is named without a file.** Lines 257 and 312 say
   `rustBinResolve` "falls back to the TS server". `src/cli/serverControl.ts:32-36` says the
   opposite in its own words ("no longer ships a TypeScript fallback (TRDD-1B98LCVR box 4), so a
   missing binary here is a hard stop"), and `src/rustBinResolve.ts:15-17` carries the same
   stale sentence as a code comment ("must fall back to the TS server rather than crash the
   CLI").

Present-tense doctrine naming a path that is not there is the defect; a reader who trusts
line 270 goes looking for the guard in a file that has not existed for eight days.

## Evidence (2026-09-09, first-hand)

- `git log --diff-filter=D --oneline -- standalone/server.ts` → `567fc5c2 feat!: retire the
  TypeScript server — alcore is the only backend (TRDD-1B98LCVR box 4)`; its stat: 15 files,
  +192/−4,712, `standalone/server.ts | 4177 ----`.
- `standalone/` at HEAD holds `cli.ts`, `cli.js`, `cli.js.map`, `tsconfig.json` — no
  `server.ts`, no `server.js`.
- `esbuild.js` `entryPoints` at lines 28, 43, 56: `media/src/dashboard.tsx`,
  `media/src/sidebarWebview.ts`, `standalone/cli.ts` — three targets, not four.
- Eight CLAUDE.md commits landed after 567fc5c2 (incl. 25d17c43 "post-retirement factual
  fixes") and the six lines survive at HEAD.
- `src/rustBinResolve.ts` read whole: `npmPlatformBin` returns null for an unshipped platform
  or a missing file; `src/cli/serverControl.ts:103-133` (`alcoreBin`): env override, then
  `<dataDir>/bin/alcore`, then `bin-native/`; returns null when the platform is unshipped or
  `bin-native/` is absent (the caller stops with `noServerAvailableError`, `:37`); THROWS when
  `bin-native/` exists but the binary is missing or not executable (`:124-132`). No branch
  spawns anything but alcore.
- The guard doctrine at line 270 (atomic exclusive create, stale-lock takeover,
  ownership-checked release) is true of alcore: `rust-core/crates/agentlens-core/src/pid_lock.rs`
  `atomic_exclusive_write` (:74), `claim` (:118), `release` (:180) — signatures seen in a grep,
  bodies not read; reading them is acceptance item 3's job. The doctrine stays; only its home
  moves.
- UNCERTAIN, not checked: whether any TS code still resolves `sql.js` at runtime (line 151's
  gotcha may be dead with the server or may live on in a scan path). Acceptance item 2 settles
  it before rewriting that line.

## Acceptance

1. `! grep -q 'standalone/server.ts' CLAUDE.md` exits 0, and `grep -c entryPoints esbuild.js`
   prints `3` with line 135's count corrected to match.
2. Line 151 is rewritten from a grep of `require.resolve('sql.js')` / `sql.js` over non-test
   `src/` and `standalone/`: either the gotcha names its live file, or it is removed as retired.
3. Lines 257 and 312 state what happens with no binary (null → `noServerAvailableError`; throw
   on a corrupt install, `serverControl.ts:121-132`), and line 270 names `pid_lock.rs::claim`
   after its body is read and the three guard properties are confirmed against it.
4. `src/rustBinResolve.ts:15-17` reads "must return null (the CLI stops with an actionable
   error) rather than crash the CLI" or equivalent — no "fall back to the TS server".
5. `pnpm run check-identities` exit 0 on the edited CLAUDE.md (it is a checked file).

Filed at `todo` like the two sibling cards of 2026-09-09 (Tier-0 docs work that should drain),
not `backburner`. The CLAUDE.md working copy is currently modified by the janitor's wikimem
index regeneration; the fix is made on top of that, never by reverting it.

## Notes and lessons learned
