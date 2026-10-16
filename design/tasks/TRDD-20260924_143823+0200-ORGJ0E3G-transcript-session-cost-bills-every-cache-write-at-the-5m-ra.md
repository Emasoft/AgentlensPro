---
trdd-id: ORGJ0E3G
title: Transcript session cost bills every cache write at the 5m rate
column: blocked
created: 2026-09-24T14:38:23+0200
updated: 2026-10-16T11:13:33+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: bugfix
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-24T14:38:23+0200
implementation-commits: [513623fe, 80958154, 86f4fa22, 63f41d04]
blocked-by: [TWDGR75R]
status: tasked
pre-block-column: dev
---

# Transcript session cost bills every cache write at the 5m rate

## Approval log

- 2026-09-24T14:38:23+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-16T11:13:33+0200 — column → blocked by main-agent@agentlenspro. deploy waits on TWDGR75R establishing the OOM cause; triage row 16

## Evidence

Report: reports/cc-alignment/20260924_142509+0200-acceptance-7ab3ebfc.md — a 1h-tagged main-conversation transcript's server-reported cost_usd ($29.2513, n=230) undercounts the tier-aware recompute ($32.4828) by ~10%, because session_cost / speedBlendedCostUsd hand calc_token_cost_usd a hardcoded 0.0 for the 1h cache-write argument while the accumulator (agentlens-logscan lib.rs Buckets) never even extracts usage.cache_creation.ephemeral_1h_input_tokens. Distinct from TRDD-K4XQ7M2B, which is the same defect shape in the PER-CALL forensics api_calls row (forensicsIndex.ts / forensics_scan.rs), not the session CARD.

## File-line list

rust-core/crates/agentlens-logscan/src/lib.rs: Buckets/disjoint_anthropic (~132-149) now extracts cache_create_1h from usage.cache_creation.ephemeral_1h_input_tokens; ClaudeAccum.total_cache_create_1h + SubAgentRec.cache_create_1h + BlendTurn.cache_create_1h accumulate it; Card.cache_create_1h_tokens persists it. copilot.rs/codex.rs/opencode.rs Card literals set it to 0.0 (no Anthropic tier split). rust-core/crates/agentlens-core/src/mcp_tools.rs:699-712 session_cost reads cacheCreate1hTokens instead of a hardcoded 0.0. rust-core/crates/agentlens-core/src/log_reader.rs:93 speedBlendedCostUsd passes t.cache_create_1h. src/shared/summarizerTypes.ts SessionSummaryCard gained cacheCreate1hTokens?: number. src/mcpServer.ts sessionCost (dead TS server, survives only as the gen-sessionreports/gen-mcptools parity oracle) reads it too, for TS/Rust agreement if that path is ever re-activated.

## Acceptance

The card cost for a 1h-tagged transcript equals the tier-aware recompute to the cent — pinned by rust-core/crates/agentlens-core/tests/ui.rs::get_session_detail_bills_the_1h_cache_write_tier (fails on 0.0-hardcoded old code, passes after; asserts cost_usd equals a direct calc_token_cost_usd call with the real 1h split). disjoint_anthropic covered for all-1h, mixed-5m/1h, and flat-total-no-split-object shapes in rust-core/crates/agentlens-logscan/src/lib.rs tests::disjoint_anthropic_*. Old DurableState snapshots with no cacheCreate1hTokens field read as 0 (mcp_tools.rs::f() default) — same behavior as before this fix, never a crash.

## Persisted-row decision

UPDATED 2026-09-24 (revised, same day): the LOG_INGEST_VERSION 7→8 whole-corpus bump above was RETRACTED after a review found it unsafe — DurableState::restore() treats a stale version as "restore nothing", and the cold rescan that follows only rebuilds cards from transcripts STILL ON DISK, so any session whose transcript Claude Code's own cleanupPeriodDays had already deleted, or whose Codex/Copilot/OpenCode source had rotated, would have vanished from the dashboard permanently — an unbounded history loss to backfill one bounded field. Measured on the live ~/.agentlens corpus (read-only, log-sessions.snapshot+delta.ndjson merged): 34,657 total cards, 10,594 of them top-level (no parentSessionId), and 2,048 of those top-level cards' session ids match no transcript file discoverable on this machine today — i.e. a 7→8 bump would have discarded roughly 1 in 5 top-level sessions' history outright. LOG_INGEST_VERSION now stays 7 (both twins: rust-core/crates/agentlens-core/src/log_reader.rs, src/collectorState.ts). Instead DurableState::restore() (log_reader.rs) keeps every card unconditionally, and for a Claude card that is missing cacheCreate1hTokens, has cacheCreateTokens > 0, and whose source file DOES still exist (discover_all + session_id_for_file, resolved once per restore, not per card), drops only that one file's saved read offset before tailer.import_file_state — forcing exactly one full re-parse of that file on the next sweep, which rebuilds just that card. A card whose file is gone is left exactly as restored (cacheCreate1hTokens absent, same as pre-fix behavior, never a crash); a card that already carries the field is never touched. Covered by three new tests replacing the old whole-corpus-rescan test in rust-core/crates/agentlens-core/tests/log_reader_parity.rs: restore_reparses_once_a_stale_card_whose_file_still_exists, restore_keeps_a_stale_card_untouched_when_its_file_is_gone, restore_does_not_reparse_a_card_that_already_has_the_field (all fail against the pre-fix reparse logic, pass after; log_ingest_version_is_in_lockstep_with_the_ts_constant now pins 7). The parity fixture (tests/fixtures/logs-home + gen-log-reader-expected.mjs) previously exercised cacheCreate1hTokens nowhere — every one of its 14 generated cards read 0 — so it proved nothing about the field or its message.id dedup; the msg_1 rows of the Claude fixture transcript now carry a real cache_creation 5m/1h split (50/150, repeated verbatim on both content-block rows of msg_1), and log-reader-expected.json was regenerated (parent card cccccccc-...: cacheCreate1hTokens=150, deduplicated not doubled). Isolated-instance re-parse measurement (DATA_DIR/HOME per CLAUDE.md's single-instance recipe, ports offset, real ~/.claude/.codex/.copilot read-only via symlinks, live delta-log copies as the pre-fix corpus): see reports/cc-alignment/ for the timing/RSS numbers. CHANGELOG.md [Unreleased] updated to match. Other calc_token_cost_usd call sites still passing a hardcoded 0.0 (mcp_tools.rs:165, heartbeat_cost.rs:124, forensics_db.rs:272, context_composition_index.rs:285, cache_break_timeline.rs:2543, cache_creation_forensics.rs:328/444) remain unaudited — each is a candidate for the same bug (review-fork finding, 2026-09-24) and stays out of this bounded fix's scope.
REVIEW (2026-09-24, adversarial fork): fixed discover_all gated only on restored>0 (permanent per-boot disk walk) by adding a cheap in-memory any_candidates pre-scan before the walk; added an eprintln logging the dropped-offset count (previously invisible inside a lower imported figure). Acknowledged not fixed: a genuinely separate-file subagent transcript whose own sessionId differs from its file's session_id_for_file key is never resolvable via claude_paths and so could never be independently flagged — narrow gap, follow-up. Verdict false alarms ruled out: no infinite reparse loop (cache_create_1h_tokens is non-optional, so a rebuilt card always carries the key); cacheCreateTokens>0 gate cannot skip real 1h data (cache_create_1h_tokens <= cache_create_tokens invariant). Full detail: reports/cc-alignment/20260924_153940+0200-targeted-reparse.md.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-24

HEAD is NOT deployable since 513623fe (513623fe alone was never measured; 80958154 is the build that crashed): an isolated full-size run of the re-parse build crashed after boot (card-store OOM, see TRDD-TWDGR75R). Deploy only after that card establishes whether the re-parse causes it. A plain `agentlenspro server restart` is safe: it reuses the prebuilt bin-native binary.
Sessions last modified more than 30 days before the upgrade keep the 5m-rate cache-write cost (REPARSE_MAX_AGE); cross-session totals mix tier-aware and 5m-rate cards (~10% measured on one session).
2026-09-24: the re-parse approach (513623fe, 80958154) is not deployable in its current form because it causes the TRDD-TWDGR75R card-store OOM (see that card's VERDICT: put() replaces rows, but a reparsed card's larger JSON doubled cards.duckdb and blew the 256 MiB buffer-pool ceiling on the first cards_json() call). The likely right design is a usage-only pass that reads just usage.cache_creation.ephemeral_1h_input_tokens per message id from each flagged transcript and patches cacheCreate1hTokens into the restored card, instead of rebuilding the full card.
2026-09-24: usage-only backfill (86f4fa22) replaces the full-card re-parse; hardening (63f41d04) made it a chunk per sweep with a save per chunk. CORRECTED persistence evidence: Run P (86f4fa22) was killed AFTER logging "filled 8761 of 8761" (i.e. after the backfill had already COMPLETED), and Run C (restarted on Run P's data) flagged 0 transcripts — that proves a COMPLETED backfill's patched values persist and are restored, NOT that a hard exit mid-backfill loses at most one chunk. The mid-backfill-loses-at-most-one-chunk claim belongs to 63f41d04 and is still unverified — a real kill-mid-chunk test is in progress. Open: scoped per-chunk save (worker running), deploy gate needs a full-size memory run of the final build.
Q6 (2026-09-24): restore() walks every transcript under the state lock on every boot until all flagged cards are filled — this is the mechanism the backfill rides on, and it is why restore() holding the lock is coupled to the backfill's own progress.
Open 63f41d04 review items (2026-09-24), being fixed in worktree /tmp/wt-bfs: loop order runs a backfill chunk before handling waiting changes; next_full re-arm is unverified; the backstop can be skipped under a steady event stream; Stop latency during a chunk is unmeasured. None of these are resolved yet.
2026-09-25T15:10:00+0200: The wt-bfs worktree hardening (scoped per-chunk save via save_cards_for/append_changed; backfill chunk yields to queued events; FULL_RESCAN backstop check moved out of the Timeout arm so a steady stream cannot starve it; hard-exit test now uses mem::forget; no-full-scan counter test) is VERIFIED: cargo test -p agentlens-core 660 passed / 0 failed, all four review items covered by new tests (backstop re-arm, no-whole-store-scan, hard-exit durability, event priority). Isolated full-size run of 8c74c5c0 (reports/deploy/20260925_150640+0200-iso-run-8c74c5c0.md) PASSED the memory/drain gates but the backfill itself never armed there (fresh offsets — the instance restored from the same snapshot it then ran with), so full-size backfill behavior remains unit-tested-only, bounded ≤200 files/chunk by construction. NEXT: commit the wt-bfs worktree hardening onto main, then the deploy (build+codesign+restart) carries both. 

## Corrections (2026-09-24)

Corrections to the 86f4fa22 commit message: 'the same dedup a full parse uses' was unproven at commit time (later verified by an equivalence test in 63f41d04); 'not this change' overstated - the backfill's own work shortens time-to-cap 182s -> 77s; 'exactly as persisted' rests on one card's JSON.
Corrections to the 63f41d04 commit message: its hard-exit test ran in-process (Drop may flush) - a real-kill test is in progress; 'forever' was inferred.
Scope notes: unreadable transcripts stored as a known 0; cards older than 30 days are not backfilled.
