---
name: statusline-capture-and-store
description: "how do I get rate_limits without hitting the usage endpoint / why is session_id coming back as hugeint / JSON.stringify throws Do not know how to serialize a BigInt / why did lifecycle-events go empty / can I add a second statusLine / does Claude Code send the 5h 7d windows on stdin / should I pack N samples per row in parquet / how big should a parquet chunk be / get_account_status shows another account's window — the statusline sample store, its measured format choices, and the DuckDB traps that shipped bugs"
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
`description` (the agent's task) and `label` (its current activity). Selecting `t.name` is a hard
binder error that kills the whole query.

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

## Three DuckDB traps that each SHIPPED a bug (all invisible to tsc)

1. **UUID auto-detection.** `read_json_auto` detects a UUID-*shaped* string as the UUID type, and the
   node client returns it as `{hugeint:"-42379450445917529599431978701661611460"}` — not the id, and
   useless. The inference is **per-file**, so the same column can be UUID in one part and VARCHAR in
   another. **Always `CAST(session_id AS VARCHAR)`.** The test that missed this seeded `"sess-0"`,
   which is never inferred as UUID — seed REAL UUIDs and assert `typeof === 'string'` (an object is
   truthy and sails through a truthiness check).
2. **`JSON.stringify` throws on BigInt.** Every BIGINT column (token counts, epoch ms, `count(*)`)
   arrives as a JS `BigInt`: *"Do not know how to serialize a BigInt"*. A table view hides it behind
   `String()`, so `--json` is the only broken path and it fails outright. Convert ≤2^53 to number and
   stringify beyond, never round silently.
3. **Two consecutive `WITH` clauses.** A query spliced in after `WITH samples AS (…)` must not open
   with its own `WITH` — use a subquery.[^3]

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
