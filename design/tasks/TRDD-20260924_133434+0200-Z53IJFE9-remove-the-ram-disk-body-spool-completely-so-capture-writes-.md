---
trdd-id: Z53IJFE9
title: Remove the RAM-disk body spool completely so capture writes straight to the SSD bodies dir
column: dev
created: 2026-09-24T13:34:34+0200
updated: 2026-09-24T13:36:26+0200
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
---

# Remove the RAM-disk body spool completely so capture writes straight to the SSD bodies dir

## Approval log

- 2026-09-24T13:34:34+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-24

OWNER DIRECTIVE (verbatim, 2026-09-24): "i told you to remove the spool completely, since it was an intermediate buffer that proved to be useless and only slowed down the ingestion and occupied space"
No earlier card recorded a removal order; the last recorded directive was the 2026-08-29 redesign order on TRDD-5YL1OQV1. Its two requirements still bind the SSD dir and are carried here verbatim: "no data must ever be lost! And the digestion must proceed in background at all times so after a while, if the telemetry stream slow down, the spool is emptied."
Incident that surfaced this: since the 2026-09-23 05:24 reboot the RAM disk was not mounted while `~/.claude/settings.json` still sent `OTEL_LOG_RAW_API_BODIES` to `/Volumes/AgentLensSpool/otel-bodies`; `~/.agentlens/otel-bodies` did not exist, so NO raw body was captured anywhere. The `com.agentlens.spool` LaunchAgent exits 78 because its plist bakes `/opt/homebrew/Cellar/node/26.5.0/bin/node`, which no longer exists (reports/spool-removal/20260924_132959+0200-measure.md).
Cost of the decision, recorded so it is made with its cost: the spool existed to keep raw bodies off the SSD (TRDD-K3WDPR7M). Estimates disagree: `src/ramdisk.ts` header says ~21 MB/min; the review's estimate from August counts is ~2.6 GB/day (~1 TB/year). Both are estimates, not measurements.

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
