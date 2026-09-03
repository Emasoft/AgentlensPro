---
name: always-on-ingestion-model
description: "how does no-loss ingestion work / is a log lost when the server is down / why isn't there a separate ingestion daemon / where do undelivered hooks go / hook-spool / server melts under many claude instances / 20 instances hammering the cli / admission control / 503 Retry-After / server busy backpressure / how to keep ingestion up 24/7 / daemon install launchd / why did a request get shed"
ocd: 2026-07-12
lmd: 2026-09-02
metadata:
  node_type: memory
  type: project
  tier: hub
  globs: ["src/cli/hookHandlers.ts", "src/cli/serverControl.ts", "src/resourceMonitor.ts", "src/admissionController.ts", "standalone/server.ts"]
publish-globally: false
---

^H8IUKLAQ [desc:"ingestion is always-on and loss-less while any Claude instance is active, surviving 20+ concurrent instances without a separate daemon process — the standalone server IS the ingestion daemon", keywords:"how_does_no_loss_ingestion_work why_isnt_there_a_separate_ingestion_daemon always_on_ingestion server_melts_under_many_claude_instances 20_instances_hammering_the_cli TRDD-D3K7QM2P", ocd:2026-07-12, lmd:2026-09-02]
AgentlensPro's ingestion is **always-on and loss-less whenever any Claude instance is active**, and
survives 20+ concurrent instances — WITHOUT a two-process daemon/dashboard split. The ingestion
daemon **IS** the standalone server, kept up by the hooks themselves (TRDD-D3K7QM2P, user-confirmed
architecture over the split).

^DGIH73FR [desc:"a separate ingestion daemon was rejected because JSONL is already loss-less with persisted offset backfill; only OTEL-downtime and hooks-downtime were real loss vectors, both closed cheaply", keywords:"why_not_a_separate_daemon_process jsonl_already_loss_less offset_backfill_on_restart two_process_split_rejected real_downtime_loss_vectors", ocd:2026-07-12, lmd:2026-09-02]
**Why NOT a separate daemon process:** JSONL transcripts are ALREADY loss-less — Claude/Codex/Copilot
write them to disk themselves; `LogReader.scan()` tails with PERSISTED byte offsets and backfills on
restart. So the split's headline benefit was already met, while it would have added two-process store
concurrency + SSE across processes + a migration (high risk on a working 3200-line server). The only
real downtime loss vectors were (a) OTEL spans pushed to :4318 while nothing listens and (b) hook
events POSTed while the server is down. Both are closed below.[^1]

**The three mechanisms (all in one process):**
^H05QX5H7 [desc:"on any hook-delivery failure the payload spools to hook-spool and a detached server revive fires; the hook still exits 0 fast, and the server drains the spool on boot and on a 30s tick", keywords:"hook_durability hook_spool where_do_undelivered_hooks_go detached_server_revive daemon_revive_lock AGENTLENS_HOOK_SPOOL_MAX ingestHookEvent", ocd:2026-07-12, lmd:2026-09-02]
1. **Hook durability** (`src/cli/hookHandlers.ts` `forwardHookEvent`): on ANY delivery failure —
   server down, timeout, or a 503 shed — the raw payload is spooled to `~/.agentlens/hook-spool/` and
   a DETACHED, stampede-locked (`~/.agentlens/.daemon-revive.lock`, ~15s TTL) server revive is fired.
   The hook still exits 0 fast (contract). The server drains the spool through the SAME
   `/api/hook-events` ingest path (extracted as `ingestHookEvent` in `standalone/server.ts`) on boot
   AND on a ~30s tick, deleting each file. Bounded (oldest-dropped over `AGENTLENS_HOOK_SPOOL_MAX`,
   default 20k) so a permanently-down server can't fill the disk. `AGENTLENS_NO_REVIVE=1` = spool-only.
^FSWEU1AD [desc:"the agentlenspro daemon command IS the server (one pidfile guard) with start/stop/restart/status/install/uninstall; install writes an opt-in launchd agent for 24/7 supervision across reboot", keywords:"agentlenspro_daemon_command daemon_install_launchd com.agentlens.collector how_to_keep_ingestion_up_24_7 opt_in_supervision", ocd:2026-07-12, lmd:2026-09-02]
2. **`agentlenspro daemon`** (`src/cli/serverControl.ts`): start/stop/restart/status/install/uninstall.
   The daemon == the server (one pidfile guard); `status` adds the hook-spool depth; `install` writes
   a launchd agent (`com.agentlens.collector`, embedded plist, `daemon start --supervise`) for 24/7
   supervision across reboot — OPT-IN, because hooks already revive it when Claude is active.
^G0PLW7U2 [desc:"admission control shares one resource monitor and concurrency controller across both HTTP servers; over soft it queues, at a hard wall it sheds 503+Retry-After loss-free, exempting health endpoints", keywords:"admission_control 503_retry_after server_busy_backpressure why_did_a_request_get_shed shed_is_loss_free hard_wall_rss_disk", ocd:2026-07-12, lmd:2026-09-02]
3. **Admission control** (`src/resourceMonitor.ts` + `src/admissionController.ts`): both HTTP servers
   (UI :3000, OTLP :4318) share ONE monitor (RSS / per-core load / free disk, TTL-cached) + ONE
   bounded-concurrency controller. Over soft → queue (bounded + deadlined, NEVER blocks a caller
   unbounded); at a hard wall (RSS/disk over, queue full) → shed `503 + Retry-After`. **Shed is
   loss-free**: a shed hook spools (mech 1), a shed OTLP export is retried/backfilled, a shed gate
   fails OPEN. Exempt (always answer): `/events` SSE (long-lived — would drain the pool),
   `/api/server-stats` (health), GET `/api/hook-config` (kill-switch). Env-tunable + CPU-scaled;
   live counters on `/api/server-stats` (`admission`, `resources`, `hookEvents.spooled`).

**Load-bearing facts / gotchas:**
^QQM391B6 [desc:"HTTP handlers await admission.enter() at the top; Node keeps the POST body stream paused during the await so no body is lost across the admission gate", keywords:"async_handlers_await_admission post_body_not_lost node_stream_paused_during_await", ocd:2026-07-12, lmd:2026-09-02]
- The HTTP handlers are now `async` (they `await admission.enter()` at the top). Node keeps the
  request body stream PAUSED during the await, so no POST body is lost — proven by every real-boot
  POST test still passing through the gate.[^2]
^9C1IM3DC [desc:"the hook contract is sacred: agentlenspro hook/gate always exit 0 fast and never throw or block; the spool and detached revive are best-effort and fully guarded", keywords:"hook_contract_sacred exit_0_fast_never_block spool_and_revive_best_effort", ocd:2026-07-12, lmd:2026-09-02]
- The hook contract is sacred: `agentlenspro hook`/`gate` ALWAYS exit 0 fast, never throw/block. The
  spool + detached revive are best-effort and fully guarded.
^HEECJCYT [desc:"admission shedding is a cost/stability control, not security, and always fails toward availability (queue then shed then spool) rather than blocking a Claude launch", keywords:"admission_shedding_not_security fails_toward_availability never_blocks_claude_launch", ocd:2026-07-12, lmd:2026-09-02]
- Admission shedding is a COST/stability control, not security. It fails toward availability
  (queue→shed→spool), never toward blocking a Claude launch.
- See also [[agentlens-burn-token-model]] (the gate the admission controller sheds), [[cache-ttl-model]],
  [[dashboard-tree-render-topology]] (the same "rebuild needs a process restart" discipline
  applies to a new `/api/*` route here).

## Notes and lessons learned
[^1]: [id:ATOM-VERIFY-LOSS-VECTORS-FIRST, status:valid, keywords:"why_isnt_there_a_separate_ingestion_daemon jsonl_already_loss_less two_process_split_rejected verify_actual_loss_vectors_before_building", ocd:2026-07-12, lmd:2026-07-12] Phase 1 was PLANNED as a two-process split (separate ingestion
  daemon; dashboard a reader). During implementation the investigation surfaced that JSONL is already
  loss-less (offset backfill) and the split is high-risk for marginal benefit; flagged to the user,
  who chose the simpler hook-revive + spool. Lesson: verify the ACTUAL loss vectors before building
  a big architecture to fix an assumed one — most of "no log lost" was already true, so the remaining
  gap (OTEL + hooks during downtime) had a far cheaper solution than a process split.
[^2]: [id:ATOM-DETERMINISTIC-OVERLOAD-TEST, status:valid, keywords:"timing_dependent_overload_test_flaky admission_shed_did_not_trigger force_condition_deterministically_hard_rss_wall", ocd:2026-07-12, lmd:2026-07-12] a first admission integration test asserted a concurrent burst
  would shed — it did NOT, because `/api/summary` on an empty server is too fast for requests to
  overlap at maxInflight=2 (shedTotal=0). Lesson: never assert on timing-dependent overload in an
  integration test; force the condition deterministically (a 1 MiB hard RSS wall sheds every request
  regardless of overlap) and cover the timing-sensitive logic in unit tests instead.
