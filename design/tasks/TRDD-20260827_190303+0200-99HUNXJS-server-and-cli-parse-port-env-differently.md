---
trdd-id: 99HUNXJS
title: The server and the CLI parse the same port env vars by different rules
column: testing
created: 2026-08-27T19:03:03+0200
updated: 2026-09-04T10:00:39+0200
current-owner: main
task-type: bugfix
severity: LOW
priority: 4
labels: [cli, server, config, isolation]
relevant-rules: []
created-by: TRDD-BSDR4TRM ai_review round 2 (NEW-4)
---

## The divergence (measured 2026-08-27, ai_review round 2 of TRDD-BSDR4TRM)

Three spellings of "read a port from the env" exist, and they disagree on every malformed value:

| site | rule |
|---|---|
| `standalone/server.ts:94-96` | `parseInt(process.env.UI_PORT ?? '3000')` — takes a numeric PREFIX, `NaN` on junk |
| `src/cli/setup.ts:109-110` | `Number(process.env.UI_PORT ?? 3000)` — `Number('')` is **0** |
| `src/cli/cliCore.ts::envPort` | validated: integer in `(0, 65536)`, else the default |

So for `UI_PORT=8080/evil` the server binds 8080 and the CLI dials 3000; for `abc` the server calls
`listen(NaN)` while the CLI dials 3000; for `0` the server takes a kernel-assigned port that answers
nothing. Every row is an operator-error input, and in each one the two halves end up on different
ports without saying so.

TRDD-BSDR4TRM fixed the CLI half only, deliberately: before it, junk threw `Invalid URL` at every
call site or injected a path into the endpoint. It did not touch the server, and it should not have —
`alcoreServeArgs`'s own comment already says unifying the three spellings "changes setup.ts's
behaviour and belongs in its own diff".

## Why it is LOW and not urgent

Reaching any row requires an operator to export a malformed port. Nothing silently corrupts data: the
worst outcome is a CLI that cannot find its server, and TRDD-BSDR4TRM's data-dir-keyed resolver now
answers correctly from the lock regardless of what the ports do.

## The fix, when it is taken

One parser, used by all three. `envPort` is the validated one; it lives in `src/cli/cliCore.ts`,
which the server cannot import (CLI-only, and the server takes `src/dataDir.ts` instead). Move it to
a module both sides already take, then delete the other two spellings.

**Fail-fast alternative worth weighing first:** a malformed port is operator error, so REFUSING to
start (exit non-zero, naming the variable and its value) may beat any silent fallback — including
`envPort`'s. Decide that before unifying, or the unification ossifies the wrong default.

## Acceptance

- [x] One port parser, imported by `standalone/server.ts`, `src/cli/setup.ts` and `src/cli/cliCore.ts`.
- [x] A test table asserting all three sites agree on `['', '   ', 'abc', '0', '-1', '65536', '80.5', '3e3', '8080/evil']`.
- [x] The refuse-vs-fallback decision recorded here before the code lands.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-03

`standalone/server.ts` is gone (deleted in 567fc5c2) — the acceptance box literally naming it is
satisfied vacuously; the fix landed against the two sites that still existed.

**What moved:** `src/cli/setup.ts::resolveCtx` — its three `Number(process.env.X ?? default)`
port reads (`uiPort`/`mcpPort`/`otlpPort`, was `Number('')===0`) now call the same validated
`envPort()` from `src/cli/cliCore.ts` that `serverControl.ts::alcoreServeArgs` already used, so
setup's health-check/status URLs and the spawned server can no longer disagree on a malformed
port. Also fixed `standalone/cli.ts`'s post-spawn "open browser" URL (`process.env.UI_PORT ??
'3000'`, same `Number('')` shape), same call. Exported `resolveCtx` + `Ctx` (were file-private) so
the new test can assert them directly instead of running the whole multi-step `runSetup` flow.

**Refuse-vs-fallback decision:** kept `envPort`'s existing fallback-on-malformed semantics
(no refuse-and-exit). `envPort` was already the ratified parser from TRDD-BSDR4TRM's ai_review;
introducing a NEW refuse-vs-fallback split in this bugfix would re-litigate that decision on a
LOW-severity card whose acceptance only asked for one shared parser, not a behavior change.

**Gates:** `pnpm run check-types` exit 0. `npx eslint src/cli/setup.ts src/cli/serverControl.ts
standalone/cli.ts src/test/setupPortEnv.test.ts --quiet` exit 0. New suite
`src/test/setupPortEnv.test.ts` (11 tests, all `resolveCtx`-level, no mocks) — 11 passing, exit 0.

Run ONE suite with the repo's own idiom, the one `package.json::test:browser` already uses:

```
npx mocha --no-config --ui tdd --require ./src/test/setup.js out/test/test/setupPortEnv.test.js
```

The config is `.mocharc.cjs` (not `.mocharc.js`), and its `spec` glob is indeed why a positional
file arg alone still runs the ~8min repo-wide suite. But this STATE block previously prescribed
`--config <empty.json>` for that, and **that recipe cannot work**: an empty config drops
`ui: 'tdd'` along with the glob, so the file fails to load with `ReferenceError: suite is not
defined` before a single test runs — verified 2026-09-04, exit 1. `--no-config --ui tdd` drops the
glob and keeps the interface. The lesson is the reusable part: a config file carries more than the
one setting you are trying to defeat, so replace it selectively rather than emptying it.

**Files:** `src/cli/setup.ts`, `standalone/cli.ts`, `src/test/setupPortEnv.test.ts` (new).

**NEXT ACTION:** none — ready for ai_review / merge into `testing`.

## Related

- [[TRDD-BSDR4TRM]] — fixed the CLI half and created this card.
