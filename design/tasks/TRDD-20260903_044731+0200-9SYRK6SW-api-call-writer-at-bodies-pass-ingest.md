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

**STEP 3 HAS NEVER HAD THE OPPORTUNITY TO RUN — measured 2026-09-04, read-only.** The live store
holds **497 parquet parts** (~5.0 MB, measured when the count was 495) under
`~/.agentlens/store/api_calls/`, actively growing
(495 → 497 in three minutes), so the WRITER half is well supported. But the earliest part by mtime
is 08:56:13, after the running server started (`uptime=7h34m` at 16:30), and every filename's
`<pid>` field reads 37180 — the live pid. **No part predates the process**, so the store has never
been through a restart with `api_calls` parts present. Step 3 has not failed; there has been
nothing for it to test.

**Basis for "nothing rewrote the older parts", stated with its real warrant:** TRDD-IRNHEN4Z — the
card that would implement `api_calls` part compaction — is `column: planned`, i.e. unbuilt. Code
searches for a compactor were run and are NOT the warrant: they were scoped to one crate's flat
`src/*.rs` glob and to the literal word `compact`, so a nested module, a merger named
`merge`/`consolidate`/`gc`, or the TypeScript store writer (`src/store/*.ts`, per TRDD-TP3BA3ED)
would all be invisible to them. Do not cite those searches as a rule-out.

**TO SETTLE IT — snapshot, restart, compare THE SAME FILES:**

```bash
D=~/.agentlens/store/api_calls
rm -f /tmp/parts-before.txt /tmp/parts-after.txt /tmp/p.raw
# find's OWN exit status is captured (a pipeline would discard it), and no `exit` —
# this block is meant to be PASTED, and `exit` closes an interactive shell.
find "$D" -name '*.parquet' > /tmp/p.raw && sort /tmp/p.raw > /tmp/parts-before.txt \
  || { rm -f /tmp/parts-before.txt; echo "BEFORE snapshot FAILED (find or sort) — do NOT restart"; }
agentlenspro server restart
find "$D" -name '*.parquet' > /tmp/p.raw && sort /tmp/p.raw > /tmp/parts-after.txt \
  || { rm -f /tmp/parts-after.txt; echo "AFTER snapshot FAILED (find or sort) — NOT data loss"; }
[ -s /tmp/parts-before.txt ] && [ -s /tmp/parts-after.txt ] \
  && comm -23 /tmp/parts-before.txt /tmp/parts-after.txt \
  || echo "a snapshot is missing (see above) — comparison SKIPPED, not passed"
# then (b), the readability half — the node block below
```

**(b), verified working against the live store 2026-09-04T17:5x — run from the repo root:**

```bash
node -e '
const { DuckDBInstance } = require("@duckdb/node-api"); const fs = require("fs");
(async () => {
  const files = fs.readFileSync("/tmp/parts-before.txt","utf8").split("\n").filter(Boolean);
  const con = await (await DuckDBInstance.create(":memory:")).connect();
  let bad = 0, rows = 0;
  for (const f of files) {
    try { const r = await con.runAndReadAll(`SELECT * FROM read_parquet('"'"'${f}'"'"')`);
          rows += r.getRowObjects().length; }
    catch (e) { bad++; console.log("UNREADABLE", f); }
  }
  console.log(`checked ${files.length} parts, unreadable=${bad}, rows=${rows}`);
})();'
```

**BASELINE, measured pre-restart:** `checked 509 parts, unreadable=0, rows=10444`
— all 26 columns read per part. After the restart, the same command over the same
`/tmp/parts-before.txt` must still report **unreadable=0**.
(An intermediate version of this recipe also reported `sum(raw_bytes)` = 5,630,947,899; the
current command does not compute it, so it is recorded here as a one-off measurement rather than
left in the baseline line describing output the command no longer produces.)

**Why `SELECT *` with the rows CONSUMED, and not a narrower query — two earlier versions were both
narrower than their own claim:**
- `count(*)` is answered from the **footer's row-group metadata; it opens no data pages at all.** A
  part whose footer survived while its pages were truncated mid-flush — precisely what a restart can
  cause — returns its row count happily. It was the one query least able to see the damage it was
  added to catch.
- `sum(raw_bytes), max(length(stem))` opened only **2 of the table's 26 columns**. Parquet stores
  each column's pages independently, so a part corrupt only in `billing_header` still passed clean.
  Same defect one rung less severe.
- `SELECT *` with `getRowObjects()` forces **every** column's pages open and is shorter than either.
  (`runAndReadAll` materialises the result rather than returning a lazy handle, so nothing defers.
  It establishes the pages DECOMPRESS, not that the values are semantically right — which is the
  correct bar for a criterion whose word is "readable".)

**THE ACTUAL LESSON — the trajectory above had one cause, and it was not the reviews.** Existence →
`count(*)` → 2 columns → 26 columns is four checks, each closing exactly the hole the last review
named. The question that would have produced `SELECT *` on the first attempt — **"what does
*readable* mean here?"** — was answerable in one pass from the criterion's own three words, before
any check was written. **Define the property before instrumenting it.** "Respond to reviews less
literally" is the symptom and is not actionable; the omitted definition is the cause and is.

The loop is per-file, so one bad part is attributed to itself rather than depending on whether
DuckDB aborts a whole multi-file scan.

**BOTH halves are required — step 3 says "survives AND is readable".** (a) empty output ⇒ every
pre-restart part still exists; (b) unreadable=0 ⇒ those same parts still parse. A part that
persists TRUNCATED OR CORRUPT passes (a) and fails the criterion, so filename identity is a proxy
for content survival, not a substitute.

**Two fixes to earlier versions of this recipe, both mine:**
- It invoked **`agentlenspro sql`, WHICH DOES NOT EXIST.** `agentlenspro list --desc` has no `sql`
  verb — the real ones are `run_diagnostics_sql` (the forensics fact DB) and `run_transcript_sql`
  (over `.jsonl` transcripts); neither reads store parquet. I hedged the invented command instead
  of checking it, in a recipe written to be pasted. There is also no `duckdb` CLI on this machine;
  `@duckdb/node-api` is a declared runtime dep and loads, which is why (b) is written in node.
- It globbed `$D/*.parquet`, which reads the parts the NEW server wrote too — so a healthy new part
  could carry the query while an old one was corrupt. (b) iterates the pre-restart list
  file-by-file, so each surviving part is judged on its own.

**One false-FAILURE to rule out before believing (a). The class is ANY CONCURRENT MUTATION of `$D`
between the two snapshots** — a bodies-pass flush landing mid-window, a manual deletion, anything
that changes the directory for reasons unrelated to the restart. Each snapshot is faithful to the
moment it was taken; `comm -23` cannot tell "lost to the restart" from "changed underneath us".
Retention is the instance worth naming because it is machinery that fires on its own schedule, but
it is an instance, not the class:
(`retention_config.rs`, `summarize/retention.rs`, `AGENTLENS_STATUSLINE_RETENTION_DAYS`); whether
any of it targets `store/api_calls/` is UNESTABLISHED. If (a) lists parts, confirm they were lost
to the RESTART and not deleted on a retention schedule that happened to fire in the same window —
the window is short, so a collision is unlikely, not excluded.

**A pid-diversity check does NOT work here, and the earlier version of this recipe was wrong.** It
said "more than one distinct pid ⇒ parts survived". Immediately after a restart the old parts are
present (old pid) and the NEW server has flushed nothing yet — parts flush on a cadence — so
`sort -u` returns ONE pid and that criterion reads a perfectly healthy, surviving store as
"did not survive". It fires on flush TIMING, not on the property being tested. Survival is a claim
about specific FILES persisting; pid-diversity is an inference about who wrote them, and it imports
a dependency the question never had.

Not performed here:
restarting the live collector is an unrequested state change on a running system (TRDD-BSDR4TRM is
the precedent for what those cost).

**COLUMN NOT CHANGED.** Table A's `testing → ai_review` row describes a card whose
`test-requirements:`/`audit-requirements:` FRONTMATTER fields passed. This card carries neither
(`## VERIFICATION` is prose, not a field), so it never enters that row's situation and
`manager-approval-defaults.md`'s default governs: *"Anything not on the exempt list is
non-exempt."* Six ticked ACCEPTANCE boxes is a separate claim — they were ticked against the
implementation, and step 3 is the one that outlives it.

*(The record of four self-corrections that produced this section lives in the commit history —
`b69cb30d`, `7ce2f279`, `c9ac8efe` and this one — not on the card.)*

## Approval log

## Notes and lessons learned
