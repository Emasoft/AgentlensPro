---
trdd-id: PQ40PZ9D
title: The flood bench cannot grow a transcript so no arm drives log-sweeper rebuilds
column: human_review
created: 2026-09-23T20:20:27+0200
updated: 2026-10-08T18:43:15+0200
current-owner: main-session
created-by: main-session
task-type: infra
min-approval-requirement: none
assignee: main-session
mandate: true
mandated-by: none
approved: true
approval-judge: main-session
approval-datetime: 2026-09-23T20:20:27+0200
status: tasked
implementation-commits: [df44e8de]
---

# The flood bench cannot grow a transcript so no arm drives log-sweeper rebuilds

EQCGAVGV's arms need a log-growth driver: put_log_session (rust-core/crates/agentlens-core/src/lib.rs:292) bumps data_version whenever the log sweeper updates a session card, so transcript growth drives summary rebuilds, and no current flood-bench mode grows a transcript.

Add a mode to scripts/bench/alcore-ingest-flood.mjs that appends synthetic Claude Code JSONL (assistant turns carrying usage) to <isolated HOME>/.claude/projects/<slug>/<session>.jsonl at a configurable lines/s, refusing the passwd user's real ~/.claude (os.userInfo().homedir).

Acceptance: [x] the isolated instance's summary misses and session-card count rise with the appended lines (live run 2026-10-08: summaryMissesDelta=8, logSessionsDelta=15, dataVersionDelta=128, exit 0, append rate 24.999/s vs target 25); [x] refuses the real home (subtree guard: real home, its .claude, any descendant, '/', plus a post-mkdir symlink re-resolve; 8 refusal checks exit 2); [x] the line shape is parsed by agentlens-logscan's Claude parser (cited in source: agentlens-logscan/src/lib.rs:842 assistant branch, :851 usage dedup per message.id, :762 cwd, :1279 file-stem session id, disjoint_anthropic :147, spanstore parse_iso_ms :165). related: [EQCGAVGV, C19SUVPH].

## Approval log

- 2026-09-23T20:20:27+0200 — MANDATE issued by main-session (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-08T17:40:51+0200 — column → dev by main-agent@agentlenspro.
- 2026-10-08T18:33:11+0200 — column → testing by main-agent@agentlenspro.
- 2026-10-08T18:40:05+0200 — column → human_review by main-agent@agentlenspro.

## Implemented (2026-10-08)

--mix transcripts landed in scripts/bench/alcore-ingest-flood.mjs (173 insertions, 10 deletions, uncommitted). --lines-per-sec is the TOTAL append rate, routed through the existing --rate pacing machinery (no third pacing loop); the transcripts branch replaces the http post with fs.appendFileSync. Refusal guard is subtree-based (real home, its .claude, any descendant, '/') with a post-mkdir symlink re-resolve ceiling. Live run against an isolated alcore (copied+codesigned binary, own HOME/DATA_DIR/ports 3907/4407/3997): exit 0, 1125 appends at 24.999/s (target 25), logSessionsDelta=15, summaryMissesDelta=8, dataVersionDelta=128, 0 bad. Known mechanisms recorded per review: fetchSnapshot GETs /api/summary in transcripts mode (the reader that makes summaryMissesDelta meaningful — without it the delta is structurally 0); fs append failures are NOT a server-down signal but still feed the 20-fail/30s early-stop as a wedged-fs guard; underRate/reqPerSec/ok2xx mean appends in this mode. Ops note: SIGTERM did not stop the test alcore within 2s; SIGKILL was needed (uninvestigated, ops-lessons candidate). Full report: docs_dev/20261008_182830+0200-PQ40PZ9D-impl-report.md (gitignored).

## Review round 3 (2026-10-08)

The work-review fork's findings, dispositioned: (1) id-counter scope CONFIRMED PER-WORKER — transcriptLineNo is declared inside worker() (line 519), and an all-1126-lines scan found 1126 distinct ids, zero dups; the single-sampled-file gap is closed. (2) 'Parser accepts with silently defaulted fields' ceiling NAMED: all 16 bench cards share one synthetic cwd/workspace (single-project slug) — a fidelity ceiling a real fleet would not have; acceptable for a churn/heap bench, recorded here as the ceiling. (3) refusal-error message says 'the real home (or its .claude)' for every branch including '/' — cosmetic, left. (4) SIGTERM-insufficient-against-test-alcore is now a THREE-occurrence pattern (pids 32797/50556 orphans, this run's 43823) — filed as its own card, not a note. (5) Column: this card's live run WAS the test; testing → human_review is the honest hop (the substantive code pass happened in two adversarial spec rounds + the parent's diff read).

## Review round 4 (2026-10-08)

Round-4 fork: the id-uniqueness closure was over-claimed as scan-proven. CORRECTED: uniqueness is guaranteed STRUCTURALLY by the msg_w${i} worker-index prefix in the id (each worker's counter is its own), with the 1126-distinct-ids zero-dup scan across all 16 files as corroboration only. No further action.
