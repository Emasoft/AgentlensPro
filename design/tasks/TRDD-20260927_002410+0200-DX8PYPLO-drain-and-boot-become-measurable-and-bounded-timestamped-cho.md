---
trdd-id: DX8PYPLO
title: Drain and boot become measurable and bounded — timestamped chore lines, one bounded re-measure, a resilience bench
column: todo
status: tasked
created: 2026-09-27T00:24:10+0200
updated: 2026-09-27T02:30:37+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: infra
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-27T00:24:10+0200
---

# Drain and boot become measurable and bounded — timestamped chore lines, one bounded re-measure, a resilience bench

OWNER DIRECTIVE (2026-09-26, verbatim): 'make the server faster and resilient to all. no more crashes.' And from the review chain on TRDD-Z53IJFE9: no GB/day figure derived from the timestampless server.log is quotable — three brackets were minted and each was wrong in a different way.

VERIFIED GAPS (all checked in source, 2026-09-26/27):
G1. server.log lines carry NO timestamps — the log Reader has to guess spans from rotation boundaries. The bodies-pass line (chores.rs:368), the hook-spool line, and the boot provenance line are all timestampless. requests.log (the HTTP layer) is the ONLY timestamped log, and it does not cover chore work.
G2. Because of G1, the body-write rate is unmeasurable from history: the Z53IJFE9 wikimem ladder ended at '12,257 MB freed over an unmeasurable span'. A single timestamp on the pass line makes every future measure one grep.
G3. No resilience bench exists: nothing reproduces the crash loop. TRDD-2JOIAH2G's acceptance needs a repeatable scenario — fill otel-bodies with >2 GB while the server is STOPPED, start it, and assert zero RSS-cap exits and drain-to-empty.
G4. The soft summarization valve (span_window.rs apply_memory_pressure, budget 4096 MB) never fires on this failure mode (window holds 10-124 spans vs the 1M count cap), so there is currently NO graduated response between 'working fine' and 'exit(1)'.

DESIGN:
D1. Timestamp every alcore eprintln/println chore line (bodies pass, hook-spool, boot provenance, state lock): one helper, applied at the call sites in chores.rs + bin/alcore.rs + log_reader.rs boot lines. ISO 8601 local, same %Y-%m-%dT%H:%M:%S%z shape as TRDD frontmatter.
D2. After D1 ships and the server has a day of uptime: ONE bounded re-measure of the body-write rate (sum freed MB over a known 1h window) replaces the entire wikimem ladder (ATOM-LN86-T9RZ + ATOM-2JW2-CPGV + ATOM-NSSD-71W1 + ATOM-O9EN-PDYP) with one number — the four lessons get superseded by a fifth that cites the timestamped measurement.
D3. A resilience test (rust-core test or a scripted scenario under src/test/) that runs the G3 scenario against a real alcore binary in an isolated data dir, asserting: zero 'RSS HARD CAP' lines, drain completes, every body in the store (alstore verify on an aside copy). MUTATION CHECK (discriminates the FIX, not the guard — guard-off produces zero cap lines and would score the main assertion PASS): rerun with the purge fix REVERTED, or with AGENTLENS_RSS_HARD_CAP_MB set to the forced-breach value = MEASURED fixed steady-state (R0b on TRDD-2JOIAH2G) + margin, floor 1.5 GB — a hard constant goes stale as the corpus grows (the ~1.1-1.3 GB figure is from the iso-run gate on an EARLIER copy of the data; the live corpus has grown since), and a value below real steady-state breaches even WITH the fix and discriminates nothing (the 256 MB defect class); the harness word is not 'kills' (no revive supervisor exists in an isolated data dir) but the OBSERVABLE ARTIFACTS: entries in <dataDir>/rss-hard-cap.log (written by the same code path that exits) and the process's non-zero exit — assert those APPEAR in the reverted arm and are ABSENT with the fix. This is the executable form of 'no more crashes' for THIS family — the same discipline that caught the pid-lock regression (serverSingleInstance.test.ts, mutation-verified).
D4. Fold into the 2JOIAH2G implementation order as the instrumentation step (D1 first — the measurement for R2 'measure before picking the number' then exists).

NON-GOALS: no redesign of the store layout (DuckDB is already the direct-ingest target per owner directive), no new buffer, no process split (always-on-ingestion-model lesson: verify the ACTUAL loss vectors first — they are covered).

RELATED: TRDD-2JOIAH2G (the crash-loop fix this instruments), TRDD-Z53IJFE9 (drain semantics pinned — do not break), TRDD-563B8WYH (discovery card).

ACCEPTANCE:
- [ ] every chore/boot log line starts with an ISO 8601 local timestamp
- [ ] the resilience scenario runs green against a real binary, and the REVERTED-FIX (or forced-breach cap = measured steady-state + margin, floor 1.5 GB) arm produces rss-hard-cap.log entries + non-zero exit while the fixed arm produces none (mutation check that can actually fail)
- [ ] the wikimem ladder is collapsed to one timestamped measurement
- [ ] a 1h bounded re-measure of the body-write rate exists and is cited by the collapsed lesson

## Approval log

- 2026-09-27T00:24:10+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-09-27T00:24:18+0200 — column → todo by main-agent@agentlenspro. owner directive: resilience + measurability; D1 is prerequisite measurement for 2JOIAH2G R2

## Review amendments (gate round 1, 2026-09-27, applied)

HISTORICAL RETELLING — SUPERSEDED by the design-text edits of commit 51128af1 + the round-3 fixes; the design sections above are AUTHORITATIVE, this appendix quotes pre-correction values: AMENDMENTS from the gate review (findings F4/F5 applied here): F4 — D3's mutation check was INVERTED as written (guard-off produces zero cap lines, which the 'zero RSS HARD CAP lines' assertion scores as PASS — the test could never catch the thing it exists to catch). The discriminating mutation is the FIX, not the guard: run the backlog scenario with the purge fix REVERTED (or AGENTLENS_RSS_HARD_CAP_MB=256 for a forced-breach arm) and assert cap exits/kills APPEAR; with the fix, none. F5 — D2 promised a collapse the verbs cannot perform: a fifth lesson anchored on Y2TV adds a FOURTH supersedes pointer (deepening the fan-out) and retires none of LN86/2JW2/NSSD/O9EN (lesson footnotes are unreachable by every write verb). The achievable collapse: one new lesson carrying the measured number + a page-description update via memgrep update-mem-topic so the RECALL SURFACE itself points at the truth; the fan-out itself goes to the maintainer proposal already recorded in O9EN. F7 (from the shared review) — line-number citations rot; function names carry the meaning.

## STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-27

CROSS-CARD DEPENDENCY (gate round 4, F3'''): D3 cannot be WRITTEN until TRDD-2JOIAH2G R0b lands (its measure-first forced-breach value = measured idle steady-state footprint + margin, per D3's own text — R0b records idle steady-state on the fixed binary; boot peak is a transient and is NOT the source). D1 (timestamps) and D2 (bounded re-measure) are independent and may start immediately. STEP 0 recording protocol on TRDD-2JOIAH2G: the owner's cap-disambiguation answer goes there verbatim the turn it is given (per plans-in-design-folder), and is never re-asked. TERMINAL DEPENDENCY: the D3 blocker is ultimately the OWNER'S STEP 0 SILENCE (D3 ← 2JOIAH2G R0b ← fixed binary stable ← R1/R2 ← STEP 0 ← owner) — if R0b is pending, chase the answer on 2JOIAH2G, do not re-derive this chain. The 'floor 1.5 GB' figure lives in D3's own text — that is the normative source. RETIRE-CHECK (tracked debt, not a footnote): if D3 ships with the floor as the interim forced-breach value, DX8PYPLO's acceptance holds until it is re-derived from R0b's recorded steady-state — add to the acceptance list: '[ ] forced-breach value re-derived from R0b's recorded steady-state; the floor-as-interim is retired'.
SETTLEMENT 2026-09-27 (gate round 7 verdict): the doc-only review chain on this card is CLOSED — future gate rounds evaluate NEW assertions only; findings-application commits and the STEP 0 answer recording are exempt from re-review. Full review resumes when implementation (code) commits land.
D1 LANDED + ACCEPTANCE SATISFIED 2026-09-27: commits d0ae2a6d (52 sites, 5 files) + ee0ec1be (the crate-wide sweep the full review demanded found 19 MORE sites — ui.rs x7, lib.rs x4, hook_events.rs x4, statusline_store.rs x2, rss_guard.rs fallback x1, log_reader.rs scan-profile x1) — every stdout/stderr diagnostic line in agentlens-core now carries the log_ts() prefix, verified by orchestrator re-sweep and 661/0 tests both commits. Caveats recorded (gate F-2/F-3): server.log lines now BEGIN with the timestamp (line-start-anchored parsers must adjust, substring matches unaffected); timestamps are PRINT-time not event-time (drain-scale measurement unaffected). rss_guard.rs file format stays pinned; only its file-write-failure fallback got the prefix. D1 DONE. SEQUENCE (gate round 15 J-i/J-ii corrected): R0b is HALF-done — its BEFORE-half = R0a's kill-log classification (complete, sibling card); its AFTER-half (boot-peak + idle steady-state on the fixed binary) runs ONLY after R5/R1/R2 land and deploy, and that measurement is also D3's forced-breach source. Next dispatch: R5 first, then R1/R2 (order enforced by 2JOIAH2G's R0a rule: R5 precedes R1), then deploy, then R0b AFTER-half. Full review round on d0ae2a6d verdict KEEP with F-1 (sweep gap, now closed) and F-2/F-3 (documentation, recorded here).
