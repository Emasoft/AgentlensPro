---
name: ctxmap-exact-measurement-cost
description: "ctxmap/ctxvis exact token measurement is slow / should I rewrite it in rust or duckdb to speed it up / why does a context map take a minute / can I cache count_tokens results without the number going stale / --estimate is fast but is it accurate"
ocd: 2026-08-01
lmd: 2026-08-01
metadata:
  node_type: memory
  type: project
  tier: component
publish-globally: false
---

# ctxmap-exact-measurement-cost

See also: [[cache-risk-command-detection]] — this page is the tool that MEASURES what is in the
prefix and what measuring it exactly costs; that one classifies WHY a prefix broke.


^ATOM-E9OC-9NY0 [desc:"Exact ctxmap measurement is NETWORK-bound, not CPU-bound — so a rust/duckdb rewrite optimises a layer that costs 0.15% of the run.", keywords: ctxmap_slow rewrite_in_rust use_duckdb_to_speed_up exact_token_measurement_takes_a_minute count_tokens_is_slow network_bound_not_cpu_bound, ocd: 2026-08-01, lmd: 2026-08-01]

`ctxmap <request>` measured exact is slow because it makes one `count_tokens` HTTPS call per
cumulative prefix, not because tokenizing is expensive. Profiled on one 252,562-token capture with
201 elements: `--list` 0.07s; `--estimate` (the LOCAL tokenizer, all 201 elements) **0.09s**;
`--find` over the whole spool 6.60s; the exact path **57.69s wall but only 1.22s CPU**. 98% of the
slow path is idle waiting on the network.

So the levers are SEND LESS and ASK AGAIN LESS, never "tokenize faster". A native-code tokenizer
would attack the 0.09s. The two that worked: drop the prefix preamble that cancels (see the
cancellation atom) and cache counts content-addressed (see the cache atom).

`--estimate` is the local estimator and reads **~29% LOW** on this content (161,685 vs 226,910
measured; 2.56 chars/token). It is a speed escape hatch, never a token count to quote. [^2]


^ATOM-KJHX-SRO9 [desc:"Per-element cost is a DIFFERENCE within a tier, so any term identical across that tier cancels — uploading it is pure waste (45% of all bytes sent).", keywords: prefix_preamble_cancels redundant_upload_in_differencing why_is_ctxmap_uploading_megabytes cumulative_prefix_differencing residual_must_be_zero, ocd: 2026-08-01, lmd: 2026-08-01]

Each element's cost is `count(prefix ending after it) − count(prefix ending before it)`, and those
differences are only ever taken WITHIN one tier. Anything identical across every call of a tier
therefore cancels exactly and contributes nothing to any reported number — so shipping it is pure
upload waste. Tool-tier prefixes were carrying the whole `system`; message-tier prefixes were
carrying `system` AND `tools`.

Measured on one capture (`system` 3,986 + `tools` 96,408 = a 100,394-token preamble): 22.21M tokens
uploaded, of which **9.94M (45%) was the cancelling preamble**. Dropping it leaves every per-element
number byte-identical.

What makes this safe is not the argument, it is the check: Σ(per-element diffs) must equal the ONE
full-request count taken separately, which is exactly `coverage.residual`. A non-zero residual means
the cancellation assumption broke, and the run falls back to the preamble-carrying scheme rather
than reporting a number it cannot justify. The whole-request count must stay the real untruncated
body for that check to mean anything. [^1]


^ATOM-BIP0-B938 [desc:"The count cache keys on the exact wire bytes, so any change to how the request is built produces a MISS, never a stale wrong number; freshness is proven per run, not guessed with a TTL.", keywords: cache_count_tokens_results stale_cached_token_count is_a_cached_measurement_still_exact content_addressed_cache_key freshness_sentinel_instead_of_ttl, ocd: 2026-08-01, lmd: 2026-08-01]

This tool's whole value is "measured, not estimated", so a stale hit returning a wrong number is
worse than being slow. Two design choices carry that:

**Key = sha256 of the exact wire string already built for the request** (`JSON.stringify` of the
cache-control-stripped body), not a new canonical-JSON scheme. That reduces "is this hit equal to
what the API would answer" to "identical bytes were sent" — and it means ANY later edit to how the
prefix or the countable body is built changes the key, producing a miss rather than a wrong number.

**A per-run freshness sentinel, not a guessed TTL.** On any run that gets hits, re-count the single
largest cached entry live and compare. Match ⇒ trust the rest; mismatch ⇒ drop that model's entries,
warn, re-measure. One call buys a MEASURED freshness guarantee, which is the only kind consistent
with the tool's claim. Storage is append-only NDJSON (never a persistent DuckDB file — that is a
measured 300x write amplification here), with a format+API version stamped per row.

Result: warm ctxmap 152.11s -> ~1.5s (75-100x), cold 152.11 -> 131.29s, `--find` 6.60 -> 2.94s, all
reported numbers byte-identical and `unattributed` still 0.

## Notes and lessons learned

[^1]: [id:ATOM-A4E0-AE72, status:valid, desc:"The residual fallback keyed on a value that is only computed when nothing failed — so the lean path's own failures switched the guard off.", keywords:"guard_disabled_itself fallback_never_fires fast_path_skipped_the_safety_check residual_only_computed_on_success optimisation_bypassed_its_own_gate", ocd:2026-08-01, lmd:2026-08-01] DO NOT gate an optimisation's fallback on a health signal that is only COMPUTED when the run succeeded, BECAUSE the optimisation's own failures then suppress the signal and the guard silently disables itself exactly when it was needed — here the lean prefix fell back only on `residual !== 0`, but residual is computed only when `failed === 0`, and a lean prefix can CAUSE failures. DO make the guard fire on `failed > 0 || residual !== 0`, i.e. on every state that is not provably clean.
[^2]: [id:ATOM-2W09-XZB7, status:valid, desc:"The --find prefilter tested raw file bytes, so any gzipped capture could never match — and the 'zero false negatives' check only sampled uncompressed files.", keywords:"prefilter_false_negative grep_raw_file_misses_gzipped search_says_zero_hits_but_data_is_there proof_covered_only_the_easy_case compressed_captures_skipped", ocd:2026-08-01, lmd:2026-08-01] DO NOT prove a search prefilter has no false negatives by running it over whatever files happen to be on disk, BECAUSE a uniform corpus hides the case it cannot handle — the raw-bytes prefilter could never match a GZIPPED capture, and the proof passed only because 0 of 1354 files were compressed at the time. DO run the prefilter through the same decoding path as the full read (here: `readBodyText`, which gunzips without parsing), and make the test corpus contain the encoding the prefilter must survive.
