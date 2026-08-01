---
name: statusline-capture-and-store
description: "how do I get rate_limits without hitting the usage endpoint / why is session_id coming back as hugeint / JSON.stringify throws Do not know how to serialize a BigInt / why did lifecycle-events go empty / can I add a second statusLine / does Claude Code send the 5h 7d windows on stdin / should I pack N samples per row in parquet / how big should a parquet chunk be / get_account_status shows another account's window / was that turn actually a cache miss / how do I verify a claimed cold cache write in one command / is the 1-hour write tier real on this machine / why does the same turn show up twelve times / why is the burn monitor reporting far more cost than was really spent / the statusline burn path over-counts / I raised a feed's sample rate and its deltas broke / Could not convert string to INT128 / failed to cast column session_id from VARCHAR to UUID / one row blinds every view / Could not find key effort in struct / a struct field missing from one parquet file / subagents view binder error / Referenced column not found in FROM clause / an older payload without rate_limits crashes the query / all five views died at once — the statusline sample store, its measured format choices, the cache/peaks query views, the one-event-per-turn billing rule, and the DuckDB traps that shipped bugs"
ocd: 2026-08-01
lmd: 2026-08-01
metadata:
  node_type: memory
  type: project
  tier: component
---

Claude Code hands the status line a JSON payload richer than anything else on this machine exposes
together, and it costs **no API call** — the harness has already computed it for the render.
`agentlenspro --install-statusline` captures it; `agentlenspro statusline-history` queries it.

## `statusLine` is NOT a hook event — capture can only WRAP

`hooks` is a map of event name → an ARRAY of matchers, so any number of tools coexist on one event.
`statusLine` is a **single top-level object with one `command` string**, and settings scopes
**override rather than merge**. There is therefore no way to add a second entry beside an existing
one. The only correct shape is a wrapper that re-runs the original through a shell (exactly as Claude
Code does), inherits its stdout, and returns its exit code — Claude Code **blanks the status line on
a non-zero exit or empty output**, so capture may never influence either.[^1]

`subagentStatusLine` is a **separate key with its own command**, and it is the safer surface: the docs
specify that omitting a task's `id` from the output keeps that row's DEFAULT rendering, so a capture
that prints nothing changes nothing. Its `tasks[]` is the ONLY published source of per-subagent
`tokenCount`, `contextWindowSize`, `effort`, `model` and `cwd` (the last distinguishes a worktree
agent). **The docs list a `name` field on each task; the LIVE payload has no such key** — it carries
`description` (the agent's task) and `label` (its current activity).

**Do not select ANY of these as a struct member.** `t.name` was a hard binder error that killed the
whole query, and the same is true of a field that merely *happens* to be absent from one file —
`effort` comes and goes between parts (trap 4 below). The struct has drifted twice already, so a
fixed shape is a standing bet against a payload we do not control: read every field with
`to_json(t)->>'field'`.

## The payload DOES carry `rate_limits`, at full float precision

MEASURED 2026-08-01: `rate_limits.five_hour.used_percentage` = `57.99999999999999`. The
`/api/oauth/usage` endpoint returns **integers**; this source has **no quantization at all**, so the
±25%-at-pct=2 error that bounds anchor calibration does not apply to it. Each sample is also
attributed **by construction** to the account that session bills to — no `/api/oauth/profile` lookup,
no keychain, no rate limit.

`~/.claude/statusline.py`'s old `write_usage_jsonl` emitted 13 hand-picked fields and **never**
`rate_limits`, which is why `getLatestRateLimits()` returned null and `get_account_status` fell back
to a calibrated guess. That script was replaced 2026-07-31 20:28 and the writer dropped, freezing
`src/statuslineUsage.ts`'s "authoritative" feed for 23 h. **Never depend on a user's personal script
for product data** — the projection now lives in `recordFromStatuslinePayload`.[^4]

## Format choices — all measured on 40k real samples, none assumed

| choice | measurement |
|---|---|
| Parquet+ZSTD vs zstd-19 NDJSON | parquet wins at every realistic chunk (10k rows: 823 vs 933 KB; 40k: 3197 vs 3724 KB) |
| below ~1k rows | parquet LOSES — its ~40-leaf footer metadata dominates ⇒ **chunks must be large** (SEAL_ROWS 10k) |
| ZSTD level 3 → 22 | 116.9× → 121.4× only — the residual cost is **metadata, not codec** |
| **packing N samples per row** | **2% WORSE** (3257 vs 3195 KB) — do NOT do it |
| flat dotted keys vs nested structs | identical size (3194.6 vs 3196.6 KB), far simpler queries ⇒ flatten |
| UUID-typing `prompt_id` | **saves exactly 0 bytes** |
| `ORDER BY session_id` on seal | **1.24× better** — clusters a session's near-identical rows into single runs |

**Why packing is pointless:** DuckDB already collapses an unchanging column across the *whole row
group*, not a 10-sample window. Per-column bytes over 40,000 samples —
`context_window_context_window_size` **71 B total** (0.002 B/sample), `session_id` 434 B,
`model_id` 586 B, vs `context_window_total_input_tokens` 123 KB and `prompt_id` **640 KB (20% of the
file)**. Packing can only take ~0 to ~0 while adding list-repetition overhead to the ~68% of fields
that DO vary. DuckDB picks per column from Constant, RLE, Bit-packing, Frame-of-Reference, Delta,
Dictionary/FSST, and Chimp/Patas/ALP for floats (`PRAGMA storage_info` shows the pick for native
tables; `parquet_metadata()` shows `encodings` for a file).[^2]

**Why UUID typing is pointless:** ZSTD already compresses the 36-char text to 16.0 B/sample, which IS
a UUID's 122-bit entropy. Native 16-byte storage cannot beat the entropy floor either. `prompt_id`
costs 20% of the file because that is what it is worth — and it earns it as the only join key to the
OTEL span store (the docs specify it equals the `prompt.id` span attribute; nothing else indexes it).

Live result: **109×** — 6,310 rows / 13 sessions in 85.3 KB against a 9.08 MB raw equivalent.

## Five DuckDB traps that each SHIPPED a bug (all invisible to tsc)

**Four of the five are ONE root cause: per-file schema inference in a store built from append-only
files.** Each was found by probing the next surface after fixing the last, never by reading the code
— so when a fifth surface turns up, expect it to be the same thing wearing another mask.


1. **UUID auto-detection — and it bites TWICE, at two different layers.**
   *(a) In the RESULT.* `read_json_auto` detects a UUID-*shaped* string as the UUID type and the node
   client returns it as `{hugeint:"-42379450445917529599431978701661611460"}` — not the id, and
   useless. `CAST(session_id AS VARCHAR)` in the SELECT list fixes this half. The test that missed it
   seeded `"sess-0"`, which is never inferred as UUID — seed REAL UUIDs and assert
   `typeof === 'string'` (an object is truthy and sails through a truthiness check).
   *(b) In the READ, where the SELECT-list cast CANNOT reach.* The inference is **per-file**, so one
   part can be UUID and another VARCHAR; the union reconciles them to **UUID**, and multi-file
   `read_parquet([...])` does the same *internally*, taking its schema from the FIRST file. A single
   session whose id is not UUID-shaped then kills the query outright —
   `Could not convert string 'x' to INT128` — and it killed three of five live views. Normalize
   **per FILE** (`* REPLACE` over a zero-row typed template, since `* REPLACE` is a binder error when
   the column is absent) **and** seal `session_id` as VARCHAR so new parts need no repair; pre-fix
   UUID parts sit on disk for the whole retention, so both are required, not either.[^8]
2. **`JSON.stringify` throws on BigInt.** Every BIGINT column (token counts, epoch ms, `count(*)`)
   arrives as a JS `BigInt`: *"Do not know how to serialize a BigInt"*. A table view hides it behind
   `String()`, so `--json` is the only broken path and it fails outright. Convert ≤2^53 to number and
   stringify beyond, never round silently.
3. **Two consecutive `WITH` clauses.** A query spliced in after `WITH samples AS (…)` must not open
   with its own `WITH` — use a subquery.[^3]
4. **A STRUCT field that is absent from one file.** Same per-file inference, one level down: DuckDB
   types the `tasks` struct from the data in each file, so a part where no task reported `effort` has
   **no such key**, and `t.effort` is a hard `Binder Error: Could not find key "effort" in struct`
   that kills the whole view. Measured live: 1 of 6 subagent parts had no `effort` key, another
   carried it on 1 of 413 tasks. Production survived only by accident — file selection is by DAY
   partition, so a sibling part that has the key joins the union; a day whose parts all lack it goes
   down. Extract with **`to_json(t)->>'field'`** (NULL for an absent key), for EVERY field — not just
   the one that broke.[^9]
5. **A top-level column NO file in the window carries.** `union_by_name` fills a column SOME file
   has; one that NO file has does not exist, and referencing it is `Binder Error: Referenced column
   "..." not found in FROM clause`. Measured: ONE sample lacking the optional `rate_limits` and
   `current_usage` blocks — what an older Claude Code build, or any turn predating them, produces —
   killed **all five** main-stream views at once. Absence became a crash, which is neither BLIND nor
   empty and is indistinguishable from a broken query. Union a zero-row TYPED template
   (`GUARANTEED_COLUMNS`) declaring every column the queries may reference. It is a CONTRACT, not a
   schema: other columns still flow through, and a genuinely mistyped name still fails loudly.[^10]

Plus the inherited invariants from `src/store/db.ts`: never a persistent `.duckdb` (300× write
amplification; `memory_limit` does NOT fix it), never a bare glob (an empty glob is an ERROR, not an
empty set), never derive part names from a file count (`COPY TO` silently overwrites).

## Volume, and why samples must NOT share the hook-event bucket

MEASURED: **396 samples/min across 13 sessions** (~30/min each, mean 1509 B) ⇒ ~609/min ≈ **1.29
GB/day raw** at 20 instances. Landing these in `hook-events` was measurably destructive: the 600-slot
`recentHookEvents` ring collapsed to an **~87 second** span (blinding `check_burn_risk`'s 300 s and
600 s windows), and `GET /api/lifecycle-events` + MCP `get_lifecycle_events` — which call
`readHookEvents(limit:1000)` with **no `ev` filter** — had their whole budget eaten, silently
truncating the timeline. They POST to `/api/statusline-samples` now.

Samples also deliberately **do not spool** when the server is down: at this rate they would fill the
shared 20k hook-spool within the hour and evict its OLDEST entries — the lifecycle events (StopFailure,
PreCompact) that exist because nothing else records them.

WALs are named per-pid, so **every server restart strands one**; an orphan seals immediately like a
past-day WAL, or it sits uncompressed until midnight being re-read in full by every query.

## The rate-limit snapshot must be resolved PER ACCOUNT

`src/statuslineUsage.ts` documented the assumption that "every session on the account shares the same
fill". MEASURED 2026-08-01: **13 concurrent sessions reported EIGHT distinct (5h, 7d) pairs** — at
least four accounts live at once. Machine-wide latest-wins therefore returns whichever session sampled
LAST, and `get_account_status` printed it beside the current account's email: it reported
**5h 59% / 7d 51%** when that account was really at **5h 5% / 7d 74%**. Resolve through the cards'
`accountId` (`getRateLimitsForSessions`) and return **null** rather than an unattributed number — the
caller has an estimate to fall back on and no way to know the "authoritative" figure was someone
else's. See [[agentlens-account-window-budget]], [[cache-ttl-model]].


^ATOM-IXQ7-DOMU [desc:"The two query views that answer cost questions from the payload — cache (warm vs cold, cost bracketed by TTL tier) and peaks (delta + its gap) — and the measured agreement that validates the pricing t", keywords: was_that_turn_a_cache_miss verify_a_cache_miss_claim statusline-history_cache_view cache_write_vs_cache_read_per_turn is_the_1h_write_tier_real d_cost_across_an_idle_gap peaks_column_overstates_a_turn, ocd: 2026-08-01, lmd: 2026-08-01] [^5] [^6] [^7] [^8] [^9] [^10] [^11]

## Answering a cost question from the payload: `cache` and `peaks`

`agentlenspro statusline-history cache` is the FALSIFIER for a claimed cache miss.
`context_window.current_usage` splits each turn into fresh input / cache WRITE / cache READ, and the
ratio IS the verdict: a warm turn re-reads its whole prefix at 0.1x and writes only the new suffix
(measured here: write 4.7k against read 617.7k = 0.75%), while a cold rewrite puts the PREFIX in
cache_creation (write 513.1k against read 92.5k = 84.7%). Cost is printed as a 5m/1h BRACKET because
the write rate is tiered by TTL and the payload does not carry the tier — one number would be a guess.

**MEASURED 2026-08-01, and it validates `src/shared/pricing.ts` from outside:** on four turns of one
session the cost computed by `calcTokenCostUsd` from the payload buckets at the **1h** tier —
4.9201 / 5.1814 / 5.2879 / 1.1693 — equals the harness's OWN cumulative `cost.total_cost_usd` delta
to four decimals, while the 5m column (3.0940 / 3.2573 / 3.3239 / 0.7493) does not match any of them.
Two independent paths, exact agreement, and it picks the tier. See [[cache-ttl-model]].

`peaks` shows that cumulative-cost delta directly, and it now carries `gap s` + `span` because the
delta is a per-turn cost ONLY when the samples are adjacent: sampling STOPS while a session is idle,
so a pair bracketing an idle stretch is an INTERVAL total covering every turn inside it.

## Notes and lessons learned

[^1]: [id:ATOM-SL-STATUSLINE-IS-NOT-A-HOOK, status:valid, keywords:"can_i_add_a_second_statusline add_statusline_beside_existing statusline_is_a_hook_event wrap_the_existing_statusline", ocd:2026-08-01, lmd:2026-08-01] DO NOT try to
  register a second `statusLine` entry beside an existing one, BECAUSE it is a single object and
  settings scopes override rather than merge, so one silently replaces the other. DO wrap the
  existing command and pass its stdout and exit code through untouched instead.

[^2]: [id:ATOM-SL-DO-NOT-PACK-ROWS, status:valid, keywords:"pack_rows_for_compression batch_samples_per_row duckdb_compresses_repeated_values_already chunk_of_10_refreshes_per_row", ocd:2026-08-01, lmd:2026-08-01] DO NOT hand-pack N
  samples into one row to collapse repeated values, BECAUSE DuckDB's per-column encoding already
  collapses an unchanging column across the whole row group (71 bytes for 40,000 identical values)
  and packing measured 2% WORSE by adding list overhead to the fields that vary. DO write one row
  per sample and let the engine choose the encoding.

[^3]: [id:ATOM-SL-DUCKDB-TYPE-TRAPS, status:valid, keywords:"session_id_hugeint uuid_object_instead_of_string do_not_know_how_to_serialize_a_bigint duckdb_json_type_inference cast_as_varchar", ocd:2026-08-01, lmd:2026-08-01] DO NOT select a
  UUID-shaped column or a BIGINT out of DuckDB and assume you get a string or a number, BECAUSE
  `read_json_auto` infers UUID (returned as `{hugeint:…}`, and per-FILE so it differs between parts)
  and every BIGINT arrives as a JS BigInt that `JSON.stringify` throws on. DO `CAST(… AS VARCHAR)` at
  every selection site and convert BigInts before serializing — and seed tests with REAL UUIDs, since
  a placeholder like "sess-0" is never inferred as UUID and lets the bug pass.

[^4]: [id:ATOM-SL-NO-PERSONAL-SCRIPT-AS-SOURCE, status:valid, keywords:"statusline_data_frozen authoritative_source_went_stale write_usage_jsonl_missing product_data_from_user_script", ocd:2026-08-01, lmd:2026-08-01] DO NOT source product
  data from a file only a user's personal script writes, BECAUSE `~/.claude/statusline.py` was
  replaced and its writer dropped, freezing this module's "authoritative" feed for 23 h while every
  consumer kept reporting stale numbers with no error. DO own the projection in-product and push data
  in at ingest.
[^5]: [id:ATOM-6DGB-S0MO, status:valid, keywords:"same_turn_appears_twelve_times statusline_re-renders_the_same_usage one_row_per_sample_is_wrong current_usage_is_the_last_turn_not_this_sample output_tokens_grows_while_streaming dedupe_on_the_input_buckets", ocd:2026-08-01, lmd:2026-08-01] DO NOT emit one row per status-line sample when reporting per-turn usage, BECAUSE `current_usage` describes the LAST COMPLETED turn and the status line re-renders every ~3 s whether or not a turn happened — the first live run showed a single compaction rewrite twelve times and nothing else, a table that reads as twelve cold writes. DO group by the turn's INPUT buckets (input + cache_creation + cache_read, fixed the moment the request is sent) and take `max(output_tokens)`: grouping on the full tuple splits one turn back into its streaming snapshots (out=2, then 119, then 170).
[^6]: [id:ATOM-118H-5886, status:valid, keywords:"d_cost_looks_like_a_five_dollar_turn cumulative_cost_delta_over_an_idle_gap per-turn_cost_overstated_15x cost_total_cost_usd_is_cumulative sampling_stops_while_idle", ocd:2026-08-01, lmd:2026-08-01] DO NOT read a delta of `cost.total_cost_usd` as one turn's cost without checking the time gap between the two samples, BECAUSE the field is cumulative and sampling STOPS while a session is idle, so the pair bracketing an idle stretch carries every turn in between — read that way it reported a $0.35 warm turn as a $5 cold write, and the claim was repeated for a dozen turns before the transcript contradicted it. DO show the gap beside the delta and label anything past ~60 s an INTERVAL total.
[^7]: [id:ATOM-UQSH-Y776, status:valid, keywords:"burn_monitor_over-counts statusline_path_inflates_cost_36x one_billing_event_per_sample snapshot_field_treated_as_an_increment guard_covered_cost_but_not_tokens raising_a_sample_rate_broke_a_delta", ocd:2026-08-01, lmd:2026-08-01] DO NOT emit a per-turn billing event per status-line SAMPLE, BECAUSE `current_usage` is a snapshot of the last COMPLETED turn that is republished every ~3 s — measured, 704 turns arrived as 34,498 samples and fed the burn monitor $7,628 for $208 of real spend (36.7x). The cost half of the guard was correct and useless: `deltaCostUsd` IS 0 on a re-render, but the condition was `deltaTokens > 0 || deltaCost > 0` and `deltaTokens` is the raw bucket sum. DO key the turn on its INPUT buckets and UPDATE the open event; and when you raise a feed's sample rate, re-derive every delta computed from it.
[^8]: [id:ATOM-KR07-9K0D, status:valid, keywords:"could_not_convert_string_to_INT128 failed_to_cast_column_session_id_from_VARCHAR_to_UUID one_row_blinds_every_view non_uuid_session_id_breaks_duckdb cast_in_the_select_list_does_not_help read_parquet_takes_the_schema_from_the_first_file", ocd:2026-08-01, lmd:2026-08-01] DO NOT rely on `CAST(session_id AS VARCHAR)` in the SELECT list to survive DuckDB's per-file UUID inference, BECAUSE the coercion happens in the UNION (and inside multi-file `read_parquet`, which takes its schema from the FIRST file) — before any projection — so ONE session with a non-UUID id killed three of five live views with `Could not convert string 'x' to INT128`. DO normalize per FILE (`* REPLACE` over a zero-row typed template, since REPLACE is a binder error on a missing column) AND seal `session_id` as VARCHAR, since pre-fix UUID parts sit on disk for the whole retention.
[^9]: [id:ATOM-KQSZ-XY9Y, status:valid, keywords:"could_not_find_key_in_struct binder_error_on_a_struct_field tasks_struct_missing_effort per_file_struct_inference duckdb_struct_field_comes_and_goes view_dies_on_one_absent_field", ocd:2026-08-01, lmd:2026-08-01] DO NOT select a `tasks[]` field as a struct member (`t.effort`), BECAUSE DuckDB infers the struct type PER FILE, so a part where no task reported that field has NO such key and `t.effort` is a hard `Binder Error: Could not find key "effort" in struct` that kills the WHOLE view — measured live, 1 of 6 subagent parts had no `effort` key and another carried it on 1 of 413 tasks; it survives today only because day-partition file selection pulls in a sibling part that does have it. DO extract with `to_json(t)->>'field'`, which yields NULL for an absent key — this struct has already drifted twice.
[^10]: [id:ATOM-7YR1-KLSM, status:valid, keywords:"referenced_column_not_found_in_FROM_clause union_by_name_does_not_invent_a_column older_payload_without_rate_limits absence_should_be_empty_not_an_error all_five_views_died_at_once optional_block_missing_kills_the_query", ocd:2026-08-01, lmd:2026-08-01] DO NOT assume `union_by_name` makes an optional column safe to reference, BECAUSE it only fills a column SOME file has — a column NO file in the window has does not exist, and referencing it is `Binder Error: Referenced column "..." not found in FROM clause`. Measured: ONE sample lacking the optional `rate_limits` and `current_usage` blocks killed all FIVE main-stream views, turning "no data" into a crash and breaking the store's own BLIND contract. DO union a zero-row TYPED template declaring every column the queries may reference, so absence binds as NULL.
[^11]: [id:ATOM-LQNA-A6I0, status:valid, keywords:"query_returned_BLIND_but_the_data_exists record_missing_from_its_own_day_window partition_day_differs_from_record_ts flush_files_a_batch_by_write_time midnight_boundary_loses_records", ocd:2026-08-01, lmd:2026-08-01] DO NOT assume a record's `ts` and the day-partition holding it agree, BECAUSE `flush()` files a whole batch under the day it is WRITTEN — a batch appended before UTC midnight and flushed after lands in the NEXT day — so a day-granular window skipped that partition and returned **BLIND**, claiming "we cannot see" for data that existed and matched. DO widen PARTITION selection by a day on each side and let the per-row `ts` filter do the real work; the slack and the batch-by-write-time partitioning are a PAIR, and a comment claiming the skew is "harmless" is how it stayed unnoticed.
