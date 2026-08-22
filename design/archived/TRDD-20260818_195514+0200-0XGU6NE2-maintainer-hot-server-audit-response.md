---
trdd-id: 0XGU6NE2
title: Audit response — maintainer claim that the server self-restarts and eats 2G/hr of disk
column: complete
created: 2026-08-18T19:55:14+0200
updated: 2026-08-22T19:39:15+0200
current-owner: agentlenspro-session
task-type: audit
audit-trigger: cross-session message from ai-maestro-maintainer-agent (2026-08-16 host-hygiene audit)
relevant-cards: [DMWOBWFH]
---

# Audit response — "server runs hot, restarts itself when killed, disk 96% growing 2G/hr"

Cross-session request (2026-08-18) from the maintainer agent asked this project to investigate
its "supervisor/restart config" as the lever for a hot, self-resurrecting server on a 96%-full
disk. Investigated first-hand the same day. **Verdict: no change to AgentlensPro is warranted;
three of the four claims do not hold against measurement, and the fourth (disk 96%) is real but
not attributable to this server.**

## Findings (all measured 2026-08-18 ~19:50+0200)

1. **There is NO supervisor and NO restart config.** The only launchd item is
   `com.agentlens.spool` — a one-shot `agentlenspro spool ensure` (RAM-disk mount) with
   `RunAtLoad` only: no `KeepAlive`, state `not running` after login. The server runs detached
   (ppid 1) but nothing in launchd restarts it. There is nothing to throttle or disable.
2. **The observed "resurrection" (pid 26449 → 27917) is session-driven, not supervision.**
   The registered Claude hooks (`agentlenspro hook`/`gate`) spool to disk and never start the
   server (verified: `src/cli/hookHandlers.ts` has no ensureServer/spawn path). The verbs that
   auto-start are `agentlenspro dashboard` and diagnostics invoked with `--server`/`--dashboard`
   (`ensureServer`, main.ts:230, diagnosticsCli.ts:672) — plus the active dev sessions on this
   host, which restart the server deliberately after every bundle deploy (the TRDD-DMWOBWFH
   Rust-rewrite work restarted it many times on 08-16..08-18). A kill during that window is
   expected to be followed by a new pid.
3. **"Runs hot from startup" no longer holds.** Measured 3.8% / 1.9% / 21.5% CPU over 6s on a
   freshly booted server (bursts = live log tailing of concurrent Claude sessions). The 08-16
   observation predates the Rust engines going live (P1 span scan 32.7s→1.1s; P2 cold boot
   27s→6.7s) and the TRDD-66IXMIGN heap-retention fix (v2.27.0) — the historic hot-boot causes
   are shipped fixes.
4. **The 2G/hr disk growth is NOT this server.** `/` is genuinely at 96% (1.8T/1.9T, 85G free),
   but `~/.agentlens` totals 5.4G ALL-TIME (store 2.2G, log-events 1.5G, spans 451M — all
   retention-bounded) and the running server reports **0.3MB written since boot**. For scale:
   `~/.claude/projects` (session transcripts) is 18G and grows with every turn of every session
   on this host — a far better candidate for the 2G/hr writer. Recommend the maintainer hunt the
   writer directly (`fs_usage -w -f filesys` or interval `du` deltas) rather than by suspicion.

## Approval log

- 2026-08-18T19:55:14+0200 — COMPLETED by agentlenspro-session. Investigation-only audit; no code
  change needed; findings relayed to the maintainer agent via SendMessage.
- 2026-08-22T19:39:15+0200 — ARCHIVED by main (self-orchestrating; USER authorised). Archived AS
  `complete`, not renamed to `completed` — per the 3-pillars 2.0.0 amendment (3P-ZON-05) every
  terminal column archives as itself, because the complete→completed dual-write was measured
  drifting 232 times fleet-wide. It had sat in `design/tasks/` since 2026-08-18, inflating the
  open-work zone with a card that was already decided.
