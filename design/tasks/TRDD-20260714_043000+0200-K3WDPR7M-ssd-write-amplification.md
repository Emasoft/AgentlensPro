---
trdd-id: K3WDPR7M
title: SSD write amplification — raw OTEL bodies rewrite the whole conversation every turn; move the body store to a fileless-DuckDB to immutable-Parquet loop
column: dev
created: 2026-07-14T04:30:00+0200
updated: 2026-07-16T17:26:00+0200
current-owner: main
task-type: bugfix
severity: critical
scope: project
npt: []
eht: []
---

## ⏵ STATE — 2026-07-16 17:26 — RECONCILIATION: Phase 6 RESOLVED by X2E6OSWK; Phase 3 premise DOWNGRADED; Phase 4 burn-half already landed

**Supersedes the ~21:40 block's NEXT-ACTIONS list below (items c/e resolved; a re-scoped).**

- **(c) Phase 6 — CPU spin: ✅ RESOLVED via TRDD-X2E6OSWK (2026-07-16).** The planned `--cpu-prof`
  profiling is moot: the culprit was NAMED (get_cost_by_cause's unyielding 50-reparse flatMap,
  matched frame-by-frame against the 15:24 native sample), BOUNDED (scanWithBudget: macrotask
  yield + 20s deadline, now shared by every corpus-fanning drill incl. check_cache_expiry), and
  BACKSTOPPED (event-loop watchdog 4949af7 + per-tool start/done logging 4b4dc8f so any future
  wedge names itself). Shipped in v2.8.0 + follow-up.
- **(a) Phase 3 — RAM-disk body spool: ✅ BUILT AND LIVE (correcting this addendum's first
  version, which said "not built" off the stale 21:40 block — the CODE disproved it).** The full
  pipeline ships in `standalone/server.ts` (spool resolution at boot with re-create-on-reboot,
  drain targets with RAM caps, verified-then-delete ingest into the store) + the capture-on CLI
  flow (spool creation, `capture.spoolDir` persistence, LaunchAgent remount). ACTIVATED on this
  machine 2026-07-16 ~17:30 per the USER's data-retention directive ("no otel logs" = broken):
  `captureRawBodies=on`, 2 GB spool at `/Volumes/AgentLensSpool`, key wired `file:<spool>`.
  Follow-up defect found + fixed in the activation: the spool-blind server-boot converge
  re-pointed the key at the legacy SSD dir minutes after the CLI wired the spool — closed by the
  ONE bodies-dir resolution (`effectiveBodiesDir`, commit `4efe0f5`, 4 regression tests).
- **(b) Phase 4 — the burn half ALREADY LANDED**: log-sessions/log-offsets delta append shipped in
  `9985c34` (9.4 MB/min → ~0, measured via ri_diskio_byteswritten). Remaining Phase-4 items are
  NOT burn issues: `forensics.db` fold (openForensicsDb has 0 prod callers — dead path) and the
  `loadSpawnMap` unresolved-spawn bug (forensics-only). Both are cleanup chores on a dead code
  path; low priority.
- **Known gap #3 (ts backfill) is CLOSED — do not reopen.** The v2 migration corrected all
  78,354 idx-joinable rows (probe: 0 wrong ±2s); the residual 22,569 rows keep ingest-ts because
  their capture times are UNRECOVERABLE BY DESIGN — accepted + documented in
  CHANGELOG/README/ARCHITECTURE (commit `eaf0b53`).
- **Genuinely open, in order:** (1) forensics fold + loadSpawnMap (dead-path chores, low
  priority); (2) conditional RAM-disk spool (only if capture-on is ever recommended). USER-gated:
  `store.old-v0` (270 M) + `spans.json.bak*` (182 M) disposal; branch pushes.

(Superseded ~21:40 block, kept for lineage:)

## STATE (superseded) — 2026-07-15 ~21:40 — WAD VERIFY+RECLAIM DONE (15.78 GB reclaimed, 0 lost); Phases 3/4/6 still open

**Supersedes the ~10:09 block below (its NEXT ACTION 5a is DONE).**

1. **Wad verify+reclaim COMPLETE — clean pass.** `verify-and-reclaim-wad.cjs --delete` proved all
   **78,355/78,355 lumps** byte+capture-ts identical vs the `.idx`, **0 failed**, 170.8 min. Then
   deleted ONLY `bodies-2026-07.wad` (**15.78 GB reclaimed**) and KEPT `bodies-2026-07.wad.idx`
   (8.5 MB). Archive dir now holds only the `.idx`. Log: `/tmp/wad-verify.txt`.
   **AUDIT (RULE 0.5):** authorized by USER 2026-07-15 verbatim — "delete the wad only after the
   verification passes"; executed 2026-07-15T19:35:00Z after the 0-failed proof.
2. **The verifier had to be DAEMONIZED to finish.** Harness-tracked `run_in_background` tasks were
   killed twice by session-lifecycle events (each before the first progress line, losing all
   progress — no checkpoint). Fix: `scripts_dev/detach-run.py` (double-fork + `os.setsid`; macOS has
   no `setsid`) reparents to init (ppid 1); the daemon then survived a server restart AND a
   `/compact`. Lesson captured in LOCAL memory `detach-long-jobs-from-session-lifecycle`.
3. **Disk picture now** (`du -sh ~/.agentlens/*`, was ~22 GB): `otel-bodies` **6.0 G** (raw CC bodies,
   still SSD — Phase 3 RAM-disk pipeline NOT built yet), `spans` 551 M, `store` 269 M (v2 compact),
   `store.old-v0` 270 M (pre-migration backup — separate USER disposal decision), plus stale
   `spans.json.bak*` (99 M + 83 M), `log-sessions.snapshot` 33 M. The 15.78 GB wad — the single
   biggest offender — is gone.
4. **NEXT ACTIONS (K3WDPR7M still `dev` — the store loop is not finished):** (a) Phase 3 — RAM-disk
   body pipeline so CC's ~21 MB/min never touches the SSD and `otel-bodies` (6 G) stops growing;
   retire `archiveOtelBodies()`. (b) Phase 4 — delta writes for `log-sessions.json`/`log-offsets.json`
   + fold `forensics.db` + fix `loadSpawnMap()`. (c) Phase 6 — profile the CPU spin (`--cpu-prof`
   first; earlier root cause REFUTED). (d) `store.old-v0` disposal = USER call. (e) USER: restart
   stale Claude sessions (still writing raw bodies). (f) branch `feat/cache-expiry-probe` NOT pushed
   — push/PR = USER call.

## ⏵ STATE — 2026-07-15 ~10:09 — MIGRATION DONE (schema v2, probe 0 wrong); server LIVE on v2; wad verify+reclaim IN FLIGHT

**Supersedes the ~06:00 block below (its NEXT ACTIONS 1–4 are DONE).**

1. **Schema-v2 migration SUCCEEDED** (attempt 3; attempts 1–2 aborted SAFE — port guard, then
   float-mtime `BigInt` throw, fixed in `223ad27`). 78,354 ts corrections + 323 alias rows;
   VERIFY#1 full validation 208 min: 100,600 bodies + 328,606 spans, **0 lost**; atomic swap done.
   Manifest: `schemaVersion: 2, migratedFrom: 0`. Backup kept at `~/.agentlens/store.old-v0`
   (NOT `.old-v1` — schema 0 IS the v1 layout, the backup is named `.old-v<from>`; disposal is a
   separate USER decision). Log: `/tmp/ts-migration3.txt`.
2. **Post-migration probe PASS** (`/tmp/ts-probe-after.txt`): 78,354/78,354 idx-joinable rows
   ts-CORRECT (±2s), **0 wrong**; 22,569 rows keep ingest-ts (capture times unrecoverable by
   design — documented in CHANGELOG/README/ARCHITECTURE, commit `eaf0b53`). Body rows now
   100,923 = 100,600 + 323 aliases.
3. **Server re-enabled + LIVE on the v2 store** (pid 64106, boot 10:07): ui/mcp/otlp up,
   0.0 MB disk writes since boot, archive 78,355 lumps / 15.79 GB visible.
4. **IN FLIGHT: wad verify+reclaim** — `scripts_dev/verify-and-reclaim-wad.cjs --delete`
   running in background (~2.5 h) → `/tmp/wad-verify.txt` (`WAD_VERIFY_EXIT=<n>` appended).
   Full per-lump proof (bytes + capture-ts vs .idx); on 100% pass it deletes ONLY
   `bodies-2026-07.wad` (16.9 GB), ALWAYS keeps the `.idx`. AUDIT (RULE 0.5): authorized by
   USER 2026-07-15 verbatim — "delete the wad only after the verification passes".
5. **NEXT ACTIONS:** (a) read `/tmp/wad-verify.txt` on completion — pass ⇒ confirm .wad gone +
   `.idx` kept, record audit line; fail ⇒ NOTHING deleted, read named failures, fix, re-run;
   (b) final report to user (migration + wad verdicts, `du -sh ~/.agentlens/*`, branch state —
   `feat/cache-expiry-probe` NOT pushed, push/PR = USER call); (c) USER still needs to restart
   stale Claude sessions (they keep writing raw bodies until relaunch).

## ⏵ STATE — 2026-07-15 ~06:00 — USER directives: universal verify-before-delete + verified .wad reclamation; ts recovery ready to run [SUPERSEDED]

**Supersedes the ~04:15 block below. USER directives (verbatim, 2026-07-15):**
1. "do not delete the wad, ingest it" → then superseded by (3).
2. "improve the ingestion system adding a verification step. only after the verification that all
   data was imported, you can delete the source file."
3. "delete the wad only after the verification passes." ← the STANDING authorization: full per-lump
   verification (bytes + capture-ts) ⇒ delete `bodies-2026-07.wad`, ALWAYS keep the 8.8 MB `.idx`.
4. "the verification step must be done everytime the source is gonna be deleted after. even for
   OTEL logs, statusline logs, hooks logs, etc." → the UNIVERSAL invariant.

**Probe evidence (`scripts_dev/probe-ts-damage.cjs`):** 78,031/78,031 idx-joinable rows carry
ingest-batch ts (drain ran 21:52→00:15 on STALE out/ — tsMs support wasn't compiled); 22,569 pass-1
rows also ingest-day ts, their true times UNRECOVERABLE (sources deleted, no span↔file linkage in
code — do not fabricate); 323 idx names have NO row (content-dedup aliases).

**LANDED (commit `ddd633b`, 1179 tests green):** `src/store/verifyInStore.ts` (THE gate: bytes
reconstruct + (src_name,ts) row ±2s) wired into ingestPass + migrateArchive; ingestBody now writes
an alias row per deduped capture (else the gate could never pass for duplicates) + explicit
`existed` flag; `src/store/tsRecovery.ts` + CURRENT_SCHEMA=2 (staged migration: .idx-driven ts
corrections + alias materialization, aborts on unprovable alias); `src/store/archiveVerify.ts`
(per-lump volume verification); `purgeArchiveVolumes` now REQUIRES an async canDelete gate and
keeps `.idx` (uncommitted with its tests until the server wiring lands).

**IN FLIGHT:** background agent implementing hook-spool drain verification (+ rejected/ quarantine
instead of unlink) and DeltaLog compaction read-back verification.

**NEXT ACTIONS, in order:**
1. Agent done → wire server.ts: archiveOtelBodies passes the verifyVolumeInStore gate to
   purgeArchiveVolumes; rewrite POST /api/bodies/purge to verify-then-delete (keep .idx).
2. Full gate → commit (stage agent-created files BY NAME too) → rebuild bundle.
3. `agentlenspro server stop` → `pnpm run compile-tests` → `node scripts_dev/run-ts-migration.cjs`
   (staged, VERIFY#1 full validation ≈3.6 h, VERIFY#2 set-equality, swap; v1 kept at store.old-v1).
4. Re-run probe (expect tsWrong=0, aliases present) → server start.
5. `node scripts_dev/verify-and-reclaim-wad.cjs --delete` (~2.5 h): full per-lump proof, then
   deletes ONLY the .wad per directive (3); audit line in output.
6. Docs (README/ARCHITECTURE/CHANGELOG/skill) + this STATE, final commit.

## ⏵ STATE — 2026-07-15 ~04:15 — VALIDATION PASSED; the store code had NEVER SHIPPED (fixed, `36c87c8`); live acceptance measurement in flight

**READ THIS BLOCK FIRST — it supersedes the NIGHT block below.**

1. **Full-corpus independent validation: VALID.** V1 328,606/328,606 spans content-address OK;
   V2 100,600/100,600 bodies reconstruct to sha256 == body_id; 0 dangling; 0 errors (3.6 h,
   store quiescent). Evidence + all reclaim figures:
   `reports/storage-migration/20260715_003054+0200-backfill-and-drain.md`.
2. **THE BIG CATCH — the store never shipped.** `standalone/server.js` on disk contained ZERO
   store code: esbuild had been FAILING since d925107 wired the store into server.ts, because
   `@duckdb/node-api`'s native `.node` bindings cannot be bundled — and a failed esbuild leaves
   the stale outfile untouched, so the bundle *looked* current. The tsc+mocha gates run from
   `out/` and never exercise esbuild. FIX (`36c87c8`): `external: ['@duckdb/node-api']` on both
   node targets (it is a declared runtime dependency — runtime resolution from node_modules is
   the intended model, same stance as sql.js). LESSON: **source-only commits change nothing at
   runtime — a phase is "landed" only after build + restart**; the kill-switch violation below
   is the same failure class.
3. **Old server evidence.** The pre-store server (pid 98648) booted 17:50 Jul 14 — 4 min AFTER
   the DISABLED flag (17:46) — because the then-deployed cli.js predated the 32f24c8 kill-switch
   fix. Its own counters over 10 h: 5.5 GB written — offsets 1.9 GB×602 + cards 3.6 GB×112
   rewrites ≈ 9 MB/min, the exact burn the delta log fixes. Replaced 03:59 by pid 62615 running
   HEAD (36c87c8).
4. **New server boot is clean:** 17,018 cards + 12,472 offsets migrated from legacy JSON into
   the DeltaLog; fast restart; store online (411,240 spans, 270 MB); capture key absent
   ("Full telemetry config already in place"); rss 642 MB at boot (old server: 2.9 GB).
5. **Drain semantics confirmed as designed (not a bug):** non-spool mode drains HOURLY with a
   72 h live window (`bodiesMaxAgeHours def 72`) and an 8 GB emergency cap (over it: ingest
   everything, age 0). The 3.5 GB regrown backlog is all <72 h old → unreferenced by any pass
   yet; it self-cleans as it ages. Spool mode is 60 s cadence.

**NEXT ACTION:** read `/tmp/accept-writes.txt` after the 40-min sampler (task #57) — per-minute
`ri_diskio_byteswritten` deltas of pid 62615; target ~1 MB/min AgentlensPro-attributable
(baseline `/tmp/baseline-writes.txt`: 30.4 MB/min is Claude Code's own, with us OFF). Then
live-verify the kill-switch (task #58: disable → start must refuse → enable). Then hand the
USER the `.wad` decision: `otel-bodies-archive/bodies-2026-07.wad` = 16,945,501,938 bytes
(~16.9 GB) is now fully redundant (every lump provably reconstructable) — deletion is the
USER's call, and the 8.8 MB `.idx` MUST be kept until task #56 (ts recovery) has run.

### SUPERSEDED — do NOT carry forward
- "gates green through ab0eee0 prove the server works" — FALSE for runtime: the bundle was
  stale-broken the whole time (item 2). Everything server-side ran old code until 03:59 Jul 15.
- "AgentlensPro server down while disabled" — FALSE: pid 98648 ran 10 h through the disable
  (item 3).

## ⏵ STATE — 2026-07-15 NIGHT — deep re-audit found 2 latent defects (both fixed, `ee88e0b`)

Re-auditing my own "completed" checkmarks surfaced, in order of severity:

1. **Part-name collision = silent data loss (FIXED).** Part names came from the directory's FILE
   COUNT; two concurrent writers compute the same name, and **`COPY TO` silently overwrites**
   (verified by experiment). Now epoch-ms+pid+seq names + a refuse-to-overwrite guard, plus a
   concurrent-writers test. Prior corpus checked: no damage (old seeds always exceeded max tag;
   live store validates 0 dangling).
2. **The read path dead-ended (FIXED).** Reclaimed bodies existed only in the store and nothing
   read the store; `/api/bodies/export` now has a store half (`exportBodiesFromStore`).
3. **KNOWN GAP — backfilled `ts` is INGEST time, not capture time.** `ingestBody` now takes `tsMs`
   (both callers pass file mtime / .idx mtimeMs), but the first backfill's ~22k rows + drained
   lumps carry ingest-day timestamps. RECOVERY PATH: the retained `.wad` `.idx` entries hold true
   mtimes by src_name, and span body-pointer events hold capture times — a schema migration (the
   framework exists, `src/store/migrate.ts`) can rewrite the `bodies` parts from that map. Bytes
   are unaffected (hash-proven); only time-window queries lie until then.
4. **forensics.db is NOT a live write source** (plan claim stale): untouched since Jul 9,
   `openForensicsDb` has no callers. The `loadSpawnMap` unresolved-spawn bug remains a separate
   functional issue, not a burn issue.
5. **Phase 3's RAM-disk spool was NOT actually built** when I first marked it done — only the
   archiver retirement was. Now in flight (opus agent, spec in this session): capture-on requires
   the spool, fail-fast, 60s drain, LaunchAgent remount.

## ⏵ STATE — 2026-07-14 EVENING — Phases 2/3/4 LANDED, gate green (1093 passing)

**Every claim below is measured, not reasoned.** Device writes via `ri_diskio_byteswritten` —
file-size growth LIES (a row-group rewrite burns writes without growing the file).

| burn source | before | after | where |
|---|---|---|---|
| Claude Code raw bodies | ~21 MB/min | **0** (capture opt-in, default OFF) | TRDD-BKF5NZD3 |
| `.wad` archiver boot pass | **694 MB/min** | **retired** → throttled store ingest | `d925107` |
| `log-sessions.json` + `log-offsets.json` | 9.4 MB/min | **~0** (delta append) | `9985c34` |
| our store | — | **15 KB/turn** (floor is 14) | `e63ec01` |
| CPU spin | 50–78% | fix in flight | TRDD-X2E6OSWK |

**DRY RUN on the real corpus (deleteAfter=false — NOTHING deleted):**
`7,439 bodies · 4.00 GB → 0.024 GB zstd Parquet (167×) · VERIFIED 7439/7439 byte-identical from the
DURABLE store · 0 failures.`

**The extension is CANCELLED, on evidence** (user-ratified): the measured floor is 14 KB/turn and
plain SQL already achieves 15 KB/turn. A custom Rust DuckDB extension cannot beat the floor — at
best it recovers ~1 KB/turn — while costing a per-platform native binary loaded in-process, which
breaks the prebuilt-binary/npx-installable property. Reopen ONLY if profiling shows the JS
sectioner is a real bottleneck.

**CPU-spin root cause (profiled, and it REFUTES the old 4s-tick theory):** `buildUpdatePayload()`
rebuilds the whole dashboard on a **1-second** debounce floor (the code's own comment says 4s), and
`runLogScan()` does a full readdir+stat of **12,508 files every 5 s** *and* on every `fs.watch`
event. Together ~78% of non-idle CPU.
Evidence: `reports/cpu-profile/20260714_203932+0200-cpu-spin.md`.

**NEXT ACTION:** Phase 5 — full backfill + reclaim. Authorized by the user, gated on the dry run
above. `ingestPass` only deletes a body after proving it reconstructs byte-for-byte from a DURABLE
Parquet part.

**SUPERSEDED — do NOT carry forward:**
- ~~"the 4-second tickBurn rebuild causes the CPU spin"~~ — measured and refuted twice.
- ~~"memory_limit removes the write amplification"~~ — it does NOT (the persistent `.db` burned
  5 MB/turn *with* it set). Being FILELESS does. `memory_limit`'s real job is to stop DuckDB
  spilling to `temp_directory` (which defaults to `.tmp` — a hidden SSD write path we now disable).
- ~~"this session writes 0 raw bodies"~~ — it did; I read the wrong metadata field (`session_uuid`;
  the real one is `session_id`), so everything attributed to `?`.

---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-14

**USER-REPORTED SYMPTOM (the trigger).** "We got a big problem with the server — it is burning my SSD
writing and rewriting the logs!" Activity Monitor: the server node process wrote **3.75 GB in 1h23m**.
The user's hard requirement: *"even 10 MB per minute is too much — you have to make it write only
optimized and compressed data into a SQLite DB."*

**MEASURED FACTS (all verified this session; no inference).**

| fact | value |
|---|---|
| `~/.agentlens/otel-bodies/` (loose JSON) | **8.1 GB**, 14,404 files |
| `~/.agentlens/otel-bodies-archive/bodies-2026-07.wad` | **14.7 GB** (single file) |
| total body storage | **~22 GB** |
| ONE raw request body | **~1.9 MB** |
| bodies written by Claude Code | ~30/min ⇒ **~57 MB/min** |
| `log-sessions.json` full rewrite | **33 MB every 5 min** (6.6 MB/min) |
| `log-offsets.json` full rewrite | **3.3 MB every 60 s** (3.3 MB/min) |

**ROOT CAUSE — TWO DISTINCT WRITE STREAMS, both amplifying.**

1. **Claude Code writes the bodies, not us.** `agentlenspro --install-otel` sets
   `OTEL_LOG_RAW_API_BODIES=file:~/.agentlens/otel-bodies` in `~/.claude/settings.json`. That makes
   **Claude Code itself** dump the *entire* request body — the whole conversation re-serialized — to a
   fresh ~1.9 MB JSON file on EVERY LLM request. We cannot change how CC writes; the only levers are
   (a) don't turn it on, (b) ingest-and-delete promptly.
2. **The server writes a SECOND copy.** `archiveOtelBodies()` (hourly) packs those loose bodies into an
   ever-growing `.wad` (now 14.7 GB, never pruned). So every byte lands on the SSD twice, and the
   archive grows without bound. This is what Activity Monitor attributed to the node process.
3. **Full-file rewrites of mutable state.** `log-sessions.json` (16,959 cards, 33 MB) and
   `log-offsets.json` (12,433 offsets, 3.3 MB) are rewritten IN FULL on a timer whenever any single card
   or offset changes — a whole-corpus rewrite to record a few KB of delta. (A cadence throttle was
   already applied — offsets 60 s, cards 5 min — but throttling a 33 MB full rewrite is treating the
   symptom; the file format is the bug.)

**THE KEY MEASUREMENT — the data is ~86% pure repetition.** Each request re-sends the whole transcript,
so body N+1 is almost entirely byte-identical to body N. Over a 40-body sample of one session:

```
raw bytes on disk:      45,184,010          (40 request bodies)
message blocks:         11,238  ->  unique 1,618  (14.4%)   <- 85.6% are exact repeats
dedup only:              6,405,841           (7.1x smaller)
dedup + per-block zlib:  3,035,790          (14.9x smaller)
```

Long-window compression confirms it independently: `zstd -19 --long=27` over 5 concatenated bodies gets
6,040,704 → 817,384 (7.4×), whereas per-file gzip only manages 2.6× — gzip's 32 KB window is blind to
the cross-body redundancy, which is exactly where all the waste lives.

**The load-bearing consequence:** with content-addressed message blocks, a turn's INCREMENTAL write is
only its NEW messages (`INSERT OR IGNORE` makes the 85.6% repeats cost ~0 bytes) — tens of KB per
request instead of 1.9 MB. That is the ~40–90× reduction on the write path, not merely a 15× shrink at
rest.

**ACTIONS ALREADY TAKEN (bleeding stopped).**
- Killed the runaway server (pid 75229: 78% CPU idle, 1.2 GB RSS) and an orphaned duplicate (18670).
- Removed `OTEL_LOG_RAW_API_BODIES` from `~/.claude/settings.json` via **`safeConfigEdit`** (the only
  sanctioned writer). Verified surgical: that ONE key gone; all 17 other OTEL keys and 19 top-level keys
  intact. Backup: `~/.claude/settings.json.agentlens-bak-20260714_042225291`.
  ⚠ **CC reads `env` at LAUNCH** — the current session keeps writing ~57 MB/min until the USER RESTARTS
  Claude Code. This is the single most urgent user action.
- Added an on-disk revive brake `<dataDir>/NO_REVIVE` (`reviveDisabledOnDisk()` in
  `src/cli/hookHandlers.ts`) — the env-only `AGENTLENS_NO_REVIVE` is unreachable in practice because a
  hook inherits the AGENT's env, so an operator cannot retrofit it onto a running agent, and `kill`
  alone is futile when the next hook resurrects the server. Rebuilt; verified the brake HOLDS across
  live hook fires (server stayed down, ports free). **The brake is currently ARMED — disarm with
  `rm ~/.agentlens/NO_REVIVE` once the fix lands.**

## ⏵ PHASE 1 BAKE-OFF — DECIDED BY **REAL DEVICE-WRITE** MEASUREMENT (2026-07-14, redone)

Evidence: `reports/storage-bakeoff/20260714_134500+0200-real-disk-writes.md`.
Harness: `scripts_dev/measure_writes.py` + `scripts_dev/writeprobe.mjs`. 40 real bodies,
chronological; 20-turn baseline then 20 MEASURED turns. Raw input = **881 KB/turn** (what CC writes today).

⚠ **SUPERSEDES the first bake-off** (`…122132+0200-duckdb-vs-sqlite.md`), which ranked engines on
**file-size growth** — a PROXY, and wrong by up to **57×**. The USER challenged whether the numbers were
real; they were not. We now read **`ri_diskio_byteswritten`** (`proc_pid_rusage`) — the same counter
Activity Monitor shows — **validated against a known 64 MB fsync'd write before use**, and every layout
is **forced fully durable (fsync) before sampling**. Without that forcing, `sqlite_tuned` measured
**0 KB/turn** — its pages were merely still dirty in the page cache. A too-good-to-be-true number is a
harness bug, not a result.

| layout | **REAL write/turn** | stored | vs raw |
|---|---|---|---|
| **floor** — append-only zstd, no index/engine (the yardstick) | **14 KB** | 1.98 MB | 63× |
| **duckdb_parquet** — fileless DuckDB → immutable ZSTD Parquet | **15 KB** | **1.21 MB** | **59×** |
| sqlite_tuned — WAL, synchronous=NORMAL, 16K pages, batched commit | 65 KB | 3.30 MB | 14× |
| sqlite — WAL, commit/turn, checkpoint(TRUNCATE) | 125 KB | 2.96 MB | 7× |
| **duckdb persistent `.db`** — content-addressed + `USING COMPRESSION zstd` | **5,018 KB** | 4.01 MB | **5.7× WORSE than raw** |

**DECISION: fileless (in-memory) DuckDB → immutable, hive-partitioned, ZSTD Parquet.** It writes at the
theoretical floor (15 KB vs 14 KB) AND produces the smallest store (1.21 MB — 39 % smaller than the
flat-file floor, because Parquet's column-chunk zstd + dictionary encoding beats per-section zstd).
Projected: **37 GB/day → 0.63 GB/day (59×).**

Findings, each of which would otherwise have shipped a bug:
1. **A persistent DuckDB file is the WORST option — 5 MB/turn to store a 881 KB body (5.7× worse than
   doing nothing).** Columnar OLAP: 256 KB blocks + row-group rewrite on checkpoint. Architectural, not
   tunable. The file-size proxy said 179 KB — a **28× underestimate**, because a row-group rewrite burns
   SSD writes without growing the file.
2. **`memory_limit` is NOT the mechanism** (correcting the guide's framing): it sizes the buffer pool; a
   persistent store still rewrote row groups at 5 MB/turn. The lever is the **fileless DB + `COPY … TO`
   Parquet** — parts are written once and never rewritten.
3. **The `storage_compatibility_version` trap.** Defaults to **`v0.10.2`**, which PREDATES zstd column
   compression (v1.2.0) ⇒ `USING COMPRESSION zstd` is **silently ignored** and big strings stored
   **uncompressed**; the first run produced a DB **2× LARGER than the raw JSON**. Never infer compression
   from a ratio — assert it (`pragma_storage_info`); that is what caught it.
4. **HYPOTHESIS REFUTED — DuckDB's native cross-row zstd window does NOT capture our redundancy.**
   Per-section rows without dedup (3.3×) are no better than whole-body rows (3.6×). **Content-addressed
   dedup does 100 % of the work** — Parquet has no cross-file content-addressing, so the dedup must stay
   OURS.
5. **The RAM disk is still required and is ORTHOGONAL.** No DuckDB setting can stop **Claude Code itself**
   from writing its ~881 KB raw body per request. The RAM disk targets CC's write; the Parquet loop
   targets ours. Both are needed.
6. **The raw bodies on the RAM disk ARE the write-ahead log** — never delete a body until the Parquet
   part containing it is durable. Bounds crash exposure to one flush interval at **zero SSD cost**.

**NEXT ACTION** — in order:
1. **Body store → compressed content-addressed SQLite** (per the bake-off). `blob(sha PK, n, z)` holding
   each unique section compressed once; `body` + `section(body_id, pos, path, idx, sha, n_bytes)` holding
   the ordered refs **with size + hash in clear** (so all analytics run with zero decompression).
   `INSERT OR IGNORE` ⇒ repeats write 0 bytes. Ingest each loose body, then DELETE it.
   **Retire the `.wad` archiver entirely** (it is the second-copy amplifier).
2. **Cards/offsets → SQLite rows, delta writes only.** UPSERT only the cards/offsets that actually
   CHANGED (`runLogScan` already returns just the advanced sessions). Kills the 10 MB/min of full-file
   rewrites outright. The project ALREADY has SQLite infra (`src/database/`) — reuse, do not re-invent.
3. **Raw-body capture becomes OPT-IN.** `--install-otel` must NOT default to a setting that costs the
   user ~80 GB/day of SSD writes. Gate it behind an explicit flag with the cost stated in the help text.
4. **Bound the store.** Retention/size cap on the body DB, enforced on write, not by an hourly sweep.
5. **Fix the CPU spin (TRDD-X2E6OSWK)** — SEPARATE defect, still open. See "Refuted" below.

**⚠ REFUTED — do NOT carry forward (from TRDD-X2E6OSWK).** I claimed the 4-second `tickBurn` full
rebuild was the cause of the ~100% CPU spin. **MEASURED: `buildSessionSummary()` = 289 ms** against the
real corpus (54,870 spans / 16,959 cards) — a **7.2% duty cycle**, which CANNOT explain the observed
50–78% CPU. Breakdown: summarizeSpans 263 ms · merge 3 ms · link 8.5 ms · sort 17 ms. The merge/link are
Map-based O(n), NOT the O(n²) I hypothesized. The 4 s rebuild is real waste and still worth memoizing,
but the spin has a DIFFERENT, still-unidentified cause — likely the 5 s `runLogScan` stat-ing 12,433
tailed files, and/or the 33 MB `JSON.stringify` of the card set. **Profile before fixing** (`--cpu-prof`);
do not repeat the mistake of shipping a fix for an unmeasured hypothesis.

**Open questions for the USER.**
- Reclaiming the **~22 GB** in `otel-bodies/` + `otel-bodies-archive/` needs explicit approval (RULE 0 —
  these are not regeneratable). Ingest-then-delete, or delete outright?

## Verification
- `bash scripts/safe-deploy.sh --dry-run` GREEN (baseline 1016 passing).
- New regression tests: (a) re-ingesting the same body twice writes ZERO new block bytes; (b) a card
  update writes only that card's row, not the corpus; (c) the body DB round-trips a body byte-identically.
- Live: run ≥1 h under real traffic; `iostat`/Activity-Monitor bytes-written stays in the **KB/min**
  range, not MB/min.

## Approval log
- Tier 0: in-scope bugfix on the project's own server. USER explicitly directed both the architecture
  revision ("we cannot permit that the server hangs in no circumstances… if a speed problem arises that
  cannot be optimized further, you must implement rust helpers") and the storage fix ("even 10 MB per
  minute is too much.. you have to make it write only an optimized and compressed data into sqlite db").
- Destructive-op approval for the 22 GB reclaim: PENDING USER.
