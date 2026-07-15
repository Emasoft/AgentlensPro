# Changelog

All notable changes to AgentlensPro are documented here.

> **Lineage note:** AgentlensPro continues the history of [AgentLens](https://github.com/RogerReed/agentlens), from which it was forked. Entries below that predate the fork refer to the original AgentLens lineage.

## [Unreleased]

## [2.7.0] - 2026-07-15

### Added

- **`get_window_eta` — how long until the current account exhausts its rate-limit windows, by COST.**
  `agentlenspro get_window_eta` projects time-to-exhaustion on dollars, not tokens: Anthropic meters
  the 5h/7d windows by cost (cache-read weighted ~0.1×), so a token projection over-counts the
  ~96%-cache-read stream. Returns both windows with consumed $ vs the calibrated $ cap, % used, the
  account's current $/min (over `--rate_window_min`, default 30), an ETA, and marks which window
  EXHAUSTS FIRST. It models the ROLLING window correctly: a window sheds consumption older than its
  length, so at a steady rate it plateaus at rate×length — if that is below the cap the window
  **cannot** exhaust at that rate and the tool says so (a plateau, not a fictional countdown) rather
  than reporting an impossible multi-window ETA. The rate is the account's own burn (rate limits are
  per OAuth account); capacity is the account's observed calibration, else a same-plan account's as a
  labeled proxy, else no ETA is projected (never guessed). (TRDD-8ZMZ4I6B)

- **`get_account_burners` — who exhausted a given OAuth account's rate-limit windows.** After a
  forced account rotation, `agentlenspro get_account_burners` (default `--account previous`) answers
  in one call with BOTH windows — a 5h table and a 7d table, each grouped by PROJECT/agent (sessions
  pooled by workspace, so a restarted agent stays one row) with share%, billable-weighted equiv
  (input×1, output×5, cacheRead×0.1, cacheCreate×1.25), cost, explicit **cache-created** and
  **cache-read** token columns, session count and top model; per-session rows ride in the JSON. The
  window nearer/over its calibrated capacity at the rotation moment is marked **MOST LIKELY
  EXHAUSTED** (the rotation trigger) — capacity from the account's own auto-calibration, else a
  same-plan account's as a labeled proxy, else the verdict says undetermined rather than guessing.
  `--interval` chooses the window end: `last` (default — the account's rotation-out moment, the
  windows it last filled), `current` (ongoing, ends now), or an ISO date (the windows ending at that
  instant). Attribution is TIME-based against the machine's account-state timeline (one OAuth token
  is active machine-wide at a time), so a session alive across a rotation splits correctly between
  the two accounts instead of pooling onto one card. Fills the gap between `investigate_burn`
  (window culprits, but no account filter) and `get_window_budget` (per-account, but no ranking).
  Coverage gaps are disclosed — totals older than the event sources reach are labeled a lower bound.
  (TRDD-1XM0YSWQ)

- **`get_body_writers` — which sessions are still writing raw OTEL bodies, ranked.** A session keeps
  its launch-time `OTEL_LOG_RAW_API_BODIES` env until restarted, so stale sessions keep writing
  ~0.7–1.9 MB request bodies per LLM call. The new diagnostic (`agentlenspro get_body_writers
  [--window_min 30] [--active_min 10] [--limit 20]`) names each writer session with its workspace and
  model, its recent write rate (MB/min over the window), an `active` flag (wrote within
  `--active_min`), and its total bytes — ranked by rate, then total, so the terminals to restart are
  the top rows. Attribution unit is the request body (its tail carries `session_id`; responses carry
  no session metadata and are reported in aggregate, never guessed). Totals are the exact union of
  the ingested store history and not-yet-ingested live files — a file present in both is counted
  once — and a down/absent store degrades to live-dir-only with an explicit note. (TRDD-1FEIW17E)

- **`check_cache_expiry` — is a session's prompt cache expired yet?** A new diagnostic that
  measures idle time since a session's last LLM (`api_request`) call and compares it to that
  session's TTL — 1h for a subscription main conversation, 5min for a subagent (always) or a
  usage-credits/API session — so `expired` means the cached prefix was likely evicted and the next
  request pays a full cache-creation write (~1.25× the prefix). Per session it returns `verdict`
  (fresh|expired|unknown), `idleHuman` (e.g. "1h 12m"), `ttlMin`/`ttlSource`/`ttlBasis` (the same
  honesty contract as the rest of the TTL surface — unknown auth surfaces an `assumed` 5-min floor,
  never a silent guess), `lastRequestAt`, and a human `reason`. Default target is the newest MAIN
  session (`agentlenspro check_cache_expiry`); `--all` covers every session, `--sessionId <id>` one,
  and `--thresholdMinutes N` overrides the TTL with an explicit cutoff (e.g. `60` to probe "> 1h
  idle"). Reuses the doc-verified TTL classifier (`src/shared/cacheTtl.ts`) — no TTL number is
  re-declared. Pure core in `src/cacheExpiry.ts` (15 unit tests). (TRDD-OCNHOHE9)

- **Global kill switch — `agentlenspro disable [reason]` / `agentlenspro enable`.** A single flag
  file now disarms every hook, the burn-gate, server auto-revive, and background ingestion in
  **every** Claude Code session already running, on that session's very next hook fire — no
  restart needed, which a `settings.json` edit cannot achieve (a running session keeps using the
  config it loaded at launch). `disable` also stops a running server and turns raw-body capture
  off (removing `OTEL_LOG_RAW_API_BODIES` from `settings.json`), so "disabled" actually means
  nothing is still writing. `enable` clears the flag; hooks resume on their next fire.
  (TRDD-K3WDPR7M)

- **Raw-body capture is now opt-in, off by default.** `agentlenspro config set captureRawBodies
  on|off` (env `AGENTLENS_CAPTURE_RAW_BODIES`) toggles it. Turning it on (macOS only) mounts a
  RAM-disk spool (`AgentLensSpool`, 2 GB default, `AGENTLENS_SPOOL_MB` to resize), points
  `OTEL_LOG_RAW_API_BODIES` at the spool instead of a real disk path, and installs a boot-remount
  LaunchAgent (`agentlenspro spool ensure`) so a reboot doesn't strand capture pointed at a
  vanished RAM disk. If the RAM disk cannot be created, capture is refused rather than silently
  falling back to writing raw bodies to the SSD. Previously this was force-armed on every server
  boot with no way to turn it off. (TRDD-BKF5NZD3)

- **Content-addressed body store — fileless DuckDB → immutable zstd Parquet.** Captured bodies are
  now ingested into `<dataDir>/store/` and deduplicated across turns instead of accumulating as
  loose JSON files or feeding an ever-growing gzip archive. A body is deleted from its source only
  after it is proven to reconstruct byte-identically from the durable store (verify, then delete).
  Measured on this project's own captured history: ~52 GB of raw bodies (live capture plus the
  drained legacy `.wad` archive) compressed to ~270 MB of Parquet on disk (~190×), with every body
  verified byte-identical at ingest time, then re-proven by an independent full-corpus validation
  sweep — 328,606/328,606 spans content-address OK and 100,600/100,600 bodies reconstructing to
  the exact sha256 of their original source files, zero dangling references
  (`reports/storage-migration/20260715_003054+0200-backfill-and-drain.md`). A smaller,
  independently-run dry run measured 167× (4.00 GB → 24 MB, 7,439/7,439 bodies verified).
  `--export-bodies` now reads from both the store and the legacy `.wad` archive (kept as a
  read-only fallback, never deleted automatically), so a time-window export can no longer silently
  miss a body that has already been reclaimed from disk. (TRDD-K3WDPR7M)

- **Delta persistence for session/offset state.** `log-sessions.json` and `log-offsets.json` no
  longer get rewritten in full on every save — previously ~9.4 MB/min of device writes combined,
  regardless of how much actually changed. Only the records that changed are now appended to a
  delta log, with periodic compaction back into a fresh snapshot. (TRDD-K3WDPR7M)

- **Verify-before-delete is now a universal invariant, not just a body-store rule.** Every code
  path that deletes a source after ingesting it first proves the durable store holds *all* of that
  record's data — the exact bytes *and* the `(src_name, capture-time)` row (±2s) — through one
  shared gate (`src/store/verifyInStore.ts`) so the bar cannot drift apart per call site.
  Byte-identity alone is not enough: the first backfill held every byte perfectly (hash-proven
  twice) while stamping 100,600 rows with ingest time instead of capture time, so a bytes-only gate
  would have blessed broken metadata. The gate now guards the live/spool reclaim, the legacy `.wad`
  drain, the retention purge, and the explicit purge endpoint. Two lifecycle sources previously
  trusted on faith are now gated the same way: appended hook-event lines are read back from their
  daily bucket byte-for-byte before the spool file is unlinked, and delta-log compaction re-parses
  the candidate snapshot from disk (record count + per-record hash) before the delta is dropped, so
  a short or corrupt snapshot write aborts with the old snapshot and the delta both intact. A hook
  payload that can never ingest (unparseable, or rejected with a 400) is now **quarantined** to
  `hook-spool/rejected/` rather than deleted — it is still data. `POST /api/bodies/purge` now
  verifies each archive volume individually and returns `{removed, kept, freedBytes}`; an unproven
  volume is kept and named, and the `.idx` sidecars are always retained. (TRDD-K3WDPR7M)

- **Store schema v2 — capture-time recovery.** A staged migration (`src/store/tsRecovery.ts`,
  `migrate.ts`, `CURRENT_SCHEMA=2`) corrects `body.ts` from the archive `.idx` sidecars' ground
  truth and materializes **alias rows** so content captured under several names has one queryable
  row per name — previously content-dedup meant the second and later names got no row at all. It
  runs the store's crash-safe migration protocol (build in `<dir>.migrating`, full validation,
  body-id set-equality, atomic swap, old store kept as `.old-v<from>`) and aborts with the live store
  untouched on any alias it cannot prove. **Not every timestamp is recoverable, and the docs do not
  pretend otherwise:** of the ~100,600 backfilled rows, the ~78,031 that join an archive `.idx` can
  be corrected to their true capture time, but the remaining ~22,569 were reclaimed from live files
  that had already been deleted (no `.idx` to recover from) — their capture times are unrecoverable,
  so those rows keep their ingest-time `ts`. Inventing a capture time would be fabrication. Related:
  `ingestBody` now records a `(src_name, ts)` row for every capture event even when the content
  dedups, so a duplicate-content capture is still queryable by name and can pass the
  verify-before-delete gate. (TRDD-K3WDPR7M)

### Fixed

- **Server CPU spin under sustained load.** The dashboard rebuild is now memoized (an unchanged
  model is not rebuilt), and log scanning is now targeted at the specific paths `fs.watch` names
  instead of a full directory sweep on every tick, with a 60-second full sweep kept only as a
  correctness backstop for events the watcher coalesces or misses. Measured under identical
  synthetic load: 17.1% → 3.0% CPU with one writing session, 28.8% → 8.2% with four.
  (TRDD-X2E6OSWK)

- **Transcript tailer could resume mid-file on a replaced transcript.** Claude Code ≥2.1.208
  prunes superseded file-history backups from session transcripts (replace-by-rename ⇒ new
  inode), breaking the old append-only assumption. The live tail's resume guard checked only
  that the file had not shrunk — a prune combined with an append inside one scan interval can
  leave the new file at least as large as the old read offset, and the tailer would then resume
  mid-file on a different file, welding misaligned bytes onto the stale session accumulator.
  The resume guard now also requires the inode to match (the boot-time offset import already
  did); any replacement rebuilds the card from offset 0. (TRDD-K3WDPR7M)

- **The bundle build silently never shipped the body store.** `@duckdb/node-api` loads prebuilt
  native `.node` binaries that esbuild cannot bundle, so every build since the store landed
  failed — and because a failed esbuild leaves the previous outfile untouched, the stale
  `standalone/server.js` looked current while containing none of the new code. The package is now
  marked `external` in both node bundle targets and resolves from `node_modules` at runtime (it is
  a declared runtime dependency — the same stance `sql.js` already takes). (TRDD-K3WDPR7M)

## [2.6.0] - 2026-07-13

### Added

- **`agentlenspro env` — environment/system detection surface.** A new client-side diagnostic
  (no server needed) that reports the full nature of the runtime environment, queryable one facet
  at a time or all at once as a single JSON report. `--out FILE` writes the full JSON to disk and
  prints only a one-line digest, keeping big reports out of the terminal / an agent's context.
  Ten facets: **terminal** (hosting terminal by *process ancestry* — iTerm/Ghostty/WezTerm/kitty/
  Alacritty/Warp/Hyper/Windows Terminal/macOS Terminal/VS Code/tmux — not `$TERM_PROGRAM`, which
  lies across subshells/ssh/multiplexers — plus ai-maestro agent, multiplexer, ssh, tmux),
  **os**, **runtime** (CI runner, container/dev-container/WSL/sandbox, Claude Code context),
  **claude** (config dir, settings permission summary, plugins, CLI version), **filesystem**
  (fs type, git repo + worktree main-vs-linked + branch, free disk), **user**, **network**
  (interfaces, VPN incl. Tailscale, proxy, DNS, listening ports, gateway — no outbound calls),
  **cloud** (AWS/Azure/GCP via env/config/CLI — never contacts a metadata server), **tooling**
  (runtimes, package managers, compilers, linters, version managers), **mcp** (configured MCP
  servers). Every detector is fail-soft and time-boxes its probes. `agentlenspro env list` shows
  the facets. New "Environment diagnostics" section in the README.

### Changed

- **`agentlenspro-diagnostics` skill + README** now document the `config` (data retention) and
  `env` (environment detection) commands with recipes and use cases, so the full CLI surface is
  covered.

## [2.5.1] - 2026-07-13

### Added

- **Persistent, discoverable data-retention config.** Retention was already tunable via the
  `AGENTLENS_*` environment variables, but env vars are ephemeral and never reach the launchd
  daemon. A new `agentlenspro config` CLI now reads and writes the five retention knobs
  (`spansRetentionDays`, `summaryWindowHours`, `bodiesMaxAgeHours`, `bodiesMaxGb`,
  `bodiesRetentionDays`) to a persistent `~/.agentlens/config.json` that survives an
  uninstall/upgrade/CLI-path-change like the data it governs, and the always-on daemon re-reads
  it every boot. `agentlenspro config` lists every knob with its effective value and source;
  `config get <key>` / `config set <key> <value>` inspect and persist one. The server resolves each
  knob at boot with the precedence **env var > config.json > built-in default** (env stays the ops
  override), each value min-floored. A `set` on a corrupt config file refuses to write rather than
  clobbering it. New "Data retention" section in the README documents all five knobs.

## [2.5.0] - 2026-07-12

### Added

- **Dashboard custom datetime range.** The time-range picker gains a `15m` quick preset and explicit
  from/to `datetime-local` inputs (local time) for an arbitrary custom window, plus an active-window
  chip showing the exact selected range. Setting either input switches to a `custom` range and fires
  the same server query as a preset. (Text/agent/type/workspace filtering was already instant —
  Preact computed signals recompute on every keystroke with no debounce.)
- **Always-on, no-loss ingestion + resource-aware admission control (D3K7QM2P).** Ingestion now
  survives the server being down AND 20+ concurrent Claude instances hammering it:
  - **Durable hook-spool + auto-revive.** A hook event that can't be delivered (server down, or shed
    under load) is now spooled to `~/.agentlens/hook-spool/` and a detached, stampede-locked server
    revive is fired, instead of being silently dropped. The server reingests the spool on boot and on
    a slow tick, so nothing a live Claude instance emits is lost across the revive window. (JSONL
    transcripts were already loss-less via offset-backfill; this closes the OTEL/hook gap.)
  - **`agentlenspro daemon start|stop|restart|status|install|uninstall`.** Names the always-on
    ingestion role (the same process as the server); `status` shows the hook-spool depth; `install`
    sets up a launchd agent (macOS) to keep it up 24/7 across reboot (opt-in — hooks already revive
    it whenever Claude is active).
  - **Admission control.** Both HTTP servers (UI :3000, OTLP :4318) share a resource monitor
    (RSS / per-core load / free disk) and a bounded-concurrency controller that queues overflow
    briefly and sheds (`503 + Retry-After`) only at a hard wall — never blocking a caller unbounded.
    Shedding is loss-free (a shed hook spools, a shed OTLP export retries, a shed gate fails open).
    `/events`, `/api/server-stats`, and the hook-config kill-switch read are exempt; limits are
    env-tunable and CPU-scaled. `/api/server-stats` now reports live admission + resource counters.
- **Copy a fully-expanded branch tree from the dashboard.** Each session in the Sessions detail —
  plus every sub-agent branch and the Flow view — gains a **⧉ tree** button that copies the whole
  branch (the session and its recursive sub-agents, every timeline step, thinking/response/tool I/O)
  as a self-describing TEXT tree. The header carries the session id + project slug + source; every
  LLM/tool node carries a grep-able **OTEL match key** `⟨span=… req=… trace=…⟩` so the raw OTEL
  request is trivially found; and any node whose output exceeds ~8 KB is written to a dump file under
  `~/.claude/projects/<slug>/agentlens-branch-dumps/` — via the new localhost-only
  `POST /api/branch-dump`, confined to the Claude projects tree (slug must name a real project dir;
  path-traversal + CSRF guarded) — with its path substituted inline, keeping the clipboard small
  while preserving the full output on disk.

### Fixed

- **Hook-revive stampede lock no longer re-arms on a just-written lock.** The freshness check used
  `age >= 0 && age < TTL`, but `fs.statSync().mtimeMs` carries sub-ms precision while `Date.now()`
  truncates to integer ms — so a lock written in the same millisecond as the check reads a tiny
  *negative* age (~97 % of the time on a fast machine), failed the `>= 0` guard, and was treated as
  stale. A burst of hooks then each fired a revive instead of collapsing to one (benign — the server
  pidfile rejects a second instance — but a real defect). The window is now `[−skew, TTL)` with a 2 s
  clock-skew tolerance.

### Changed

- **Codex per-prompt grouping — the two drift-prone atoms are now single-sourced.** The
  prompt-cycle event predicate and the `codex:<conv>:prompt-N` key format were duplicated
  between the ingest-side `CodexSessionNormalizer` and the summarizer's batch grouper
  (`groupCodexSpansBySession`); both now share one definition, so the ingest store-key and the
  user-visible `/api/summary` grouping cannot diverge on those. The two grouping *algorithms*
  intentionally stay distinct (a streaming resolver vs a batch grouper) — a full merge was
  rejected because it would change the summarizer's output; a new characterization test locks
  that output. No user-facing behavior change.

### Added

- **Assistant response text for gen_ai agents (Codex/OpenAI) in the dashboard (S3-F3b).** The
  gen_ai_latest_experimental instrumentation emits the assistant's reply as a separate
  `gen_ai.choice` / `gen_ai.assistant.message` log event correlated to its LLM span by
  traceId:spanId — which the shipped standalone ingest path previously DROPPED, so those
  sessions showed no response text. The server now formats that event into `gen_ai.output.messages`
  and merges it into the matching span via a new read-time attribute overlay on the segmented
  span store (`SegmentedSpanStore.injectSpanAttribute`), applied when the span is read so the
  event may arrive before or after the span and no persisted segment is ever rewritten. The
  formatter is now the one shared `src/genAiContent.ts` both ingest paths import (no duplicate).
  New read-only localhost debug endpoint `/api/debug/span-attr` exposes one stored span attribute
  for verification.

## [2.4.1] — 2026-07-11

### Fixed

- **Docker image build (broken since 2.3.1).** The Dockerfile's builder stage copied
  `media/dashboard.css` from the build context, but that file became a gitignored esbuild
  build artifact in 2.3.1 — so it is absent from a clean checkout and `docker build` failed
  with `"/media/dashboard.css": not found`. Both the v2.3.1 and v2.4.0 image publishes
  failed as a result, leaving `ghcr.io/emasoft/agentlenspro:latest` stuck at 2.3.0. The
  stale `COPY` is removed (esbuild generates the CSS in the builder stage and the runtime
  stage copies it from there), and `media/dashboard.css` is added to `.dockerignore`
  alongside its `dashboard.js` sibling so the build context matches the git checkout.
  Verified with a local `docker build`. The npm package was unaffected — 2.4.0 published
  normally; 2.4.1 is functionally identical on npm (the Dockerfile is not in the tarball).

## [2.4.0] — 2026-07-11

Round-2 remediation of the whole-codebase code review (TRDD-4AFOFVFD), plus a security
hardening surfaced during the follow-up evaluation.

### Security

- **Scoped the dashboard server's `Access-Control-Allow-Origin` to allowed origins (TRDD-F6BM1BDI).**
  The standalone UI server previously returned `Access-Control-Allow-Origin: *` on every response.
  The CSRF guard added earlier only refused cross-origin *writes*; reads were left open, so any web
  page you happened to be browsing could `fetch("http://localhost:<UI_PORT>/api/summary")` and read
  your local AI-session data (prompt text, costs, model names, project file paths) cross-origin. The
  server now echoes `Access-Control-Allow-Origin` only for same-origin / loopback origins (reusing the
  existing `isDisallowedCrossOrigin` predicate) plus `Vary: Origin`; a cross-origin page receives no
  CORS header, so the browser blocks it from reading the response. The same-origin dashboard and
  loopback tooling are unaffected — there was no legitimate cross-origin browser consumer.

### Fixed

- **Unified Codex per-prompt session grouping into one shared normalizer (S3-F3a).** The three
  OTLP-log ingest paths — `standalone/server.ts` `processLogs` (the shipped npx/Docker path),
  `src/otlpCollector.ts`, and `src/otlpParser.ts` — each carried their own copy of the
  `codex:<conversation>:prompt-N` grouping logic, and the shipped path had drifted to group Codex by
  conversation id alone. The logic now lives once in the new `src/codexSessionNormalizer.ts`
  (net −158/+79 LOC); the shipped path groups per prompt and stamps `codex.session.id`. No change to
  summarized sessions (the summarizer re-derives per-prompt grouping downstream) — this removes
  duplication and closes the ingest-side drift.
- **Cache-break waste uses the model's own cache-read rate (S2-F5)** — `priceWaste` no longer
  hardcodes a 0.1× cache-read multiplier, so non-0.1× models (e.g. codex-mini at 0.25×) report the
  correct wasted figure.
- **`SessionStore.tokensUsed` no longer double-counts (S1-F7)** — one token-key family per provider
  instead of summing native + `gen_ai.*` + cache + output into one scalar.
- **`tool_result` attributed to its own `toolUseResult` (S1-F8)** — a multi-`tool_result` user entry
  no longer attributes one entry-level usage to every block.
- **Per-turn fast-mode pricing (S1-F9)** — a single fast turn no longer flips a whole mixed session
  to `-fast` pricing; each turn is priced at its own speed.
- **OpenCode WAL commit-boundary (S1-F6)** — `_mergeWal` now stops at the last committed frame, so an
  in-flight (uncommitted) transaction can no longer surface as committed rows.
- **Race-safe hook install (S3-F5)** — hook installation appends via `append_unique` instead of
  rewriting the whole `hooks.<event>` array from a stale snapshot, so a foreign hook added
  concurrently is preserved.

### Added

- **`GET /api/debug/codex-store-groups`** — a read-only, localhost-only debug endpoint returning the
  distinct stored `codex.*` span trace IDs, exposing the ingest-level Codex grouping that the summary
  API masks (added to make the S3-F3a store-grouping directly testable).

## [2.3.1] — 2026-07-11

### Fixed

- **Docs consistency audit (TRDD-1758VB34)** — brought the documentation in line with the shipped
  TTL-regime model. `ARCHITECTURE.md`'s keepWarm section no longer claims a fixed "~5 minutes
  (`CACHE_TTL_MS`)" cache TTL (that constant was removed by the TTL work) — it now describes the
  per-session `TtlRegime` (1h subscription main / 5m subagent+usage-credits+API / fork inherits) and
  `computeKeepWarm(timeline, regime)`. The diagnostics skill's `COLD_RESUME_RISK` row is regime-aware
  (subagents always ride the 5-min tier even when the main session is on the 1-hour tier). Verified
  every doc command reference (`pnpm run local`/`capture`/`demo`/…) still exists.

### Changed

- **`media/dashboard.css` is now a gitignored build artifact (TRDD-1758VB34)** — it is an esbuild
  output (bundled from `media/src/styles/*.css` via the dashboard entry's CSS imports), so it was
  dirtying the tree on every build while ALSO being git-tracked — two owners. It now joins its already-
  ignored siblings (`media/dashboard.js`, `standalone/*.js`, `media/dashboard.css.map`); the single
  owner is `media/src/styles/*.css`. The publish workflow builds before `npm pack`, so the tarball
  still ships a freshly-built CSS (it stays in the `files` allowlist).

## [2.3.0] — 2026-07-11

### Added

- **Account-state timeline (TRDD-YQZ9P8IL)** — every past request/span is now attributable to the
  subscription state (account / billing mode / plan / cache-TTL regime) that was active AT THAT TIME,
  without hammering the SSD. The state is a slowly-changing dimension, so it is logged as a
  change-detected append-only timeline (`~/.agentlens/account-state.ndjson`) — one record only when
  the DISCRETE dims change (account/mode/plan/ttl), never per-request. The continuously-moving 5h/7d %
  are deliberately excluded from the change key (query them live). Result: ~a few disk writes/hour, not
  thousands. An in-memory buffer flushes on a 60-second timer (tunable via
  `AGENTLENS_ACCOUNT_STATE_FLUSH_MS`), at 32 records / ~16 KB, or on graceful shutdown (SIGTERM);
  fsync is once per batch, never per record. A restart into an unchanged state does not re-log it.
- **`get_account_state_at` diagnostic tool** — resolves "which account/mode/plan/TTL was I on at
  instant T" by binary-searching the timeline (last record with `ts <= T`). Accepts a ms-epoch `ts` or
  an ISO-8601 `iso`; returns the matching state or null (never a fabricated state) when the timeline
  doesn't reach that far back.

### Changed

- Plan/mode formatting (`describePlan`/`describeAccountMode`) and the auth-regime resolver now live in
  one module shared by `get_account_status` and the timeline sampler — a single source of truth (no
  drift between the live status and the recorded state).

## [2.2.0] — 2026-07-11

### Fixed

- **Cache-TTL misclassification on subscription accounts (TRDD-VY1IUVUM)** — `resolveAuthRegime`
  compared `billingType === 'subscription'` EXACTLY, but the real `~/.claude.json` oauthAccount value
  is `stripe_subscription` (Anthropic prefixes the billing shape with the payment processor). Every
  subscription account fell through to the API-key branch → the wrong 5-min cache TTL → the burn-gate
  and keepWarm emitted FALSE cold-rewrite warnings on sessions that actually ride the 1-hour tier. Now
  any billingType whose lowercased value CONTAINS `subscription` resolves to the subscription regime
  (also survives any future processor prefix). Regression-tested.

### Added

- **TTL-aware cache diagnostics (TRDD-VY1IUVUM)** — the doc-verified TTL matrix lives in ONE runtime-
  neutral module (`src/shared/cacheTtl.ts`): main+subscription = 1h, usage-credits/API/subagent = 5m,
  fork inherits the parent, `FORCE_PROMPT_CACHING_5M`/`ENABLE_PROMPT_CACHING_1H` overrides honored.
  keepWarm, the burn-gate COLD_RESUME/COLD_FORK, and gap-based warnings now classify against the
  session's resolved regime instead of a hardcoded 5-min constant, each number stamped with a
  `ttlSource` (`doc-matrix`/`config`/`measured`/`assumed`) — the measured falsifier flips to
  `measured` when observed cache behaviour contradicts the assumption. No silent guesses.
- **`get_account_status` Part-5 enrichment** — now returns a one-line human `summary` plus `plan`
  ("Max 5x"/"Max 20x"/"Pro" from planType + rateLimitTier), billing `mode` (subscription-within-plan
  vs drawing-usage-credits vs API pay-per-token), the session `cacheTtl` {minutes, regime, ttlSource},
  and `usageWindows` {fiveHourPct, sevenDayPct, windowSource} — Claude Code's own `rate_limits`
  utilization when the statusline persists it (`windowSource: cc-rate-limits`), else AgentlensPro's
  calibrated pct (`calibrated`), else null (`none`) — a null is NEVER presented as 0.
- **SKILL.md "Cache TTL tracking" section** — the matrix, how to read the TTL-aware output (the four
  `ttlSource` values), true cold rewrites (full-prefix spikes) vs normal suffix writes, and the audit
  one-liners.

## [2.1.0] — 2026-07-11

### Added

- **`get_agent_tokens` diagnostic tool (TRDD-9YT1UR2F)** — exact tokens + cost for ONE agent:
  `agentlenspro get_agent_tokens --agentId <id>` (also on the MCP surface; the CLI picks it up
  from the live schema automatically). Accepts a bare agent id, its `agent-<id>` transcript
  form, or a full sessionId — case-insensitive; optional `--parentSessionId` scopes the lookup;
  an ambiguous id returns an error LISTING the candidates, never a silent guess. Returns the
  four disjoint billing buckets + `totalTokens`/`cost_usd` under the exact same conventions as
  `get_subagent_tree` children (cross-tool consistent by construction, asserted in tests),
  spawn metadata (`spawnKind`/`warm`/`model`/`parentSessionId`/`spawnedByTurn`), P7
  `tokensSource`/`coverageNote` provenance, and `ccDisplayEquivalent` — the reconciliation
  block for Claude Code's per-agent ↓ footer, whose semantics were empirically decoded
  (2026-07-11): **CC's ↓ ≈ `cumulativeInputSideTokens`** (cumulative
  input+cacheRead+cacheCreation across ALL the agent's turns, launch turn included — a fork's
  turn-1 inherited-prefix cache read dominates it; output excluded or below CC's 0.1k display
  rounding). The ↓ figure is volume moved, not billing — `cost_usd` is the spend figure;
  `lastTurnContextRead` is the live context-size proxy. Zero buckets on an async child with no
  transcript stay flagged `asyncTokensUnknown` (unknown, never measured-free).

## [2.0.0] — 2026-07-11

ONE executable + the `setup` verb (TRDD-7284WCW7).

### Breaking

- **The package now publishes exactly ONE bin: `agentlenspro`.** The bins
  `agentlenspro-cli`, `agentlenspro-hook`, `agentlenspro-gate`, and
  `agentlenspro-heartbeat-cost` are removed, along with the loose scripts they wrapped
  (`spy-agentlens*.{sh,mjs}`, `agentlens-up.sh`, `agentlens-supervise.js`, `install.sh`,
  `configure-*.{sh,ps1}`). Everything is a subcommand of the single executable:
  `agentlenspro setup | server start|stop|restart|status [--supervise] | dashboard | hook |
  gate | heartbeat-cost | telemetry | list | help <tool> | <tool> …` plus the existing
  `--install-otel/--install-hooks/--install-skill/--start-server` flags. Bare
  `npx agentlenspro` still runs the server in the foreground, `~/.agentlens` and every
  `AGENTLENS_*` env var are unchanged.
- **Hook registrations are now the command strings `agentlenspro hook` / `agentlenspro gate`.**
  Registrations written by earlier versions (the v1 `agentlenspro-hook`/`agentlenspro-gate`
  PATH bins and the v0 absolute-path `spy-agentlens*` entries) are auto-migrated by
  `agentlenspro setup` or a re-run of `--install-hooks`; `--uninstall-hooks` strips every
  generation.

### Added

- **`agentlenspro setup [--dry-run] [--yes]`** — the idempotent installer/repairer:
  detect → converge → verify-per-step → final end-to-end self-test. Every step re-verifies
  real state through an independent path (fresh JSON re-parse after safeConfigEdit, sha256
  compare after the skill copy, HTTP/pid/span-count probes after a server start, EXECUTION of
  the registered hook commands against synthetic payloads), fails fast non-zero on any
  verification failure, and repairs broken/maimed installs: missing/wrong/truncated telemetry
  env, duplicated or stale hook registrations of every past generation, skill content drift,
  corrupt `forensics.db` (backed up aside as `.corrupt-<ts>` — data is never wiped), and
  old-generation `agentlens-dashboard` installs (removal gated on `--yes`). A second run is
  all no-ops. The final self-test posts a synthetic OTLP span and reads it back through
  `get_recent_sessions`, then runs the hook + gate handlers against synthetic stdin payloads,
  reporting a per-step unicode result table.
- **`agentlenspro --version` / `-v` and `--help`** answer from static data with ZERO side
  effects — no data-dir creation, no server checks (previously `npx agentlenspro --version`
  booted the span store and exited 1).

### Fixed

- **`--install-otel` now delegates to the telemetry-config module** instead of a second
  hand-synced env-key table (which had already drifted — it lacked
  `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`); uninstall now restores pre-existing values
  byte-identically instead of blind-deleting keys.

## [1.0.1] — 2026-07-11

Five field defects found dogfooding the P6 burn-gate + cache diagnostics (all live-verified).

### Fixed

- **Burn-gate: keep-warm pinger allowance (user order).** A fork (or type-less) launch whose
  prompt matches the keep-warm signature is never denied — every deny state (THRASH_ACTIVE,
  COLD_RESUME, FORK_STORM, fan-out) downgrades to at most an advisory. The pinger prevents the
  cold cache the gate guards against; under COLD_RESUME it *is* the warm-up.
- **Burn-gate: cache-thrash is now attributed per SOURCE session.** THRASH_ACTIVE requires the
  SAME session re-writing its prefix ≥3× in the window; N distinct fresh sessions' one-time
  cold-start writes are reported as FAN_OUT_COLD_START (advisory only). Fixes the measured
  false positive that blamed 4 freshly-spawned agents' cold starts (~463k tokens) while the
  parent read its cache warm.
- **Burn-gate: SendMessage denies only DEAD targets.** Target liveness resolves from the
  SubagentStart/Stop hook events: live targets always pass (delivery rides the existing run),
  unknown liveness downgrades the deny to a warning — never a hard deny of live messaging.
- **Burn-gate: COLD_RESUME disarms on evidence.** A post-stall response from the stalled session
  showing warm cache (big cache_read, small cache_creation) ends the cold-resume rule
  immediately; the 10-min window remains only as the no-evidence fallback (it was measured
  denying 6 minutes after recovery).
- **get_cache_break_timeline: `agent-<id>` child sessions now classify.** Child API calls carry
  the parent's session id in the raw bodies, so exact child-id lookups returned
  turnsClassified 0; the child's stream is now carved out of the parent bucket via its
  subagents transcript's message-id chain (stream head recovered by first-block fingerprint).

## [1.0.0] — 2026-07-10

First stable release of **AgentlensPro**, the professional continuation of the
[AgentLens](https://github.com/RogerReed/agentlens) fork: the VS Code extension host was removed
pre-fork and the product reshaped around a CLI + npx/standalone server + Docker image + Claude Code
skills, while keeping `~/.agentlens`, the `AGENTLENS_*` env vars, and the hook script names
byte-compatible. The road to 1.0.0 (P2–P9, shipped across 0.10.x–0.12.0):

- **P2** — one source of truth for host/webview shared modules in `src/shared/` (mirror drift killed by `scripts/check-no-mirrors.js`)
- **P3** — the four-disjoint-token-buckets invariant (`tokenBuckets.ts`), one convention on disk and on every card/entry
- **P4** — segmented append-only span store: restarts no longer destroy spans, no cap, no eviction
- **P5** — window-capacity auto-calibration from observed rate-limit hits (zero manual config)
- **P6** — keep-warm/cache-gap diagnostic, burn-gate `SendMessage` coverage, named fallback counters (silence is never invisible)
- **P7** — provenance on every served number (`tokensSource`/`coverageNote` stamped at the merge decision points)
- **P8** — async sub-agent token resolution from the children's own transcripts
- **P9** — headless dashboard browser smoke suite (real server, both themes, dedicated CI job)

### Added

- **PATH-bin hook registration (Homebrew-safe).** Two new package bins — `agentlenspro-hook` and
  `agentlenspro-gate` — thin wrappers that resolve the real spy scripts relative to their own
  installed location at every fire. `--install-hooks` now registers those **bare PATH names** in
  `~/.claude/settings.json` instead of absolute paths into the package tree (which dangle under
  Homebrew's versioned Cellar after every upgrade), and refuses to install when the bins are not on
  `PATH`. `--uninstall-hooks` removes both generations (bare names AND legacy absolute
  `spy-agentlens*` entries); a re-run migrates legacy registrations in place.
- **SLSA provenance on the release path.** The tag-triggered release workflow packs the npm tarball,
  attests it with `actions/attest-build-provenance`, and attaches it to the GitHub Release;
  `npm publish --provenance` covers the registry copy; the Docker workflow builds with
  `provenance: true` and now publishes to **GHCR only** (`ghcr.io/emasoft/agentlenspro`) — the
  fork-inherited Docker Hub push targeted the upstream project's repository.

### Fixed

- **Codex fixture under-counted LLM turns.** `demo/generate-fixtures.js` modeled a tool-calling
  Codex session with a single `response.completed` event; real captures emit one per API turn. The
  fixture now carries both terminal events, and all 5 fixtures validate clean through
  `summarizeSpans` (`pnpm run fixtures:check`).
- **Release workflow could never have passed** (first run is this tag): pnpm 11.9 needs Node ≥ 22.13
  (was pinned to 20), and the unit suite boots the esbuild server bundle, which was never built.
  Both fixed; lint/type-check/tests now gate the Release + npm publish on the tag.

### Docs

- README documents the PATH-binary contract and the GHCR image; ARCHITECTURE now covers the P7
  provenance stamps and the keep-warm diagnostic, and no longer describes the removed VS Code
  extension host as shipped reality; `pnpm run standalone` → `pnpm run local` stale mentions fixed.

## [0.12.0] — 2026-07-10

### Added

- **Provenance on every served number** (P7). Session cards carry `tokensSource: 'log' | 'otel' | 'merged'` (+ optional `coverageNote`), stamped at the `feedMergePolicy` decision points — log-wins collisions say what was displaced, OTEL-only sessions say so, identity merges say 'merged'. Surfaced on `get_session_status`, `get_recent_sessions`, `get_cost_rollup` session rows, `get_session_burn_profile`, and a source chip on the dashboard session detail. Cards persisted before this release render as "unknown" — never fabricated.
- **Async sub-agent token resolution** (P8). Background/async Agent launches used to leave zero-bucket placeholder children flagged `asyncTokensUnknown` (the parent transcript never carries their usage — upstream gap filed as anthropics/claude-code#76484). The children's OWN transcripts (`subagents/*.jsonl`) are now linked to the placeholders at read time: real totals replace the zeros, spawn rollups bill them, `asyncTokensUnknown` clears when resolved, and a missing transcript honestly stays unknown. `LOG_INGEST_VERSION` 6→7 relinks all history.
- **Headless dashboard smoke suite** (P9). `puppeteer-core` harness (`src/test/browser/`) boots the built standalone server on an ephemeral port with a temp data dir and asserts full-tab render in BOTH themes, one-card-per-fixture-session, hook-config round-trip, zero console errors. Gated behind `AGENTLENSPRO_BROWSER_TESTS=1` (`pnpm run test:browser`) + a dedicated CI job — the default suite is untouched.

### Fixed

- **Installed skill is PATH-portable**. The `agentlenspro-diagnostics` skill referenced the developer checkout (repo `scripts/`, `npm link`, an absolute Homebrew path); end users install via npm/npx/Homebrew where no repo exists. The skill now relies exclusively on PATH binaries, and the janitor-facing heartbeat-cost helper ships as a real package bin: `agentlenspro-heartbeat-cost`.

## [0.11.0] — 2026-07-10

### Added

- **Keep-warm / cache-gap diagnostic** (P6). The Anthropic prompt cache expires ~5 min after the last request; a session whose turns are spaced past the TTL re-pays the full prefix at the cache-WRITE rate (1.25×) instead of the read rate (0.1×) — invisible in per-turn totals because the turn still "works". New runtime-neutral engine `src/shared/keepWarm.ts` measures it per session from the `api_request` timeline entries (exact timestamps + the four disjoint cache buckets): a turn is **warm** when its gap since the previous request is under the TTL, **cold** when the gap is ≥ TTL *and* the call re-wrote the prefix (`cacheCreate > cacheRead`); cold turns' cache-creation tokens are the attributed waste, and a ≥TTL gap without the re-write signature counts in neither bucket (a penalty that wasn't observed is never invented). Surfaced as `keepWarm: {warmTurns, coldTurns, wastedWriteTokens, worstGapMin}` on `get_session_status` and per-entry on `get_burn_status.topSessions`, plus a compact badge on the dashboard session detail (amber `❄ N cold turns · ~Xk re-written · worst gap Ym`, green `♨ cache kept warm`). Honest absence throughout: sessions without `api_request` entries report `keepWarm: null` (and get no badge), never zeros presented as measurements
- **Burn-gate `SendMessage` coverage**. Resuming a DEAD agent via `SendMessage` re-runs the request that killed it — when the target died in a rate-limit stall, the prompt cache is past its TTL and the resume re-pays the agent's full prefix at the write rate. The hook matcher widens to `^(Task|Agent|Workflow|SendMessage)$`, but `SendMessage` routes to a NARROWER evaluator (`evaluateSendMessageGate`): only an active cache-thrash (`THRASH_ACTIVE`) or a stall inside the cold-resume window (new `COLD_RESUME_MESSAGE`) may deny; fan-out/fork signatures never apply, so routine team messaging is never gated — proven by quiet-state and runaway-state pass tests at both the pure-function and real-server-endpoint levels. Re-run `agentlenspro-cli --install-hooks` to pick up the widened matcher
- **`degradations` in `/api/server-stats` — silence is never invisible**. The ingest paths stay fail-open (a corrupt line must never take the collector down), but every silent catch-fallback now has a name and a count via `src/shared/fallbackCounters.ts`: OTLP non-JSON payloads and unparseable `gen_ai` content, JSONL line drops and file read errors in the log reader, the OpenCode DB→JSON fallback, and corrupt collector-state sidecars (a MISSING sidecar — normal first boot — is deliberately not counted). Zero behavior change at the swallow sites: count, don't throw; unfired counters are absent, not zero

## [0.10.4] — 2026-07-10

### Added

- **Window-capacity auto-calibration from rate-limit hits** (P5). `get_window_budget`'s % consumed and time-to-exhaustion projections needed a manual capacity (`AGENTLENS_WINDOW_5H_TOKENS`/`_7D_TOKENS`) because Anthropic doesn't publish the raw window caps — on unconfigured machines the tool's core promise was dead (`capacitySource: none`). The cap IS observable, once: when a rate-limit-class `StopFailure` kills a turn **before** the account's 5h window rolled, the consumption accumulated since the window started is a proven lower bound on the cap. The standalone hook-event ingest path (`POST /api/hook-events`) now measures exactly that (`src/capacityCalibration.ts`) and persists it per account (`accountUuid`-keyed `observed` section of `~/.agentlens/burn-config.json`, atomic temp+rename); `computeWindowBudget` consumes it so projections, time-to-exhaustion and the `check_burn_risk` remaining-window clause work with **zero manual config**, reported as `capacitySource: "observed"` + `capacityObservedAt` (the calibration date). Guards: only rate-limit-class errors calibrate; a natural 5h rollover never does (consumption straddling the 5h boundary measures elapsed time, not the cap); observed figures only ratchet **up** (a later larger window raises them, a smaller one is ignored); any manual cap (env or file) disables calibration outright — user config is never clobbered, and an existing-but-unparseable `burn-config.json` is refused, never replaced. The running server reloads its burn config after each calibration, so the very next 4s burn tick projects against the measured cap without a restart. Covered by 16 real-fs unit tests + a 5-test real-boot suite that replays synthetic StopFailure fixtures through the actual OTLP + hook-event ingest against a temp data dir

## [0.10.3] — 2026-07-10

### Changed

- **Segmented append-only span store — restarts no longer destroy spans** (P4). The standalone server's single-file `~/.agentlens/spans.json` with its `MAX_SPANS=50,000` eviction was measured losing 1,700 spans in ONE restart (`Loaded 50000 spans (capped from 51700)`) — the root mechanism behind "OTEL is a lossy lower bound". Spans now persist as daily append-only NDJSON segments under `~/.agentlens/spans/` (`2026-07-10.ndjson`, one JSON span per line) with a per-segment index (span count + time range + bytes, atomic, self-healing after a crash): append cost is O(record), a segment is **never rewritten** (the whole-store shutdown rewrite — the last survivor of the 420GB/4.4h SSD-wear pattern — is gone too), and there is **no span-count cap and no eviction**. In-memory the server keeps only the rolling summarization window (`AGENTLENS_SUMMARY_WINDOW_HOURS`, default 24h; halves down to a 5-minute floor under heap pressure, logged loudly) — trimming memory is not data loss, since boot and range queries load only the segments overlapping the requested time range. Retention (`AGENTLENS_SPANS_RETENTION_DAYS`, default 30) runs on boot + daily and deletes whole EXPIRED segments only, one explicit line per deletion (`retention: deleted segment 2026-06-01.ndjson, N spans, age 39d`). First boot migrates the legacy `spans.json` into segments and preserves it as `spans.json.bak` (never deleted). Deliberately no native deps (better-sqlite3) to keep `npx` portability. `AGENTLENS_MAX_SPANS` is retired; `/api/server-stats` `spans` now reports `{windowMs, retentionDays, pendingAppends, store:{segments,totalSpans,totalBytes}}` and `agentlenspro-cli --status` renders both the new and the pre-P4 shape

## [0.10.2] — 2026-07-10

### Added

- **`src/shared/tokenBuckets.ts` — the four-disjoint-buckets invariant, compile-shaped** (P3). Every card AND every timeline entry carries four DISJOINT buckets (raw uncached `inputTokens` / `cacheReadTokens` / `cacheCreateTokens` / `outputTokens`), each billed at its own rate. `disjointBuckets()` is the ONE constructor every producer routes through (OpenAI-shaped usage sheds its `cached ⊂ input` share at construction; Anthropic-shaped passes through); `contextTokens()` is the one derivation of context size (input + cacheRead + cacheCreation). Grounded by the 2026-07-10 OTEL-vs-JSONL measurement (same session read up to ~1,246× apart across feeds)
- **Entry-level parity contract** — `tokenConventionParity.test.ts` now also proves the SAME call through the OTEL and JSONL feeds yields bucket-identical timeline entries and an identical per-entry cost; real sql.js round-trip tests cover the v6 re-ingest guard

### Changed

- **Timeline entries normalized to RAW** — OTEL-produced `llm` entries stored incl-cache input (`input+cacheRead+cacheCreate`) while log-produced entries were raw; both now store the raw uncached share with the cache buckets in their own fields (codex/copilot/opencode entries gain those fields). All producers (`src/summarizers/*`, `src/logReader.ts`, standalone paths) construct through `disjointBuckets()`
- **`LOG_INGEST_VERSION` → 6 with an in-place SQLite migration** — persisted OTEL `llm` timeline entries are normalized by subtracting each row's own cache columns (clamped at 0); log-sourced rows and sidecars cold-rescan from the durable transcripts. One convention on disk, ever. Pre-v6 codex/copilot OTEL entry rows without per-entry cache data are left unchanged (their incl-cache share is unknowable — same documented discontinuity stance as the v5 card migration)

### Fixed

- **Webview compensations that assumed incl-cache entries deleted** — `calcEntryCost` no longer subtracts the caches out of `entry.inputTokens` (it silently under-billed raw log entries all along); `getPeakContextUsage`, the per-turn cost curve, the context-growth insight, the oversized-start insight, the growth chart, and Flow's per-turn size now derive context as input + cacheRead + cacheCreation via `contextTokens()`. `tokenBreakdown()` stops undoing incl-cache on cards that have been raw since v5 (it clamped "fresh" to ~0 on every cache-heavy session); `computeTurnGrowth` (MCP) and the standalone sidebar sparkline same fix

## [0.10.1] — 2026-07-10

### Changed

- **One source of truth for the host/webview shared modules** — the runtime-neutral engines and type definitions (`pricing`, `summarizerTypes`, `telemetryTypes`, `cacheBreak`, `residentCost`, `spawnRollup`, `tokensByCause`) moved to `src/shared/`, imported by BOTH the extension-host/standalone code and the webview. The hand-synced `media/src/` mirror copies are deleted; `media/src/types.ts` now re-exports the shared types and keeps only webview-specific message/UI shapes. The two diverged pricing tables merged into one (`ModelRates` now carries `contextWindowTokens` AND the Copilot request multipliers)

### Fixed

- **Webview cache-break analysis detects FAST_MODE again** — the drifted `media/src/cacheBreak.ts` mirror had silently lost the fast-mode-toggle break cause; the Cache tab / trace markers now run the same classifier the MCP tools use. The webview session cards also gain the `spawnSubagentType` and `statusline` fields the old types mirror was missing

### Added

- **Anti-mirror CI guard** — `scripts/check-no-mirrors.js` (`pnpm run check-mirrors`, wired into CI after Lint) fails the build if any file under `media/src/` re-declares a symbol `src/shared/` exports, so this duplication class cannot come back. First real catch: both tokenEstimators re-declared the shared `TokenSource` type (removed)

## [0.10.0] — 2026-07-10

### Added

- **The burn-gate — token disasters PREVENTED at agent-launch time, not just warned about** (TRDD-GOD0108C). `--install-hooks` now also registers `scripts/spy-agentlens-gate.sh` on `PreToolUse`/`PostToolUse` matched to `^(Task|Agent|Workflow)$` only — the rare, high-stakes moments explosions start, never per-tool-call overhead. Before each agent launch the resident server decides in-memory (measured: decision p50 0.9ms, hook end-to-end 14ms) and **denies the four measured disaster signatures**, feeding the reason back to the agent so it adapts: `THRASH_ACTIVE` (cache-thrash in progress — more agents multiply the re-billing), `RUNAWAY_FANOUT` (≥8 launches/60s), `COLD_RESUME_FANOUT` (a rate-limit stall just ended and one agent is already in flight — that first launch is the cache warm-up; the incident this encodes: 14 forks resumed into a cold cache = 883k tokens in 33s), `FORK_STORM_FORMING` (forks of a ≥200k-token parent into a TTL-expired cache during a fan-out). Real parent size comes from the transcript's last `message.usage` via a bounded 256KB tail read — never bytes/4 over the append-only JSONL. Ambiguous situations get a `systemMessage` warning (with the real token numbers and a "pin a cheaper model" hint when recent traffic is premium) or a silent allow. Fail-open by construction: server down = 13ms silent no-op; `AGENTLENS_GATE=off` kill-switch checked before any network; `AGENTLENS_GATE_MODE=warn` downgrades denies; thresholds tunable via `AGENTLENS_GATE_*` envs; deny/warn/advisory counts in `/api/server-stats` under `gate`
- **`CACHE_THRASH` — the 6th `check_burn_risk` flag**: ≥3 responses in 5min with big `cache_creation` and ~zero `cache_read` (Anthropic's exact usage numbers from the raw response bodies, which land as files the instant calls complete) means the context prefix is being INVALIDATED every turn instead of read — the pattern class behind the lean-ctx incident. Detail names the model and the re-billed tokens; `--guard` picks it up automatically
- **PostToolUse in-band advisory** — when an agent wave completes while `CACHE_THRASH`/a fan-out burst is active, the gate injects ONE `additionalContext` warning to the model, deduped per session+risk per 10min (per-call injections that later get stripped in place are themselves a cache-break cause — the #778 lesson)
- **Every gate/guard message names the culprit** (TRDD-9CNHP8CN) — cause, entity, and who is affected, in one line: spawning sessions with workspace + agent types (exact, from SubagentStart payloads), the stalled session behind a cold-resume deny (StopFailure payload), and thrash/fat-request "likely source" senders (session + model + MB, from a bounded 6KB head/tail read of each fat request — `Primary working directory` sits ~92% into a body and is not tail-reachable, so workspaces ride the hook events instead). Unattributable thrash says so and points at `investigate_burn` — never a guess. Top-2 + "+N more" keeps the one-line hook budget
- **`predict_session_cost` — precedent-based cost prediction** (TRDD-O981ZJKV item 9): "what will this code review / ultracode workflow cost?" answered as a p25/p50/p75 DISTRIBUTION over real matched past sessions (task keywords + sub-agent type + soft file-size band), precedents listed for auditability, flat p50/p75 headline fields, no-match = no prediction (never fabricated)
- **`get_runtime_inventory` — every Claude Code instance with its total memory footprint** (TRDD-O981ZJKV item 13): one `ps` snapshot + pure process-tree rollup — each claude root instance with EVERYTHING it spawned (subshells, worktree/subagent processes, plugin crons, MCP servers, background tasks), ranked by total tree RSS, project dir via lsof, 5 heaviest descendants listed, Claude Code client version reported. Nested claude processes fold into their root; matching is argv0-exact so command lines mentioning `~/.claude/...` paths never false-positive; ppid-cycle-safe. POSIX (macOS/Linux/WSL) with an honest note on native Windows
- **Warnings are now-focused** (user directive): every warning speaks only about CURRENT events (all detection windows ≤10min), past-incident references removed from warning texts, and the one future-looking fact added — how long until the current 5h/7d window fills at the current rate (from the per-account budget projection; honestly absent when window capacity is not configured, never invented)
- **Dashboard hook-switches card** (Alerts tab): realtime toggles for the burn-gate / lifecycle capture / in-band advisor + gate-mode selector, driven purely by the server's response state (never optimistic); hides itself in the VS Code webview where the REST endpoint doesn't exist. Gate denies/warnings/advisories render on the same tab via SSE
- **Cross-platform: Python interpreter resolved, not hardcoded** — `safeConfigEdit` (the sole config-mutation path) and the CLI's transaction runner probe `python`/`py`/`python3` platform-aware instead of assuming `python3`, fixing config management on native Windows (audit blocker #1); POSIX resolution order unchanged
- **Realtime hook switches — enable/disable every AgentLens hook for ALL running sessions at once, no restarts** (`~/.agentlens/hook-config.json` + `GET/POST /api/hook-config` + `agentlens-cli --hooks gate=off|warn|enforce capture=on|off advisor=on|off`). Claude Code reads hook registrations only at session start, so the switches live where they can act in realtime: the resident server every hook curls. Atomic config writes; junk patches degrade instead of failing; `AGENTLENS_GATE_MODE` env honored until a config file exists. Gate denies/warnings/advisories also mirror onto the dashboard's SSE alert channel, so the notification panel shows every gate intervention live
- **`get_cost_rollup` — interval cost/usage rollup with the 5-value breakdown** (TRDD-O981ZJKV): groupBy `project` / `all` / `session` / `model` / `subagent` (spawned agents ranked with spawn kind/type + parent), window by `windowHours` or `sinceIso`/`untilIso`, filters `subagentsOnly` / `parentSessionId` / `liveOnly` (the "what are my running subagents burning" view), sortBy any of the 5 values, tokens-and-$ per hour on every row. Honest semantics: sessions count when they OVERLAP the window (totals are whole-session — disclosed), unpriced and undated sessions counted, never silently mixed or dropped
- **`get_rate_limit_report` — rate-limit forensics** (TRDD-O981ZJKV): StopFailure hook events grouped into stall EPISODES (≤10min apart = one incident) with affected sessions/workspaces and the verbatim error head; the newest episode is deep-attributed by scanning the 5h window that ENDED at the stall — the exact billed usage that filled the rate-limit window (Anthropic's own response-body numbers) with `investigate_burn`'s ranked culprit findings; verdict/cost/topFindings hoisted to flat fields so the default (shaped) view carries the answer. Live-verified against the 2026-07-10 incident: 93 turn-deaths → one episode, FORK_STORM named, $167.78 window
- **`agentlens-cli --risk` + `GET /api/burn-risk` — realtime culprit check in ~40ms** (was ~700ms via MCP): a plain-REST fast path with the FULL unshaped risk list (the MCP lean-shaper's 5-row array cap once hid the 6th risk from naive callers); `--guard` rides it too, with a one-time MCP fallback for older servers. Server-side: the 4s burn tick now caches its status for hot paths (recomputing it per request measured ~270ms) and bodies-tracker polls moved to a 5s background timer so a poll landing on new multi-MB response files can never spike request latency (measured endpoint p50 2.1ms)

### Changed

- **Guard/gate hot path is now fully in-memory** — the server keeps an in-memory hook-event ring (fed by `POST /api/hook-events`, boot-seeded from the last hour on disk) and an incremental `BodiesActivityTracker` (readdir + stat only unseen names — bodies are write-once, so this is exact; the seed pass runs 3s after boot, off the interactive path). `check_burn_risk` served by the standalone server no longer reads NDJSON buckets nor stats every body file per call
- `appendHookEvent` returns the record alongside the byte count so the disk line and the server's ring share one construction point

### Fixed

- **ONE token convention — the OTEL-vs-JSONL discrepancy** (user-reported; root-caused by a 2,340-call three-way measurement against the raw Anthropic response bodies, 0 per-call mismatches — neither parser corrupts numbers). OTEL cards stored `inputTokens` INCLUDING the cache buckets while log cards stored it RAW, so the same session read 318×–1,246× apart between feeds, and the write-time cost DOUBLE-BILLED every cache token on OTEL cards at the full input rate. The schema invariant is now **four disjoint buckets** normalized at every ingestion site (claude/copilot/codex summarizers + log sub-agent cards; OpenAI-shaped input sheds its contained cached tokens); the structurally-unsound read-time detection heuristic is deleted; persisted OTEL rows are normalized in place with cost recomputed; the standalone's restart sidecars are version-stamped so stale-convention cards rebuild on next boot. A standing parity test feeds one identical call through both feeds and asserts bucket-identical cards + identical cost. Known remaining (documented, next change): the same split at the timeline-ENTRY level, and the feed-correlation gap that still serves each session as 1 log card + N per-trace OTEL cards
- **One Claude session no longer serves as 1 log card + up to 336 per-trace OTEL cards** (Phase B of the token-feed fix; measurement in reports/token-discrepancy/20260710_141134+0200-otel-vs-jsonl.md §4bis). OTEL Claude cards were keyed by the interaction spanId (or `synth-<traceId>`) — never the transcript UUID — so the log/OTEL id merge could structurally never collide and every session was served at least twice with different totals. The Claude summarizer now groups interaction spans by their `session.id` attribute (the real transcript UUID, already on the wire) and emits ONE session-scoped card per UUID — buckets summed, timeline concatenated in time order, turns = Σ llm calls, startTime/duration spanning the group; synthesized in-progress roots inherit the UUID from their trace's spans; interactions without the attr keep the per-interaction card (fail-soft, no invented identity). **Merge doctrine revised** and centralized in `src/feedMergePolicy.ts`: for Claude sessions the LOG transcript wins on collision — transcripts are durable and call-complete, while the measurement proved OTEL is a lossy LOWER BOUND (`MAX_SPANS` eviction + collector-downtime loss) whose totals also include sub-agent calls the log parent card intentionally excludes; OTEL-only sessions (no transcript) still serve; every other source keeps OTEL-wins. Applied uniformly in the standalone server merge, the extension's `SessionRepository` merge/dedup, and the `DatabaseWriter` write guard
- **The standalone server never ingested rich Claude Code log events at all** — it has its own OTLP ingest path (separate from the extension's collector class) that lacked the rich-event gate entirely, so `api_request`/`compaction`/`api_error` events were dropped under BOTH naming conventions on the deployment that actually runs. The name resolution (attrs → the OTLP 1.4 `eventName` proto field → string body), prefix normalization, and gate sets now live in one shared module (`src/otlpLogEvents.ts`) used by both paths. Rich events + tool_result are keyed session.id-FIRST (CC 2.1.206 propagates a traceId on log records that groups them away from their session), and rejected log-event names are now counted and surfaced as `otlpDroppedLogEvents` in `/api/server-stats` — a silent-drop bug class made permanently visible
- **Every rich Claude Code log event was silently dropped at ingest** — Claude Code 2.1.206 emits BARE log-event names (`api_request`, `compaction`, `api_error`, …) while the collector's gate only matched the documented `claude_code.`-prefixed forms (which don't exist in that binary), so 0 `api_request` spans ever landed in an 81MB store and `get_cost_by_cause` had nothing to attribute. The gate now normalizes the name (both conventions accepted; stored span names stay prefixed for the summarizer), and `tool_result` events also match the snake-case `tool_name` attribute 2.1.206 uses
- **Async/background Agent launches produced no sub-agent child cards** — an async launch writes only a `status:"async_launched"` acknowledgment to the parent transcript (never `usage`/`totalTokens`; the completion arrives as a task-notification message), so async-heavy sessions reported `childCount: 0` and their fan-out was invisible. Linkage cards are now synthesized from the launch record (agentId + resolved model), with the missing tokens flagged honestly instead of faked: `spawnAsync` on the card (persisted), `outcome: 'unknown'`, `asyncTokensUnknown` on `get_subagent_tree` children, and `asyncUnreportedChildren` on the spawn rollup so its totals never read as complete coverage. A later usage-carrying result upgrades the placeholder in place. Live-verified: an async-heavy session went from 0 to 59 children. `INGEST_VERSION` 3→4 re-ingests history
- **`spawn_subagent_type` was persisted but never read back** — the DB reader dropped it on every round-trip; now loaded with the other spawn fields

## [0.9.0] — 2026-07-10

### Added

- **`check_burn_risk` + `agentlens-cli --guard` — realtime early-warning against token explosions.** The guard half of `investigate_burn` (which explains a drain after the fact): one cheap poll fuses the server's three realtime feeds — lifecycle hook events (`SubagentStart` bursts = a fan-out launching now; `StopFailure` = a rate-limit stall whose end means a cold cache; `PreCompact` = full-prefix rewrite), the raw-bodies dir (≥3 requests >1MB in 90s = fat-context fan-out in flight, stat-only), and the live burn monitor (tokens/min spike) — into 5 risk flags with per-risk advice and an honest `sources` block when a feed is absent. `--guard [seconds]` is the watch loop: one `[burn-guard]` line per risk *transition*, silent while quiet — designed to be armed in a background monitor before spawning agent fan-outs
- **`investigate_burn` — one-command window-burn investigation** (`agentlens-cli investigate_burn`). Answers "my 5h window drained: what burned it and who?" in a single call: exact billed usage from the raw OTEL response bodies (never estimated), workspace/model/agent-kind attribution from the request bodies (deep Environment-block search — it sits *after* the messages in fat transcripts, which is exactly how shallow scans misattribute), and a ranked findings list over a measured cause taxonomy: `FORK_STORM`, `SUBAGENT_BOOT_TAX`, `PREMIUM_MODEL_FANOUT`, `FAT_SESSION_REWRITES`, `IDLE_FLEET_KEEPWARM`, `IMAGE_BLOB_RESIDENT`, `RATE_LIMIT_COLD_RESUME` (correlated with the lifecycle hook-event store when installed). Every finding carries its evidence numbers and confidence; coverage caps are disclosed; the unattributed remainder is stated, never hidden. Born from the 2026-07-10 incident where the manual investigation took ~15 commands and the first attribution was wrong

- **Lifecycle hook-event capture** — `agentlens-cli --install-hooks` registers `scripts/spy-agentlens.sh` on ten Claude Code lifecycle events (SessionStart/SessionEnd, Stop, StopFailure, PreCompact/PostCompact, PermissionRequest, Notification, SubagentStart/SubagentStop). These carry signals the JSONL transcripts and OTEL bodies do not: exact rate-limit turn deaths (`StopFailure`), compaction boundaries with their trigger (`PreCompact`), and true session lifecycle. Events land in `~/.agentlens/hook-events/` as append-only NDJSON daily buckets (31-day retention, `AGENTLENS_HOOK_EVENTS_RETENTION_DAYS`) and are queryable at `GET /api/hook-events?session=&ev=&since=&until=&limit=`. Deliberately *not* registered on `PreToolUse`/`PostToolUse`: that data is already fully captured, and those are the only high-frequency hooks. `--uninstall-hooks` removes exactly these entries. Both go through the `safeConfigEdit` verified transaction and leave other tools' hooks untouched
- **`agentlens-cli --install-skill`** — (re)installs the `agentlens-diagnostics` skill into `~/.claude/skills/` from the in-repo copy, idempotent by content comparison (reports installed / updated / already current), so a deleted user-scope skill is recoverable with one command
- **`scripts/install.sh`** — one-command installer: Node ≥18 check, dependency install, bundle build, global CLI link, skill install, server start. It never touches `~/.claude/settings.json`; telemetry (`--install-otel`) and hook capture (`--install-hooks`) stay explicit opt-ins that the script recommends at the end

### Changed

- **`--status` reports the hook-event store** — event count since boot, bucket count, and bytes on disk, alongside the existing span/bodies accounting

### Fixed

- **Calendar-invalid hook-event bucket names could never be purged** — the bucket-name regex `\d{4}-\d{2}-\d{2}` also matches names like `2026-13-99` (parses to `NaN`) and `2026-02-31` (overflows to Mar 3). `NaN` defeated both the read fast-path (the bucket got scanned instead of skipped) and the string-comparison purge (the file was never deleted while disk-usage kept counting it). A single `bucketDayMs()` helper now parses the day once and round-trips it through `toISOString` to reject overflow; read, purge, and disk-usage all share it, and purge compares day-milliseconds numerically

## [0.8.5] — 2026-06-15

### Fixed

- **First session in standalone Traces tab never loads timeline** — The first session in the Traces tab starts expanded by default, but `loadSessionDetail` was only dispatched inside `toggle()`, which fires on user click. The auto-expanded session would show "Loading timeline…" indefinitely until the user manually collapsed and re-expanded it. Fix: add a `useEffect` that fires on mount (and whenever `collapsed` changes) to dispatch the fetch whenever the session is expanded but its timeline has not yet loaded (#161, #162)

---

## [0.8.4] — 2026-06-14

### Fixed

- **Per-turn token costs wrong for cached Claude turns** — `TimelineEntry` had no `cacheReadTokens` / `cacheCreateTokens` fields, so `calcEntryCost` passed zeros for both cache tiers and billed every token at the full input rate. A turn with 100 K total context where 90 K is cached was priced ~5–10× too high, and costs looked uniform across turns because the inflated formula only grew with the slowly-expanding context window. Fix: add the two optional fields throughout the pipeline (summarizer, DB schema + migration, writer, reader, webview types) and update `calcEntryCost` to apply the correct cache-read (10%) and cache-write (125%) rates. The Traces tab StepRow compact display now shows total tokens and cache-read count on two short lines that fit the 90 px column instead of a single overflowing string (#157, #159)
- **Standalone server locks up Safari on load** — `getHtml()` inlined `window.__INITIAL_SPANS__` (the full raw spans array, never consumed by the Preact app — potentially multiple MB) and full per-session timeline arrays inside `__INITIAL_SESSION_SUMMARY__`, all synchronously in `<script>` tags before `dashboard.js` could evaluate. Safari's JavaScriptCore parses large inline scripts on the main thread with no incremental yield, freezing the page immediately after first paint. The raw spans array was also re-sent in every SSE update payload. Fix: remove `__INITIAL_SPANS__` entirely, strip timeline arrays from the inline summary, add `/api/summary` and `/api/timeline/:sessionId` endpoints for lazy loading, wire `loadSessionDetail` in the `acquireVsCodeApi` shim to fetch timelines on demand, and add an SSE `onerror` → 2-second polling fallback so Safari private mode (where ITP blocks `EventSource`) shows live data instead of a frozen page. Diagnostic `console.log` timestamps are now emitted at key load stages to aid future cross-browser diagnosis (#158, #160)

---

## [0.8.3] — 2026-06-14

### Fixed

- **OOM crash during long Claude Code sessions with enhanced telemetry** — `genAiResponseBuffer` in the OTLP collector leaked one large JSON blob per LLM call when the `claude_code.llm_request` span arrived before its matching `gen_ai.choice` log event (the common ordering with `gen_ai_latest_experimental`). `processTraces` deleted buffer entries when it consumed them, but when the span was already in the store by the time the log arrived, `processLogs` injected immediately and never cleaned up its own entry. Over a long session the buffer accumulated the full accumulated conversation context for every turn, growing the heap to the 4 GB V8 limit and crashing VS Code. Fix: check `injectSpanAttribute`'s return value and delete the buffer key immediately on successful injection. A 500-entry LRU-style cap also guards against orphaned entries when a span is dropped by the agent's OTLP exporter (#155, #156)

---

## [0.8.2] — 2026-06-11

### Fixed

- **Windows: Codex and Copilot CLI sessions not discovered** — `codexSessionsDirs()` and `copilotSessionStateDir()` only checked Unix-style home-directory paths. On Windows, Codex likely stores sessions under `%LOCALAPPDATA%\Codex\sessions` or `%APPDATA%\Codex\sessions`, and Copilot CLI under `%APPDATA%\copilot\session-state`. Both are now checked as primary candidates on `win32` before falling back to the `~/.codex` / `~/.copilot` paths, matching the existing pattern used for Claude Code (#153, #154)

---

## [0.8.1] — 2026-06-11

### Fixed

- **Standalone UI hangs empty on startup** — `startLogIngestion()` awaits sql.js before scanning, so the browser frequently connects to the SSE `/events` endpoint during that async gap and receives an empty payload. After the scan completes and `logSessions` is populated, `fileState` is fully current so the 5-second `runLogScan` poll finds no changed files and never pushes an update — the dashboard stays blank indefinitely. Fix: call `pushUpdate()` at the end of `startLogIngestion()` to flush sessions to any already-connected SSE clients (#151, #152)

---

## [0.8.0] — 2026-06-10

### Added

- **OpenCode support** — AgentLens now reads OpenCode's local SQLite database (`~/.local/share/opencode/opencode.db` on Mac/Linux, `%APPDATA%\opencode\opencode.db` on Windows) directly, with no agent configuration required. Sessions, messages, parts (tool calls, file accesses), and token counts are all parsed; the WAL is merged at read time so sessions appear immediately after each run. Subagent sessions (`parent_id` set) are excluded. Falls back to reading `storage/message/*.json` files when the SQLite driver is not available (Docker). Override the default path with `OPENCODE_DATA_DIR` (comma-separated for multiple directories). Windows path (`%APPDATA%\opencode`) is also checked automatically (#147)
- **Import tab** — New **Import** tab in the dashboard accepts an AgentLens JSON export file (drag-drop or file picker), shows a preview with session count by agent source and date range, then imports with live progress updates. Sessions already present in the local database are skipped automatically. Works in both VS Code extension mode and standalone server mode. The standalone server adds a `/api/import` endpoint for the batched POST path (#148)
- **Pricing: claude-fable-5** — Added `claude-fable-5` to both pricing tables at `$10/$50` per MTok input/output with a 1 M token context window (#150)
- **Pricing: big-pickle** — Added `big-pickle` (OpenCode's stealth model, free during limited evaluation) to both pricing tables (#147)

### Fixed

- **Import hang in VS Code** — Importing sessions previously blocked indefinitely because `drain()` returned the shared `drainPromise`, which could be an in-flight log-reader drain waiting on async blob writes. Import now uses a dedicated `importCards()` synchronous transaction path that bypasses the drain pipeline entirely (#148)
- **Import progress stuck at 0 in standalone** — Standalone HTML injects `window.acquireVsCodeApi` as a shim, making `vscode` truthy even in browser mode. The Import tab now checks `window.__STANDALONE__` to route correctly, and sends sessions in 50-session batches so progress updates are visible during large imports (#148)
- **Context window values for 1 M-context models** — `contextWindowTokens` corrected from `200_000` to `1_000_000` for all Opus 4.x, Sonnet 4.x, and Opus fast-mode entries; these models have supported 1 M context since Opus 4.6 (#150)

## [0.7.3] — 2026-06-09

### Fixed

- **sql.js not resolvable in packaged extension** — `require('sql.js')` failed with `Cannot find module` in installed extensions because `sql.js` was marked external in esbuild but `node_modules` is excluded from the `.vsix`. `sql-wasm.js` is now copied to `dist/` at build time and required by path; covers both the primary window (`openDatabase`) and secondary sync windows (`openReadonlySnapshot`) (#141)
- **Friendly EADDRINUSE errors** — MCP (port 4316) and UI (port 3000) servers now print an actionable message and exit cleanly on port conflict instead of crashing with a raw Node stack trace; all three servers (OTLP, MCP, UI) now use the same pattern (#140)

---

## [0.7.2] — 2026-06-08

### Fixed

- `media/help-mascot.png` removed from `.dockerignore`, `.vscodeignore`, and `.npmignore` — it is served by the VS Code webview, standalone server, and Docker image and must be included in all packages; only `media/demo.gif` is README-only

---

## [0.7.1] — 2026-06-08

### Added

- **Ingestion toggles** — new Settings tab with per-source ingestion toggles (Claude Code logs, Copilot logs, OTEL spans); each source can be disabled independently without clearing data

### Fixed

- **Fast mode cost multiplier** — fast mode sessions now apply the 5× cost multiplier from the `usage.speed` field; was previously ignored, causing fast mode sessions to be underpriced (#124)
- **Tiered pricing for claude-sonnet-4** — input tokens above 200 K now apply the correct surcharge tier; the `calcTokenCostUsd` calling convention was also corrected to pre-subtract cache tokens before tier lookup (#130)
- **Copilot OTEL token convention** — GPT-model Copilot sessions use the OpenAI token convention (`input_tokens` = total context including cached); the summarizer no longer double-counts cached tokens when `cacheRead` is non-zero (#133)
- **Unpriced sessions excluded from cost chart** — sessions with unrecognized model IDs (grey `?` markers) are now filtered out of the ESTIMATED COST bar chart; they contributed $0 to all calculations but consumed slots and created visual noise; a footnote reports how many were excluded (#135)
- **"Clear All Data" visually confirms** — post-clear re-ingestion delay increased from 500 ms to 5 s so the cleared state is visible before sessions reload (#136)
- **Dashboard picks up log scan results** — `DashboardPanel.update()` is now called after every `runLogScan` drain; previously the dashboard could lag up to 40 s behind the sidebar after a log scan (#136)

### Chore

- `media/demo.gif` and `media/help-mascot.png` (README-only assets) excluded from `.vscodeignore`, `.dockerignore`, and `.npmignore`
- Updated demo GIF

---

## [0.7.0] — 2026-06-07

### Added

- **Advisor tab** — new tab (merged into the Patterns tab area) with three sub-panels:
  - *Instruction Advisor* — surfaces per-workspace suggestions derived from session patterns: hot file guidance, loop prevention rules, scope discipline, tool discipline, and discovery prompts; each card shows the suggested text and an "Apply to file" button with a file-picker dropdown targeting detected instruction files (CLAUDE.md, .cursorrules, etc.)
  - *Instruction Effectiveness* — tracks the before/after impact of applied suggestions; compares cost-per-session and turns-per-session in a 20-session window before vs. after each applied suggestion; surface area shows `baselineCostAvg`, `postCostAvg`, delta, and a trend indicator; requires at least 5 post-apply sessions to report
  - *Prompt Analyzer* — pre-session cost prediction and context advice (foundation for issue #119)
- **Hot Files — Written mode** — new toggle on the Patterns tab Hot Files panel; switches from "files read most" to "files fully written by the agent"; files where the agent overwrote the entire content are ranked by session count; tip box adapts to Written mode with guidance on what fully-written files indicate
- **Instruction file apply/remove** — suggestions can be applied directly to a target file (appends a marked block `<!-- AgentLens suggestion applied -->`); remove clears the block; both VS Code extension and standalone server support apply/remove; standalone adds `POST /api/instructions/apply` and `DELETE /api/instructions/applied/:id` endpoints
- **Effectiveness persistence** — `instruction_applied` and `instruction_dismissed` SQLite tables store applied suggestion records, baseline snapshots, and dismissed IDs per workspace; `InstructionRepository` and `InstructionEffectiveness` modules implement the full persistence and computation layer
- **Understanding Cost Estimates** — new Help section explaining how costs are derived, why estimates differ from billing, what "accumulated" means for multi-turn cached sessions, and known gaps per agent

### UX

- **$0.00 row suppression** — cost table hides rows with zero estimated cost by default; "Show $0" toggle reveals them; reduces visual noise for agents that produce no billable activity in the window
- **Cost disclaimer link** — `?` link on the "ESTIMATED COST" heading and in the disclaimer bar jumps to the Understanding Cost Estimates Help section
- **Accumulated token display** — tooltip clarifies that token counts for cached sessions represent accumulated totals across the turn chain, not per-turn usage

### Fixed

- **Strict equality** — replaced all `!= null` / `== null` comparisons with `!== null` / `=== null` (eqeqeq lint rule) across App.tsx, sidebarWebview.ts, reader.ts, and sessionRepository.ts
- **Stale instruction files on workspace switch** — switching the workspace filter to "All" now clears the `instructionFiles` signal, preventing stale file options from a previous workspace appearing in the Apply dropdown
- **Standalone remove endpoint** — VS Code extension had `removeInstructionSuggestion` message handling but standalone had no HTTP endpoint; added `DELETE /api/instructions/applied/:id` that scans all session workspaces

---

## [0.6.1] — 2026-06-06

### Added

- **Workspace filter** — new dropdown in the filter bar surfaces the project path for each session and lets you narrow the view to a single workspace; works across Sessions, Analytics, Patterns, and Export tabs
- **Cross-source workspace resolution** — OTEL-traced sessions (Claude Code, Codex) that lack a workspace attribute are matched to a log-ingested session from the same source that started within the same minute; the resolved workspace propagates to the OTEL session for filter purposes
- **Codex workspace from session_meta** — Codex sessions now read `session_meta.cwd` as the workspace path instead of the date-based directory name

### Fixed

- **Workspace in live sessions** — OTEL span attributes (`process.cwd`, `session.workspace`) are now extracted and surfaced in live (in-memory) sessions, not just persisted ones
- **Workspace filter applied to DB results** — `rangedSessions` was not applying the workspace filter to SQLite query results; fixed to filter in the DB layer

---

## [0.6.0] — 2026-06-05

### Added

- **Patterns tab** — new cross-session behavioral analysis tab with two panels:
  - *Efficiency Map* — scatter plot (cost × LLM calls) colored by cache hit rate; click any dot to navigate to that session; top-10 table is sortable by time, cost, turns, or cache hit; each row shows an agent dot and a time hyperlink that jumps to the expanded session in the Sessions tab
  - *Hot Files* — files the agent accessed most often, ranked by session count; shows read and changed counts per file with a "last seen" date; tip box adapts per mode (Read / Changed / Both) explaining what to do about each pattern
- **MCP server** — Streamable HTTP server (port 4316) that gives Claude Code and other agents direct access to session history via five tools: `get_recent_sessions`, `get_workspace_patterns`, `get_session_detail`, `find_relevant_context`, `get_efficiency_report`; toggle in Settings; auto-starts with the extension; standalone server also runs on port 4316
- **Shared filter bar** — time range, agent, source, text search, and From (initiator) filters now appear on Sessions, Analytics, Patterns, and Export tabs; state retained when switching tabs; Reset available everywhere
- **Export respects filters** — export sends the active filtered session IDs to the backend; both VS Code and standalone export only what is visible, not the full database
- **Chart → session navigation** — clicking a bar in Estimated Cost or Token Usage Per Session, or a line in Context Growth, navigates to the Sessions tab and expands that session
- **Loop signals for log sessions** — `detectLoopSignals` now runs on log-reader sessions (was always empty); exact-tool-repeat and runaway-step signals now appear on log-sourced sessions
- **VS Code-family IDE coverage** — Copilot Chat log ingestion now scans Cursor, Windsurf, VSCodium, Trae, and Kiro workspace storage directories in addition to VS Code and VS Code Insiders
- **Improved ingestion logs** — span ingestion now shows agent name instead of a running total; session load shows per-agent breakdown with source directories
- **Context and Context Window** added to the Help glossary with precise definitions

### UX

- **Analytics section headers** — all-caps with letter-spacing; first section spacing tightened to match filter bar
- **Patterns section headers** — all-caps with letter-spacing, matching Analytics style
- **Context Growth chart** — most recent 25 sessions shown (was oldest 25); session count label; ◀▶ step buttons moved next to speed controls; fixed step buttons not highlighting when an external session focus was set
- **Context Growth bug fix** — chart was missing for log-sourced sessions because tool-using turns were classified as `type:'tool'` instead of `'llm'`; now correctly picks up turns with `inputTokens > 0` regardless of type
- **View Automations button** — automation popup now has a View Automations button to the left of Copy Prompt, matching the alert popup pattern
- **Padding and spacing** — added padding above sessions table, patterns content, and export cards
- **Export tab** — removed total session count header; removed "browser download" label

### Fixed

- **Analytics charts filter** — Estimated Cost bar chart, Token Usage Per Session, and Context Growth were not updating when the text filter or From filter changed; fixed to use `filteredSessions` (sorted by time) instead of `rangedSessions`
- **Refresh button stale range** — time range picker's Refresh button now writes the fresh `TimeRange` to the signal before calling `fireSearch`, fixing stale in-memory session boundaries after refresh
- **MCP workspace filter no-op** — `get_recent_sessions` workspace filter had `|| true` making it always pass; removed
- **logReader sparse array crash** — `Math.max(...turnTimestamps)` on a sparse array (turns with missing timestamps) threw `RangeError: Invalid time value`; now filters undefined entries first
- **Cost sort wrong pricing mode** — session sort by cost was pricing session B with session A's mode; fixed to derive mode per session
- **Session detail request on every render** — `vscode.postMessage({ type: 'loadSessionDetail' })` was called in the render body of `SessionDetail`, firing on every re-render; moved into `useEffect`
- **Export standalone fix** — standalone export was a no-op (re-dispatched message to window with no listener); now triggers a real browser download
- **Redacted export** — now replaces file paths with `[redacted]` in addition to prompt text
- **`scheduleWatchScan` debounce** — was leading-edge (only first event in a burst); converted to trailing-edge so scan fires 300ms after the *last* fs.watch event, preventing partial reads during streaming file writes

### Docs

- **Help — Patterns section** — new section in the TOC and content covering the Efficiency Map and Hot Files panels
- **Help — Export section** — corrected description; export now respects active filters
- **Help — Agent Integration** — CLAUDE.md block tightened to 2 lines; note added that brevity avoids context window bloat; standalone MCP URL corrected to port 4316
- **README** — Patterns feature bullet added; Export bullet updated to reflect filter-aware export
- **CLAUDE.md** — tightened to 2-line instruction block

---

## [0.5.0] — 2026-06-03

### UX

- **Navigation overhauled** — tab bar collapsed from six entries to three data views (`Sessions | Analytics | Export`); three icon buttons sit right-aligned in the header
- **Bell icon — active alert status** — badge shows the number of currently triggered alerts; click to open a compact status card listing each alert with severity, name, and detail text; "Configure alerts →" link jumps to the settings panel
- **Gear icon — settings panel** — slide-in panel (440px, scrollable) with collapsible Alerts and Automation sections, both open by default; close with × or Escape
- **Help icon** — replaces the Help tab; active state shows the same blue underline as tab buttons
- **SVG icons throughout** — bell, gear, help, and refresh buttons are all stroke-based SVGs using `currentColor`; same visual weight at any size, work in dark and light themes with no emoji rendering quirks
- **Severity dots in alert card** — alert card rows use small coloured circles instead of emoji for severity indicators
- **Tab bar alignment** — tabs now sit flush to the top of the view in both VS Code and standalone; standalone sidebar gets 8px top padding for breathing room
- **Agent key legend removed** — the `● Copilot ● Claude ● Codex` row at the top of the sidebar was redundant with the per-session agent indicator already shown in each card

### Fixed

- **Copilot Chat log ingestion** — added `_parseCopilotVSCodeFile` (delta-log JSONL) and `_parseCopilotVSCodeJsonFile` (legacy JSON snapshot) for `workspaceStorage/chatSessions`; handles three `completionTokens` formats (direct kind=1, embedded in kind=2 push, pre-June 2026 result.usage); fixes k.length===1 guard to prevent sub-array inflation of `requestPushCount`; two-phase startup loading (fast group batch=10, slow .json group batch=2 with 50ms gap) to keep extension host responsive
- **Copilot CLI session.shutdown** — reads `modelMetrics[model].usage` instead of `currentTokens` for correct token totals
- **Codex prompt extraction** — extracts user prompt from `event_msg payload.type=user_message`; strips IDE context preamble (`## My request for Codex:`) via `_extractCodexUserText`
- **Clear All Data** — `agentLens.clearSessions` command was registered but the button did nothing; now correctly clears pending queue and generation counter, refreshes UI before re-ingestion, and triggers `setImmediate(runLogScan)` in standalone so log sessions repopulate after clear
- **Standalone alert / automation notifications** — match VS Code UX: automation label format `Automation: <label>`, alert notifications use `showActionNotification` with View Alerts secondary action and 30s dismiss; `\n` escaping fixed in template literals to prevent broken inline JS strings

### Docs

- **Help — Settings section** — replaces separate Alerts and Automation sections in the Help TOC; describes the bell icon (badge, status card, Configure link) and gear icon (settings panel, collapsible sections)

### Chore

- **`.map` files gitignored** — `media/dashboard.js.map`, `media/dashboard.css.map`, `media/sidebar.js.map`, and `standalone/cli.js.map` are no longer tracked; all caused unresolvable conflicts on rebase because git cannot merge the base64 mapping blobs
- **Post-rebase/merge hooks** — `.githooks/post-rewrite` and `.githooks/post-merge` run `node esbuild.js` automatically so `cli.js` and other build artifacts stay in sync after any rebase or merge without manual intervention; `core.hooksPath = .githooks` set in project git config
- **`.claude/settings.json` gitignored** — per-developer Claude Code permissions config; was creating constant noise in `git status`

---

## [0.4.1] — 2026-06-03

### Docs

- **Help tab restructured** — dedicated sections for Sessions, Analytics, Alerts, Automation, and Export now mirror the app's tab layout; Insights and Loop Detection moved from standalone top-level sections into the Sessions section where they live in the app; Sessions section now clearly documents the five sub-tabs (Overview, Trace, Flow, Tools, Files) including that Insights lives inside Overview
- **Log file ingestion mentioned in descriptions** — Help Overview paragraph, VS Code extension description, and walkthrough "Agents Are Ready" step now surface log file ingestion as a zero-config data source alongside OTEL traces

---

## [0.4.0] — 2026-06-02

### Added

- **Source filter** — Sessions and Analytics tabs now have an OTEL / Log toggle to show only OpenTelemetry-traced sessions or only log-ingested sessions (or both)
- **Session initiator badges** — each session row shows a `User`, `Agent`, or `API` badge indicating how the session was started; an Initiator filter in the Sessions tab lets you narrow to a specific origin
- **Real-time log updates** — standalone server uses `fs.watch` to detect JSONL file changes and re-reads the full file immediately, so new turns appear without waiting for the 30-second poll

### Fixed

- **Standalone first-load blank page** — log sessions are now loaded synchronously before the first response so the Sessions tab is never empty on first open
- **Standalone cache hit rate and token counts** — corrected calculation from log-ingested sessions; total tokens and cache hit rate now match VS Code sidebar values
- **VS Code notification prefixes** — alert and automation notifications are now prefixed `Alert:` / `Automation:` instead of the longer `AgentLens Alert:` / `AgentLens Automation [label]:`
- **Reset button placement** — Reset sits adjacent to the Source filter in the Sessions and Analytics toolbars, with a slightly larger hit area

### Docs

- Getting Started reordered: Local (npx) install first, VS Code second, Docker third; "standalone" renamed to "local" throughout README and in-app Help

---

## [0.3.0] — 2026-06-02

### Added

- **Local log file ingestion** — AgentLens now reads JSONL session files from disk for all three agents automatically, with no OTLP setup required. Files are scanned at startup (newest-first, in batches of 10 to avoid blocking) and polled every 30 seconds for new or updated files. Sessions from log files carry an OTEL/Log source badge in the Sessions table.
  - Claude Code: `~/.claude/projects/**/*.jsonl` (env override: `CLAUDE_CONFIG_DIR`)
  - Codex: `~/.codex/sessions/**/*.jsonl` (env override: `CODEX_HOME`)
  - Copilot CLI: `~/.copilot/session-state/<uuid>/events.jsonl` (written automatically — no env setup required)
  - Disable via `agentLens.enableLogIngestion: false` in VS Code settings
- **Standalone server — log ingestion + npx** — the standalone server now ingests local log files, auto-opens the browser on start, and is available as `npx agentlens` / `npx agentlens-dashboard` (pass `--no-open` to suppress browser launch)
- **Cost table — M/K token display** — token counts in the Estimated Cost table now display in compact form (e.g. `1.2M` / `345K`) with a toggle to switch between compact and raw numbers; Model column shortened to show only the model name without the provider prefix

### Fixed

- **Analytics chart label overlap** — date and turn labels on all three charts now thin automatically to prevent collision at any zoom level or session count: `HistoryChart` (SVG bar chart, daily mode) uses a pixel-aware stride snapped to human-readable intervals; `CostBarChart` uses a minimum-gap guard on day boundary labels; `ContextGrowthChart` uses pixel-aware x-axis step calculation (minimum 32 px between label centres)
- **Copilot log path** — Copilot sessions now read from `~/.copilot/session-state/` (the path written by Copilot CLI automatically); was incorrectly reading from `~/.copilot/otel/`
- **In-progress vs. missing prompt** — sessions with a prompt that hasn't arrived yet show `…`; sessions that genuinely have no prompt (e.g. log-only Codex sessions) show `—`
- **Copilot prompt extraction** — startup log scan now skips injected XML preamble blocks (`<current_datetime>`, `<system_reminder>`) when extracting the user request from Copilot `transformedContent` events

### Docs

- README and walkthrough updated for log file ingestion; Docker and native run instructions added; OTEL setup prioritised over log files in getting-started guide
- ARCHITECTURE.md updated: new §4 Local Log Ingestion (file paths, incremental scan mechanics, data parity table), §1 system overview showing `LogReader` as a parallel ingestion path, updated `SessionSummaryCard` class diagram (`dataSource`, `conversationId`), and updated file map

---

## [0.2.1] — 2026-06-01

### Added

- **Analytics cost table — CSV download** — `↓ CSV` button above the Estimated Cost table exports `agentlens-cost.csv` with one row per agent per day (raw numeric token counts and 4-decimal cost) plus a grand total row; works in VS Code and standalone browser

### Fixed

- **Automation notifications** — all three notification sites now consistently read `AgentLens Automation [label]`; was showing `AgentLens [label]` (missing "Automation") or `AgentLens Automation: label` (colon instead of brackets)
- **Sidebar burn rate** — retains last known value after a session ends instead of reverting to "Waiting for data…"; resets when a new session starts
- **Standalone sidebar** — removed Open Dashboard button (the dashboard is the main panel in standalone; VS Code sidebar keeps it)
- **Sessions filter bar** — sort pills (Cost/Duration/Tokens) replaced with a Reset button at the right end; clears text filter, agent filter, time range, session limit, and sort back to defaults; only visible when at least one filter is non-default
- **Analytics** — Token Usage Per Session section moved below Context Growth
- Silent catch blocks in standalone server now log via `console.warn` instead of swallowing errors; unhandled promise on `writer.drain()` now has a `.catch()` handler; DB open failure logs the reason

## [0.2.0] — 2026-06-01

### Added

- **SQLite persistence** — four-phase database layer: schema (phase 1), write path persisting sessions after summarization (phase 2), read path replacing in-memory summarization with DB queries (phase 3), and analytics layer with historical queries, session search, time-range filtering, and storage management (phase 4)
- **Sidebar reworked as real-time live session monitor** — replaces the previous static summary with a live-updating panel: status card (Active/Idle, agent, model, prompt), counters (Turns / Tools / Errors / Cache hit rate), context growth sparkline with play/pause controls, token bars scaling independently against historical average with avg values inline, estimated cost card, and burn rate card; "X sessions stored" footer; Clear All Data fully resets all top-card fields
- **Sessions tab overhaul** — sortable by Cost, Duration, or Tokens via pills in the filter bar; filtered session count shown; Tools and Flow sub-tab labels show counts; expand-in-place row with five sub-tabs: Overview (stat tiles, burn rate, Insights), Trace (LLM and tool call waterfall), Flow (turn-to-tool graph), Tools (donut chart), Files (modified files with diffs)
- **Analytics tab overhaul** — per-agent breakdown cards, Estimated Cost chart with daily total green overlay line and date labels drawn inline at day boundaries, Token Usage Per Session, Context Growth chart with session-cycling animation
- **Standalone server sidebar parity** — token bars, estimated cost, burn rate, counters, sparkline, and all CSS classes now match the VS Code sidebar exactly; fixed crash from undefined `inProgressTraceIds` variables
- **Demo replay: export-format support** — `pnpm run demo -- --file ./export_sessions_<timestamp>.json` now works; converts session summaries into synthetic OTEL spans (root + LLM call + tool call spans per session) with correct attribute keys for the summarizer
- **Estimated cost per LLM span** — shown in Traces and Flow tabs alongside each LLM call
- **Tool call detail in Traces tab** — arguments and results visible in expanded span rows
- **Session ID in clipboard prompts** — Insights copy button includes `Session ID:` so AI can identify the session
- **user_input timeline entry type** — Claude Code permission prompt interactions captured in the session timeline
- **"X sessions stored" footer** — unfiltered session count shown in sidebar footer and Sessions tab footer
- **Date labels inside Estimated Cost chart** — day boundary labels rendered inline matching Token Usage Per Session style

### Fixed

- Standalone sidebar tokens and estimated cost not rendering — `computeSidebarPayload` was missing `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreateTokens`, `costUsd`, `avgInputTokens`, `avgOutputTokens`
- Context Growth animation frozen in play mode — `focusedSessionId` was overriding `activeIdx` unconditionally; animation index was resetting to 0 on every SSE update due to new array reference on each render
- Sidebar Clear All Data not resetting top card — agent name, duration, prompt, and model now clear when `currentSession` is null
- Sidebar active indicator firing on background Copilot calls — whitelisted to real agent span names only (`claude_code.*`, `invoke_agent*`, `codex.turn/session`); 45-second window
- Burn rate tied to `isActive` instead of 2-minute `startTime` cutoff
- Sidebar estimated cost: cache tokens subtracted from `inputTokens` before rate calculation (matches Sessions table)
- Help pill nav clipping on wrap — `flex-wrap:nowrap` + horizontal scroll
- Demo replay crash on export files — `BigInt()` cannot parse ISO timestamp strings
- Status bar item now opens both sidebar and dashboard on click

### Changed

- Daily total line on Estimated Cost chart changed from purple to green, matching cost value color used throughout the UI
- Summaries tab renamed to Traces; old waterfall Traces tab removed
- Tab structure simplified to 6 primary tabs: Sessions, Analytics, Alerts, Automation, Export, Help
- Automation popups labelled "AgentLens Automation: \<label\>"; alert popups labelled "AgentLens Alert"
- "Current session" label removed from sidebar status card
- Insight card text size reduced to 11px to match rest of UI
- Product name removed from all clipboard prompts
- Sessions sort moved into filter bar; Errors sort removed

### Docs

- README: updated tagline, corrected Claude Code config (removed stale `OTEL_SEMCONV_STABILITY_OPT_IN` and `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` env vars now cleaned up by auto-configure), dashboard tab names corrected, Copilot billing table updated
- Walkthrough files: dashboard tab table rewritten for current 6-tab structure; loops walkthrough updated to reflect Insights location and clipboard copy button
- Help tab Setup section: stale env vars removed; Copilot OTEL coverage corrected (cache read tokens are available; only cache write is absent)
- ARCHITECTURE.md: fully rewritten covering the 4-phase SQLite persistence architecture with Mermaid diagrams

## [0.1.5] — 2026-05-28

### Added

- **Claude Code cost estimates** — the Cost tab now includes `claude_code` sessions alongside Copilot and Codex; uses Anthropic API token-based pricing (input, cache write, cache read, output) with per-model rates for all current Opus, Sonnet, and Haiku variants; no billing mode toggle needed (Claude has always been token-based)
- **Codex cost estimates** — Cost tab extended to include Codex CLI sessions using OpenAI token-based pricing (input, cached input, output) with rates for all current and deprecated Codex models
- **Primary tab bar + More ▾ overflow dropdown** — replaces the flat wrapping tab row with a fixed-height single row; six primary tabs always visible (Efficiency, Cost, Summaries, Recommendations, Export, Help); ten secondary tabs (Agents, Alerts, Automation, Errors, Files, Flow, Latency, Tokens, Tools, Traces) in an alphabetically-sorted dropdown; active secondary tab name shown in the button label
- **Help tab — mode-aware Setup section** — configuration steps adapt to VS Code extension vs. standalone server context; Copilot CLI configuration added; Manual Configuration section with per-agent headings
- **Help tab — glossary hyperlinks** — first-mention of each glossary term in body text links to its definition; VS Code webview link styling fixed
- `pricing.ts` — Codex model rate table (all current and deprecated models including `codex-mini-latest`); Claude fast-mode rates corrected (`claude-opus-4-6-fast`, `claude-opus-4-7-fast` at $30/$150 per MTok); deprecated Claude models added for historical sessions
- `PRICING_SOURCES.md` — Claude section fully populated: source URL, OTEL fields, formula, rate table with fast-mode and deprecated entries, known gaps (cache TTL ambiguity, fast-mode underestimation, Opus 4.7 tokenizer change)

### Fixed

- Help tab VIEWS array: replaced stale `Timeline` entry (orphaned component, not a real tab) with `Export`; order corrected to match the actual tab bar sequence

### Changed

- Cost tab: Claude and Codex subtotal rows added to the session table footer; grand total row now appears when sessions from any two agent types are present; Known Gaps section restructured per-agent with a new Claude block
- Cost tab empty state updated to mention Copilot, Claude, and Codex
- Renamed "OpenAI Codex" → "Codex" throughout dashboard UI, Help tab, README, and configuration scripts
- README restructured: Getting Started moved before Features; Standalone Docker split into Running and Configuring subheaders; Cost Estimation section expanded to cover all three agents; Manual Configuration section expanded to mirror Help tab content; `chmod +x` and PowerShell execution policy instructions added for configuration scripts; Additional Features section added at the bottom

## [0.1.4] — 2026-05-27

### Added

- **Cost tab** — estimates Copilot session cost with three billing model toggles: token-based AI Credits (Jun 2026+, default), request-based with multipliers (pre-Jun 2026), and annual-plan request-based (post-Jun 2026 for annual plan holders)
- Per-session cost bar chart; zero-cost sessions shown as a colored tick on the x-axis
- Cross-session cost table with token breakdown, cost, and AI Credits columns; respects active session filter
- Estimates-only disclaimer with last-updated date and anchor-linked Known Gaps section
- `media/src/pricing.ts` — rate table for all Copilot models verified against GitHub pricing docs, including footnotes for included models (GPT-4.1, GPT-5 mini → $0 in token mode) and long-context surcharge notes
- `PRICING_SOURCES.md` — authoritative source URLs and maintainer notes for all three Copilot billing models

### Fixed

- README "Agent Telemetry Formats — Copilot" section incorrectly stated cache token data is unavailable; corrected to note cache read tokens are present via `gen_ai.usage.cache_read.input_tokens` and only cache write is absent

### Changed

- README: added Cost Estimation section, updated feature list, corrected dashboard tab count to 16

## [0.1.3] — 2026-05-24

### Changed

- README overhauled — restructured around a local/transparency theme; Getting Started split into VS Code Extension and Standalone (Docker) subsections with ephemeral and persistent Docker commands; Configuration reorganized with Manual Configuration first followed by Auto-configuration; Replaying Exported Spans promoted to its own top-level section; section headers simplified throughout
- Removed unused setting from VS Code extension settings contributions

## [0.1.2] — 2026-05-22

### Added

- **Export tab** — new dashboard tab (between Errors and Help) with Export Raw and Export Redacted buttons, 3-second confirmation state, and inline replay instructions
- **Export Redacted** — `AgentLens: Export OTEL Data (Redacted)` command; prompt text, tool inputs/results, and PII fields (`user.*`, `enduser.*`, `organization.*`) replaced with `[redacted]`; files named `export_redacted_*`
- **Replay from exported file** — `pnpm run demo -- --file <path>` replays any exported JSON (raw or redacted) directly into the dashboard; instant send by default, `--speed N` for paced replay; works with both plugin and standalone on port 4318
- **Sidebar latest session card** — model, source, turns, tool calls, errors, and cache hit rate for the most recent session
- **Sidebar expand/collapse** — ◄/► toggle to show or hide the AgentLens sidebar panel; dashboard opens automatically on first activation

### Changed

- Recommendations action buttons unified to "Copy for {Agent}" / "Copy to Clipboard" (removed "Ask Claude / Ask Copilot / Ask Codex" labels)
- Standalone export now downloads a ZIP archive; plugin export writes JSON files to workspace root

### Fixed

- Export `message` event listener was registered inside the tooltip `useEffect` without cleanup — moved to its own `useEffect` with proper removal on unmount

## [0.1.1] — 2026-05-22

### Fixed

- Port conflict detection now distinguishes between another AgentLens VS Code window (silent fallback with cross-window sync), the AgentLens standalone server (error with specific message), and an unrelated process (error with instruction to change `agentLens.otlpPort`)
- Plugin and standalone servers now expose fingerprint endpoints (`/agentlens/plugin` and `/agentlens/standalone`) so each can identify the other

## [0.1.0] — 2026-05-21

### Added

- Built-in OTLP/HTTP collector on `127.0.0.1:4318` — JSON-over-HTTP only (protobuf not required)
- Auto-configuration for GitHub Copilot, Claude Code, and Codex on activation
- 15-tab dashboard: Efficiency, Recommendations, Alerts, Automation, Summaries, Traces, Files, Agents, Tokens, Latency, Flow, Tools, Errors, Export, Help
- Loop and malfunction detection — Tool Call Deadlock, State Corruption Spiral, Hallucination Amplification Loop, Escalating Scope, Context Accumulation
- Conversation grouping — Copilot and Codex sessions linked by their conversation thread ID
- Per-session Conversation column in Efficiency tab
- Standalone web server mode (`pnpm run standalone`) and Docker image (`agentlens/agentlens`)
- Write Prompts File automation — writes triggered prompts to `agentlens-prompts-{agent}.md` in workspace or server directory
- Automation recency guard — only sessions active within the last 2 minutes trigger automations
- Per-agent threshold profiles for Alerts and Automation tabs
- Export tab — export raw or redacted span data as JSON directly from the dashboard; includes replay instructions
- Export OTEL Data command — writes raw span data as JSON files (Command Palette: `AgentLens: Export OTEL Data`)
- Export OTEL Data (Redacted) command — same export with prompt text, tool inputs/results, and PII fields replaced with `[redacted]` (Command Palette: `AgentLens: Export OTEL Data (Redacted)`)
- Collector error banner in sidebar when OTLP port is already in use
