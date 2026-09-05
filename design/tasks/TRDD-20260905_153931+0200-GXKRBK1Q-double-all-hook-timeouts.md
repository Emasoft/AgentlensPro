---
trdd-id: GXKRBK1Q
title: Double every hook timeout the installer writes and every hook's own network budget
column: dev
created: 2026-09-05T15:39:31+0200
updated: 2026-09-05T15:39:31+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
scope: project
project-id: agentlenspro
related: [3EZ6SJ2Z, X4YTS5BF]
relevant-rules: []
implementation-commits: []
---

# Double every hook timeout the installer writes and every hook's own network budget

USER order 2026-09-05 15:38: "relax the timeouts of all hooks.. they must be doubled".

## Current values (✓ VERIFIED)

Outer — the `timeout` the installer writes into `~/.claude/settings.json` (`src/cli/hookInstall.ts`):

| hook | fn | now | new |
|---|---|---|---|
| lifecycle forwarder (async) | `lifecycleMatcher` `:179` | 5 s | 10 s |
| burn gate (sync, agent-launch + image Read) | `gateMatcher` `:189` | 5 s | 10 s |
| review gate (sync, Stop/SubagentStop) | `reviewGateMatcher` `:198` | 10 s | 20 s |
| review supervisor | `reviewSupervisorMatcher` `:202` | 5 s | 10 s |

The live `~/.claude/settings.json` carries exactly these values today (22 agentlenspro hook entries:
5 s everywhere, 10 s on the two review-gate entries).

Inner — the budget a hook gives its own HTTP call, which must stay inside the outer ceiling:
`src/cli/hookHandlers.ts:239` default `AGENTLENS_HOOK_TIMEOUT` 1 s → 2 s and `:266` default
`AGENTLENS_GATE_TIMEOUT` 2 s → 4 s; `src/cli/setup.ts:297-298` verify-exec env for both 2 → 4, and
the `:301` comment that named "the 2 s above". Sweep for stale numbers (`skills/`, README, ARCHITECTURE,
CLAUDE.md, `src/**`): no other site names the old values.

## Why the sync gate's doubling is acceptable

The 5 s gate comment (`hookInstall.ts:182-187`) already records the trade: the stall only occurs when
the server is WEDGED and the call is an agent launch or an image Read; a gate that times out first
under load fails OPEN and misses the disaster it exists to deny. At the loads this machine runs
(load-avg 16–26 measured today, 130+ on 2026-08-14) the user's report is that the ceilings are hit;
doubling trades a rarer 10 s worst-case stall for fewer silently-dropped captures and fewer gates
failing open.

## Acceptance

- [ ] The four matcher fns write 10/10/20/10; the hook and gate network defaults are doubled; the
      setup verify env is doubled. Tests that pin the old numbers updated (none found pinning 5/10 for
      agentlenspro hooks — the only `timeout: 5` in tests is a FOREIGN janitor hook that must survive).
- [ ] `pnpm run check-types` 0 and `node esbuild.js` succeeds (the CLI bundle is what `setup` runs).
- [ ] `agentlenspro setup --yes` (or `--install-hooks`) converges the live settings.json through
      `safeConfigEdit`; `python3` read-back shows 10/10/20/10 on all 22 agentlenspro entries and the
      foreign hooks untouched. Whether the new ceilings apply without a session restart is a LOCAL
      memory note (hook registration reloaded live on CC 2.1.240), not verified here — restart if in doubt.

## Notes and lessons learned
