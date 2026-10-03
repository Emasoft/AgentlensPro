---
spec-id: duckplan-interim-stabilization
title: Keep the current alcore usable while the DuckDB-index rewrite is built
status: draft
created: 2026-10-03T18:54:48+0200
parent-trdd: 9VX3WTGU
---

# Interim stabilization of the current alcore

VERIFIED = read or measured this session. INFERRED = derived, not measured. Per-copy memory sizes are INFERRED everywhere: no report measures the size of a `serde_json::Value` copy; they are derived from "live 1.0-1.4 GB vs 72 MB of card text".

## 1. Problem and success criterion

Since commit 94125a8d (card reuse) every start answers in 2-8 s, then the first full summary build pushes the process past the 2048 MB RSS hard cap 22-31 s after start and the process exits. Revive is hook-driven with exponential backoff, so the server was down about 13 of 16 minutes (docs_dev/20261003_132115+0200-card-reuse-redeploy.md, VERIFIED).

Cause (post-start-memory-spike report, code VERIFIED, magnitudes INFERRED): baseline at listen is 1177 MB (parsed layer + DuckDB, VERIFIED from requests.log). The first full pass then adds the owned merged summary (`summary_over` clone, lib.rs ~440) and the owned stripped twin (`strip_one_session`, ui.rs:597). Observed climb: RSS 1177 -> 2811 MB in 15 s (three bursts of about +300/+600/+600 MB), phys_footprint 2122 MB at kill, mimalloc commit 1912 MB. The climb was still rising when the process was killed, so the plateau is UNKNOWN.

Measured criterion for "usable": for 60 consecutive minutes (a) the same alcore pid, (b) no new `RSS HARD CAP` entry in ~/.agentlens/rss-hard-cap.log, (c) `GET http://127.0.0.1:3000/api/summary` returns 200 on every 60 s sample after t+90 s.

(c) matters: at 18:52 this session found pid 13922 alive 1h30m with RSS 2.28 GB, yet a request to :3000 got an empty reply (exit 52). A pid check alone would call that server healthy. Cause of that state is not investigated here.

## 2. How the cap is set today (VERIFIED)

- Read in `rss_hard_cap_bytes()`, rust-core/crates/agentlens-core/src/rss_guard.rs:25-37: env `AGENTLENS_RSS_HARD_CAP_MB`, non-positive or unparseable -> 2048. Read on each check; no config.json key exists (config.json holds only `capture` and an empty `retention`). The metric is phys_footprint (rss_guard.rs:388), checked every 5 s (lib.rs ~800). Pressure ladder stages are fractions of the cap (macOS 0.70/0.80/0.90, rss_guard.rs:420), so raising the cap also moves the ladder; stage 2 is the amplifier (it clears the summary cache and forces a full rebuild, lib.rs:765-768).
- The live process has no cap variable: its environment (read from `ps eww` of pid 13922) carries only `AGENTLENS_STARTED_BY=hook-revive`, `MIMALLOC_PURGE_DELAY=0`, `MIMALLOC_VERBOSE=1`. ~/.claude/settings.json `env` block (line 3) has no AGENTLENS key.
- Launch paths: `agentlenspro server start` -> serverControl.ts:309 `alcoreSpawnEnv(startedBy)` -> spawn at :320. Hook revive -> hookHandlers.ts:327 `reviveSpawnSpec` spreads the HOOK process env (which is the env of whichever Claude Code session fired the hook) -> `server revive` -> the same `alcoreSpawnEnv` (serverControl.ts:222-224: `{ ...baseEnv, STARTED_BY, MIMALLOC_PURGE_DELAY }`).
- Consequence: a cap exported in a shell or in settings.json reaches the server only when that exact environment launched it. About 36 sessions run with their old env; any one of them can revive the server at 2048 MB again. The only choke point every launch path shares is `alcoreSpawnEnv` (serverControl.ts:222). Default-in-Rust (`unwrap_or(2048)`) is the other single point, but it overturns the "2048 per owner directive" comment and needs a cargo build plus codesign.

## 3. Options

Backoff state for reference: `consecutiveQuickDeaths` 4 in ~/.agentlens/.revive-backoff.json (30 s * 2^(n-1), cap 30 min, hookHandlers.ts:159-164, 238); `agentlenspro server start` resets it.

| option | memory effect | risk | effort (mine, unmeasured) | deleted by the rewrite | fixes the crash loop |
|---|---|---|---|---|---|
| (a) cap 4096 via `alcoreSpawnEnv` default | none; adds 2048 MB headroom. Peak estimate 1.18 GB + owned summary 0.5-1.0 + stripped 0.5-1.0 + first-build transients = about 2.5-3.2 GB (INFERRED) | low-medium: a runaway now reaches 4 GB before the kill; if the plateau or a coinciding MCP clone (+0.5-1 GB each, report 1c) exceeds 4 GB the loop returns | one-line TS change + test, esbuild, restart: under an hour | no (an env default, revert when done) | yes if plateau < 4096 (unproven) |
| (b) stripped twin as JSON text (design report option c) | removes one Value copy (0.5-1.0 GB INFERRED), replaced by 54 MB of text (VERIFIED size); expected post-start peak 1.8-2.1 GB, thin under 2048 (report's own estimate) | low-medium: byte exactness of the hand-assembled SSE frame; parity test already exists (tests/summary_engine.rs:95-101) | one commit across summary_engine.rs, lib.rs, ui.rs, update_payload.rs, chores.rs and tests: about a day of worker time plus a review round | yes (summary/stripped caches go to SQL in Phase E) | alone: marginal (report says to pair it with the cap) |
| (c) borrow in the 15 `.cloned()` MCP sites | removes one transient full-corpus copy per MCP/hook call; zero effect on the post-start climb (no HTTP request occurred in the failing window) | low: no served-byte change; six sites need the Arc moved into `spawn_blocking` | about half a day | mostly (consumers are rewritten over SQL; INFERRED) | no |
| (d) delay the first full summary build until a request needs it | none in steady state; only moves the spike to the first dashboard or MCP request | low, but defeats the criterion: the first dashboard request triggers the same build and the same kill | about 2 hours | yes | no |
| (e) nothing | none | server down about 80% (13 of 16 min measured) | 0 | n/a | no |

Rejected: (c) and (d) do not stop the post-start kill; (b) costs about a day of work the rewrite deletes and still leaves the process near the cap.

## 4. Recommendation: (a) only, at 4096, through `alcoreSpawnEnv`

Change (done by a worker, not by this spec): in serverControl.ts `alcoreSpawnEnv`, add `AGENTLENS_RSS_HARD_CAP_MB: baseEnv.AGENTLENS_RSS_HARD_CAP_MB ?? '4096'` to the returned object, so an explicit operator value still wins and both launch paths get it. A comment must say why: revive inherits the hook's session env, so a shell export is lost on the next revive. Do not touch rss_guard.rs.

Escalation rule, decided up front: if any watch sample shows footprint above 3.6 GB (88% of cap) and still rising, restart once with `AGENTLENS_RSS_HARD_CAP_MB=6144` exported, purely to measure the plateau (the post-start report proposes 6000 for the same reason), then pick the number from the measurement. If `memory pressure stage` reaches 2 at 4096 (3277 MB), do (b) before raising further.

### Does a raised cap risk the 64 GB machine? (read-only `sysctl`, `vm_stat`, 2026-10-03 18:52)

- hw.memsize 64 GiB. Page size 16 KB: free 4.3 GiB, inactive 22.7 GiB, speculative 1.1 GiB, wired 11.1 GiB, compressor holds about 6 GiB of logical pages. Reclaimable without swapping: about 28 GiB. 
- vm.swapusage: 2301 MB used of 3072 MB, 770 MB free (75% used; macOS grows swap on demand, and the 3 GB total says earlier pressure existed).
- Judgement (INFERRED): +2 GB is 3% of RAM and well inside the reclaimable pool, so the cap raise alone is low risk. The real exposure is a leak that used to be killed at 2 GB now living to 4 GB; the cap and ladder remain as the backstop. The swap figure is a reason to watch, not to refuse.

## 5. Verification procedure (measured watch, same shape as the card-reuse deploy docs)

All steps by a lean-worker, sampler in the background and detached (`detach-run.py`), report in docs_dev.

1. Before: `ps -eo pid,etime,rss,command > snapshot`, copy `.revive-backoff.json`, size of cards.duckdb and .wal, last line of rss-hard-cap.log.
2. Deploy: edit, `node esbuild.js`, grep the new symbol in standalone/cli.js, confirm which agentlenspro is on PATH (`readlink -f $(command -v agentlenspro)`), `agentlenspro server restart` (restart goes through `server start`, which resets the backoff).
3. Prove the env reached the process: `ps eww -p <pid> > f; tr ' ' '\n' < f | grep AGENTLENS_RSS_HARD_CAP_MB` must show 4096. Then prove the revive path: after the watch, kill nothing; instead run `agentlenspro server revive` against a stopped server in the isolated recipe (own DATA_DIR) or read the next hook-revive pid env the same way.
4. Sampler every 60 s for 65 min writing one TSV row: time, pid, etime, RSS KB (ps), HTTP code and time of `GET /api/summary` (curl -m 5), `GET /api/debug/log-scan-stats` summaryEngine counters (full_passes, shared_copies), cards.duckdb bytes, wal bytes, count of `memory pressure stage` lines in server.log.
5. Pass: criterion in section 1, plus max footprint below 3277 MB. Fail: any cap exit, a pid change, a non-200 after t+90 s, or stage 2 reached. Report the table with the plateau figure; that number also replaces the INFERRED copy sizes in this spec.

## 6. Rollback

Nothing is migrated: the cap is an environment value. Revert the one-line diff, `node esbuild.js`, `agentlenspro server restart`. Immediate runtime form: stop the server and start it with `AGENTLENS_RSS_HARD_CAP_MB=2048` exported. cards.duckdb and the backoff file are not touched by this change. Rollback trigger: a cap exit at 4096, or the machine's swap rising above 2.9 GB while the server runs.

## 7. cards.duckdb growth (no compaction since 94125a8d)

Evidence: 190 MB at 13:05, 238 at 13:10, 273 at 13:20 (card-reuse-redeploy report); 474 MB per the task brief (not re-measured by me); 575 418 368 bytes at 17:27 (`ls -la` this session, VERIFIED), plus a 991 KB WAL. The card text is about 72 MB (composition line, VERIFIED), so the file is about 8x its content. Writes are upserts (card_store.rs:419) and demote updates (:599), which leave old row versions behind. `grep` over the crate finds no CHECKPOINT or VACUUM statement. Whether freed blocks are reused so the size plateaus, or whether this DuckDB (crate 1.10505.0) truncates on checkpoint, is NOT verified here; no duckdb CLI is on PATH to test offline.

Mitigation, smallest first:

1. Now: nothing, but the sampler records the size and the spec's trigger is 1 GB (about 14x the content, double today's file). Rationale: 575 MB costs no RAM that the cap does not already see, and a rebuild costs a slow start.
2. If the file passes 1 GB: add a size gate to `CardStore::try_reuse` (card_store.rs ~255): file bytes above the limit returns `Err("file too large, rebuilding")`, which takes the existing NOT-reusing path (delete, empty store, full restore from the card snapshot). Cost: one slow start (median 2:23 before reuse, plus the 664 MB restore burst, measured over 96 boots in the TRDD) every time the limit is crossed. About 5 lines; likely survives the rewrite if the rewrite keeps a DuckDB card file (INFERRED).
3. Optional, only with a measurement first: a `CHECKPOINT` after the restore finishes. Keep it only if the sampler shows the file size dropping; otherwise it is wasted code.
4. Manual, server stopped: move (not delete) cards.duckdb and its .wal to `~/.agentlens/cards.duckdb.bak-<timestamp>`; the next start rebuilds from the snapshot. Per RULE 0 this is a move, and the backup can be restored by moving it back.

## 8. Unverified

Plateau of the post-start climb; per-copy Value sizes; why pid 13922 is alive but not answering; whether the three bursts are three passes or one pass in three phases; DuckDB truncate-on-checkpoint behaviour; whether `server revive` is exercised by the env-inheritance test in step 3 exactly as the hook path does.
