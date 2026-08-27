---
trdd-id: 99HUNXJS
title: The server and the CLI parse the same port env vars by different rules
column: backburner
created: 2026-08-27T19:03:03+0200
updated: 2026-08-27T19:03:03+0200
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

- [ ] One port parser, imported by `standalone/server.ts`, `src/cli/setup.ts` and `src/cli/cliCore.ts`.
- [ ] A test table asserting all three sites agree on `['', '   ', 'abc', '0', '-1', '65536', '80.5', '3e3', '8080/evil']`.
- [ ] The refuse-vs-fallback decision recorded here before the code lands.

## Related

- [[TRDD-BSDR4TRM]] — fixed the CLI half and created this card.
