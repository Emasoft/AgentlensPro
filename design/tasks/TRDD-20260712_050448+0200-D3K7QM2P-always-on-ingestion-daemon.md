---
trdd-id: D3K7QM2P
title: Always-on no-loss ingestion — hook-revive + spool + resource-aware admission control
column: dev
created: 2026-07-12T05:04:48+0200
updated: 2026-07-12T05:04:48+0200
current-owner: claude-code-review
assignee: claude-code-review
priority: 2
severity: HIGH
effort: XL
labels: [ingest, resilience, daemon, hooks, backpressure, resource-monitor]
task-type: feature
parent-trdd: null
npt: []
eht: []
blocked-by: []
supersedes: []
superseded-by: []
relevant-rules: []
release-via: publish
delivery: pull-request
target-branch: main
merge-strategy: merge
must-pass-tests-before-merge: true
publish-target: npm
publish-channel: stable
test-requirements: [unit, integration, lint, typecheck]
audit-requirements: []
review-requirements: [code-review]
runtime-targets: [macos, linux]
impacts: [install-script, config-schema]
attempts: 0
test-failures: 0
last-test-result: not-run
last-test-at: null
implementation-commits: []
pr-url: null
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-07-12

**What this is:** Phase 1 of the /go-on-yourself plan — make ingestion always-on and
loss-less whenever any Claude instance is active, AND survive 20+ concurrent Claude
instances (plus their subagents) hammering the CLI/server without melting down.

**ARCHITECTURE DECISION (user-confirmed 2026-07-12, AskUserQuestion):** NOT a two-process
daemon/dashboard split. Instead: keep ONE supervised server process, kept always-on by the
hooks themselves, with a durable hook-spool so nothing is lost during any revive/overload
window. Rationale — VERIFIED facts:
- **JSONL transcripts are ALREADY loss-less.** Claude/Codex/Copilot write them to disk
  themselves (independent of AgentlensPro); `LogReader.scan()` tails them with PERSISTED byte
  offsets (`importFileState`) and backfills everything on restart. Server up or down, no JSONL
  is lost. So the two-process split's headline benefit was already met.
- **The only downtime loss vectors are (a) OTEL spans pushed to :4318 while nothing listens,
  and (b) hook events POSTed while the server is down (`forwardHookEvent` = silent no-op).**
- The server already has `runSupervise` (crash-restart + backoff + crash.log), `ensureServer`
  (detached spawn + 20s poll), and a pidfile single-writer guard (`IS_CANONICAL`, exits 1 on a
  second canonical instance). The two-process split would add store concurrency + SSE across
  processes + a migration — HIGH risk on a working 3200-line server for MARGINAL benefit.

So: hooks make the server always-on (each hook fires a detached, stampede-locked `ensureDaemon`),
the hook-spool + boot-drain guarantees zero loss even across the revive window, and a
resource-aware admission controller sheds/enqueues under overload WITHOUT loss (a shed hook
spools and is drained later).

## NEXT ACTION

Implement **sub-phase 1a** (hook durability) first — it is the foundation 1b/1c build on. TDD:
`src/test/hookSpool.test.ts` (spool-on-server-down, boot-drain reingests + deletes, stampede
lock). Then 1b (daemon CLI), 1c (resource monitor + admission), 1d (setup launchd + docs).
Gate each with `bash scripts/safe-deploy.sh --dry-run` (baseline 890/0); commit on a branch,
merge --no-ff. Do NOT push/tag — the v2.5.0 release is cut at the END of the whole plan.

## Design — sub-phases (each gated + committed + TDD)

### 1a — Hook durability: spool + revive + boot-drain  [FOUNDATION]
- `src/cli/hookHandlers.ts` `forwardHookEvent`: try the POST as today; on FAILURE (server
  down / timeout / 503-shed) → (1) durably append the raw payload to
  `DATA_DIR/hook-spool/<ts>-<rand>.json`, (2) fire a DETACHED, stampede-locked `ensureDaemon()`
  (never blocks the hook — exit 0 fast). A short-TTL lock file (`DATA_DIR/.daemon-revive.lock`,
  mtime-gated ~15s) collapses a burst of N hooks into ONE revive spawn; the server's pidfile
  guard is the backstop if two race. Spool is bounded (cap oldest-dropped LOUDLY) so a
  permanently-down server cannot fill the disk.
- `standalone/server.ts` boot: drain `DATA_DIR/hook-spool/` — reingest each file via the SAME
  `appendHookEvent` path `/api/hook-events` uses, then delete it (idempotent: a crash mid-drain
  leaves the rest for next boot). Runs after the hook-event store is initialized.
- Derived: the spool file format IS the raw hook payload; drain must parse it exactly as the
  handler does. Reuse the handler's parse, don't reinvent.

### 1b — `agentlenspro daemon start|stop|restart|status` + `ensureDaemon`
- `src/cli/serverControl.ts`: `ensureDaemon()` = `ensureServer()` + the stampede lock;
  `daemonCommand(argv)` maps start→supervised server, stop→stopServer, status→showStatus + the
  spool depth + resource snapshot. `server`/`dashboard` verbs auto-ensure the daemon first.
- `src/cli/main.ts` / help: wire the `daemon` verb; document it (it is the always-on ingestion
  role — same process as the server, named for the mental model the user asked for).

### 1c — Resource monitor + admission control (backpressure, NO loss)  [NEW USER REQ 2026-07-12]
- **Monitor** (`src/resourceMonitor.ts`, new, runtime-neutral where possible): sample RSS
  (`process.memoryUsage`, reuse `heapPressure`), CPU/load (`os.loadavg()` / cpuCount), free disk
  on DATA_DIR, and in-flight request count. Cheap, cached (~1s), exposed on `/api/server-stats`.
- **Admission controller** on the server's request path (before the heavy handlers — OTLP
  ingest, /api/hook-events, /api/agent-gate, /api/* reads): when over a SOFT limit → ENQUEUE the
  request in a bounded FIFO and serve it when capacity frees; over a HARD limit or queue-full →
  shed with `503 + Retry-After`. Limits are env-configurable
  (`AGENTLENS_MAX_INFLIGHT`, `AGENTLENS_MAX_RSS_MB`, `AGENTLENS_MIN_FREE_DISK_MB`, `AGENTLENS_LOADAVG_MAX`).
  Composes with 1a: a shed hook (503) spools + is drained later → backpressure WITHOUT loss.
  OTLP shed is safe too (the exporter retries / the next scan backfills). Gate checks fail-open
  (a shed gate returns '' = allow — never blocks a launch).
- Derived: the CLI hook/gate timeouts are short (1-2s); the admission queue must serve or shed
  WITHIN that budget so the hook never hangs a tool call. Queue wait has its own deadline →
  on deadline, shed (→ spool). Never unbounded-block a caller.
- Derived: 20 instances × N subagents each firing PreToolUse gate + hook + OTLP is the design
  load. Test with a concurrent burst; assert no unbounded memory, no crash, no lost hook.

### 1d — setup installs launchd supervision + docs
- `src/cli/setup.ts`: install/verify a per-user launchd agent (macOS) /
  systemd-user unit note (linux) that runs `agentlenspro daemon start --supervise`, so the
  always-on daemon survives logout/reboot. Idempotent, via safeConfigEdit-class atomic writes.
- Docs/help/README/ARCHITECTURE/CHANGELOG/wikimem: the always-on model, the spool, the
  admission controller, the `daemon` verb.

## Load-bearing facts / gotchas
- Same Node split + gate as the rest: `bash scripts/safe-deploy.sh --dry-run` (Node 20 for
  mocha; pnpm crashes under Node 20). Real-boot tests need `node esbuild.js` FIRST (the gate's
  --dry-run does NOT rebuild the bundle) — the standalone/*.test.ts boot the built server.
- Hook contract is SACRED: `agentlenspro hook`/`gate` must ALWAYS exit 0 fast and never fail a
  tool call. Spool + detached revive must never block or throw into the hook.
- `appendHookEvent` (src/hookEventStore) is the ONE hook-event writer; the boot-drain reuses it.
- `heapPressure()` + `RequestLog` (src/serverRuntime) already exist — build the monitor on them.
- The pidfile guard already guarantees single-writer for the canonical instance; the revive
  stampede lock is an optimization on top, not the correctness mechanism.

## Approval log
- 2026-07-12 — architecture confirmed by USER via AskUserQuestion: "Hook-revive + spool
  (recommended)" over the two-process split, after the orchestrator surfaced that JSONL is
  already loss-less and the split is high-risk for marginal benefit.
- 2026-07-12 — USER added mid-flight: a resource monitor + request admission/enqueue control
  for 20+ concurrent Claude instances (+ subagents). Folded in as sub-phase 1c.
