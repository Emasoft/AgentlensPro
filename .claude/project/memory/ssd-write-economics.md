---
name: ssd-write-economics
description: "is SSD life spent by write operations or by bytes / does batching writes reduce SSD wear / why is the span store 6GB when the body store is compressed / should I delay writes to save the disk / what does write amplification mean for us / file got smaller but disk writes went up / is it safe to gzip a span segment / why did a compressed segment disappear from the reader"
ocd: 2026-08-11
lmd: 2026-08-11
metadata:
  node_type: memory
  type: project
  tier: aspect
---

# ssd-write-economics


^ATOM-Y2TV-18OF [desc:"SSD life is spent in NAND bytes = host bytes x write-amplification; batching alone saves nothing, it is only the ENABLER of compression — and the RAM spool is what keeps this machine inside a 15 GB/da", keywords: is_ssd_life_spent_by_operations_or_bytes does_batching_writes_reduce_ssd_wear write_amplification_factor sub-page_write_programs_a_whole_page how_many_GB_per_day_can_an_ssd_sustain delaying_writes_to_save_the_disk, type: reference, ocd: 2026-08-11, lmd: 2026-08-11]

**Wear is charged in NAND bytes, and NAND bytes = host bytes x Write Amplification Factor.**
Endurance ratings (TBW, P/E cycles) are a BYTES measure, so writing the same bytes in one large
batch instead of many small ones does not by itself reduce wear. WAF is the caveat: small random
writes drive it up, large sequential writes hold it near 1, and a write smaller than the NAND page
(~4-16 KB) still programs a WHOLE page — so 100 x 200-byte writes can burn ~1.6 MB of NAND for
20 KB of data.

**Consequence here: batching is not a wear lever, it is the ENABLER of compression.** You cannot
compress an append-only stream without first accumulating it in RAM. Our Parquet parts are already
large and sequential, so WAF is ~1 and further batching buys ~1 KB/turn of footer overhead against
a measured 14 KB/turn append-only floor. Reach for compression (fewer host bytes); reach for
batching only because compression requires it.

**Budget (owner, 2026-08-11): an SSD sustains ~25 GB/day for ~3 years; keep under 15 GB/day.**
Measured against that: ~120-400 MB/day total, i.e. under 3% of budget. **The RAM-disk spool is the
entire margin** — Claude Code writes ~21 MB/min (~30 GB/day) of raw bodies, which without the
spool would exceed both the 15 GB target and the 25 GB sustainable line. Protecting the SPOOL
(drain throughput, back-pressure) is therefore the real SSD-longevity work; compressing the
already-small stores is a disk-SPACE win, not a longevity one.


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

Judge this work as a DISK-SPACE win (see [[ssd-write-economics]] for why it is not a longevity
one).

## Notes and lessons learned
