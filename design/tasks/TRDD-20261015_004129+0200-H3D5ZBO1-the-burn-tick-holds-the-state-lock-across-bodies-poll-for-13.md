---
trdd-id: H3D5ZBO1
title: The burn tick holds the state lock across bodies.poll, for 130-576 s on the first pass after boot
column: testing
status: tasked
created: 2026-10-15T00:41:29+0200
updated: 2026-11-19T12:57:36+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T00:41:29+0200
implementation-commits: [8e0cb02c, 4e095f80, a2c4459d]
---

# The burn tick holds the state lock across bodies.poll, for 130-576 s on the first pass after boot

## Approval log

- 2026-10-15T00:41:29+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
2026-11-15 10:3x — NEXT (3) real-data boot measurement RAN (HEAD 580a03db alcore release build, codesigned; APFS clone ~/agentlens-h3d5zbo1-clone, 185,636 otel-bodies entries, log scan OFF, isolated DATA_DIR/HOME/ports, AGENTLENS_LOCK_TRACE_MS=250, host load 14-110). VERDICT INCONCLUSIVE: the bodies scan took 8,442 ms (run 1) and 7.4 s (run 2), under the spec's > 10 s precondition. No 'lock held' / 'guard split' trace line was emitted in either run (a guard logs only on drop, so a hold in progress at a hard-cap exit leaves none). REPORT-ONLY: run 1 hit the 2048 MB RSS hard cap at boot+81 s with 2556 MB commit — NOT like-for-like with the 925 MB --no-log-scan baseline (unresolved confound: whether the summary build ran is not established; the probe's own early /api/burn-risk call at boot+8 s is a reader that could have started it), not a regression claim. /api/burn-risk figures are HTTP latency, not hold measurements. Run 2 (post-run-1 clone: retention purged, spool drained, DuckDB not cleanly closed; cap 8192) stopped on SIGTERM in 8.14 s, exit 0. Nothing written under media/. Report: reports_dev/H3D5ZBO1/20261115_103231+0100-real-data-boot-measure.md (gitignored). To settle the gate: a cold-cache or larger corpus run where the scan exceeds 10 s, with log scan ON. Deploy still blocked by TRDD-12FGMAEP.

## Findings (2026-10-15)

- bodies.poll is called at ui.rs:4173, under the state lock.
- The bodies store holds about 588k files (147 GB) in ~/.agentlens/otel-bodies.
- On the first pass after each boot it takes 130-576 s; after that it takes about 7.5 s per tick.
- It is still under the state lock at HEAD.
- It is the dominant long holder of the state lock today; TRDD-N60JUWU3's stop path starves behind it.

## Findings (2026-10-18)

2026-10-18: the 55 s hold is BodiesActivityTracker::poll (burn/bodies_activity.rs:247), which stats every unseen name on its first poll before the 15-min seed skip; it is also called from lib.rs:647. Footprint grew only ~55 MB during the hold, so moving it off the lock relieves lock starvation but is not shown to lower the memory peak. Skipping the first-poll stat would empty the burn-risk and warm-disarm evidence for 15 min after each restart.

## Live evidence 2026-10-28

735Q3JF4 deferred run A (real-data copy, log scan on, 185636 body files): a 12.6 s state-lock hold attributed to ui.rs:4426, i.e. the burn tick's whole locked block (which contains bodies.poll, plus statusline.flush and ttl_context) at up ~0 made three waiters (ui.rs:948, ui.rs:262, chores.rs:69) wait 12.5 s (docs_dev/20261028_211829+0100-735Q3JF4-deferred-measurements.md). With 185636 body files vs 588k when 130-576 s was measured: a size data point consistent with first-pass cost scaling with file count, not a re-confirmation of that magnitude.

## ⏵ STATE — 2026-10-29 (authoritative)

Implemented in two commits after two review rounds: 8e0cb02c + 4e095f80 split BodiesActivityTracker into BodiesPoller (scan &self, commit) and BodiesActivity (merge, prune, report), no behaviour change, frozen-oracle tests; a2c4459d runs the scan in a spawn_blocking task the burn tick starts and never awaits, holding the state lock only to clone two Arcs and to merge. Lock order poller then state. in_flight CAS + drop guard. Names commit to seen only after merge. /api/burn-risk and MCP check_burn_risk no longer poll; new bodiesScan {seeded, inProgress, lastMergeAgeMs}.
Gate trade-off settled: the agent-gate hook fails open after 4 s (src/cli/hookHandlers.ts:473-487), so during a first pass it already allowed everything; now it answers at once.
Evidence: live server.log lock_a 534087-587855 ms with bodies_poll within 17-41 ms of it (statusline_flush <= 38 ms). Design facts and reviews: docs_dev/20261029_054348+0100-H3D5ZBO1-design-facts.md, docs_dev/20261029_054540+0100-H3D5ZBO1-measure.md, docs_dev/20261029_054758+0100-H3D5ZBO1-measure-r2.md, docs_dev/20261029_060541+0100-H3D5ZBO1-commit2-report.md.
Not guarded by a test: the merge-then-commit order inside run_bodies_scan_with (comment and review only); the poisoned-poller recovery is reachable only in test binaries (production panic hook exits).
NEXT: (1) commit-2 review follow-ups in flight (poll doc-hidden, TS BurnRiskReport.bodiesScan + digest line, CHANGELOG, full agentlens-core suite incl shutdown_flush); (2) delete the frozen OracleTracker and its oracle-comparison asserts (keep the delta-level and rescan tests); (3) [RAN 2026-11-15, INCONCLUSIVE: scan 8.4 s < 10 s, log scan OFF, see the Approval log line of that date; settle with a cold-cache or larger-corpus run, log scan ON] real-data boot measurement on an APFS clone (cp -cpR, mtimes preserved, 60 GB free guard) with otel-bodies present, AGENTLENS_LOCK_TRACE_MS=250: pass/fail = burn-tick lock A and merge holds <= 1 s with bodies scan > 10 s; report-only = the /api/burn-risk hold (guard.rs:215 read_dir), peak phys_footprint and mimalloc commit vs TRDD-735Q3JF4 baselines, and server stop time; (4) deploy blocked by TRDD-12FGMAEP.
2026-11-17T06:59+0100 main agent, DECISION on NEXT (3), which supersedes its wording above. The gate as written (a clone of the real otel-bodies folder, 147 GB when measured) is no longer allowed: owner order 2026-11-16, no test or measurement creates or copies more than 4 GB, never a full-size data clone, and a clone counts in full. Facts the new gate rests on: the first-pass cost follows the NUMBER of files, not their bytes (Findings 2026-10-18: the poll stats every unseen name; 588k files gave 130 to 576 s, 185,636 files gave 7.4 to 8.4 s). NEW GATE: an isolated alcore (own DATA_DIR, HOME and ports, AGENTLENS_LOCK_TRACE_MS=250, run through scripts/test-data-cap.sh) over a GENERATED otel-bodies folder of small files, enough of them for the scan to exceed 10 s on the day (start at 600,000 files of a few bytes, well under 4 GB; raise the count, not the size, if the scan is under 10 s); pass = burn-tick lock A and merge holds of at most 1 s while the bodies scan runs longer than 10 s, with at least one trace line that shows the hold; real files and a real scan, no mock. Report-only figures as before. It must be built from a tree that holds no other task's uncommitted Rust change, so it waits for the TRDD-JDQR0HDT worker to finish and for its change to be committed or set aside. NEXT (1) and (2) are unchanged and need no data.

## Notes

2026-11-19T01:25:02+0100 main agent: removed from TRDD-HSPUF5XH blocked-by as POST-RELEASE CHECK (NEXT 3 and 4). The line with its failure mode and whether the mechanism existed at v2.33.1 is in HSPUF5XH, section 'Release list decision 2026-11-19'. This card stays open; only the release gate changed.

## Progress log

2026-11-19 12:57 — TRDD-569BMAGD routed this card's measurement copies through scripts/capped-copy.sh, which refuses above 4 GB (owner cap 2026-11-16). clone.sh copies $SRC (~/.agentlens); that copy is refused when it is above 4 GB (its size was not measured), so re-running it may need a sample of at most 4 GB.
