---
trdd-id: FSMISF5K
title: Per-session summaries are DuckDB queries over the segments and the resident span window is deleted
column: human_review
created: 2026-09-05T22:06:10+0200
updated: 2026-11-16T22:51:23+0100
current-owner: kraken-worker-fix/fsmisf5k
implementation-commits: [dfeef735, 7d552913, 7d1fbd76]
task-type: refactor
priority: high
min-approval-requirement: none
scope: project
project-id: agentlenspro
parent-trdd: 7YPQWKPG
npt: [XTFDRTH2]
related: [7YPQWKPG, Q9WD3K5R, YILE6N3T, 7RM5YW2T]
relevant-files: [rust-core/crates/agentlens-core/src/span_window.rs, rust-core/crates/agentlens-core/src/ui.rs, rust-core/crates/agentlens-core/src/lib.rs, rust-core/crates/agentlens-spanstore/src/writer.rs]
labels: [rust-core, memory, duckdb]
status: tasked
---

# Per-session summaries are DuckDB queries over the segments and the resident span window is deleted

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-06T09:20:26+0200

Worked by a kraken worker in the worktree branch `fix/fsmisf5k` off `main@c08e0ae1`. Three commits
landed; the worker then STOPPED at the last green phase, as its brief requires, because the next
deletion cannot keep a wire byte-identical. Report:
`reports/fsmisf5k/20260906_044931+0200-summaries-as-sql.md`.

**THE MEASUREMENT THAT CHANGED THIS CARD'S PLAN, ✓ VERIFIED 2026-09-06 07:00 against the live
collector (`GET /api/summary`, read-only, no restart):** the served summary is **23,274 session
cards — 23,273 `dataSource: log` and exactly ONE `dataSource: otel`**, and that one is a codex
session 40 s old, i.e. from the LIVE window, not from the boot replay. So the 528,219-span /
13.2 GB boot replay contributed **zero** served cards, and it never could have: `feed_merge.rs`
serves every claude_code session from its LOG transcript whenever one exists, which on this machine
is always. The replayed OTEL twins were built at a cost of gigabytes and discarded by the merge.

**LANDED.** (1) `dfeef735` — `session_summary_sql.rs`: per-session claude_code aggregates (four
disjoint buckets, LLM/tool/error counts, model, start) as ONE DuckDB query over the segment files,
with the parity proof the card demanded — diffed against `summarize_spans` on the same fixture AND
against the TS oracle, **mutation-verified both ways**. (2) `7d552913` — `SpanWindow::boot_load`
DELETED; a fresh `CoreState` boots with an empty window; the two tests that used `boot_load` were
retargeted (the day/window filter is `load_range`'s, still the `/api/timeline` read path).
(3) `7d1fbd76` — a correctness fix found by re-reading the query, not by a red test: the SQL took
the FIRST model in file order where the card reports the LAST `llm_request`'s model by start time.
Neither parity fixture could see it (one `llm_request` per session, so both rules pick the same
span); the new test is written for the case they cannot express and is mutation-verified. Same
commit makes `start_ms` exact (a real root contributes its OWN start) and restructures the
aggregate per-SLICE-then-roll-up, which is the shape `merge_interaction_slices` has.

**NOT DONE, AND WHY (the STOP).** `SpanWindow` itself cannot be deleted byte-identically: the
summary's `efficiency` block and `backgroundSpans` array are computed FROM the window
(`summarize/summarizer.rs:339-448`), so an empty window turns both into the zero literal on every
summary-derived route, and the one live OTEL card disappears. That is a content change on ~40
`summary_now` consumers, not a refactor.

**DELIBERATELY NOT WIRED: the 5 s refresh tick.** The card asked for one, but the measurement above
says nothing reads the table yet, and a 5 s DuckDB scan of up to two ~500 MB segments to maintain a
table with no reader is CPU this card exists to remove. The module is proven and tested; its first
consumer belongs to the follow-up.

**NEXT ACTION (for whoever picks this up).** (a) Live re-measure boot RSS/footprint + CPU after
`7d552913` deploys — box 3. (b) The 57–65%-of-a-core rebuild is NOT the span half: it is
`summary_from` (`lib.rs:352`) re-parsing all 23,273 CARD JSON strings on every pass, triggered by
`data_version` bumps that a span prune causes. That needs its own card and touches `card_store.rs`.
(c) `configured_ms` is still 24 h, so a long-running server accumulates live spans to the
`max_spans` = 1M cap; lowering it to the 5-minute floor is the remaining span-RAM win and changes
`configuredWindowMs`/`windowMs` on the wire (already 300000 live, via the RSS valve).

Advisor steps 3 and 4 of TRDD-7YPQWKPG, re-issued by the USER 2026-09-05 22:00 ("make DuckDB the
only memory … why things kept in memory and not written down in parquet"). Today every derived
view is `summarize_spans` over `SpanWindow.spans: Vec<Arc<Value>>` — 24 h of spans replayed into
RAM at boot (`boot_load`) plus every live span — and the summary is a Rust-side rebuild of the
whole window (TRDD-7RM5YW2T).
**2026-11-16 (about 22:51) REVIEW IN THE OWNER'S STEAD (owner order 2026-11-16, verbatim: "review in my stead. decide yourself."): NOT ACCEPTED AS COMPLETE; the card stays open.** Two of three boxes are unticked. Box 1: SpanWindow still exists (the card itself says deleting it is not byte-identical). Box 3: boot time and 24 h RSS need the live collector, which the owner has disabled (~/.agentlens/DISABLED), so it cannot be measured now. What IS verified today: dfeef735, 7d552913, 7d1fbd76 are ancestors of HEAD and of main. The card waits on the owner turning the collector back on; nothing else can move it.

## Shape

- Per-session aggregates (tokens, cache buckets, tool counts, durations, model) become SQL over
  `read_ndjson_auto(today + yesterday)` into a `session_summary` table refreshed on the 5 s chores
  tick; timeline / synthetic-root / subagent logic stays Rust but runs PER SESSION ON DEMAND
  (`/api/timeline/:id`), never over the whole window.
- `boot_load` and `window.spans` are deleted. The 5-minute burn window = the writer's flushed
  buffer + a query over today's segment. Sealed segments convert to parquet (Q9WD3K5R's rebuild
  decision governs the schema).
- The only RAM the server keeps for spans is the bytes-bounded ingest buffer between arrival and
  flush (7YPQWKPG principle 4).

## NEXT ACTION

After XTFDRTH2: inventory every consumer of `window.spans` and of the whole-window summary
(`grep -n 'window.spans\|summary_snapshot\|summarize_spans'`), write the `session_summary` SQL and
prove it reproduces the current summary on the parity goldens BEFORE deleting anything, then
delete `boot_load` → `SpanWindow` → the rebuild loop, one phase per file group (≤5 files).

## Acceptance

- [ ] `SpanWindow` and `boot_load` no longer exist; `spans.inMemory` in `/api/server-stats`
      reports only the unflushed buffer.
      **HALF DONE (`7d552913`): `boot_load` is gone and `spans.inMemory` now reports only what has
      arrived since boot. `SpanWindow` REMAINS — deleting it is not byte-identical (see STATE
      §"NOT DONE"): the summary's `efficiency` block and `backgroundSpans` array are computed from
      the window (`summarize/summarizer.rs:339-448`), so an empty window turns both into the zero
      literal on every summary-derived route.**
- [x] Parity goldens for every summary-derived route unchanged.
      `tests/ui.rs` 41, `summarize_parity` 1, `update_payload_parity` 1, `otlp` 4,
      `received_at_stamp` 2, `span_window` 3, `session_summary_sql` 5 — all green, and
      `cargo clippy -p agentlens-core --all-targets -- -D warnings` clean, on `7d1fbd76`.
      Full sweep: **105 binaries, 623 passed, 0 failed** — and 623 reconciles exactly against the
      617 baseline (+5 `session_summary_sql`, +1 `load_range_…`; the two retargeted tests were
      renamed, not added), which is the check that no test was dropped with `boot_load`.
- [ ] Boot time and steady-state RSS recorded; RSS after 24 h under a bound the advisor sets
      (7YPQWKPG acceptance). **Stays for main's live measurement after deploy — this worker does
      not deploy, codesign or restart.**

## Notes and lessons learned

- **A green parity suite can prove nothing about a rule its fixtures cannot express.** Both
  summarize fixtures carry exactly ONE `claude_code.llm_request` per session, so "the FIRST model
  in file order" and "the LAST model by start time" select the same span. The SQL shipped the wrong
  one and every test stayed green; it was found by re-reading the query against
  `build_interaction_card`, not by a failure. Fixed in `7d1fbd76` with a test written for the case
  the fixtures cannot express (two calls, two models), and mutation-verified.
- **`SpanWindow::add`'s second argument IS the arrival clock, and `span_timestamp_ms` PREFERS the
  `receivedAt` it stamps.** A span added with `now` is stamped fresh and can never age out — the
  exact shape of the TRDD-YILE6N3T window freeze. The rewritten `span_window` test reproduced it
  before the comment was added.
- **`alcore` is a BIN TARGET of `agentlens-core`, not a workspace member**, so `cargo … -p alcore`
  fails with *"package ID specification `alcore` did not match any packages"*. Gate it with
  `-p agentlens-core --all-targets`.

## Approval log

- 2026-09-05T22:06:10+0200 — Authored into `todo` as an NPT-gated child of the USER-approved
  7YPQWKPG.
- 2026-10-16T11:16:42+0200 — column → human_review by main-agent@agentlenspro. needs a live re-measure on a deployed collector; a deploy needs the owner (row 20)
