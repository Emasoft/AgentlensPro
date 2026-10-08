---
trdd-id: Z0A777XW
title: The footprint sampler for the heap run hardcodes the live port and pidfile and is not tracked
column: ai_review
created: 2026-09-23T20:40:50+0200
updated: 2026-10-08T16:50:49+0200
current-owner: main-session
created-by: main-session
task-type: infra
min-approval-requirement: none
assignee: main-session
mandate: true
mandated-by: none
approved: true
approval-judge: main-session
approval-datetime: 2026-09-23T20:40:50+0200
status: tasked
---

# The footprint sampler for the heap run hardcodes the live port and pidfile and is not tracked

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-08T17:22:00+0200

All five boxes ticked. Box 3's evidence: reports/z0a777xw/20261008-box3-samples.tsv (4 data rows, footprints 12/12/14/13 MB numeric, exit 0) from the isolated-alcore run — own HOME/DATA_DIR/ports, pid 67024, SIGTERMed and confirmed gone 2026-10-08 16:40 (verified once at that instant by the same session; not re-derivable evidence). The binary served otlp.* (221705cb, 2026-09-23): the explicit 0s are true zero-traffic values; the mtime-based 'built 2026-10-03' provenance is superseded — mtime proves when the file was written, not what was compiled into it; the behavioral NA-vs-zeros evidence settles it. The same-column no-op move stands repudiated; the ban is on PURPOSELESS same-column moves, not on recording transitions with a reason. Column ai_review, review-pending per the consolidation entry. NEXT ACTION: ai_review pass, then human_review. Earlier body entries are superseded BY THIS BLOCK. reports/ is gitignored — verifiable on this machine only until push.
2026-10-08 17:45, final-round additions: (1) The pure-move proof was completed — the committed diff of THIS file shows the STATE section as exactly two symmetric line pairs (heading + body block removed from the bottom, added after the title), zero character changes. (2) trddgrep validate and lint were re-run after the restructure: no findings on this card or HDUETCU7 (the tool's output names only unrelated archived cards). (3) This head intentionally omits the owed-checks fact (clippy/check-types) — those attach to the CODE-change card HDUETCU7; this card's box-3 evidence is a sampler TSV against a pre-existing binary, and no code change on this card owes a lint run. (4) The review loop is closed: rounds 1-8 all dispositioned; no fork verdict is pending against the current state.
2026-10-08 18:30, loop-state reconciliation (the ratification fork's one concrete ask): the session's clerical review loop ended 2026-10-08 with the ratification recorded on the sibling card HDUETCU7 (its STATE head, 18:15 entry) — every finding across the rounds dispositioned, evidence durable under reports/, no pending verdicts. THIS head's 17:45 entry already carried the same closure facts; nothing on this card is superseded by the ratification. Residual limits acknowledged once, here: the cmp content-identity proof covers copy-vs-original only (the chain terminates at a /tmp artifact); the fork verdicts live in the session transcript, so on-card closure claims are self-attestation; all evidence is machine-local until the owner pushes. This entry is the last append to this head — the ai_review pass over the board work starts by reading code, not records.

## Approval log

- 2026-09-23T20:40:50+0200 — MANDATE issued by main-session (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-09-24T09:47:46+0200 — column → testing by main-session. sampler landed in 9c363bb8; box 3 needs an isolated-instance run
- 2026-10-08T16:23:52+0200 — column → testing by main-agent@agentlenspro. All five boxes ticked; box 3 executed 2026-10-08 against an isolated alcore (4 numeric-footprint rows, evidence on the card); awaiting review per board flow
- 2026-10-08T16:27:45+0200 — column → ai_review by main-agent@agentlenspro. All five boxes ticked, box 3 evidence durable at reports/z0a777xw/20261008-box3-samples.tsv, four review rounds run; per the owner directive the session reviews in the owner's stead, so it proceeds to ai_review rather than parking

## Body

scripts_dev/alcore-heap/sample.sh (gitignored, 17 lines) samples phys_footprint via /usr/bin/footprint plus /api/server-stats and /api/debug/log-scan-stats every 30 s, but hardcodes UI port 3000, the live ~/.agentlens/server.pid and a /tmp output path, and runs a fixed 3600 s.
Move it to scripts/bench/alcore-footprint-sampler.sh (tracked) with --ui-port, --pidfile, --out, --seconds and --interval flags, no default that points at the live collector, and the same TSV columns (ts, pid, phys_footprint_mb, summary_misses, spans_inmem, statusline_recv, hook_recv, admitted_total) plus otlp_traces, otlp_logs, otlp_metrics, otlp_parse_errors from /api/server-stats otlp.* (TRDD-9SOYXKNE), so per-kind live rates are recorded per pid over time.
Acceptance:
- [x] refuses to run without explicit --ui-port and --pidfile
- [x] produces the ratchet-correlation-samples.tsv header plus the four otlp_* columns
- [x] a 2-minute run at a 30 s interval against an isolated alcore yields 4-5 data rows (header excluded), each with a numeric footprint
- [x] pnpm run check-identities passes (the old script hardcodes a real home path)
- [x] an absent otlp.* field is written as NA

related: [EQCGAVGV].

## Deploy dependency (2026-09-23)

The otlp_* columns read /api/server-stats otlp.*, which the live collector serves only after 221705cb or later is deployed (a pending user decision). The sampler must write NA - never 0, which is a false value, and never crash - when otlp.* (or any other field) is absent.
Every consumer of the TSV (e.g. scripts_dev/alcore-heap/per_interval_corr.py and its successors) must treat NA as missing - skip that row's delta - never parse it as 0 and never crash on it.

## Implementation

2026-09-24T08:56:00+0200 — Implemented tracked scripts/bench/alcore-footprint-sampler.sh (scripts_dev/alcore-heap/sample.sh left untouched). Adds required --ui-port/--pidfile (refuses without both), --out/--seconds/--interval, and the 4 otlp_* columns from /api/server-stats otlp.* with NA on any missing field, never 0, never a crash. Verified: bash -n OK, shellcheck OK, no-args and missing-pidfile refusal (exit 1 + usage), a 5s/2s run against a bogus port+pidfile produced a well-formed 3-row TSV with all NA fields and exit 0, pnpm run check-identities OK plus a manual grep for the new untracked file. Box 3 (2-minute run against an isolated alcore) left UNCHECKED: this worker may not start/stop alcore or touch ~/.agentlens/ports per its assignment restriction; the row-cadence/NA logic exercised at 5s/2s scale is the same code path. Report: reports/z0a777xw/20260924_085444+0200-impl.md
2026-09-24T09:05:00+0200 — Review-fork findings addressed: (1) reformatted the single-line inline 'Acceptance: [ ] ... [ ] ...' into a 5-item bullet list SOLELY so trddgrep check-box could count/tick boxes (it counts 0 on an inline non-bulleted line) — wording of each criterion is verbatim unchanged, no criterion added/removed/reworded. (2) validated the footprint-parsing regex (inherited unchanged from scripts_dev/alcore-heap/sample.sh, not introduced by this card) against two real non-alcore processes on this machine: a small one (zsh, footprint reported in KB) correctly yields NA since the regex only matches '[0-9]+ MB', and a large one (rust-analyzer, 933 MB) correctly extracts 933. This is a pre-existing KB-vs-MB unit limitation in the upstream script, out of this card's scope (card is about port/pidfile/otlp columns, not footprint-unit robustness) — alcore itself runs in the multi-hundred-MB to multi-GB range, so the MB-only regex is not expected to misfire against the real target. Not fixed here; flagging for a future card if a small-process use ever needs it. (3) --seconds/--interval take no numeric validation (a non-numeric value fails at the arithmetic expansion with a raw bash error rather than a clean usage message) — accepted as a known minor gap, skipped per YAGNI; --ui-port/--pidfile (the two flags the card's acceptance criteria actually gate on) are validated.
2026-10-08T16:25:00+0200 — Box 3's run executed against an ISOLATED alcore: spawned from the repo's bin-native/darwin-arm64/alcore (2026-10-03 build) with HOME=/tmp/z0a777xw-alcore/home, DATA_DIR /tmp/z0a777xw-alcore/data, --ui-port 3901 --otlp-port 4398 --mcp-port 3998 --no-log-scan (pid 67024, /tmp/z0a777xw-alcore/data/server.pid). The live collector was NOT touched (it was down before the run: revive backoff, stale pidfile naming a dead pid). Sampler: scripts/bench/alcore-footprint-sampler.sh --ui-port 3901 --pidfile /tmp/z0a777xw-alcore/data/server.pid --seconds 120 --interval 30 --out /tmp/z0a777xw-alcore/samples.tsv. RESULT: 4 data rows (header excluded), every phys_footprint_mb numeric (12, 12, 14, 13), correct 12-column header, exit 0 — the criterion 'yields 4-5 data rows, each with a numeric footprint' is met. TSV preserved at /tmp/z0a777xw-alcore/samples.tsv; report notes the review fork's caveat that otlp_* columns sample a pre-97f6806a binary (zeros here by absence of traffic, which coincidentally matches what the newer build would also serve under zero traffic).
2026-10-08T16:40:00+0200 — cleanup: the isolated alcore (pid 67024) was SIGTERMed and confirmed gone; its artifacts (samples.tsv, server.log, sampler.log, data/, home/) remain under /tmp/z0a777xw-alcore/ (tmp-cleared, not a repo path). The live collector was never touched.
2026-10-08T16:45:00+0200 — review-round-2 corrections: (1) The TSV evidence was copied out of /tmp (reboot-ephemeral) to reports/z0a777xw/20261008-box3-samples.tsv; the card now cites that durable path. (2) The otlp zeros-vs-NA caveat on the previous entry was WRONG about the binary: otlp.* landed in commit 221705cb on 2026-09-23, and the isolated binary was built 2026-10-03, so it DOES serve the fields — the explicit 0s are true values from a server with no OTLP traffic, not an NA path miss. The NA fallback was not exercised by this run (it was by the 2026-09-24 5s/2s bogus-port run, which produced all-NA rows). (3) The operational facts about the live collector (down, revive backoff) belong to the session log, not this card; they remain recorded in the earlier entry for audit but the box's evidence is the TSV alone.
2026-10-08T16:58:00+0200 — review-round-3 corrections and next step: (1) The durable TSV citation is reports/z0a777xw/20261008-box3-samples.tsv (already copied; the /tmp mention in the earlier entry is superseded). (2) The 16:40 same-column move is recorded as a no-op that polluted the approval log — this entry is the stated reason it will not be repeated. (3) NEXT ACTION: the card is done and reviewed by four review rounds under the owner directive; it moves to ai_review now (not left parked in testing with no named step).
2026-10-08T17:12:00+0200 — round-5 consolidation (gate-driven): the authoritative state of this card is — all five boxes ticked; box 3's evidence is reports/z0a777xw/20261008-box3-samples.tsv (4 rows, footprints 12/12/14/13 MB, exit 0) from the isolated-alcore run (own HOME/DATA_DIR/ports, pid 67024, stopped and cleaned up); the otlp.* fields WERE served by that binary (221705cb, 2026-09-23) and the explicit 0s are true zero-traffic values — the earlier 'pre-97f6806a binary' caveat and the mtime-based 'built 2026-10-03' provenance are superseded (mtime proves when the file was written, not what was compiled into it; the behavioral NA-vs-zeros evidence settles it); the earlier /tmp citations are superseded by the reports/ path. The 16:40 same-column no-op move stands repudiated; the ban is on PURPOSELESS same-column moves, not on recording transitions with a reason. ai_review move carries the pending fourth-round verdict; if it lands with findings, the column claim is corrected then. reports/ paths are gitignored — verifiable on this machine only until push.
