---
trdd-id: 9SYRK6SW
title: api_call staging table writer at the bodies-pass ingest site
column: testing
created: 2026-09-03T04:47:31+0200
updated: 2026-09-04T17:50:14+0200
current-owner: main-session
task-type: feature
priority: high
min-approval-requirement: none
parent-trdd: CAJ5RCP9
created-by: main-session
npt: []
eht: []
blocked-by: []
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-03

- **RE-SPEC per Fable advisor verdict (2026-09-03, orchestrator-verified on 80 captured bodies):**
  requests and responses do NOT share a filename stem (`req_<id>.response.json` vs
  `<uuid>.request.json`), so a single `call_id`-keyed row design was wrong. This card now writes
  TWO row kinds, each keyed by its OWN stem — see WHAT below. `cost_usd` is dropped (circular
  crate dependency, see WHY). See parent CAJ5RCP9 STATE for the full verdict text.
- Design source: `reports/trdd-caj5rcp9/20260903_044515+0200-api-calls-table-design.md` §1-2-3
  (superseded on the `call_id`/`cost_usd` points by the advisor verdict above — everything else
  in the design doc still applies).

- **IMPLEMENTED 2026-09-03** (not committed — the main session commits). Report:
  `reports/trdd-9syrk6sw/20260903_061039+0200-writer-implementation.md`.
  Files: `rust-core/crates/agentlens-store/src/api_call.rs` (NEW — row struct + pure extractor +
  9 unit tests), `…/src/lib.rs` (`API_CALLS_DIR`, `CREATE TABLE api_call`, `all_of` arm,
  `open_store` dir, `append_api_call_row`, `flush_detailed` list, `extract_meta` now takes the
  already-parsed `Value`), `…/src/pass.rs` (fsync barrier + import),
  `…/tests/api_call.rs` (NEW — 5 real end-to-end pass tests),
  `…/tests/roundtrip.rs` (part count 3 → 4).
  Gates, all run on the FINAL tree: `cargo test -p agentlens-store` **38 PASS / 0 fail** (cargo's
  own `$?` written to its OWN file, log read whole); `cargo clippy -p agentlens-store
  -p agentlens-core --all-targets -- -D warnings` CLEAN (same, both packages in one invocation);
  `cargo test -p agentlens-core` 102 suites across two independent
  runs with `grep -cE "FAILED|^error|test result: FAILED"` = 0 over the COMPLETE log — note its
  background-task "exit code 0" is the trailing grep's, NOT cargo's, so the log grep is the
  evidence, not that number; `node scripts/check-no-identities.js` OK. All 6 acceptance boxes
  pass ⇒ `testing`. NOT deployed and NOT committed (another agent is deploying from this tree).
- **Bug found on recheck and closed BEFORE it shipped** (latent, would have been silent): the
  advisor's literal three-substring AgentMeta test SELF-MATCHES any injected block that merely
  QUOTES `cc_version=` — a CLAUDE.md, a rule file, a memory page about this mechanism. That block
  would have lost its real hash to the `agentmeta` placeholder (blinding `system_fps` to changes
  in the LARGEST block in the prefix) and had its whole ~65k-token text copied into
  `billing_header` on every request row. `is_agent_meta` now also bounds the block at 4096 bytes
  — the real header measures 195 B across all 39 captures, so the SIZE is the discriminator, and
  nothing is truncated. Measured 0 divergent blocks today, i.e. latent, which is why it would
  have shipped.

- **THREE SCHEMA DEVIATIONS from WHAT below, all from the 2026-09-03 Fable-advisor verdict and
  each verified first-hand against the 39 real captured requests in
  `reports/cache-coldwrite/bodies-20260903_044257+0200/`** — the WHAT section is left as it was
  written so the change is visible; THIS block is authoritative:
  1. `cc_version` + `cc_is_subagent` columns REPLACED by **`billing_header`** — the
     `x-anthropic-billing-header` block stored VERBATIM (~195 B, ZSTD-cheap). Measured: the
     header carries SEVEN keys (`cc_version` 39/39, `cc_entrypoint` 39, `cch` 39, `cc_prev_req`
     39, `cc_prompt_id` 39, `cc_is_subagent` **24**, `cc_workload` **8**) and `cc_workload`
     appears nowhere in `rust-core` — a column set fixed today goes blind on the eighth key.
     DuckDB reads any of them with `regexp_extract(billing_header,'cc_workload=([^;]+)',1)`,
     which IS the 7YPQWKPG principle. `cc_prev_req` keeps its own column because it is a JOIN
     KEY, not a datum. Bonus: `cc_is_subagent` is ABSENT on a main-thread request, not `false` —
     a typed column would have erased that.
  2. `system_fp` → **`system_fps`**, a comma-joined list with ONE ENTRY PER SYSTEM BLOCK IN
     ORDER (same VARCHAR-list shape as `breakpoint_positions`). A scalar can only say "the
     system region changed"; the list says WHICH block diverged. A block classified AgentMeta
     (same three-substring test as `agentlens-core`'s `classify_content_kind`) contributes the
     literal `agentmeta` instead of a hash — it mutates every turn yet sits before every
     breakpoint and is cache-NEUTRAL (TRDD-POLG0613), so hashing it would make the column differ
     on every single turn and answer nothing. Positions stay intact because the placeholder sits
     at the block's own index.
  3. The card's "move `compute_frontmatter_fp` into `agentlens-store`" is NOT done, deliberately:
     that function hashes block IDENTITY (`rule:<file>`/`claudemd`/`system`), so a CLAUDE.md or
     rule-text EDIT — a real byte-level break — leaves it unchanged. The fingerprints here are
     over the block TEXT, which is what the prompt cache keys on. No `regex` dep was added.

- Also per the verdict: the extractor takes `&Value` (an unparseable body gets NO api_call row —
  its `body` row still lands and the bytes stay reconstructible, so the facts are re-derivable),
  the row is appended INSIDE `append_body_row` (the one place a body row is created, so the
  content-dedup path is covered by construction) and BEFORE the body INSERT and the set inserts
  (failing after them would let the sets claim the file, short-circuit the next pass as
  `existed`, and strand the delete gate); the `flush_detailed` early-return guard is NOT changed
  (a stranded row simply flushes with the next batch).

- **Review-gate pass (adversarial fork over the 10 claims).** Three things it hardened:
  (a) the appender writes 26 values POSITIONALLY into 26 columns, and
  `system_fps`/`tools_fp`/`first_user_fp` are three ADJACENT VARCHARs all holding bare 16-hex —
  a transposition there compiles, runs, and passes any `is_some()` check silently and
  permanently. Now pinned two ways in `tests/api_call.rs`: each fp asserted against the hash of
  its own canonical string, and a behavioural test (change only the tools ⇒ only `tools_fp`
  moves; change only the first user message ⇒ only `first_user_fp` moves).
  (b) "parsed exactly once" re-verified AT SOURCE — all four `from_str` sites in the crate read:
  `lib.rs:375` is the one whole-body parse, `lib.rs:319` is the embedded `metadata.user_id`
  string, `pass.rs:85` is the pass STATE FILE, `sections.rs:137` is a single key token in the
  pre-existing sectionizer.
  (c) "purely additive" re-verified against the TS twin: `src/store/db.ts` creates three dirs and
  flushes three tables and `src/store/validate.ts` queries named tables rather than enumerating
  directories, so a fourth dir cannot fail it.
- **ONE REAL ASYMMETRY, deliberately not fixed here** (belongs to whichever card owns the TS
  store's fate): the Rust engine now writes a table its TypeScript twin does not, so if the TS
  pass ever runs over this store, `api_calls` has a HOLE for that period — bodies deleted with no
  per-call row behind them. Silent gap, not an error. Porting the writer to TS would contradict
  "the server is Rust now", so it is recorded rather than patched.

- NEXT ACTION: none in this card beyond the main session committing it and deploying. Then
  CAJ5RCP9's siblings unblock: **GVA8TTJF must read `system_fps`/`billing_header`, not
  `system_fp`/`cc_version`/`cc_is_subagent`.** Day-one watch items from the verdict: any NULL
  `cc_prev_req` on a request row means a CC release moved the header out of `system[0]` and the
  chain key is dead; `max(length(system_fps))` on the first flush shows whether a wide `system[]`
  widens rows (measured today: 3 or 5 blocks).

## WHY

The bodies pass (`chores.rs:208` `bodies_pass`) deletes response/request bodies after ingest for
names not in `skip_names` (`pass.rs:479-488`), over-cap files are deferred (`pass.rs:448-451`),
and GATE-1 failures stay on disk unrowed (`pass.rs:496-499`) — so per-call cache facts (miss
reason, token buckets, tier split) evaporate for the common case. `ingest_body`
(`agentlens-store/src/lib.rs:323`) already parses each body's JSON once via `extract_meta`
(`lib.rs:284-297`) before that delete — reached even on the content-dedup path, which still
appends a body row per new `src_name` (`lib.rs:327-333`, next to `append_body_row` at `lib.rs:330`
and `:359`) — so this is the one place to capture the facts durably, at zero extra I/O (reuse the
already-parsed `serde_json::Value`).

`cost_usd` is dropped from this table: `agentlens-store` cannot call `agentlens-core`'s pricing
module because `agentlens-core` depends on `agentlens-store` (`agentlens-core/Cargo.toml:17`) —
adding the reverse edge would be a cycle. OTEL's own harness-reported cost is preferred anyway
per CLAUDE.md doctrine 2 ("prefer a harness-reported `cost_usd` over recomputing"). The pure
extractor `compute_frontmatter_fp` (`forensics_index.rs:78`) moves into `agentlens-store` since it
has no crate-boundary dependency.

**OPEN QUESTION (not a child):** the ~907k bodies already ingested into the store before this
writer deploys never re-enter `ingest_body`, so this table's history starts at deploy time, not
retroactively. A backfill (one-time scan of any bodies still on disk, if any survive) is out of
scope for this card; raise it separately if a historical backfill is later wanted.

## WHAT

Two ROW KINDS, each keyed by its OWN filename stem (per advisor verdict — requests and responses
are NOT pairable by stem):

- **Request rows** — stem = the request file's own uuid (`<uuid>.request.json`). Columns:
  `stem, session_id, ts_ms, model, cc_version, cc_is_subagent, cc_prev_req,
  previous_message_id, system_fp, tools_fp, first_user_fp, breakpoint_positions,
  tool_choice, thinking_config, raw_bytes`. (`system_fp`/`tools_fp`/`first_user_fp` are the
  fingerprint fields per design doc §2; `breakpoint_positions` is a VARCHAR list, never a STRUCT —
  see TYPES below.)
- **Response rows** — stem = `request_id` (the OTLP-side id, `req_<id>.response.json`). Columns:
  `stem, msg_id, ts_ms, model, stop_reason, input_tokens, output_tokens, cache_read_tokens,
  cache_creation_tokens, tier_5m_tokens, tier_1h_tokens, cache_missed_input_tokens,
  cache_miss_reason, service_tier, raw_bytes`. No `cost_usd` (see WHY).

**TYPES (load-bearing):**
- `session_id` — VARCHAR, sealed the same way `body.session_id` already is (`lib.rs:145`); never
  let DuckDB infer it as a UUID type across parquet parts (per ATOM-KR07-9K0D, cited by GVA8TTJF).
- `ts_ms` — BIGINT milliseconds, matching the statusline store's own `ts` column
  (`statusline_store.rs:156`) so the join in GVA8TTJF needs no epoch-unit conversion.
- `breakpoint_positions` — VARCHAR list (e.g. comma-joined or DuckDB `LIST(VARCHAR)`), never a
  STRUCT — keeps `union_by_name := true` reads stable across schema growth.

Both kinds land in ONE `api_call` staging table (nullable columns for the fields the other kind
doesn't have) — union_by_name at read time (GVA8TTJF) coalesces them per call.

- `call_id`/`stem` = filename stem with the `.request.json`/`.response.json` suffix stripped
  (confirmed shared-suffix stripping only — stems themselves differ per kind, see STATE above).
- Add `extract_api_call_meta(raw, src_name) -> ApiCallRow` next to `extract_meta` (`lib.rs:284`),
  reusing the same parsed JSON value — do not re-parse `raw` a second time.
- Add `append_api_call_row(...)` next to `append_body_row` (`lib.rs:299-315`), called from the
  same site(s) `append_body_row` is called from (`lib.rs:330` and `:359`) so the content-dedup
  path is covered too.
- Wire the extraction call into `ingest_body` (`lib.rs:323`), reached for files not in
  `skip_names` (`pass.rs:479-488`) before the `settle!`/delete gate (`fs::remove_file` at
  `pass.rs:381`/`412`) — same ordering guarantee `body` rows already rely on.
- Add `("api_call", "api_calls")` to `flush_detailed`'s `for (table, sub) in [...]` list
  (`lib.rs:215`) so it flushes to `store/api_calls/part-<ms>-<pid>-<seq>.parquet` on the existing
  cadence.
- **Storage plumbing fixes (both required, both currently missing for a 5th table):**
  `open_store` creates only the three existing dirs (`lib.rs:133`) — add the `api_calls` dir
  there; the fsync barrier walks the same three dirs (`pass.rs:291`) — add `api_calls` there too,
  or the new parts are unprotected by the durability barrier.
- No `spawn_kind`/`account_uuid` column — resolved at read time via join, per design doc §1 last
  row (and per no-identities doctrine: `device_id`/`account_uuid` from `metadata.user_id` must
  NOT be persisted).

## ACCEPTANCE

- [x] `api_call` table exists in the store schema; a new response body ingested during a normal
      bodies-pass tick produces one response-kind row with response-only fields populated and
      NULL request-only fields (no `cost_usd` column at all).
      — `tests/api_call.rs::a_bodies_pass_leaves_one_row_per_kind_and_the_bodies_are_gone`, which
      also asserts the bodies are DELETED afterwards (the whole point of the card).
- [x] A new request body produces one request-kind row with `cc_prev_req`/`previous_message_id`/
      fingerprint fields populated (where present in the source body) and NULL response-only
      fields. — same test; fingerprints are `system_fps`/`tools_fp`/`first_user_fp` (deviation 2).
- [x] `flush_detailed` writes `store/api_calls/*.parquet` parts on the same cadence as `body`/`part`.
      — `tests/api_call.rs::the_rows_flush_to_parquet_and_survive_a_reopen` (reopens the store and
      reads the rows back out of the part with staging empty); `tests/roundtrip.rs` part count 4.
- [x] `open_store` creates the `api_calls` directory and the fsync barrier covers it (verify both
      call sites were touched, not just the schema).
      — `tests/api_call.rs::the_fsync_barrier_covers_the_new_api_calls_directory` asserts the
      pass's own `fsynced` set contains a path under `store/api_calls/` (needs
      `durable_source: true`, which the default PassOptions does NOT set — the server does).
- [x] No change in behavior/output for any existing consumer (`get_cache_event_log`,
      `get_cache_break_timeline`, `investigate_burn`) — this child is additive only.
      — purely additive: one new table, one new dir, one new module; the only edit to an existing
      signature is `extract_meta` taking the already-parsed `Value` (same return, same call site).
      `cargo test -p agentlens-core` green.
- [x] `raw = fs::read_to_string` is parsed as JSON exactly once per file (verify no second
      `serde_json::from_str` call was introduced for the new extraction).
      — `append_body_row` does the ONE `from_str` and hands the same `&Value` to both extractors;
      `extract_api_call_meta` takes a `&Value` and cannot parse. The only other `from_str` in the
      path is `extract_meta`'s pre-existing parse of the EMBEDDED `metadata.user_id` string, a
      different string, unchanged.

## VERIFICATION

1. `cargo build -p agentlens-store` clean.
2. Drop a synthetic request+response pair into the bodies watch dir, let one bodies-pass tick run,
   query `SELECT * FROM api_call` (pre-flush) or the flushed parquet part — confirm both rows.
3. Restart the server, confirm the parquet part under `store/api_calls/` survives and is readable.

**STEP 3 IS UNEVIDENCED ON THIS MACHINE — measured 2026-09-04T17:44, corrected and completed
17:48. All read-only.** The live store holds **497 parquet parts / 5.0 MB** under
`~/.agentlens/store/api_calls/` and is actively growing (495 → 497 in three minutes), so the writer
half is well supported.

**The decisive fact is the mtime.** The earliest part by mtime is **08:56:13**, consistent with the
server's start (`uptime=7h34m` displayed at 16:30 → ~08:56). Stated as an INEQUALITY, which is all
the argument needs and all the measurement supports: **the earliest part is AFTER the process
started, so no part predates it.** An earlier version claimed 08:56:13 *is* the boot time — a
to-the-second equality drawn from a to-the-minute display, which brackets the start to ±30s at
best.
Two weak signals AGREE here and the conclusion rests on the agreement, not on either alone: the
mtime ordering, and every filename's `<pid>` field reading 37180. An earlier version also claimed
the mtime evidence "does not depend on my reading of the filename at all" — true of the raw fact,
FALSE of the argument as built, since that same paragraph uses pid uniformity as corroboration.

**The competing explanation is ruled out.** A first version of this note enumerated two readings
("feature landed after this server started" / "earlier parts were removed") and presented the list
as complete. It was not: a **compaction chore rewriting surviving parts under the current pid**
would produce the same observation and would mean restart-survival WORKS.

**The first rule-out was mis-scoped and is replaced.** It ran `grep -rln 'api_call'` and then looked
for `compact` among those hits — which can only find a compactor that also contains the literal
`api_call`. A generic chore iterating `store/<table>/` would name a directory variable instead, and
that is precisely the shape TRDD-TP3BA3ED documents for the sibling `body`/`part`/`blob` dirs. The
search's scope had silently become the claim's scope: the 99HUNXJS error again. Replaced with the
inverted search:

- `grep -rn 'fn .*compact\|compact_\|\.compact('` over ALL of `rust-core/crates` returns only
  unrelated senses — `delta_log.rs::compact` (compacts an `IndexMap` of records, not parquet),
  and Claude Code's own `compact_boundary` / `compact_file_reference` / PreCompact-hook readers.
  Nothing iterates store directories.
- **`agentlens-store` — the crate that owns the parquet store — contains `compact` ZERO times.**
- No `rename` / `remove_file` path over parquet parts exists in that crate.
- Independently: TRDD-IRNHEN4Z ("api_calls part compaction by count…") is `column: planned`. **This
  is the STRONGER of the two facts** and the first version cited it only as corroboration.

So no rewrite path exists today — and the mtime result below makes the question moot regardless.

**What that leaves, stated precisely:** the store has never been through a restart WITH api_calls
parts present — the parts begin at this server's boot. Step 3 has not failed; it has never had the
opportunity to run. That is still "unevidenced", but for a cleaner reason than first recorded.

**Also corrected:** the first version cited "earliest part 10:33". That came from `ls | tail -3`,
which is DIRECTORY order over 495 files, not time order — the true earliest is 08:56:13. A `tail`
on unsorted output reported as an extreme.

**Settling it costs one restart and one `find`**, and the card should not be advanced before that:
restart the collector, then confirm parts bearing the OLD pid are still present and readable. Not
performed here — restarting the user's live collector is an action on a running system that was not
asked for, and this session has already learned what an unrequested state change costs
(TRDD-BSDR4TRM's `server stop` hitting the wrong process).

**COLUMN NOT CHANGED. The ground is simpler than either version I first recorded.**

Table A's row — *`testing → ai_review`: All `test-requirements:` + `audit-requirements:` PASSED* —
is a description of the situation in which the transition is MECHANICAL: a card that declared those
frontmatter fields and saw them pass. **This card carries neither field** (`## VERIFICATION` is
prose, not a field), so it never enters that situation and falls **OUTSIDE table A's scope**.
`manager-approval-defaults.md` then settles it directly: *"Anything not on the exempt list is
non-exempt."* No appeal to conservatism is needed; the conservative principle is a backstop here,
not the reason.

**Both earlier framings are withdrawn.** The first said the exemption's "precondition is not met"
(wrong object — it keyed on prose, not on the fields the rule names). The second said the condition
was **VACUOUSLY SATISFIED** so *"the rule as literally written would permit the move"* — that is
FALSE, and dangerously so: it imports predicate-logic semantics into a table of worked examples,
under which any card would become auto-exempt by declaring FEWER requirements. No rule is written
to reward declaring less.

All six ACCEPTANCE boxes being ticked is a separate claim: they were ticked against the
implementation, and step 3 is the one that outlives it.

## Approval log

## Notes and lessons learned
