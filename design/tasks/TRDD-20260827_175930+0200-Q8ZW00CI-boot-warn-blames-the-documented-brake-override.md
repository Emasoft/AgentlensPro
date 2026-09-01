---
trdd-id: Q8ZW00CI
title: The boot WARN says the starter did not honour the brake even for the documented server start override
column: human_review
created: 2026-08-27T17:59:30+0200
updated: 2026-09-01T19:51:30+0200
last-test-result: pass
last-test-at: 2026-08-27T19:42:00+0200
current-owner: main
task-type: bugfix
severity: LOW
priority: 4
labels: [server, lifecycle, wording]
relevant-rules: []
created-by: TRDD-8VGQK9L9 closing verification
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-08-29

**Implemented and verified on the SHIPPED backend, which is not where this card was originally
aimed.** The fix landed in `standalone/server.ts:304-307` on 2026-08-27 — but alcore is the shipped
server now, and alcore had NO brake WARN and no boot-provenance line at all (grep: zero hits for
`NO_REVIVE` / `STARTED_BY` under `rust-core/`). So the card's fix lived only in the server being
retired, and the live path warned about nothing. Meanwhile the CLI had been stamping
`AGENTLENS_STARTED_BY` on the alcore spawn all along (`serverControl.ts:218-220`) — the stamp
arrived and was dropped.

Ported in `952357e8`. Verified by running the real binary twice against an isolated data dir with
`NO_REVIVE` armed:

| `started-by` | output |
| --- | --- |
| `server start` | `[AgentlensPro] brake PRESENT — being lifted by \`server start\`.` — and NO warn |
| `hook` | the WARNING, verbatim |

The predicate is `agentlens_core::brake_lift_is_sanctioned`, in the LIBRARY rather than inside
`alcore.rs`'s `main`, because a binary's main is unreachable from a test. Its test
(`tests/brake_provenance.rs`) pins BOTH directions — a one-sided test of a predicate is satisfied
by a constant.

**NOT DONE:** no test asserts the two boot LINES themselves (only the predicate behind them); that
was verified by hand. And the TS branch at `standalone/server.ts:304` remains untested — it is
deliberately left alone because that file is slated for removal under TRDD-1B98LCVR, and adding a
test to code being deleted is work with a known expiry.

## Observation (measured 2026-08-27 17:57, scratch data dir, brake armed)

`agentlenspro server start` is the ONE command documented to lift the brake; it spawns with
`overrideBrake` and clears the flag once the server answers (`src/cli/serverControl.ts:795-805`).
The child's boot line is correct — `started-by=server start … brake=PRESENT` — but the WARN that
follows it is not:

```
WARNING: this server started while the NO_REVIVE brake was PRESENT. The starter above did not
honour it. Clear the brake with `agentlenspro server start`, or stop this server with …
```

(`standalone/server.ts:299`). For `started-by=server start` the starter DID honour the brake's
contract — it is the sanctioned override — and the WARN's advice ("clear it with `server start`")
tells the operator to run the command that just ran. On the other four spawn paths the WARN is
true and wanted; it is the provenance-blind wording that is wrong.

## Fix (one branch)

The server already has `startedBy` in hand. When it is `server start` or `server restart`, log an
INFO line ("brake lifted by `server start`") instead of the WARN; keep the WARN verbatim for every
other starter. No new state, no CLI change — the clear still happens CLI-side after readiness, so
the invariant "brake cleared ⟺ a server is running" is untouched.

## Acceptance

- [x] A scratch start with the brake armed logs the INFO line, not the WARN.
      Measured: `[AgentlensPro] brake PRESENT — being lifted by ``server start``.` (same for
      `server restart`), observed in an isolated scratch dir on ports 39011-3 with `NO_REVIVE`
      armed, launching `node standalone/server.js` directly — never the live server.
- [x] A hook/supervisor/setup/watchdog spawn with the brake armed still logs the WARN — the second
      arm was observed in the same scratch run with `AGENTLENS_STARTED_BY=hook-revive`, text
      unchanged byte-for-byte.

Gates: `check-types` 0, `eslint` 0, `node esbuild.js` 0 (checked, not assumed — a failed esbuild
silently leaves the stale bundle).
