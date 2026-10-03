---
spec-id: duckplan-cutover-and-release
title: Cutover of the DuckDB-index alcore in one switch, rollback, release and retirement
status: draft
scope: project
created: 2026-10-03T19:34:47+0200
parent-trdd: 9VX3WTGU
sources: docs_dev/duckplan-decisions.md (DEC, authoritative), design/specs/duckplan/SPEC-golden-capture-and-clock.md (GC), SPEC-effects-handling.md (EH), SPEC-legacy-card-import.md (LI), SPEC-interim-stabilization.md (IS), reports/DUCKPLAN/20261003_165118+0200-concurrency-and-flaws.md (CF), docs_dev/20261003_130400+0200-card-reuse-deploy.md (DEP1), docs_dev/20261003_132115+0200-card-reuse-redeploy.md (DEP2), CLAUDE.md sections Releases, DISTRIBUTION vs DEVELOPMENT, Operations (CL)
---

# Cutover and release of the DuckDB-index alcore

Marks: VERIFIED = read or measured this session in the cited file. INFERRED = derived here, not measured. OPEN = undecided, needs the owner or a measurement before it is relied on. Citations: DEC D-xx = decision id, GC/EH/LI/IS = section or item id of the sibling spec, CF Hn = hazard, DEP1/DEP2 = the two card-reuse deploy reports, CL = repo CLAUDE.md.

Rationale in one sentence: the owner decided "cutover all at once" (DEC header), so the new engine replaces the old one in a single switch, built and proven beforehand in an isolated shadow instance, with a rehearsed rollback that needs nothing from the new engine and an automatic trigger set during the first hour.

Terms: OLD = the current alcore (cards.duckdb, snapshot+delta sidecars, in-RAM summary). NEW = the DuckDB-index alcore (`index.duckdb` + Parquet raw parts, DEC D-1, D-4, D-10). LIVE data dir = `~/.agentlens` (VERIFIED listing, section 4.1). SHADOW = an isolated NEW instance with its own data dir.

## 0. Principles (each traced to a decision)

1. One binary. The sha256 of the binary that passes the gates (section 2) is the binary that runs the shadow soak, the golden capture, the switch and the release candidate build. Any rebuild restarts the gates that depend on the binary (G3, G8, G9, G10, G11). Source: GC A10 (manifest names the build under test).
2. The index is never auto-deleted (DEC D-11, CF H1): every step below that touches `index.duckdb` moves aside, never removes, and a failed open exits naming the holder.
3. Nothing of OLD is touched by NEW (EH I94, I147; LI section 7). The cutover is reversible exactly as long as OLD's own files are byte-identical to their state at OLD's last stop (checked, section 4.3).
4. Fail fast: a gate is a command with a pass criterion; there is no "looks fine". A gate that cannot be run is a blocker, not a skip.
5. The machine stays responsive (DEC header): the shadow runs at background priority with a measured CPU budget and a governor (section 1.3).
6. Disk is the owner's to free (global rule). The disk is 96% full (VERIFIED `df`: 1.9 TB, 75 GB free at 19:34). Every phase has a free-space floor (section 1.4); below it STOP and ask.

## 1. Shadow build

### 1.1 What the shadow is

NEW started by hand (not through hook revive) with its own `DATA_DIR`, its own three ports, and `AGENTLENS_STARTED_BY=cutover-shadow` (provenance stamp, GC 1.4). It builds the full index by backfilling the real corpus while OLD keeps serving on 3000/4316/4318. It is a normal NEW instance; the only special thing is that it must not write anywhere outside its own data dir and must not bind any live port.

Layout (INFERRED names, OPEN until the storage spec fixes them): `$SHADOW=~/.agentlens-shadow` is a NEW sibling directory of the live one, created once (not a hidden dir created by tooling; the existing dot-folder rule is about new hidden folders: this is visible and named, but its location is OPEN, alternative `~/Code/AgentlensPro/reports_dev/shadow/` which is gitignored and visible, preferred if it is on the same APFS volume as `~/.agentlens`, see 1.2).

### 1.2 Source choice: read the live corpus read-only, do not clone it

Options compared:

| option | how | verdict | reason |
|---|---|---|---|
| A. APFS clone of the corpus (`cp -c -p -R`, as GC 2.1) | shadow reads a frozen copy | REJECTED for the shadow that will be switched in | file identity is `(dev, inode)` plus fingerprint (CF H6); every clone file has a new inode, so after the rename into the live data dir every live transcript would look like a rotated/new file and be re-read from 0 (duplicates or wasted backfill). Also the shadow would be as old as the clone and still need catch-up. A is the right choice for the GOLDEN instance (GC), not for the shadow. |
| B. Read live `~/.claude/projects` and live spans read-only, by their real paths | shadow `file` rows carry real `(dev, inode, path)` | CHOSEN | the index that is renamed into the live data dir already describes the live files, so the switch needs only a catch-up of the bytes appended since (section 3.5). 18.72 GB / 27.7k files read at background QoS, no extra disk for the corpus (DEC D-DAT-8). |

Requirements this puts on NEW (each is an implementation requirement for the owner of the reader/ingest spec, OPEN until confirmed in code, because `bin/alcore.rs` was not read for this spec, same caveat as GC section 9):
- R-S1 shadow mode (name INFERRED: env `AGENTLENS_SHADOW_BUILD=1`, accepted only together with an explicit `DATA_DIR` different from the default) in which the process (a) opens transcript roots and the live `spans/` directory read-only (no create, no rename, no delete there), (b) binds no OTLP listener on 4318 (a busy 4318 refuses to start by design, CL "Ports"; the shadow gets a free OTLP port nobody posts to, and ingests spans only by tailing the live span NDJSON, DEC D-6), (c) never writes hook-events, statusline, account-state, body store or config under the live data dir, (d) refuses to start if `DATA_DIR` equals the live data dir.
- R-S2 every path stored in the index that lives under the data dir (Parquet part files, temp, spill) is stored RELATIVE to the data dir, so `mv` of the index plus parts directory into another data dir keeps working. Transcript and span paths are absolute (they are outside the data dir). Test: move a small shadow data dir to a new name and open it (part of G11).
- R-S3 identity tolerates the move: `file` is keyed by `(dev, inode)`; the shadow and the live data dir are on the same volume, so `dev` is equal (check with `stat -f %d`, section 1.4).

Proof that the shadow touched nothing: before the shadow starts, record a manifest (path, size, mtime, sha256 for files under 100 MB) of every file in the live data dir and of `~/.claude/settings.json`, `~/.claude.json`, and `find ~/.claude/projects -newer` is NOT used (the transcripts legitimately grow); for transcripts the proof is `lsof`-free: the shadow is run once under `/usr/bin/fs_usage -w -f filesys <pid>` for 10 minutes in the rehearsal (G11) and the log is grepped for `write|rename|unlink|open.*O_CREAT` against paths outside `$SHADOW`: zero hits required. INFERRED: `fs_usage` needs root; if root is unavailable the fallback is read-only bind by file permissions is NOT possible on a live dir, so this check is OPEN and the weaker proof (live-dir manifest unchanged after 24 h except by OLD's own known writes) applies and is labelled as weaker.

### 1.3 Resource limits (the machine stays responsive)

| limit | value | source / status |
|---|---|---|
| process priority | start with `taskpolicy -b nice -n 19` (the exact wrapper that built 94125a8d, DEP1) so the whole process, including its fsyncs, runs at background QoS | VERIFIED command used in DEP1; consequence INFERRED: fsync at background I/O priority is slow, acceptable because the shadow has no LIVE lane to serve (CF H12 inversion does not apply to a process nobody queries during backfill) |
| thread QoS | producers (file readers, parsers) at background QoS; the single writer at normal QoS inside that background process (DEC D-7) | DEC D-7; note that under `taskpolicy -b` the writer inherits background, which is intended for the shadow |
| average CPU | target <= 0.5 core averaged over the backfill (CF H18 quotes this as the draft's target, "< 2 h" for 21 GB) | OPEN: the number is fixed by the method bench (DEC D-15); the gate is the measured figure, not the target |
| backfill duration | measured and recorded; target < 2 h from CF H18 | OPEN, a measurement |
| DuckDB `memory_limit`, `threads` | from the memory budget table of DEC D-16 (sum of all instance limits + Rust overhead + 330 MB allocator margin <= RSS cap) | OPEN until the bench fixes the numbers; enforced by NEW's startup check |
| RSS cap | `AGENTLENS_RSS_HARD_CAP_MB` set explicitly to the D-16 budget for the shadow; the metric is phys_footprint (VERIFIED, IS section 2: `rss_guard.rs:388`, checked every 5 s) | a shadow that hits its cap is a FAILED shadow run, not a reason to raise the cap blindly |
| responsiveness governor | a detached sampler every 10 s reads `sysctl -n vm.loadavg` (the 14 logical CPUs, VERIFIED `hw.ncpu`) and `memory_pressure`; if load1 > 10 for 3 consecutive samples send `SIGSTOP` to the shadow pid, `SIGCONT` when load1 < 6 for 3 samples | thresholds INFERRED (about 0.7 and 0.4 of 14); OPEN for the owner. `SIGSTOP` of a process with an open DuckDB write transaction only delays it |
| baseline probe | during the shadow run, a 60 s sampler records OLD's `/api/server-stats` latency (curl -m 5) and the load average; compare the first and the last hour of the shadow run | OLD currently exits on the RSS cap and answers for seconds (DEP2), so the probe uses only answering samples, same as DEP1 |

Do not run the shadow while another full-corpus job runs (a golden `full` capture, a cargo release build). One heavy job at a time (global rule: never two agents running heavy suites at once).

### 1.4 Preconditions and floors (STOP and ask below any floor)

1. Same volume: `stat -f %d ~/.agentlens` equals `stat -f %d $SHADOW` and equals the device of `~/.claude/projects`. Otherwise the final `mv` is a copy and the identity `dev` differs (R-S3).
2. Free space: before the shadow starts at least 40 GB free (INFERRED: index about 0.138 GB per GB raw x 18.72 GB = about 2.6 GB from DEC D-1, plus spill files 0.94 GB (D-2), plus derived tables not yet measured, plus temp spill, times 2 for the rebuild-aside copy of section 3.2); during the run, below 20 GB free (the GC 8 floor) stop the shadow and tell the owner. Do not delete anything to reclaim space (global rule).
3. OLD is up and its totals are being sampled (section 2, G3 band).
4. The binary under test is the release-profile build, signed (`codesign -s - --force`, CL), `--version` exits 64 with usage text, not 137 (VERIFIED as the check used in DEP1/DEP2).
5. All of the shadow's boot checks pass: json and parquet features present with `autoinstall_known_extensions=false; autoload_known_extensions=false` (DEC D-ENG-1) so a missing feature fails at startup, never at runtime.

### 1.5 Running and completing the backfill

1. Start: the detached launcher (`detach-run.py`, a background task killed by compaction otherwise: memory page "Detach long jobs from session lifecycle") runs `taskpolicy -b nice -n 19 <alcore> serve` with the env of 1.1 under `env -i` plus an explicit list (as GC 2.3), and records pid and start time in `$SHADOW/shadow.pid.txt`.
2. Completion = all of: `file.offset == size` for every file that is not currently growing (mtime older than 5 min), and for growing files lag under 60 s; `backfill.complete == true` in the aggregate envelope (CF H18 requires `{complete, backfill:{files_done, files_total, bytes_done}}` on every aggregate response, so the shadow can say it); `ingest_batch` stops producing BACKFILL-lane batches for 3 consecutive 60 s samples.
3. Backfill ordering caveat (CF H18): newest-mtime-first answers the 5 h / 7 d windows early but lifetime totals only at the end; no gate that compares totals may run before completion.
4. Then the shadow KEEPS RUNNING in live-tail mode (it follows new bytes of the corpus and spans) through the gates G3 to G9 and the soak G8. It is the same process the soak measures.

## 2. Gates before the switch

A gate is passed only with its evidence file under `reports/DUCKPLAN/cutover/<timestamp>-<gate>.md` (gitignored `reports/`, may hold private paths). Order: G1, G2 first (cheap, deterministic); G3 to G7 against the completed shadow; G8 runs concurrently with them; G9 to G13 last.

| id | gate | exact check | pass criterion | notes / source |
|---|---|---|---|---|
| G1 | binary identity | `shasum -a 256 bin-native/darwin-arm64/alcore`, record in `reports/DUCKPLAN/cutover/BINARY.txt` with `git rev-parse HEAD`, `cargo build --release` flags and feature list | the same hash in every later evidence file | GC A10; a hash change invalidates G3, G8 to G11 |
| G2 | static gates and tests | `pnpm run check-types`, `pnpm run lint`, `pnpm run check-mirrors`, `pnpm run check-identities`, `pnpm run check-guards`, `node scripts/check-dist-contents.js`, `node scripts/check-duckdb-only.js` (counts per EH I105), `cargo clippy -D warnings` and `cargo test --workspace` for rust-core, `pnpm run test:unit`, the golden harness tests T1 to T9 (GC section 6) | every command exit 0; the project `compile` chain (`pnpm run compile`) exit 0; no skipped gate | CL Commands; EH I104-I109; GC A11. OPEN: confirm that old modules kept until retirement do not trip clippy dead_code (they are `pub mod` of a lib crate, INFERRED, so no warning) |
| G3 | golden diff | run the GC capture of OLD (already tagged by its sha) and of NEW on the same frozen snapshot with the pinned env, then `uv run scripts/golden/compare.py <old> <new> --delta design/specs/duckplan/CONTRACT-DELTA.md` for suites `tiny` and `full`; additionally run `tiny` at the second pin NOW+6 h (GC section 8 risk table) | exit 0 on both; no `STALE` row; no unsigned row (a sub-agent cannot sign, GC 5.4); every difference is in CONTRACT-DELTA (D1 to D12, EH section 15, LI D11) | GC A3, A8, A10. The golden instance of NEW is a SEPARATE index built from the clone (GC 2.1), not the shadow: that costs a second full backfill, accepted because the clone's inodes make it useless for the switch (section 1.2). Also records the per-metric band `new/old` of the H2 totals on the snapshot: `reports_dev/golden/expected-band.json` (input to section 3.7 trigger T4) |
| G4 | independent line census | script `scripts/cutover/census.py` (INFERRED name, new): for every file row in the index, count `\n` bytes in the file with a streaming byte counter that never reads offsets from the index to decide what to count (`tr -cd '\n' < file \| wc -c` is the reference implementation to cross-check the script on 20 sampled files); compare to `count(raw_line WHERE file_id=f)`. For files whose mtime is under 5 min old, count only bytes up to the index's committed offset and assert separately, from the file bytes, that the byte at `offset-1` is `\n`. Also sum over all files | equal per file and in total (the 6.29M lines of DEC D-DAT-8 plus growth); any inequality lists the file | CF H29: the old plan's census was computed from offsets and agreed with the wrong state after a CLEAR; this one counts bytes. OPEN: whether blank lines are stored as rows (then the census counts `\n` and the rows must include them; settle in the ingest spec); trailing partial line (no final `\n`) is not a row until completed |
| G5 | legacy import counts | LI section 5 table, run on the frozen copy, bit-exact integers: 5,742 orphans, by kind 11 / 5,231 / 459 / 41, token buckets, bytes 10,943,984, `survivors + imported + explained D3/D4 = 40,979`; node-test minus path-test orphan sets fully explained; the cross-check of `cards.duckdb` card keys minus NDJSON keys reported and empty or reviewed | all rows equal; any non-empty unexplained set blocks | LI sections 1.2, 5; the final run happens again at the switch against the final freeze (section 3.4) |
| G6 | ingest_error | `SELECT kind, count(*) FROM ingest_error GROUP BY 1` through the NEW read API (or `alcore index-verify`, below) | empty, or every row explained in the evidence file (a poison line fixture class) and the owner has seen the list | CF H7, H29 (poison-line fixture). OPEN: table name `ingest_error` is the task brief's, schema spec owns it |
| G7 | invariants | new read-only subcommand `alcore index-verify --data-dir <dir>` (name OPEN) run against the shadow stopped copy (an APFS clone `cp -c` of `$SHADOW` after a `CHECKPOINT`, never against the live-running file: DuckDB holds an exclusive lock, CF H14) | exit 0. Required invariants (INFERRED from the decisions, canonical list is the schema spec's; this spec only requires that they run and fail loudly): `api_call.message_id` unique (DEC D-4); `sum(node_rollup) == sum(api_call)` per node for the numeric fields; every non-legacy node has raw_line rows; every `file.offset <= size` and its `offset-1` byte is `\n` (G4); no `file` row with rows but offset 0; Parquet parts referenced by the index exist and their row counts match; every ART index is at or under its budget (DEC D-ENG-2: a test per index); `ingest_batch` ids strictly increasing and no `clear` row without an epoch bump (CF H17); `legacy_card` count equals the import run record | the 12 failpoint and kill -9 tests named in CF H29 / "Concrete changes" item 12 are part of G2 (cargo test), not of this gate |
| G8 | memory soak | the shadow runs 24 h in live-tail mode under replayed load: (a) the live corpus growth (0.3 to 0.7 GB/day, peak 1.5, DEC D-DAT-8) is itself the ingest load; (b) a replay loop issues the `R` group of `scripts/golden/requests.json` (GC 3.4) at 1 request per second round-robin, two SSE connections held open (GC 3.7), one heavy aggregate (Q10 `groupBy:"all"`, Q38) every 5 minutes, one `/api/cards/page` cursor walk to the end every 10 minutes; (c) a burst: at hour 12 a synthetic 1 GB transcript slice is appended to a copy under a watched dummy root is NOT possible read-only, so the burst uses the shadow's own backfill: restart the shadow once at hour 12 (kill -TERM, restart) and verify WAL replay (DEC D-ENG-7: about 2.5 s and 1 GB RSS per GB of WAL) stays under the cap | phys_footprint sampled every 10 s (same metric as the cap) stays under the D-16 cap minus 10% for the whole 24 h; the least-squares slope of the hourly maxima over hours 4 to 24 is below 5 MB per hour (OPEN number, INFERRED: a leak shows as a monotone slope); zero `RSS HARD CAP` lines; zero panics; no `memory pressure stage` line above 1 (IS section 5 uses the ladder lines as signal); index file growth within 20% of the projection (0.138 GB per GB raw ingested) | DEC D-9, D-16; IS section 5 sampler shape (one TSV row per 60 s: time, pid, etime, footprint, HTTP code and time of one read route, index bytes, wal bytes, pressure lines). The 24 h shadow soak is NOT the 14 day post-switch soak of section 5 |
| G9 | screenshots | `src/test/browser/dashboardSmoke.test.ts` (EH I62, it must have grown to the paged endpoints) against the golden-corpus instance of BOTH builds (GC A9), then one headless screenshot per dashboard tab (the 15 views V0 to V14 of GC 3.6, plus the sidebar) in light and dark for OLD and for NEW, written to `reports/screenshots/duckplan/<old\|new>/<tab>-<light\|dark>.png` | both builds pass the smoke test with zero console errors; the owner reviews the 2 x 2 x tabs sheet; each visible difference maps to a CONTRACT-DELTA row (paged lists D6) or is a defect | CL "Testing" rule in `~/.claude/rules/testing.md` (screenshots in both themes; headless; close every page in `finally`) |
| G10 | npm tarball | `pnpm run package` then `npm pack --dry-run --json` and `node scripts/check-dist-contents.js` (the ACTUAL file list, CL); `node scripts/verify-bin-native.js`; assert 16 bin-native files (4 platforms x 4 binaries) executable `-rwxr-xr-x` inside the packed `.tgz` (CL "two traps"); measure `gzip -9` and unpacked size of `alcore` per platform and compare with the doctrine numbers (alcore 52.6 to 17.0 MB, ~121.5 MB downloaded / ~384 MB unpacked per install) | no src/, rust-core/, maps, build inputs in the tarball; 16 executables; sizes recorded and CL numbers updated in the same PR if they moved (EH I05, I71); the three DuckDB feature groups (`json`, `parquet`, vtab/vscalar for Rust SQL functions, DEC D-ENG-1, D-ENG-11) present: shown by the startup feature check on the darwin-arm64 binary AND by the CI matrix running the same startup check on each platform runner | OPEN: whether `publish.yml` `build-binaries` runs a `--selftest` per platform today (not read here); if not, add one: otherwise the three non-local platforms ship unverified features. Only darwin-arm64 is testable locally |
| G11 | full dress rehearsal | on a scratch copy of the live data dir (`cp -c -p -R ~/.agentlens $SCRATCH/data`, clone cost near zero, VERIFIED technique GC 2.1; scratch ports and its own HOME for hook files; reading the same corpus read-only), execute sections 3 and 4 end to end exactly as scripted: old stop, freeze, rename-in, new start, the 60 min watch with an injected failure for each rollback trigger T1 to T6 (kill -STOP for T1, `kill -SEGV` for T2, a poison line for T3, a skewed ratio for T4, a low cap for T5), automatic rollback, and OLD's restart; plus a synthetic writer appending 10 lines per second to a fixture transcript across the whole stop to start gap | every injected trigger rolls back automatically within its window; after rollback OLD answers, its sidecars' sha256 equal the pre-rehearsal manifest (section 4.3); after a switch WITHOUT rollback the census (G4) is equal and the synthetic lines are all present once | the rehearsal is the "tested rollback" of the brief; record elapsed time of each step (budget: stop-to-answering gap under 3 minutes, rollback-to-answering under 5 minutes plus OLD's own slow start, DEP1: median 2:23 and a 664 MB restore burst) |
| G12 | first-boot upgrade path (other users) | take a copy of the live data dir WITHOUT `index.duckdb` and run NEW on it as a stranger would: expect (1) automatic frozen copy of the four sidecars into `<dataDir>/legacy-source/<utc-stamp>/` with a sha256 manifest and mode 0444 BEFORE the index is first opened (LI 7), (2) the server answers while backfilling with aggregates carrying `complete:false` (CF H18, EH I98: `GET /` must answer while the index builds so the Docker healthcheck passes), (3) after catch-up `legacy-import` runs once and the LI section 5 counts hold | all three observed; setup/status report the leftover old files and never remove them (EH I95) | this is the cutover for every other machine; the owner machine's path (section 3) is the same code with the index pre-built |
| G13 | release subset of the EHT cards terminal | section 6.1 | every card in the release subset in a terminal column with its proof recorded | EH header: the parent cannot reach `complete` until all EHT are terminal; the retirement subset (6.2) is allowed to follow the release |
| G14 | owner sign-off | the owner (the human, never an agent) signs every CONTRACT-DELTA row, and approves in writing the go for the switch window | signatures present; the approval text quoted in the cutover TRDD | GC 5.4 rule 5; global rule: outward-facing/irreversible acts need the user |

Any gate failing after a code fix restarts G1 and everything that depends on the binary hash.

## 3. The switch (OLD to NEW, live data dir)

Preconditions: G1 to G14 green; shadow still running and caught up (lag under 60 s); the owner has chosen a window; at most the interactive Claude sessions run (about 36 hold stale envs, IS section 2: any can revive the server). The switch is scripted (`scripts/cutover/switch.sh`, tracked, run detached, logging every command with a timestamp to `reports/DUCKPLAN/cutover/<timestamp>-switch.log`; INFERRED location, OPEN) so that human timing is not in the gap. Every command below is run with absolute paths. `D=~/.agentlens`, `B=~/Code/AgentlensPro`, `BIN=$B/bin-native/darwin-arm64/alcore`, `NEWBIN` = the gated binary, `PRE=$B/builds_dev/pre-cutover-<sha>`.

### 3.1 Capture OLD's state and the rollback artifacts (OLD still running)

1. `ps -eo pid,ppid,etime,command > $PRE/ps-snapshot.txt` (snapshot-then-search rule).
2. Save the rollback artifacts into `builds_dev/` (never deleted, RULE 0 notes): `cp -p $BIN $PRE/alcore` and `cmp $BIN $PRE/alcore`; `codesign -dv $PRE/alcore` shows the ad-hoc signature (the saved copy must run: `$PRE/alcore --version` exit 64, not 137); copy the shipped JS and media bundles `$B/standalone/*.js`, `$B/media/*.js`, `$B/media/*.css` to `$PRE/bundles/`; `git rev-parse HEAD` and the tag `pre-duckindex` (annotated tag on the commit OLD was built from) in `$PRE/README.txt`. The previous OLD builds already in `builds_dev/` (`alcore-pre-94125a8d`, `alcore-0a9efdf7`, `alcore-oct1-rollback`, VERIFIED listing) stay as further fallbacks.
3. Which `agentlenspro` is on PATH: `readlink -f $(command -v agentlenspro)` and `ls -ld` it (CL: an npm-installed copy would not receive `node esbuild.js`). Record it. The new bundle is built BEFORE the window (it is part of G2), staged in the repo, not yet "restarted into".
4. Totals of OLD for the drift check (section 3.7, T4): `curl -m 10 http://127.0.0.1:3000/api/summary > $PRE/old-summary.json`; compute `sessions.length` and the sums of `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreateTokens` (the fields DEP1 used; `/api/summary` carries no cost field, VERIFIED DEP1). If OLD does not answer within 10 s (it often does not, DEP2), record "no old totals" and T4 uses only its monotone branch.
5. Manifest of the OLD-only files (section 4.2): `shasum -a 256` for `cards.duckdb`, `cards.duckdb.wal`, `log-sessions.{snapshot,delta}.ndjson`, `log-offsets.{snapshot,delta}.ndjson`, `log-delta-version.json`, plus size and mtime, into `$PRE/old-only.sha256`. They are still being written by OLD, so this is the PRE-STOP manifest; the authoritative one is taken after the stop (3.3).

### 3.2 Stop the shadow cleanly (the index becomes a closed file)

1. Confirm lag: the shadow's `/api/debug/log-scan-stats` (or its aggregate envelope) shows no BACKFILL work and every active file lag under 60 s.
2. `kill -TERM <shadow pid>` and wait. NEW's shutdown order is `CHECKPOINT`, drop every connection and the database instance, THEN `pid_lock::release` (CF H1, H30, DEC D-11), with a deadline: if `CHECKPOINT` does not finish in the stop deadline the WAL is left for replay (CF H30), and then the file is NOT considered clean for the rename: wait for a second, longer manual attempt (`alcore index-verify --checkpoint`, OPEN) rather than moving a file with a large WAL.
3. Verify the stop: `ps` snapshot has no shadow pid; `$SHADOW/index.duckdb.wal` is absent or empty; the pid lock file is gone. Take `shasum -a 256` of `$SHADOW/index.duckdb` and of each Parquet part into `$PRE/shadow-index.sha256`.
4. `alcore index-verify --data-dir $SHADOW` (G7 again, now on the final file) and the census (G4) on the final offsets. Both must pass or the switch aborts here with OLD still serving and nothing changed: abort cost is zero.

OPEN: stopping the shadow before the old server is stopped lengthens the window in which new bytes are not in the index (they are caught up at 3.6). Alternative: stop OLD first, then the shadow (shorter catch-up, longer OLD outage). Chosen order is shadow first: OLD keeps serving until the last moment; the extra catch-up is bounded by the bytes appended during 3.2 (INFERRED: seconds to minutes of transcript growth, measured in G11).

### 3.3 Stop OLD without letting hooks resurrect it

1. `agentlenspro server stop --stay-down` (arms the `NO_REVIVE` brake, VERIFIED to exist: `src/cli/serverControl.ts:251`, `:865`, flags at `:990`). Without it a hook in one of the ~36 sessions revives OLD mid-swap (IS section 2: revive reads the hook process env and starts the server).
2. Wait until the pid in `$D/server.pid` is gone; confirm with the ps snapshot (no `alcore` process on the data dir). OLD's own stop flushes cards (`flush_with_deadline`, CF H30).
3. The AUTHORITATIVE old-only manifest, taken now that nothing writes them: `shasum -a 256` of the 7 files of 3.1.5 into `$PRE/old-only.after-stop.sha256`. `chmod a-w` on those 7 files (and the `.tmp` directory is left as is). From here a NEW write to any of them fails loudly with EACCES instead of silently corrupting the rollback (fail fast); rollback restores `u+w` (4.4 R5). INFERRED: NEW has no code path that opens them for writing (LI 7 requires that it must not); the chmod makes that a runtime guarantee, not a belief.

### 3.4 Freeze the legacy source and import orphans (index still offline)

1. `mkdir -p $D/legacy-source/<utc-stamp>`; `cp -c -p` the four NDJSON files (`log-sessions.{snapshot,delta}.ndjson`, `log-offsets.{snapshot,delta}.ndjson`) and `log-delta-version.json` into it; `shasum -a 256` manifest; `chmod 0444` files and `chmod 0555` the directory (LI 7: copy, never move, the old binary still has to be able to start).
2. Move the shadow index in (section 3.5), then run the one-shot `alcore legacy-import --source $D/legacy-source/<utc-stamp>` (name INFERRED in LI 3) with the index unlocked and no server running. It is idempotent: a card already imported by an earlier shadow-time run is skipped (`skipped_existing`), only new keys are added (LI 3).
3. Re-run G5's count check (LI 5) on the result.

### 3.5 Move the shadow index into the live data dir (rename, not copy)

1. Preconditions re-checked: `stat -f %d` equal (1.4.1); `$D/index.duckdb` and the parts directory do NOT exist (if they do: STOP; an earlier attempt left them; move them to `index.duckdb.pre-switch-<utc-stamp>` and tell the owner; never overwrite).
2. `mv $SHADOW/index.duckdb $D/index.duckdb` and `mv $SHADOW/<parts dir> $D/<parts dir>` (names OPEN, 1.1). Both are atomic renames on one APFS volume; no data is copied (the whole point of building the index in place on the same volume). Any other NEW-owned table file (spill, meta) moves with them.
3. `shasum -a 256` of the moved index equals the value from 3.2.3.
4. Open-ability check without a server: `alcore index-verify --data-dir $D` (read-only mode that does not take the data-dir pid lock beyond its own run).

### 3.6 Install the NEW binary and start it

1. `cp $NEWBIN $BIN`; `codesign -s - --force $BIN` (CL: without it exit 137 before `main`, empty `server.log`, looks like a startup crash); `$BIN --version` must exit 64 (usage text), never 137; `shasum -a 256 $BIN` equals G1. (DEP1/DEP2 used exactly this check.)
2. The new JS and media bundles are already in the repo build (G2). Verify with a grep of a new symbol in `standalone/cli.js` (CL: a failed esbuild leaves the stale bundle in place); `agentlenspro --version` shows the new version.
3. `agentlenspro server start` (it resets `consecutiveQuickDeaths` and the revive brake, IS section 3 "Backoff state"). This is the start of the measured watch: T0 = the instant `server start` is issued.
4. The watcher (3.7) is already running detached since 3.1 and switches to its post-start mode on seeing the new pid.

### 3.7 Measured watch with automatic rollback

Shape borrowed from DEP1/DEP2 (sampler every 60 s, one TSV row each: time, pid, etime, footprint, HTTP code and latency of `GET /api/cards/page?limit=1` (the paged route that replaces `/api/summary`) and of `/api/server-stats`, index bytes, wal bytes, `ingest_error` row count, rss-hard-cap.log line count, server.log panic count) and from IS section 5 criteria (same pid, no cap exit, HTTP 200 on every sample after t+90 s). The watcher runs detached (`detach-run.py`) and on any trigger executes the rollback script itself, no human in the loop; it also pages the owner by writing to a visible file.

| trigger | condition | window | source |
|---|---|---|---|
| T1 no answer | UI port not listening or `/api/server-stats` not 200 within 5 minutes of T0; also 3 consecutive non-200 samples after t+90 s | continuous from T0 | the 5-minute criterion of DEP1 ("no answer within 5 min of a start"), (c) of IS section 1 |
| T2 crash or panic | the pid changes without an operator action, or any `panicked` line in `server.log` after T0, or any new line in `rss-hard-cap.log`; a second exit within 30 min is final | first 60 min automatic, afterwards alert only | DEP1 criterion "panic/crash-loop", IS criteria (a)(b) |
| T3 ingest_error growth | `ingest_error` row count above its value at T0 by any row whose class is not in the explained list recorded at G6; a growth of more than 10 rows of any class | first 60 min | task brief; OPEN: the 10 threshold |
| T4 totals drift | (a) monotone branch: sessions, input, output, cacheRead and cacheCreate totals (read from the NEW aggregate route, same five figures as DEP1) must never decrease between samples (no `clear` was issued; a decrease means rows were lost); (b) ratio branch, only if old totals exist (3.1.4): after catch-up (the first sample with lag under 60 s), the ratio `new/old` of each of the five figures must stay within 1% of the band recorded in `expected-band.json` of G3 (OLD and NEW totals differ BY DESIGN by D1/D2/D3/D4, so the comparison is against the golden-measured ratio, not against 1.0); sessions count not more than 2% below the old count (the DEP1 rule) | first 60 min | DEP1 "Totals check" and criterion "session count after reuse >2% below before" (2% precedent VERIFIED); 1% on token ratios INFERRED, OPEN for the owner |
| T5 RSS | `phys_footprint` above 90% of the D-16 cap for 10 minutes, or any cap exit | first 60 min automatic, 24 h alert | DEC D-16; IS escalation rule uses 88% as a precedent |
| T6 data directory guard | any change in the old-only manifest of 3.3.3 (sha256 or mtime of the 7 files) | continuous | section 4.2: proves OLD stays restorable |
| T7 index growth | index plus parts bytes grow more than 25% over the projection from bytes ingested (0.138 GB per GB) in the first hour | first 60 min | DEP1 criterion 4 (cards.duckdb +25%) fired falsely on a high-water mark: for the index the watcher compares against a PROJECTION, not against the first sample, to avoid that false positive |

After the first hour the watcher stays on for 24 h in alert-only mode (T1, T2, T5, T6 raise a flag; rollback is then the owner's decision, section 4.5). The 60 min figure and the 5 min figure follow the DEP1/DEP2 and IS procedures (65 min watch). OPEN: whether to keep T3 and T4 automatic beyond the first hour.

### 3.8 Catch-up of data that arrived during the switch (offsets make it automatic: the proof)

What arrives between the shadow stop (3.2) and NEW's first scan (3.6): (a) transcript lines appended by Claude Code sessions (about 36 live sessions), (b) OTLP spans POSTed to 4318 (OLD is down, so the POST fails), (c) hook events and statusline samples.

(a) Transcripts. Argument, each premise from the decisions: transcripts are append-only in practice (DEC D-DAT-1: 27,763 offsets <= size over 27 min); every batch commit writes the rows AND the new per-file `offset` in ONE transaction guarded by compare-and-set (`UPDATE file SET offset=:new WHERE file_id AND offset=:expected AND gen`, row count 1, DEC D-ENG-5, D-8, CF H3), so on disk the pair (rows, offset) is never torn; on start the scheduler lists files and reads `[offset, size)` of each file, identity checked by `(dev, inode)` plus head fingerprint plus newline-at-offset (DEC D-DAT-1, CF H6); a file whose identity changed is a rotation and re-reads with natural-key idempotence (`ON CONFLICT DO NOTHING` via the staging table, DEC D-ENG-3, D-4) so a rotation adds only unseen lines and never duplicates. Therefore the bytes appended during the gap are read exactly once after the start, and the bytes before the gap are not re-read. The index file written by the shadow and the live files share `(dev, inode)` because the shadow read the live paths (section 1.2): this is the reason the shadow does not read a clone.

Proof obligations (each is a test, run before the switch, none is a belief): P1 the kill -9 x50 test of CF H29 on a corpus slice shows rows and offsets agree after every crash point; P2 in the rehearsal (G11) a writer appends 10 lines per second to a fixture transcript through stop, rename-in and start, and the final census equals the number of lines the writer produced exactly once; P3 a rotation fixture (prune-by-rename, CF H6) and a same-stem two-file fixture re-read to the same count; P4 on the real switch the G4 census is re-run per file 10 minutes after T0 with the same independent byte counter, and a per-file table (rows, newline bytes) is attached to the evidence; any mismatch triggers T4 (manual escalation to rollback) because it means a file was skipped or double-read.

(b) OTLP spans. The existing span NDJSON is the write-ahead log and NEW tails it with its own offset (DEC D-6), so spans written by OLD before its stop are caught up like transcripts. Spans POSTed to 4318 while NO server listens are lost unless the exporter retries: this is the same loss every OLD restart causes today (OLD was down about 13 of 16 minutes, DEP2) and is not made worse; the scripted window keeps the gap under the 3-minute budget. OPEN: whether Claude Code's OTLP exporter retries a refused connection (not measured here); measure the gap loss once in G11 by posting fixture spans through the gap.
(c) Hook events and statusline samples: `hook-spool/` exists in the data dir (VERIFIED listing) and the hook stores are dual-written/shared files kept in their current format (EH I96, section 4.2), so what OLD or the hooks wrote is visible to NEW unchanged. OPEN: whether `hook-spool` spools while the server is down (its name suggests it; code not read here).

## 4. Rollback

### 4.1 What is kept until the soak passes

| item | where | kept because |
|---|---|---|
| OLD binary, signed, hash-pinned | `builds_dev/pre-cutover-<sha>/alcore` (and the earlier `alcore-pre-94125a8d`, `alcore-0a9efdf7`, `alcore-oct1-rollback`) | rollback target; `builds_dev/` contents are never deleted (global rule) |
| OLD JS and media bundles | `builds_dev/pre-cutover-<sha>/bundles/` | the new CLI re-points `/api/server-stats` keys (EH I30-I34) and is not guaranteed compatible with OLD's responses; rollback restores both halves |
| `git` tag `pre-duckindex` | the commit OLD was built from | rebuild possibility; EH I151 |
| `cards.duckdb`, `cards.duckdb.wal`, `cards.duckdb.tmp` | `~/.agentlens` | OLD restores from them (DEP1: reuse path) |
| `log-sessions.{snapshot,delta}.ndjson`, `log-offsets.{snapshot,delta}.ndjson`, `log-delta-version.json` | `~/.agentlens` and the 0444 copy under `legacy-source/<stamp>/` | OLD replays them; the copy is the frozen input of the orphan import (LI 7) |
| `forensics.db` | none present at spec time (EH section 9, I97) | n/a; if one exists it is kept |
| OLD-era files used by both engines | `spans/`, `account-state.ndjson`, `hook-events/`, `collector-lifecycle.json`, `statusline/`, `otel-bodies/`, `store/` | shared by design (4.2) |
| the transcripts and spans | `~/.claude/projects`, `~/.agentlens/spans` | source of truth, not touched by either engine except OLD/NEW appending spans |
| the NEW index after a rollback | renamed to `index.duckdb.rolledback-<utc-stamp>` plus parts | forensic comparison; holds raw lines of transcripts that Claude Code may have deleted since (CF H1 rationale): it is the only copy of those lines, so it is moved aside and never deleted |
| golden captures, harness, oracles | `reports_dev/golden/`, `scripts/golden/`, TS oracles (EH I112-I115, I150) | evidence; deleted last |

### 4.2 No shared file is written by both engines (verified, not assumed)

Classification of the live data dir (VERIFIED listing `ls -la ~/.agentlens`, 19:32). OLD-only: `cards.duckdb`, `.wal`, `.tmp`, `log-sessions.*`, `log-offsets.*`, `log-delta-version.json`. NEW-only (new files, OLD never opens them): `index.duckdb`, `index.duckdb.wal`, the Parquet parts directory, `legacy-source/`, `index.duckdb.corrupt-*`, `index.duckdb.pre-*`, `index.duckdb.rolledback-*` (names OPEN). Shared and written by both, formats UNCHANGED by decision (EH I96 dual-write; DEC D-6 spans WAL): `spans/` (OTLP write-ahead log), `account-state.ndjson`, `hook-events/`, `hook-spool/`, `collector-lifecycle.json`, `statusline/`, `otel-bodies/`, `store/` (alstore, untouched, EH I16), `server.log`, `requests.log`, `rss-hard-cap.log`, `server.pid`, `config.json`, `.revive-backoff.json`, `.chores.lock`, `.daemon-revive.lock`, `embed-key`, `telemetry-managed.json`, `subscription-usage*`, `countcache/`, `log-events/`. For every shared file the requirement on NEW is "append or rewrite in the same format OLD wrote"; OLD resuming after a rollback must parse what NEW wrote. Evidence required (G11 and then the soak): the old-only manifest never changes while NEW runs (T6, enforced by `chmod a-w`, 3.3.3); and the format-compatibility test: after the rehearsal's NEW run, OLD starts on the same data dir and reads `spans/`, `account-state.ndjson`, `collector-lifecycle.json` without error (part of the G11 rollback step). OPEN, needs the code: whether `collector-lifecycle.json` and `.revive-backoff.json` have a version field the new binary bumps, and whether `config.json` gains keys that OLD would reject (`assertKnownFlags`-style strictness, not read).

### 4.3 What OLD needs to resume

OLD's sidecars are stale by the soak duration (NEW never wrote them, 4.2). OLD reads its offsets and cards, then catches up from the transcripts, lossless because transcripts are append-only (EH section 17 recipe, INFERRED, proven by the G11 drill). Expected cost: a slow start (median 2:23 before card reuse, a 664 MB restore burst, DEP1/IS section 7) and then the RSS-cap loop of OLD returns if the interim cap raise (IS D-13, `AGENTLENS_RSS_HARD_CAP_MB` default 4096 in `alcoreSpawnEnv`) is not part of the restored bundle: the saved `bundles/` must contain it (check in 3.1.2: `grep AGENTLENS_RSS_HARD_CAP_MB $PRE/bundles/cli.js`; OPEN, depends on whether IS D-13 landed before the switch). Data that exists only in the NEW index (raw lines of transcripts deleted during the soak, nodes whose transcripts are gone) is not visible to OLD; it stays in the kept index (4.1).

### 4.4 Exact rollback commands (`scripts/cutover/rollback.sh`, called by the watcher and by hand; absolute paths)

R0. Mark the time; `ps -eo pid,ppid,etime,command > $PRE/ps-at-rollback.txt`.
R1. `agentlenspro server stop --stay-down` (NEW stops with `CHECKPOINT` then releases the lock). If it does not exit within 60 s: `kill -TERM <pid>`, then wait 60 s more; DuckDB replays the WAL next time, so this is safe; a `kill -9` is a last resort and is recorded.
R2. `mv $D/index.duckdb $D/index.duckdb.rolledback-<utc-stamp>`; same for `index.duckdb.wal` and the parts directory (moves, never deletes; skip any that do not exist).
R3. `cp $PRE/alcore $BIN`; `codesign -s - --force $BIN`; `cmp $BIN $PRE/alcore`; `$BIN --version` exit 64 (not 137).
R4. Restore the bundles: `cp $PRE/bundles/<each> $B/standalone/` and `$B/media/`; grep the OLD symbol; `agentlenspro --version` shows the old version.
R5. `chmod u+w` the 7 OLD-only files; `shasum -a 256 -c $PRE/old-only.after-stop.sha256` must pass (this is the proof that no shared write happened; a mismatch is recorded as a defect of the "no shared writes" claim and does NOT stop the rollback, OLD may still recover from them since it rebuilds from the transcripts).
R6. Leave the legacy-source copy in place (harmless).
R7. `agentlenspro server start` (resets the backoff). Optionally with `AGENTLENS_RSS_HARD_CAP_MB=4096` exported if the restored bundle lacks the default (4.3).
R8. Verify (detached sampler, 30 min, same row format as 3.7): listening within 5 minutes, `/api/summary` 200, sessions count at least 98% of the count at 3.1.4, no new cap exit for 30 min. Record elapsed time of R1 to R8 in the rollback log.

Automatic form: the watcher of 3.7 runs R0 to R7 itself on T1, T2, T3, T4, T5 (first hour) and T6; it never restarts NEW after a rollback (a second attempt is a new, owner-approved switch, with the rolled-back index as input: it may become the next shadow after review).

### 4.5 After the first hour (manual rollback window)

The rollback script stays valid for the whole soak (section 5). The only thing that changes with time is the loss in step 4.3: the longer NEW runs, the more rows exist only in the index. That is not data loss (the index is kept) but OLD will not show it. There is no point of no return before retirement (section 7).

## 5. Soak after the switch

Criteria = the union of IS section 1 (same pid, no cap exit, HTTP 200 on every 60 s sample) and LI section 7: for N days (LI proposes 14, INFERRED; OPEN, the owner decides, a minimum of 7 is suggested): the same NEW pid except for operator restarts; no cap exit; no panic; `ingest_error` unchanged beyond the explained list; the G4 census re-run daily on a sample of 200 files plus all files touched that day; the LI section 5 counts re-checked at every boot (they are boot assertions in LI 7); a rolling golden-parity sample (LI 5 fixed sample of 61 sessions) green; memory slope below the G8 slope; at least one clean and one forced restart (kill -TERM, kill -9) with WAL replay inside the cap (DEC D-ENG-7). The owner marks the end in the cutover TRDD in writing.

## 6. Release (only after the soak passes)

Publishing is irreversible in practice (an npm version cannot be unpublished and re-used), so release follows the owner-machine soak, not the other way round. Source of the rules: CL "Releases" and "Contribution conventions".

### 6.1 EHT cards that must be terminal BEFORE the release tag (G13)

Split by what ships: EHT-01 doctrine and docs (CLAUDE.md I01-I07, ARCHITECTURE I09-I12, README I14-I17, CHANGELOG I18, plus the delta-propagation items I141-I145 so no document quotes the old behaviour); EHT-02 skills and agents (then `agentlenspro --install-skill`); EHT-03 `server status` and `setup` self-checks (I30-I41); EHT-04 CLI verbs, including the new `agentlenspro sessions` verb (I45); EHT-05 dashboard client plumbing (I52-I63); EHT-11 first-boot migration behaviour (I93-I95, I98) and EHT-12 config knobs (I90-I92); the SHIPPING half of EHT-09 (I107 binary count 16, I108 `files` allowlist, I109 CI, I110 bench re-point); and the CHANGELOG/version items. Not required before the tag (they are retirement, section 7.1): EHT-06 module deletion, EHT-07 test deletion, EHT-08 TS oracles, EHT-10 `forensics.db` retirement, the guard-number lowering (I104, I105), EHT-13 memory pages, EHT-14 TRDD board, and EHT-15 itself which this spec closes. OPEN: whether keeping the dead modules compiled through the release is acceptable (INFERRED yes, `pub mod` of a lib crate; verify with `cargo clippy -D warnings`, G2).

### 6.2 Version and changelog

Current `package.json` version 2.34.0 (VERIFIED). The change breaks response contracts (D1 to D12: usage by LAST row, global dedupe, workflow files get parents, `journal.jsonl` and `*.orphaned-*.jsonl` skipped, uncapped timelines, paged summary, no write-on-read, no scan budgets, `clear` keeps legacy cards, and the fixed quirks of DEC D-12). Under Conventional Commits that is `feat!`. The repo already shipped `feat!` (567fc5c2) inside 2.x, so its practice is unclear: OPEN owner decision, 3.0.0 (recommended: consumers of `/api/summary` break) versus 2.35.0. The bump and the CHANGELOG entry go in the same PR (CL). The CHANGELOG `[Unreleased]` section gets: a summary table of CONTRACT-DELTA (one row per D-id, one line each, linking to the file), retired files and data files (cards.duckdb, snapshot/delta sidecars, forensics.db), the new `sessions` verb, the `index.duckdb` data layout and the first-boot legacy freeze, and the upgrade note: "first start builds the index from your transcripts; answers carry `complete:false` until done".

### 6.3 Steps (tokenless, CI-only)

1. Branch `feat/duckdb-index-cutover` (or the owner's name), Conventional Commits, `TRDD-9VX3WTGU` in subjects, merges `--no-ff`, never squash (CL).
2. PR checks: G2 chain on CI (`ci.yml`), `check-dist-contents`, `check-duckdb-only`.
3. After merge: tag `vX.Y.Z` on main; the tag triggers `.github/workflows/publish.yml`: `build-binaries` matrix builds the four platforms (never publishes), `package` downloads the four, flattens into `bin-native/`, re-`chmod +x`, runs `scripts/verify-bin-native.js`, asserts `-rwxr-xr-x` on all 16 entries inside the `.tgz`, then publishes by OIDC with provenance. NEVER publish locally, NEVER add a token or `registry-url:` (CL). The workflow filename stays `publish.yml` (npm trusts the filename).
4. A failed publish is re-run with `gh workflow run publish.yml` (no re-tag).

### 6.4 Post-publish checks

(1) `npm view agentlenspro version dist.attestations` and the `_npmUser` carries `trustedPublisher`, attestations exist (a human `_npmUser` with no attestations = token fallback: investigate, CL); fresh 404s in the first minutes are CDN propagation, not failure. (2) Install from the registry into a scratch prefix (not over the dev link): `npm install --prefix $SCRATCH agentlenspro@X.Y.Z`; `agentlenspro --version`; `agentlenspro setup --dry-run`; start on an empty `DATA_DIR` with its own ports (CL "EXACTLY ONE server may own a data directory"): server answers, OTLP fixture POST visible, `GET /` serves the shell. (3) The upgrade rehearsal of G12 again with the INSTALLED binary on a copy of an old data dir. (4) The packed binaries' sizes match G10. (5) CLAUDE.md numbers (binary sizes, per-install download) updated if they moved (EH I05). (6) The GitHub Release exists (created by the workflow, tag-guarded).

## 7. Retirement after the soak

All steps need the soak (section 5) to be marked passed in writing by the owner. Order: commit first, then move or delete (RULE 0).

### 7.1 Code, tests, guards (inside git: restorable by `git revert`; tag `pre-duckindex` marks the last OLD tree)

Per EH section 17 and sections 6, 7, 10, 11, 12: delete the old Rust modules I64 to I70 (`summary_engine`, `feed_merge` after FND-06 matches `feed-merge-expected.json`, `card_store`, `span_window`, `derived_cache`, `delta_log`, `session_summary_sql`) and their tests I79 to I83, TS twins I112 to I115 only where `tldr references` and the `gen-*.mjs` generators show nothing still requires `out/test/<module>.js` (memory page ts-dead-code-vs-rust-parity-oracles), the forensics modules and tests (EH I99 to I102, the `rusqlite` check `cargo tree -i rusqlite`), the three forensics scripts (I101), the retired config knobs (I91), `git rm` in per-card commits (sweep each category separately: direct calls, type references, string literals, re-exports, tests, docs: global rule), then lower `check-duckdb-only.js` `MAX_EXEMPTIONS`, `MAX_NON_TEST_OPENERS`, `MAX_TEST_OPENERS` to the measured counts and delete stale `ALLOW` entries (I104, I105), then `pnpm run compile` and `cargo test --workspace`. Delete dead code in its own commit before any structural refactor of a file over 300 lines (global rule).

### 7.2 Data files outside git: moved, never `rm`; owner approval required

The files in `~/.agentlens` are user data outside the project tree: `safe-delete` refuses them (use-safe-delete rule) and RULE 0 says outside the project requires stopping and asking. Procedure: list the files and their sizes (`cards.duckdb` 575 MB, `.wal` 1 MB, `.tmp`, `log-sessions.snapshot` 72 MB, `.delta` 1.4 MB, `log-offsets.snapshot` 7 MB, `.delta` 1.2 MB, `log-delta-version.json`, VERIFIED listing), restate the exact `mv` command verbatim, wait for the owner's written confirmation, then `mv` them into `~/.agentlens/retired-<utc-stamp>/` (a visible folder, a move not a delete), record the authorizing text, the command and the time in the cutover TRDD, and keep that folder for at least 90 days (the `.trashcan` age). `legacy-source/<stamp>/` is KEPT (80 MB, frozen input of the orphan import, the only extra copy of the 5,742 legacy cards besides `legacy_card`; OPEN whether the owner wants it kept forever). `builds_dev/` binaries are never removed. The rolled-back or aside index files, if any, follow the same rule.

### 7.3 Memory and documentation corrections (EHT-13, EHT-14, EHT-01 remainder)

Through `memgrep` verbs with `validate` and `lint` after each edit, commit after each write: supersede (never delete) the pages that describe the old model (EH section 13: ssd-write-economics, always-on-ingestion-model, agentlenspro-ops-lessons-deploy-and-install, -concurrency-and-event-loop, -store-durability-and-memory, otlp-ingest-topology, ts-dead-code-vs-rust-parity-oracles, vmmap-ioaccelerator-is-the-mimalloc-heap, log-scan-performance, hook-events-pipeline, statusline-capture-and-store, agentlenspro-publish-pipeline, dashboard-tree-render-topology); add the two new pages (index architecture hub, migration and rollback recipe) with both ends of every link; extend each description line with the symptom words of the new model; correct CLAUDE.md sections named in EH I01 to I07 with report-path evidence for every doctrine sentence (CL header rule): in particular the Operations bullet "exactly one server may own a data directory" and the deploy/rollback recipe of this spec; supersede or fold the TRDD cards of EH section 14 per card (no scripted mass repair, `trddgrep` writes only); close this cutover card; mark the interim items of IS obsolete (the `cards.duckdb` 1 GB gate dies with the file; the 4096 default in `alcoreSpawnEnv` is reviewed against the D-16 budget and removed or kept with a new justification).

## 8. Order of work, in one line each

1. Shadow build and gates G1 to G12 (section 1, 2). 2. Owner sign-off G14. 3. Dress rehearsal G11 (already part of the gates; repeat after any binary change). 4. Switch (section 3) with automatic rollback for the first hour. 5. Soak (section 5). 6. Release (section 6). 7. Retirement (section 7).

## 9. Open decisions (consolidated)

1. Shadow data dir location and the exact `index.duckdb`/parts names (1.1); shadow mode seam R-S1 and relative-path requirement R-S2 (need the ingest and storage specs).
2. CPU budget, memory budget numbers, memory-slope threshold, governor thresholds (1.3, G8): from the method bench (DEC D-15, D-16).
3. Whether `fs_usage` root is available for the no-outside-writes proof (1.2).
4. `alcore index-verify`, `alcore legacy-import`, `scripts/cutover/*` names and location (G7, 3.4, 3.7).
5. T3 growth threshold (10 rows), T4 ratio tolerance (1%), whether T3/T4 stay automatic after the first hour (3.7).
6. Blank-line handling in the line census (G4).
7. Whether OTLP exporters retry during the gap, and whether `hook-spool` spools while down (3.8).
8. Whether shared files (`collector-lifecycle.json`, `config.json`, `.revive-backoff.json`) carry version fields NEW would bump (4.2).
9. Whether the interim cap default (IS D-13) landed before the switch (4.3).
10. Soak length (5): LI says 14 days.
11. Version number: 3.0.0 versus 2.35.0 (6.2).
12. Per-platform startup feature check in `publish.yml` (G10).
13. Keep `legacy-source/` forever, and the 90-day retention of `retired-<stamp>/` (7.2).
14. Clippy dead_code with the old modules kept compiled through the release (6.1).

## 10. Unverified in this spec

Not read in code: `bin/alcore.rs` (flags, env names, shutdown order beyond CF's citations), `publish.yml` contents, `serverControl.ts` beyond the lines grep-confirmed for `--stay-down`, the hook-spool and exporter retry behaviour, the shapes of the NEW tables (names come from the task brief and the sibling specs), the real time and RSS of a NEW backfill (nothing built yet), APFS rename atomicity with open DuckDB parts (standard POSIX rename on one volume, INFERRED), `taskpolicy -b` effect on fsync latency (INFERRED), and whether the 36 session hooks respect the `NO_REVIVE` brake (VERIFIED that the brake exists and is documented at `serverControl.ts:251` and `hookHandlers.ts:360`, not run here). Numbers quoted from DEP1/DEP2/IS/LI/CF are as those documents state them.
