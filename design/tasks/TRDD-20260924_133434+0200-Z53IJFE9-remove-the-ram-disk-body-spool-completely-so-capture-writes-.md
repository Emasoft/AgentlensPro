---
trdd-id: Z53IJFE9
title: Remove the RAM-disk body spool completely so capture writes straight to the SSD bodies dir
column: dev
created: 2026-09-24T13:34:34+0200
updated: 2026-09-24T17:51:46+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: refactor
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-24T13:34:34+0200
implementation-commits: [b0ae59cb, 470ffbb3]
---

# Remove the RAM-disk body spool completely so capture writes straight to the SSD bodies dir

## Approval log

- 2026-09-24T13:34:34+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-24

OWNER DIRECTIVE (verbatim, 2026-09-24): "i told you to remove the spool completely, since it was an intermediate buffer that proved to be useless and only slowed down the ingestion and occupied space"
No earlier card recorded a removal order; the last recorded directive was the 2026-08-29 redesign order on TRDD-5YL1OQV1. Its two requirements still bind the SSD dir and are carried here verbatim: "no data must ever be lost! And the digestion must proceed in background at all times so after a while, if the telemetry stream slow down, the spool is emptied."
Incident that surfaced this: since the 2026-09-23 05:24 reboot the RAM disk was not mounted while `~/.claude/settings.json` still sent `OTEL_LOG_RAW_API_BODIES` to `/Volumes/AgentLensSpool/otel-bodies`; `~/.agentlens/otel-bodies` did not exist, so NO raw body was captured anywhere. The `com.agentlens.spool` LaunchAgent exits 78 because its plist bakes `/opt/homebrew/Cellar/node/26.5.0/bin/node`, which no longer exists (reports/spool-removal/20260924_132959+0200-measure.md).
Cost of the decision, recorded so it is made with its cost: the spool existed to keep raw bodies off the SSD (TRDD-K3WDPR7M). Estimates disagree: `src/ramdisk.ts` header says ~21 MB/min; the review's estimate from August counts is ~2.6 GB/day (~1 TB/year). Both are estimates, not measurements.
CORRECTION 2026-09-24: capture had been OFF because ~/.agentlens/config.json was absent (default false), so --install-otel never wrote the SSD path and the settings.json value was a leftover from an earlier state; the only toggle that turned capture on (agentlenspro config set captureRawBodies on) unconditionally mounted the RAM disk. Commit b0ae59cb (capture-toggle step) removed that mount from the ON path.
CORRECTION 2026-09-24: raw-body capture has been ON since about 13:45 today; ~/.claude/settings.json now names ~/.agentlens/otel-bodies; bodies land at ~14 MB/min (~20 GB/day SSD writes — the old RAM-disk code's own estimate was 30-35 GB/day). Already-running Claude Code sessions picked up the change without a restart — VERIFIED: 293 of 482 new *.request.json bodies carry the id of a session that started before the change.
CORRECTION 2026-09-24: until step B lands, the drain is still the legacy hourly pass gated at 72 h / 8 GB — bodies are captured but not yet ingested promptly.
ADVISOR VERDICT 2026-09-24 (reports/cc-alignment/20260924_134351+0200-advisor-verdict.md, section 2) on step B: B-1 — persist fsynced_parts across ticks instead of recomputing per tick (parts are immutable), keep the barrier over every part, as pass.rs does today; do not narrow it to newly flushed parts. B-2 — replace the size/mtime cross-tick tracker with a simple 10 s max_age cutoff; the existing parse-then-verify gate already handles a file still being written. B-3 — check staged_body_bytes == 0 for an empty dir BEFORE the pass lock and open_store, not after.
ADVISOR VERDICT 2026-09-24 (continued): the bodies_interval spawn-time arm must change from _ => 3600 to 60 once spool_dir_configured is gone, or the drain silently stays hourly. bodiesMaxAgeHours/bodiesMaxGb and the over-cap valve are dead once age is fixed and should be removed in step D, not documented. Before touching pass.rs semantics for B-1/B-2, check src/store/ingestPass.ts (the TS twin) and the parity fixtures under rust-core/crates/agentlens-core/tests/fixtures/ — CLAUDE.md warns bundle reachability alone doesn't prove a module dead.
2026-09-24 — Step B is committed (470ffbb3: 60 s interval, 10 s age, fsync barrier kept with a persisted fsynced-parts set, empty-dir skip) and NOT deployed. Deploy is blocked on an isolated full-size measurement of: (a) the first drain of the ~2 GB backlog in ~/.agentlens/otel-bodies into a store that does not exist yet, (b) parquet parts written per hour at a 60 s cadence (nothing merges parts, advisor F8), (c) RSS with a pass every minute against the 2 GB cap; and the four step-B tests must be re-run on HEAD itself.
A scratch git worktree /private/tmp/verify-z53ijfe9 from step B is still registered (git worktree list); removing it needs the owner.

## Steps

A. OPERATIONAL, now, no code: create `~/.agentlens/otel-bodies`; point `OTEL_LOG_RAW_API_BODIES` at it through safeConfigEdit (the existing installer if it already writes that path). Bodies are then delayed by the current 72 h / 8 GB legacy gate, not lost. Every running Claude Code session keeps the old path until it restarts.
B. Drain: the SSD dir gets age 0 and a 60 s interval, repeating until empty — but KEEPS `durable_source: true` (fsync before delete) and skips a file whose size or mtime is still changing. Convert `chores_spool_drain.rs` / `chores_bodies_spool_drain.rs` into SSD-dir tests instead of deleting them. Rust deploy: codesign -s - --force the copied alcore, `alcore --version` exit 0, then restart.
C. Setup migration for published installs (own commit): when the old spool is found, drain it (`alstore pass`), THEN detach the RAM disk, rewrite the settings path via safeConfigEdit, `launchctl bootout` com.agentlens.spool and remove its plist. Idempotent; never detach before draining. Version bump + CHANGELOG entry.
D. Delete spool code, list built from spool-specific names (ramdisk, spoolDir, spool_backpressure, spool_gauge, ensureRamDisk), not the word "spool". Readers (cacheCreationForensics, bodiesEvidence, bodies_evidence.rs, otelCallEvents, the burn guard read scope) are repointed, not deleted. Keep src/test/setup.js test isolation (TRDD-5IDBAJ6O). Hook-event spool out of scope unless the owner says otherwise. Document or remove `bodiesMaxAgeHours` / `bodiesMaxGb`.
E. Docs: CLAUDE.md, memory notes via memgrep verbs (old facts become dated lessons), diagnostics skill.
This machine's LaunchAgent: unload + move the plist out only after the owner says yes (outside the project).

## Acceptance

- [ ] a body from a NEW session lands in `~/.agentlens/otel-bodies`
- [ ] one such body, copied aside before the pass, round-trips: `alstore verify <store> <name> <copy>` returns ok:true after the pass deleted the original
- [ ] with the drain stalled (store lock held), no body is deleted before it is loaded
- [ ] with the producer stopped, the SSD dir drains to empty without operator action
- [ ] a machine upgraded from a spool install ends with no spool path in settings, no spool LaunchAgent, and every spooled body in the store
- [ ] no spool-specific symbol remains in src/ or rust-core/ (grep of the name list returns nothing outside history notes)

## Step C checklist

- [ ] the legacy-spoolDir refusal must drain a still-mounted spool before clearing spoolDir
- [ ] OFF may throw before it clears spoolDir (configCli.ts ~206)
- [ ] say "by default" for the 72 h / 8 GB limits in the printed text
- [ ] update the printed drain description when step B ships
- [ ] a test for the refusal message
