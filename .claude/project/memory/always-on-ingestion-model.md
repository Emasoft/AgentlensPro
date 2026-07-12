---
name: always-on-ingestion-model
description: "how does no-loss ingestion work / is a log lost when the server is down / why isn't there a separate ingestion daemon / where do undelivered hooks go / hook-spool / server melts under many claude instances / 20 instances hammering the cli / admission control / 503 Retry-After / server busy backpressure / how to keep ingestion up 24/7 / daemon install launchd / why did a request get shed"
ocd: 2026-07-12
lmd: 2026-07-12
metadata:
  node_type: memory
  type: project
  tier: hub
  globs: ["src/cli/hookHandlers.ts", "src/cli/serverControl.ts", "src/resourceMonitor.ts", "src/admissionController.ts", "standalone/server.ts"]
---

AgentlensPro's ingestion is **always-on and loss-less whenever any Claude instance is active**, and
survives 20+ concurrent instances — WITHOUT a two-process daemon/dashboard split. The ingestion
daemon **IS** the standalone server, kept up by the hooks themselves (TRDD-D3K7QM2P, user-confirmed
architecture over the split).

**Why NOT a separate daemon process:** JSONL transcripts are ALREADY loss-less — Claude/Codex/Copilot
write them to disk themselves; `LogReader.scan()` tails with PERSISTED byte offsets and backfills on
restart. So the split's headline benefit was already met, while it would have added two-process store
concurrency + SSE across processes + a migration (high risk on a working 3200-line server). The only
real downtime loss vectors were (a) OTEL spans pushed to :4318 while nothing listens and (b) hook
events POSTed while the server is down. Both are closed below.[^1]

**The three mechanisms (all in one process):**
1. **Hook durability** (`src/cli/hookHandlers.ts` `forwardHookEvent`): on ANY delivery failure —
   server down, timeout, or a 503 shed — the raw payload is spooled to `~/.agentlens/hook-spool/` and
   a DETACHED, stampede-locked (`~/.agentlens/.daemon-revive.lock`, ~15s TTL) server revive is fired.
   The hook still exits 0 fast (contract). The server drains the spool through the SAME
   `/api/hook-events` ingest path (extracted as `ingestHookEvent` in `standalone/server.ts`) on boot
   AND on a ~30s tick, deleting each file. Bounded (oldest-dropped over `AGENTLENS_HOOK_SPOOL_MAX`,
   default 20k) so a permanently-down server can't fill the disk. `AGENTLENS_NO_REVIVE=1` = spool-only.
2. **`agentlenspro daemon`** (`src/cli/serverControl.ts`): start/stop/restart/status/install/uninstall.
   The daemon == the server (one pidfile guard); `status` adds the hook-spool depth; `install` writes
   a launchd agent (`com.agentlens.collector`, embedded plist, `daemon start --supervise`) for 24/7
   supervision across reboot — OPT-IN, because hooks already revive it when Claude is active.
3. **Admission control** (`src/resourceMonitor.ts` + `src/admissionController.ts`): both HTTP servers
   (UI :3000, OTLP :4318) share ONE monitor (RSS / per-core load / free disk, TTL-cached) + ONE
   bounded-concurrency controller. Over soft → queue (bounded + deadlined, NEVER blocks a caller
   unbounded); at a hard wall (RSS/disk over, queue full) → shed `503 + Retry-After`. **Shed is
   loss-free**: a shed hook spools (mech 1), a shed OTLP export is retried/backfilled, a shed gate
   fails OPEN. Exempt (always answer): `/events` SSE (long-lived — would drain the pool),
   `/api/server-stats` (health), GET `/api/hook-config` (kill-switch). Env-tunable + CPU-scaled;
   live counters on `/api/server-stats` (`admission`, `resources`, `hookEvents.spooled`).

**Load-bearing facts / gotchas:**
- The HTTP handlers are now `async` (they `await admission.enter()` at the top). Node keeps the
  request body stream PAUSED during the await, so no POST body is lost — proven by every real-boot
  POST test still passing through the gate.[^2]
- The hook contract is sacred: `agentlenspro hook`/`gate` ALWAYS exit 0 fast, never throw/block. The
  spool + detached revive are best-effort and fully guarded.
- Admission shedding is a COST/stability control, not security. It fails toward availability
  (queue→shed→spool), never toward blocking a Claude launch.
- See also [[agentlens-burn-token-model]] (the gate the admission controller sheds), [[cache-ttl-model]].

## Notes and lessons learned
[^1]: [ocd:2026-07-12 lmd:2026-07-12] Phase 1 was PLANNED as a two-process split (separate ingestion
  daemon; dashboard a reader). During implementation the investigation surfaced that JSONL is already
  loss-less (offset backfill) and the split is high-risk for marginal benefit; flagged to the user,
  who chose the simpler hook-revive + spool. Lesson: verify the ACTUAL loss vectors before building
  a big architecture to fix an assumed one — most of "no log lost" was already true, so the remaining
  gap (OTEL + hooks during downtime) had a far cheaper solution than a process split.
[^2]: [ocd:2026-07-12 lmd:2026-07-12] a first admission integration test asserted a concurrent burst
  would shed — it did NOT, because `/api/summary` on an empty server is too fast for requests to
  overlap at maxInflight=2 (shedTotal=0). Lesson: never assert on timing-dependent overload in an
  integration test; force the condition deterministically (a 1 MiB hard RSS wall sheds every request
  regardless of overlap) and cover the timing-sensitive logic in unit tests instead.
