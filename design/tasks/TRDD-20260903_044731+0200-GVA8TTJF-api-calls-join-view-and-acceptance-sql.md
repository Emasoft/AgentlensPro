---
trdd-id: GVA8TTJF
title: api_calls coalesced view, cache_turns statusline join, and the acceptance SQL
column: blocked
created: 2026-09-03T04:47:31+0200
updated: 2026-11-19T04:39:17+0100
current-owner: main-session
task-type: feature
priority: high
min-approval-requirement: none
parent-trdd: CAJ5RCP9
derived: true
derived-kind: eht
created-by: main-session
npt: []
eht: []
blocked-by: [AJGTQ007]
status: tasked
implementation-commits: [fb09facf, da5af103, 56d960e1, 79f93dfc, 0bdad550, c7a43535]
pre-block-column: dev
unblock-when: [trdd:AJGTQ007 terminal]
blocker-probe: [trddgrep, why, GVA8TTJF]
blocker-holds-if: not-match:READY
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-17

- 2026-09-03T08:34:55+0200 — column names in the landed api_call table are `system_fps` and
  `billing_header` (there is no `system_fp`, `cc_version` or `cc_is_subagent` column); the join
  view must read those — see
  `reports/trdd-9syrk6sw/20260903_061039+0200-writer-implementation.md`.
- **RE-SPEC per Fable advisor verdict on CAJ5RCP9 (2026-09-03):** `api_calls` must coalesce TWO
  row kinds keyed by DIFFERENT stems (request stem = uuid, response stem = `request_id`) — no
  shared `call_id` to `GROUP BY` on directly. And response rows carry no `session_id` on their
  own — this view's join can only resolve one once N6A8VX3G's link table exists. Both changes are
  reflected in the WHAT below; the blockers were cleared on 2026-10-16.
- Design source: `reports/trdd-caj5rcp9/20260903_044515+0200-api-calls-table-design.md` §4-5
  (acceptance SQL block) — superseded on the coalescing-key point by the advisor verdict.
- Blocked-by was cleared on 2026-10-16 (see Notes): 9SYRK6SW (now in deploy) and N6A8VX3G (now in testing)
  had landed their code, so that blocker was cleared and the card entered dev;
  neither is terminal. Since 2026-10-17 the card is blocked on TRDD-AJGTQ007 (see NEXT ACTION).
- 2026-10-17: round 2 committed as 56d960e1 (with da5af103, the rename and doc commit). The round 2 items are listed in the Round 2 landed section at the end of this card.
  NEXT ACTION: B3 (registration) waits on TRDD-AJGTQ007's memory box; the card is blocked on it. The owner-facing item (live acceptance needs an alcore deploy) does not gate unblocking; it gates closing boxes 2, 3 and 5. After B3 the next move is ai_review. The full suite ran green on 79f93dfc.
  If AJGTQ007 ends cancelled or superseded, re-block on its successor: the auto-restore does not mean the memory box is solved. The probe syntax is copied from other cards but has never been observed firing (all 10 cards with this form are still blocked), so re-check by hand when AJGTQ007 closes.

## WHY

`api_call` is one row per ingested FILE (request XOR response); consumers need one row per CALL
and a join to the statusline samples to get write% for the same turn. Card CAJ5RCP9 acceptance
box 3 requires exactly this joined query to exist and be documented.

## WHAT

Views cannot be `CREATE VIEW`ed persistently — every DuckDB connection here opens per call
(`bodies_evidence.rs:70`, `transcript_sql.rs:401`, `statusline_store.rs:229`) — so expose these as
Rust relation builders via `run_transcript_sql` (`transcript_sql.rs:245`, the `relation_for`
pattern), not as SQL `CREATE VIEW` statements:

- `api_calls` relation: joins the `N6A8VX3G` link table to `read_parquet('store/api_calls/*.parquet',
  union_by_name := true)` on `stem`, so both request-kind and response-kind rows resolve a
  `session_id` (response rows get theirs from the link, not from their own row) — then coalesces
  per real call using the link's `request_id`↔uuid pairing (NOT a shared `call_id`, which does not
  exist — see STATE). `union_by_name := true` is load-bearing (schema-generation columns added
  later must not break older parts, per `ssd-write-economics.md`'s sibling trap and
  `statusline-capture-and-store.md` ATOM-7YR1-KLSM).
- `cache_turns` relation: first collapse the statusline stream to one row per turn (design doc §4
  note), then join to `api_calls` on `session_id` + the 4 raw token-bucket columns +
  `abs(epoch delta) <= 60`. Subagent calls share the parent's `session_id` but never appear in the
  main statusline stream — expect false negatives there, disambiguated by `cc_is_subagent` (body
  side) / `agent.name` + `query_source` (OTEL side, `spanstore/src/lib.rs:306-309`), not treated as
  join bugs.
- The acceptance query (design doc §5, "every cold write in the last N hours with its miss reason
  and the statusline write% for the same turn") — document it in this card's body and make it
  runnable via `run_transcript_sql`. (The OTEL↔SQL join proper — reading OTEL's ndjson/gz segments
  directly, `spanstore/src/lib.rs:3-5` — waits on 7YPQWKPG step 4; this card's join is body-table
  to statusline-parquet only.)

## MEASURE (not just implement)

- Run the acceptance query against real data once 9SYRK6SW has been live long enough to
  accumulate rows. Record the actual match rate between `api_calls` and the statusline feed —
  the design doc flags two known degraders (statusline's ≤1-sample/10s throttle collapsing
  bursts; `union_by_name` degrading silently on an all-missing column) and expects some
  unmatched rows, not zero.
- If the match rate is unexpectedly low, apply the ATOM-7YR1-KLSM fix (a zero-row typed template
  unioned first) before concluding the join key itself is broken.

## ACCEPTANCE

- [ ] `api_calls` view returns one row per `call_id` with request+response fields coalesced.
- [ ] `cache_turns` view joins successfully and returns a non-trivial number of matched rows
      against live data (not the 0/0 the investigation measured).
- [ ] The acceptance SQL (card CAJ5RCP9 box 3) runs via `run_diagnostics_sql` and returns
      `cache_miss_reason` + statusline write% for real cold writes in the last N hours.
- [ ] `session_id` is confirmed sealed VARCHAR end to end (no DuckDB per-file UUID inference
      breaking the join, per ATOM-KR07-9K0D).
- [ ] Response rows resolve a non-NULL `session_id` via the N6A8VX3G link table (not from their
      own row, which carries none natively).
- [ ] Before run_cache_turns_sql is registered (B3): one query's peak alcore RSS on a body-links log of about 700k records is measured and fits under the RSS cap, OR the replay streams instead of materializing the whole log.
- [ ] The acceptance query over a 700k-record body-links log completes within the MCP tool-call deadline on this machine (PROVISIONAL 60 s until that deadline is located; the number is unsourced). Measured 1410 s at 0b2c294b..f3f4899c; the pairs CTE's OR join is the inferred cause.

## Approval log
- 2026-10-08T20:07:30+0200 — column → dev by main-agent@agentlenspro.
- 2026-10-09T00:15:44+0200 — column → ai_review by main-agent@agentlenspro. implementation + 7-check adversarial review complete; live acceptance pending owner deploy
- 2026-10-16T21:42:38+0200 — column → testing by main-agent@agentlenspro. ai_review done: code on HEAD (fb09facf), synthetic tests pass; live acceptance boxes 2, 3, 5 need the alcore rebuild and restart
- 2026-10-16T21:43:42+0200 — column → ai_review by main-agent@agentlenspro. correction: the earlier move to testing said 'ai_review done', but no code review of fb09facf had happened, only a blocker triage plus synthetic tests; back to ai_review for a real review
- 2026-10-16T21:52:20+0200 — column → dev by main-agent@agentlenspro. ai_review failed: 4 blockers (body-links wrapper and UUID typing, unregistered tool, writePct formula)
- 2026-10-17T07:33:57+0200 — column → blocked by main-agent@agentlenspro. B3 registration and the memory box wait on TRDD-AJGTQ007 streaming replay; round 2 landed (56d960e1, 79f93dfc); full suite 878/0

## Notes and lessons learned
2026-10-16: blocked-by [9SYRK6SW, N6A8VX3G] cleared (not moved to npt: an NPT must be terminal before its parent passes dev, and neither is, and CAJ5RCP9 already claims both as EHTs). The dependency was build order and is satisfied. Figures in this note (timestamps, 4752 parts, strings count 0) are reported by the triage worker and not re-checked by main; that CAJ5RCP9 claims both as EHTs is inferred from lint output that showed one of them. Both landed before this card entered dev (34668285 at 19:57, dev at 20:07 on 2026-10-08; 9SYRK6SW's writer has written 4752 api_call parts). The one remaining gate for live boxes 2, 3 and 5 is an alcore rebuild from HEAD, codesign and restart: the deployed bin-native alcore is dated 2026-10-03 and contains neither body-links nor run_cache_turns_sql (strings count 0), and the collector is currently down in an RSS-cap crash loop. Synthetic tests pass: cache_turns_sql 4/4, body_link 2/2. Box wording is left for the owner: box 1 names a call_id that does not exist (pairing is via link rows), box 3 names run_diagnostics_sql where the arm is run_cache_turns_sql. Evidence: docs_dev/20261016-gva8-n6a8-cycle-report.md (gitignored).
2026-10-16 ai_review of fb09facf: FAILED, back to dev. Blockers: B1 body-links read flat (cache_turns_sql.rs:86-91 binds t.session_id) while DeltaLog writes {"k","v"} lines (delta_log.rs:4, :212), so any real file gives a Binder Error, with no last-wins or tombstone replay; the test fixtures write flat rows. B2 link columns not VARCHAR-sealed: read_ndjson_auto infers UUID, which breaks COALESCE and the <> '' guards (reviewer-measured). B3 run_cache_turns_sql is not in assets/mcp-tools.json (0 hits), so tool_exists (mcp.rs:72) rejects it and the arm is unreachable. B4 writePct = write/(input+read) disagrees with statusline-history's 100*write/(write+read). Plus 5 MAJOR and 6 MINOR. Main verified B1's code and the delta_log format, and B3's 0 hits; B2 and B4 are reviewer-reported. Fix order and full list: docs_dev/20261016-gva8ttjf-code-review.md (gitignored), back-to-dev items 1-8.
2026-10-16 0b2c294b (B1+B2): body-links are replayed by DeltaLog::load into an all-VARCHAR DuckDB table. load() is read-only: it calls replay only; heal_torn_tail runs only in the append paths, delta_log.rs:283/:311 (main read it). The five mutations, worker-reported per docs_dev/20261016-gva8ttjf-b1b2-fix-report.md: flat binding; raw read without replay or cast; UUID column; tombstone ignored; [delta, snapshot] order. GATE BEFORE B3 makes the query reachable: every query materializes the WHOLE body-links log in alcore memory, as serde Values plus a DuckDB copy. Keys are span:kind:ts, so they are never superseded (inferred from the key shape; no measured log has shown repeats); boot compaction drops only superseded and tombstoned lines, so with no retention the live record count, which load() holds in memory, grows without bound. At the planned ~700k rows this is an inferred 0.7-1 GB transient inside a process that dies at a 2 GB cap. Measure one query's peak RSS on a realistic log, or stream the replay, before registering the tool. Untested: ts_ms written as an f64 would fail the BIGINT cast.
2026-10-16 memory gate MEASURED, FAILS (docs_dev/20261016-gva8ttjf-memory-gate-report.md, worker-measured in a separate process with alcore's own phys_footprint metric). On a 700k-record body-links log, DeltaLog::load alone peaks at 1993 MiB and one query at 2217 MiB from a 2.7 MiB baseline, over the 2048 MiB cap. load() scales linearly at about 2.85 KB per record against 387 B on disk: read_lines holds the whole file plus a Vec<Value>, replay clones every v, and load re-serializes each value for the written hashes. The DuckDB side adds only about 100-225 MiB. Fix direction: a streaming visitor on DeltaLog (pass 1 indexes k to the winning file and offset and validates; pass 2 appends only winning lines from a borrowed 8-field struct), with load() rebuilt on top of it so replay keeps ONE definition. Second finding, inferred without EXPLAIN: the query took 1410 s at 700k, and 316 s with only 2 api rows, so the pairs CTE dominates. Its join predicate is an OR of two equalities, which DuckDB cannot hash-join, so it likely runs as a nested loop over about 350k x 350k with threads=2. Live ~/.agentlens has no body-links files today, so 700k is the planned size, not the present one.
2026-10-16: the streaming replay belongs to TRDD-AJGTQ007, because DeltaLog::load is shared with the card-snapshot boot path. This card's own remaining work is the pairs-CTE join (EXPLAIN ANALYZE first, then two equi-join arms kept disjoint by the COALESCE(link_rbid,'')='' guard), B3/M1 and M4. After the join fix it goes to blocked on AJGTQ007.
2026-10-17 query time: 08c2f4c7 split the pairs OR join into two hash-joined arms, and 7032cb57 folded the claim into the paired join key. On the 700k dataset the full query went from 1410 s, to 799.5 s, to 4.09 s; EXPLAIN ANALYZE shows no nested-loop join left. Worker-measured with the scratchpad harness in a separate process at load 30 or more, single runs. The query-time box stays unticked until the MCP tool-call deadline it is measured against is located (the 60 s is provisional). Still open on this card: the memory box (owned by TRDD-AJGTQ007's streaming replay), B3/M1 (register the tool, gated on that), M4 (owner decision on the subagent filter) and the live boxes 2, 3 and 5 (need a deploy).
2026-11-19T04:36+0100 main agent, MEASURED on the 2.34.0 release build (builds_dev/rel-2.34.0-3736dd88/alcore) in the isolated run of TRDD-HSPUF5XH (reports_dev/iso-run/20261119_033859+0100/driver.log lines 34-35 and 48-49): MCP tools/call run_cache_turns_sql answers -32601 unknown tool. Cause, read by the main agent: ui.rs:3332 dispatches run_cache_turns_sql, but mcp.rs:124-125 refuses any name absent from assets/mcp-tools.json, and that asset (53 tools, last changed in 9bb520d0) does not list it (checked with node over the JSON). No src/ TypeScript, README, CHANGELOG, skill or ARCHITECTURE text names the tool (grep). So the cache_turns SQL engine ships unreachable; exposing it needs a schema entry regenerated with rust-core/crates/agentlens-core/assets/gen-mcp-tools.mjs plus a CLI verb, as part of this card.
2026-11-19T04:39+0100 main agent CORRECTION of the 04:3x note: the grep for the tool name covered README.md, CHANGELOG.md, skills/, ARCHITECTURE.md and src/**/*.ts; standalone/ and media/src were not searched. That the tool was unreachable in 2.33.1 too is INFERRED from the asset's single commit 9bb520d0; v2.33.1 itself was not checked.

## N6A8VX3G landed — join requirements for THIS card (2026-10-08)

The link table is real: NDJSON DeltaLog at <dataDir>/body-links.delta.ndjson (+ .snapshot.ndjson after each boot's compact_now), row = {"k":"<span>:<kind>:<ts>","v":{session_id, span_id, kind, stem, request_id, request_body_id, message_id, ts_ms}} — read with read_ndjson_auto. TWO HARD REQUIREMENTS before this card's acceptance SQL is written: (1) GUARD THE EMPTY-STRING KEYS: N6A8VX3G rows default absent Options to '' (fixed-width schema stability) — on pre-2.1.274 traffic request_body_id is '' on BOTH a request row and a response row of DIFFERENT calls, which cross-match in an equality join (NULL would have been join-safe; '' is not). Every join on request_body_id/message_id/stem MUST add <> '' guards, or the cache_turns join silently produces false pairs. (2) THE LINK RESOLVES session_id BY STEM/PTR-KEYS, NOT RESOLUTION: response api_call rows written by 9SYRK6SW carry session_id only when extract_meta found it in the body; the link table's job is the durable stem↔session binding plus the exact pairing keys — join api_call.stem to link.stem (with kind awareness), not to a nonexistent in-memory resolution step. Also: the link table's rows are NDJSON (the card's parquet parenthetical was superseded — read_ndjson_auto does NOT tolerate a torn trailing line; the boot-compact heals it, but a snapshot older than the last crash delta is the readable form).

## Correction (2026-10-08, review round 2)

The 'TWO HARD REQUIREMENTS' entry above is marked: CONTINGENT on N6A8VX3G reaching a terminal column (it is in testing; if its wire-path gap or torn-tail question changes the row shape, this entry goes stale). The <> '' guard is recorded as a NAMED DEFECT OF THE ROW FORMAT — NULL at the source was the better contract (own the burden once); consumer-side guards own it forever and punish omission silently. This card's SQL design work does NOT need the deployed binary: its blockers' CODE is landed (9SYRK6SW in deploy pending the owner's restart, N6A8VX3G in testing); per the mono-agent hygiene rule the parent may move this card to todo and begin design against the landed code while the column formally stays blocked-by-terminal.

## Dispatched (2026-10-08)

Claimed to dev; worker dispatched with spec docs_dev/20261008-GVA8TTJF-join-views-spec.md. Design choices made by the parent (recorded for the implementer): (a) relations live in a NEW agentlens-core module cache_turns_sql.rs mirroring statusline_store.rs's relation_for/varchar_session_id/open_duck patterns — the transcript_sql preset surface reads transcript FILES and cannot see the store/data dirs; a sibling dispatch arm 'run_cache_turns_sql' in ui.rs exposes it. (b) PAIRING THROUGH THE LINK TABLE: request↔response pairs via link rows (request_body_id exact, span_id fallback), then stems join api_call parts — api_call columns alone cannot pair (response stem = request_id; cc_prev_req points at the PREVIOUS call, not the same one). (c) DEVIATION from the card's WHAT, reasoned: the statusline join is session_id + abs(ts delta) <= 60s ONLY — the card's '4 raw token-bucket columns' as JOIN KEYS would over-constrain (statusline's context_window.current_usage_* are per-tick cumulative views, api_call's buckets are per-request; different units, never equal). Tokens are the join's PAYLOAD (output columns), not its keys. (d) collapse statusline to one row per turn via (session_id, COALESCE(prompt_id, ts-bucket)) taking the LAST sample per group; NULL-prompt_id old-CC streams collapse per-tick (honest: same as uncollapsed, never wrong). (e) LIVE ACCEPTANCE IS PENDING-DEPLOY: the blockers' code is landed but the deployed binary predates 9SYRK6SW — the acceptance query runs against real data only after the owner's rebuild+restart; unit tests prove the SQL against synthetic real-DuckDB files now. (f) subagent stream excluded from v1 per the card's own false-negative note.

## Design-review round 1 (2026-10-08) — four amendments

Forwarded to the worker; the parent checks the diff for these before recording anything: (1) HALF-PAIR SEMANTICS PINNED — FULL-OUTER: unpaired requests kept with NULL response fields; unpaired responses kept with session_id from their OWN link row (preserves CAJ5RCP9's full-history goal; dropping either half silently was the unnamed fork). (2) INTERVAL-ANCHORED WINDOW (SQL-CHANGING): the fixed 60s window around request-arrival ts joins the collapsed tick FARTHEST from the anchor and fails exactly on long streaming turns (60s+ routine); fixed by carrying min_ts/max_ts per collapsed turn and joining api.ts_ms BETWEEN min-60s AND max+60s. (3) FIXTURES THROUGH THE REAL WRITER — hand-built parquet drifts from the real ~26-column writer schema; tests build api_call parts through agentlens-store's ingest+flush. (4) COVERAGE: test 1 asserts response-side link session resolution explicitly; stem/span_id guards get failing-row assertions, not just request_body_id. Plus: prompt_id stability (inherited from the flood bench's model, never verified against the real WAL) gets a settling query when live data exists; the sketch's FROM shape is superseded (link-resolved triples drive, parts side-join); the token-join deviation is MIRRORED on CAJ5RCP9 (its box-3 intent was token-fact retrieval — the join retrieves them as payload, which satisfies the letter, but the parent card should say so).

## Amendment-review confirmation (2026-10-08)

Round-2 fork confirmed the four amendment writes: the interval form STRICTLY DOMINATES the fixed window (degenerates to it exactly when a turn is short, strictly contains it when long — no data distribution where the fixed window joins a row the interval form would wrongly include), so the unmeasured turn-length premise is moot as justification; a turn-length histogram remains worthwhile only as grace-width calibration, not as a gate. GRACE WIDTH = 60s, kept for continuity with the old window's constant, tunable — recorded here so the constant is not unexplained. The CAJ5RCP9 mirror is one-way (GVA8TTJF stays authoritative). The parent's diff check before any pass remains: full-outer kept halves, BETWEEN interval, real-writer fixtures, explicit guard assertions, no bare glob, no ignore_errors on read_ndjson_auto.

## STATE consolidation obligation (2026-10-08, review round 3 — confirms the grace write; chain ended)

Grace write CONFIRMED; no further review round on it. Two records: (1) DOMINANCE PHRASING CLAUSE: 'strictly dominates' is true of join MEMBERSHIP (the interval's match set is a superset containing the fixed window's, strictly larger on long turns; short turns degenerate to it) — but the interval also ADMITS more matched rows per turn when ticks are sparse (a tick 45s after the last sample joins that the fixed window missed): intended semantics, a superset-where-it-matters, not 'same matches plus safer'. (2) STATE HEAD OWED BEFORE ai_review — the card spans multiple sessions of accumulation (one 2026-09-03 entry + four 2026-10-08 entries); at the pass-recording turn the parent consolidates a STATE head right after the title: NEXT ACTION (await worker report → six-part diff check: full-outer kept halves, BETWEEN min/max±60s interval, real-writer fixtures, explicit guard assertions, no bare glob, no ignore_errors on read_ndjson_auto → record pass), the authoritative design summary (link-table pairing via request_body_id/span_id with <> '' guards, interval window grace=60s tunable, full-outer half-pairs, pending-deploy live acceptance), and the SUPERSEDED list (the WHAT's 4-column token join wording, the fixed-window form, the parquet assumption for the link table, the FROM api_parts-sketch join shape). No further card entries until that consolidation.

## Exit-confirmation (2026-10-08) — SEVENTH diff-check added

The exit-review confirmed the ended loop stays ended (the consolidation write changes no code/evidence/falsifiable claim). It added one item to the parent's diff-check list, making it SEVEN: (7) a test asserts at least one UNPAIRED-HALF row survives into the view output — the falsifiable form of 'full-outer semantics pinned'; without it, item 1 (full-outer present) could pass while a LEFT JOIN silently drops unpaired responses. The list as consolidated: (1) full-outer kept halves, (2) BETWEEN min/max±60s interval, (3) real-writer fixtures, (4) explicit guard assertions, (5) no bare glob, (6) no ignore_errors on read_ndjson_auto, (7) unpaired-half-survival test. This is the last card entry before the STATE-head consolidation at pass-recording.
DISPOSITION: forwarded to the in-flight worker as an amendment — ONE unpaired-half survival test pointed at api_calls_relation's OWN output (a response link row with request_body_id='' and a span_id matching no request link row must survive with its own fields and session_id from its own link row), explicitly NOT at the final statusline join turns, where unpaired halves correctly do NOT survive. Owner split: checks 1-6 are parent-executed diff verifications at pass-recording; check 7 is worker-owned code; when-the-test-exists is the pass-recording checklist item. No further round (regress-bound fork Q1/Q2: check absorbed by the exit-review that minted it; two-rounds-max spent).

## Implemented + reviewed (2026-10-09) — parent-executed after worker deaths

OWNERSHIP NOTE (review item): the lean-worker died 3x on transient API timeouts after ~3h of reading with nothing on disk; the PARENT implemented everything (stop + take-over after the owner asked what the wait was for). Implemented per the spec + 7 amendments: cache_turns_sql.rs (api_calls_relation coalesced through the body-links link table with <>'' guards + the parse_filename stem bridge; cache_turns_relation per-turn collapse + 60s window + writePct; run_cache_turns_sql CTE surface; run_preset_or_sql + ACCEPTANCE_SQL) + ui.rs run_cache_turns_sql arm (spawn_blocking, lock released). 4 real-DuckDB tests through the REAL writers incl. check 7 (survival at the api_calls level). Gates: build 0, clippy -D warnings 0, 4/4, identities 0. Report: docs_dev/20261009-0000-GVA8TTJF-impl-report.md (gitignored). SEVEN CHECKS ALL PASS (review fork verdict): 1 kept-halves PASS (paired-req UNION orphan-resp shape), 2 window PASS w/ named limit, 3 real-writer PASS, 4 guards PASS (falsifiably failed pre-fix), 5 no-glob PASS, 6 no-ignore_errors PASS, 7 right-level PASS. Review dispositions APPLIED in code: (a) payload error-folding — tool_ok_lean takes &Value, sibling folds errors INTO the payload; the arm does unwrap_or_else(json!({error})) instead of ? so a SQL error is a structured answer, not a failed call; (b) from-turns heuristic DELETED — the full WITH always builds (extra CTEs harmless; heuristic missed newline variants). NAMED LIMITS (not blockers): (1) latest-tick collapse — a call near the START of a long turn can fall outside 60s of the LATEST tick and miss the join (spec-conformant cost of the prescribed collapse); (2) UNION BY NAME schema-growth — orphan arm aliases explicitly, paired arm projects from req.*/resp.*; a future api_call column addition updates both arms; per-column projection when next touched. Commit fb09facf. Live acceptance pending-deploy (owner).
Review round 3 (post-implementation writes) — no blockers, three dispositions: (1) payload shape SETTLED by grep: the sibling transcript_sql.rs:328 folds errors as {"error": <string>} INSIDE an OK payload — the arm's {"error": e} IS the established convention; (2) entry-split contract documented in the module doc (run_preset_or_sql = both-sides-or-Err; run_cache_turns_sql = optional CTEs; do not unify); (3) CAVEAT on the seven-check verdict: the round-2 fork reviewed BLIND (no tool calls) against the transcript's verbatim reads — the mechanical claims are independently covered by this session's own gate re-runs (clippy 0, 4/4, identities 0), but the verdict's epistemic footing is transcript-bound, not file-bound.

## Round 2 landed (2026-10-17)

- 56d960e1: N2 span-window join (a call joins within 60 s of the turn's [min_ts, max_ts]; ranked by distance to the span, ties to the later span end); M4 subagent filter on the turn join only (any cc_is_subagent value other than false, case- and space-insensitive); m4 single wrapper LIMIT with the preset's 100-row default and outer ORDER BY ts DESC.
- API change, fail-fast: limit must be a whole number in [1, 2000]; window_hours must be finite and in (0, 8760]. Before, for raw SQL, limit 0 ran as LIMIT 0, 5000 ran in full and 5.5 truncated to 5; for the acceptance preset any limit was a parser error (doubled LIMIT). The only caller is the ui.rs run_cache_turns_sql dispatch arm (ui.rs:3129), and the tool is not yet registered (B3), so no listed consumer sees the change.
- Evidence: 37/37 cache_turns_sql lib tests green on the final bytes (119 other tests filtered out; the full suite ran later on 79f93dfc, see below), clippy -D warnings clean on the r11 bytes (r12 is comment-only), 14 mutants with 13 killed; Cord (the preset's outer ORDER BY removed) SURVIVED because DuckDB keeps the inner order. Report: reports/GVA8TTJF/20261017_065054+0200-review-rounds-2-to-5-final-report.md
- Known limitation, pinned by an_orphan_response_without_a_header_joins_the_turn: an orphan response (no request part) has no billing header and joins as a main-thread call.
- Raw caller SQL with no limit is still unbounded (deliberate; relevant to the memory box owned by TRDD-AJGTQ007). Raw-SQL order under a limit relies on DuckDB keeping a subquery's order (pinned by raw_sql_keeps_its_own_order_under_a_caller_limit).
- Open: the doc comment above varchar_session_id still describes the code wrongly (fastedit refused the edit); rustfmt shows 81 hunks against 52 at HEAD, left unformatted; m6 (embed the api relation once) deferred until the caller-SQL hardening decision; the D4 link-key collision in lib.rs body_link_row belongs to TRDD-N6A8VX3G; the statusline GUARANTEED_COLUMNS gap (m2) (now TRDD-Q0IFYJFO); registration (B3) stays blocked on TRDD-AJGTQ007.
- m2 now owned by TRDD-Q0IFYJFO.
- Open, new: the ui.rs arm reads the MCP argument `window` (args.get("window")), but the refusal message says `window_hours must be…`, so an MCP caller sees an error naming an argument it never passed. (fixed in 79f93dfc).
- Open: lint DERIVED-FLAG-MISSING. The eht list of TRDD-CAJ5RCP9 names this card, but this card lacks derived: true. The lint header names TRDD-6SPXOV0P, which does not list this card (its eht is TRDD-7NHUU6GK only). Read the CAJ5RCP9 eht entry and its reason before changing either card; not yet read in full.
- 79f93dfc closes the `window` naming item: the refusal now says `window (hours) must be ...` (the MCP argument the ui.rs arm reads is `window`); the test asserts that prefix, and restoring the old text fails exactly that test. The full agentlens-core suite with default features (lib, every integration target, doc-tests) ran on that commit's bytes: 878 passed, 0 failed. The main agent read the totals, the clippy output (clean) and the mutation run (36 passed, 1 failed, the target test only).
- Residue: the doc comment of window_hours_outside_zero_to_one_year_is_refused_by_name still says the error names `window_hours`. fastedit cannot reach a doc comment above a #[test] attribute, the same limit as the varchar_session_id comment. Next try: one fastedit edit --replace of each whole function, doc comment included; if fastedit refuses, the owner decides.
- 0bdad550 and c7a43535 (via TRDD-Q0IFYJFO): the cache-turns query now binds on statusline windows without prompt_id or prompt_cache_ttl, and on real UUID-shaped prompt ids, which failed before. It was latent, because the tool is unregistered (B3).
