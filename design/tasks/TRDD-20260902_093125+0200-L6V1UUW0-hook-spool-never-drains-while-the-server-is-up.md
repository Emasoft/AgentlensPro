---
trdd-id: L6V1UUW0
title: The hook-spool never drains while the server is up, and every spooled hook spawns a doomed revive
column: ai_review
created: 2026-09-02T09:31:25+0200
updated: 2026-09-02T13:10:29+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
related: [465EXTJ6, 2R36W8Q1, D3K7QM2P]
---

# The hook-spool never drains while the server is up, and every spooled hook spawns a doomed revive

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-02

- **Measured 2026-09-02 09:12–09:23 under the sessions already running (no soak).** `~/.agentlens/hook-spool`
  held 23 events at window start, all written after the live server booted at 08:40; at window end 0 of the
  23 were gone and 5 more had arrived (28). The 08:49 file was still there 40 min later.
- **Cause 1 (verified in code):** `drain_hook_spool` has exactly ONE call site — the boot block of
  `chores::spawn_all` (`rust-core/crates/agentlens-core/src/chores.rs:461`). No interval calls it. The TS
  server it replaced drained every 30 s (`HOOK_SPOOL_DRAIN_MS`, git `96cf899b` `standalone/server.ts:3162`).
  `admission.rs:8`, `src/cli/hookHandlers.ts:70` and `serverControl.ts:979` all still promise "reingested on
  the next drain tick". A parity gap of TRDD-465EXTJ6's family.
- **Cause 2 (verified in log):** `forwardHookEvent` falls back to spool + `reviveDaemonDetached()` on ANY
  failure, including a 1 s timeout while the server is alive. Each revive spawns an alcore that prints
  `Refusing to start: another AgentlensPro server (pid 95443) already owns this data directory` —
  781 such refusals in `server.log`. The storm is pure waste and lands on the machine exactly when it is
  already stalling.
- **Why hooks time out at all** is TRDD-2R36W8Q1's problem (server stalls), not this card's.
- **DONE 2026-09-02 (commits f5926457 core tick, 6b6a37f2 CLI guard; deployed 12:52 as pid 26060, again
  13:09 as pid 53886).** All four boxes hold — see Acceptance. The spool had grown to 300 files by the
  deploy (28 at 09:23) and `server.log` to 7,360 refusals; both stopped at the deploy. Nothing left on this
  card but review.

## Acceptance

- [x] `drain_hook_spool` runs on an interval (default 30 s, `AGENTLENS_HOOK_SPOOL_DRAIN_MS` floor 5 s) with
      a bounded batch per tick; a unit test proves a file spooled AFTER boot is drained without a restart.
      Evidence: `rust-core/crates/agentlens-core/src/chores.rs:589-605` (the tick task, same env-parsing
      shape as `account_flush`); `rust-core/crates/agentlens-core/tests/hook_spool_drain.rs::unbounded_drains_everything`
      and `::max_files_bounds_one_drain_pass` (5 files spooled post-`CoreState::open`, drained with no
      process restart). No harness exists in `tests/` to spawn `chores::spawn_all`'s tokio tasks and
      observe a real timer tick, so the tick's own scheduling is exercised by code review, not a test —
      noting this rather than skipping it silently.
- [x] Per-tick batch cap documented in code with the reason (state lock hold bound).
      Evidence: `rust-core/crates/agentlens-core/src/hook_events.rs:288-295` (doc comment on
      `drain_hook_spool`'s `max_files` param, citing TRDD-2R36W8Q1's stall shape).
- [x] `forwardHookEvent`'s fallback does not spawn a revive when the pidfile's owner is alive; a unit test
      proves it (live pid → no spawn; dead/absent pid → spawn).
      Evidence: `src/cli/hookHandlers.ts` `pidfileOwnerAlive()` + guard in `reviveDaemonDetached()`;
      `src/test/hookSpool.test.ts` 3 new cases (`pidfileOwnerAlive: a live pid…`, `a dead pid…`, `no
      pidfile…`); `npx mocha --no-config --require src/test/setup.js --ui tdd out/test/test/hookSpool.test.js`
      → 11 passing (2026-09-02).
- [x] Live: after deploy, `hookEvents.spooled` in `/api/server-stats` reaches 0 without a server restart and
      `server.log` gains no new `started-by=hook-revive` refusals over 15 min.
      Evidence (12:53:09 → 13:08:13, pid 26060, the sessions already running): `hookEvents.spooled` 0 at
      both ends, `find hook-spool -name '*.json' | wc -l` 0 at both ends; `Refusing to start` count in
      `server.log` 7,360 → 7,360; SEVEN `alcore: hook-spool: drained 1–2 event(s)` lines AFTER the boot
      drain — those are the 30 s tick draining events spooled post-boot, the thing that never happened
      before (28 files, 0 drained, 40 min). The boot drain itself swallowed the 300-file backlog
      (`hooks: 302 event(s) since boot` at +42 s).

## Notes and lessons learned

- A field named `spooled` is a directory listing (`server_stats.rs:553`), not a counter — read the emitter
  before pairing a number with a mechanism.
