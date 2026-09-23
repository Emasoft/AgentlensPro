---
trdd-id: 81BW1CS9
title: Real capture diverted into two test-leaked tmp data dirs must be merged back into the data dir
column: todo
created: 2026-09-09T11:36:35+0200
updated: 2026-09-23T06:01:10+0200
current-owner: main
task-type: bugfix
min-approval-requirement: user
priority: high
severity: high
blocked-by: [5JZQFVO8]
npt: []
eht: []
implementation-commits: []
project-id: agentlenspro
scope: project
labels: [capture, data-recovery, alcore, hooks]
relevant-rules: []
parent-trdd: YGEV6QDD
---

# Real capture diverted into two test-leaked tmp data dirs must be merged back into the data dir

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-09 11:36

Blocked on TRDD-5JZQFVO8's deploy — pid 68584 must not be killed until its diverted data is
recovered, and the recovery procedure itself needs to be reviewed before it runs (min-approval
is USER because the merge writes into the real, live data store — irreversible if wrong).
NEXT ACTION: once 5JZQFVO8 reaches deploy, inventory both tmp dirs into `reports/`, propose a
per-store-type merge procedure, get it reviewed, then run it.

## Why

Two daemons leaked by tests (see TRDD-YGEV6QDD) squatted the canonical ports
(3000/4316/4318) with tmp data dirs, so every real session's hook events, OTLP spans, and
statusline samples were written there instead of `~/.agentlens`:

- `/var/folders/…/T/al-lat-wUTURr` — 123 MB; pid 850, killed 2026-09-08 22:38, ran ~7 h.
- `/var/folders/…/T/al-setup-OYnBpx/.agentlens` — 100 MB at 23:09, still growing; pid 68584
  since 2026-09-08 22:43; contains `hook-events/2026-09-08.ndjsonl`, `log-events`, `spans/`,
  `statusline/`, `requests.log`.

The real `~/.agentlens/hook-spool` stopped filling at 22:47 because the squatter answered
first. `min-approval-requirement: user` because the merge writes into the real data store and
is irreversible if the procedure is wrong.

## Evidence

- TRDD-YGEV6QDD STATE block — root cause of the port-squatting (missing UI_PORT/MCP_PORT/
  OTLP_PORT pins in `execRegisteredCommand`, `src/cli/setup.ts:285-311`).
- Measured 2026-09-09 11:32: pid 68584 still the only listener on port 3000, `al-setup-OYnBpx`
  dir still growing.
- Measured 2026-09-08 22:38: pid 850 killed by the orchestrator during an unrelated
  memory-verification task, `al-lat-wUTURr` dir static at 123 MB since.

## Acceptance

- [ ] Both dirs copied to a safe location under `reports_dev/` before any merge (RULE 0 — never
      deleted).
- [ ] An inventory per dir (file, rows, time span) written to `reports/`.
- [ ] A merge procedure proposed per store type (ndjson append with dedupe on event id/ts;
      spans segments; statusline) and reviewed BEFORE running.
- [ ] After merge, `agentlenspro get_recent_sessions` shows sessions from the diverted window.
- [ ] The tmp dirs are left in place until the USER deletes them.

## Approval log


## Disk check 2026-09-23

Checked on disk 2026-09-23: neither /var/folders/.../T/al-lat-wUTURr nor /var/folders/.../T/al-setup-OYnBpx/.agentlens exists anymore (find over /private/var/folders to depth 8 for both names returns nothing) — both leaked tmp data dirs are gone, presumably purged by macOS tmp cleanup or removed in an untracked prior pass; their diverted capture is not recoverable from these paths. pid 68584 (the al-setup-OYnBpx squatter) was already absent in the pre-2026-09-23-deploy process snapshot — it was not killed as part of that deploy, it had already exited or been reaped beforehand.

## Verification note

Re-verified 2026-09-23 with a stricter check per this repo's own evidence discipline: (a) tmp-dir search redone with NO maxdepth limit (not just depth 8) under /private/var/folders -- still 0 matches for al-lat-* or al-setup-* ($TMPDIR itself confirmed to point under that root). (b) pid 68584 absence re-checked by matching the PID and PPID COLUMNS of a ps snapshot (awk '$1==68584 || $2==68584'), not a substring grep -- 0 matching lines, ruling out both a live process AND a child reparented to it. Both findings VERIFIED, not merely inferred from a single substring hit.
