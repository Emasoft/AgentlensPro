---
name: ssd-write-economics
description: "is SSD life spent by write operations or by bytes / does batching writes reduce SSD wear / why is the span store 6GB when the body store is compressed / should I delay writes to save the disk / what does write amplification mean for us / file got smaller but disk writes went up / is it safe to gzip a span segment / why did a compressed segment disappear from the reader / where do raw captured bodies land now / is the spoolDir key or spool verb still valid (spool gone) / what happened to the RAM disk / what is the SSD write budget without the spool / how fast do raw bodies fill the SSD now / is the 15GB per day budget still met after the spool removal / what is the measured daily body volume"
ocd: 2026-08-11
lmd: 2026-09-26
metadata:
  node_type: memory
  type: project
  tier: aspect
publish-globally: false
---

# ssd-write-economics


^ATOM-Y2TV-18OF [desc: "Post-removal SSD inflow: one 240s ACTIVE window gross ~13.5 MB/min (~19 GB/day 24/7 — PEAK not daily); 24h average UNMEASURED, measurement owed; net ~1.35 MB/min", keywords: is_ssd_life_spent_by_operations_or_bytes does_batching_writes_reduce_ssd_wear write_amplification_factor sub-page_write_programs_a_whole_page how_many_GB_per_day_can_an_ssd_sustain delaying_writes_to_save_the_disk, type: reference, ocd: 2026-08-11, lmd: 2026-09-26]
DO NOT quote the pre-removal under-3-percent-of-budget figure, and do NOT quote '18.7 GB/day steady' as a daily verdict either, BECAUSE both outrun their evidence: the spool removal is certain (TRDD-Z53IJFE9), but the post-removal number comes from ONE 240 s sampled window (4 drain ticks, 2026-09-26, during ACTIVE work — this session's own API calls generate bodies) and possibly straddled a crash-loop restart. What the window shows: gross outflow ~13.5 MB/min (drain emptied ~48.8 MB in 240 s), net accumulation only ~1.35 MB/min (dir held just ~41 MB — a backlog catchup would be GB, so steady-STATE is plausible but unproven); extrapolated 24/7 that is ~19 GB/day, but a real day includes idle hours — the 24 h AVERAGE IS UNMEASURED and nothing has scheduled it. Direction is certain: even the defensible net floor (~1.35 MB/min x 24 h ~ 2 GB/day) is a 5-17x jump over the superseded 120-400 MB/day figure, and the 24/7 gross extrapolation (~19.4 GB/day) would be 48-162x over it — the budget-pressure flag stands, labeled peak-rate not daily-budget. DO schedule a 24 h inflow measurement before re-asserting any daily-budget verdict; the lever if pressure is confirmed stays compression (fewer host bytes), not batching.


^ATOM-UNJH-PDX2 [desc:"Bodies are ZSTD-Parquet at 59x while spans/log-events/hooks are plain NDJSON; gzip -9 measures 19.5x on a real segment — but the reader's filename regex makes a .gz segment SILENTLY INVISIBLE", keywords: why_is_the_span_store_6GB_when_the_body_store_is_compressed are_span_segments_compressed is_it_safe_to_gzip_a_span_segment compressed_segment_disappeared_from_the_reader spans_vanished_from_queries_after_compression, type: project, ocd: 2026-08-11, lmd: 2026-08-11]

**The one store we compress is the one that was already small.** Raw bodies go through the
fileless-DuckDB → immutable ZSTD Parquet loop (`src/store/db.ts`, `COPY ... TO (FORMAT PARQUET,
COMPRESSION ZSTD)`) at a measured 59x. Meanwhile the SPAN store, the log-event sink and
hook-events are written as **plain uncompressed NDJSON** — there is no gzip/zstd/zlib anywhere in
those writers. Measured on a real 34.8 MB span segment: `gzip -9` gives **19.5x**
(34,827,112 → 1,779,136).

**Compressing a SEALED segment is the safe slice.** Segments are one file per day, so every
segment except today's can never be appended to again — compressing those cannot race the append
path.

**THE TRAP: `segmentedSpanStore.ts` gates segment discovery on
`/^\d{4}-\d{2}-\d{2}\.ndjson$/`.** A `.ndjson.gz` does not fail that check loudly — it simply
never matches, so the segment becomes **invisible to the reader** and its spans silently vanish
from every query. Any compression change MUST teach the reader the new extension in the SAME
edit; shipping the writer first is data loss by omission, and it would look like a retention bug
rather than a format bug.

Judge this work as a DISK-SPACE win — the atom above is why it is not a longevity one.

## See also

- [[agentlenspro-ops-lessons-store-durability-and-memory]] — the drain/reclaim behaviour this page's
  budget depends on, including the measured reclaim rate against arrival rate.

## Notes and lessons learned

[^1]: [id: ATOM-R1X7-1V7A, status: valid, supersedes: ATOM-Y2TV-18OF, desc: "Spool gone: the RAM-disk spool is no longer the SSD-budget margin — bodies land on SSD directly", keywords: "spool_gone RAM_disk_removed capture_writes_to_SSD where_do_bodies_land spoolDir_config_invalid spool_verb_not_found ssd_write_budget_after_spool_removal does_the_ram_spool_still_save_the_ssd 15_GB_per_day_budget raw_bodies_on_ssd_direct ssd_write_amplification_body_capture bodies_spool_removed", ocd: 2026-09-26, lmd: 2026-09-26] DO NOT cite the RAM-disk spool as the mechanism keeping this machine inside the 15 GB/day SSD budget, and do not model SSD wear as "spool absorbs the 30 GB/day body flood", BECAUSE the RAM-disk body spool was removed on 2026-09-25 (commit 3c031ab8, TRDD-Z53IJFE9): raw bodies are now written STRAIGHT to <dataDir>/otel-bodies on SSD (no spoolDir config, no spool CLI verb, no com.agentlens.spool LaunchAgent) and drained by a 60 s pass with a flat 10 s age cutoff. The byte-volume question this page answers is UNCHANGED — the store-side compression still holds WAF near 1, and the 2026-08-11 measured ~120-400 MB/day figure predates the removal, so re-measure the daily body volume on SSD before re-asserting any budget margin. DO treat "protect the spool" as retired SSD-longevity work and re-derive the margin from the direct-write path if the budget question recurs. SUPERSEDED BODY: **Wear is charged in NAND bytes, and NAND bytes = host bytes x Write Amplification Factor.** Endurance ratings (TBW, P/E cycles) are a BYTES measure, so writing the same bytes in one large batch instead of many small ones does not by itself reduce wear. WAF is the caveat: small random writes drive it up, large sequential writes hold it near 1, and a write smaller than the NAND page (~4-16 KB) still programs a WHOLE page — so 100 x 200-byte writes can burn ~1.6 MB of NAND for 20 KB of data. **Consequence here: batching is not a wear lever, it is the ENABLER of compression.** You cannot compress an append-only stream without first accumulating it in RAM. Our Parquet parts are already large and sequential, so WAF is ~1 and further batching buys ~1 KB/turn of footer overhead against a measured 14 KB/turn append-only floor. Reach for compression (fewer host bytes); reach for batching only because compression requires it. **Budget (owner, 2026-08-11): an SSD sustains ~25 GB/day for ~3 years; keep under 15 GB/day.** Measured against that: ~120-400 MB/day total, i.e. under 3% of budget. **The RAM-disk spool is the entire margin** — Claude Code writes ~21 MB/min (~30 GB/day) of raw bodies, which without the spool would exceed both the 15 GB target and the 25 GB sustainable line. Protecting the SPOOL (drain throughput, back-pressure) is therefore the real SSD-longevity work; compressing the already-small stores is a disk-SPACE win, not a longevity one.
[^2]: [id: ATOM-LEO9-38X6, status: valid, desc: "Post-removal SSD inflow: one 240s ACTIVE window gross ~13.5 MB/min (~19 GB/day 24/7 — PEAK not daily); 24h average UNMEASURED, measurement owed; net ~1.35 MB/min", keywords: "bodies_inflow_measured 13_MB_per_min 18_GB_per_day ssd_budget_exceeded is_the_15GB_budget_still_met after_spool_removal daily_body_volume_ssd re_measure_budget_margin how_fast_do_raw_bodies_fill_the_ssd otel_bodies_dir_growth_rate is_ssd_write_budget_exceeded_now GB_per_day_raw_body_capture", ocd: 2026-09-26, lmd: 2026-09-26] DO NOT quote the pre-removal under-3-percent-of-budget figure, and the narrowing came from the review of the first wording — see the body atom Y2TV-18OF for the current, correctly-scoped statement (one 240s ACTIVE window; PEAK not daily; 24h average UNMEASURED, measurement owed).
