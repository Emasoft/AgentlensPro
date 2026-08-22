//! Span-store WRITER (TRDD-DMWOBWFH P3) — faithful port of the write half of
//! `src/segmentedSpanStore.ts`: buffered day-keyed appends, one appendFile per touched day at
//! flush, an `index.json` kept atomically, and the sealed-day gzip sweep with the
//! verify-before-delete contract. The on-disk format is the compatibility boundary: a store
//! written here must be byte-readable (and, for same-input spans, byte-IDENTICAL — serde's
//! preserve_order matches JSON.stringify's insertion order) by the TS store and by alscan.
//!
//! Contracts ported deliberately:
//! - `spanTimestampMs`: receivedAt → digit-only startTime/endTime as unix-ns → ISO parse → now.
//! - flush appends `lines.join('\n') + '\n'` per day; the index write is atomic
//!   (tmp + fsync + rename) and NEVER blocks the appends themselves.
//! - the pending buffer is a DISK-FAILURE failsafe bounded at 100k: overflow drops the OLDEST
//!   buffered span loudly (counted), never silently.
//! - compression touches only days STRICTLY before today; an existing `.gz` resumes (delete the
//!   plain form only if the gz verifies against it, streamed); a fresh `.gz` is written
//!   atomically and VERIFIED before the plain copy is deleted — never remove the only known-good
//!   copy on faith. Verification is engine-agnostic (gunzip-compare, not byte-compare of the gz),
//!   so flate2 vs zlib output differences cannot break the contract.

use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{civil_from_days, parse_iso_ms, segment_day_ms};

const PENDING_FAILSAFE_MAX: usize = 100_000;
const DAY_MS: i64 = 86_400_000;
pub const INDEX_FILE: &str = "index.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SegmentMeta {
    pub count: u64,
    #[serde(rename = "minTs")]
    pub min_ts: f64,
    #[serde(rename = "maxTs")]
    pub max_ts: f64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SegmentIndex {
    pub version: u32,
    /// BTreeMap: key order in the serialized index is sorted rather than insertion-ordered —
    /// readers JSON.parse it, so ordering is presentation only; sorted is deterministic.
    pub segments: BTreeMap<String, SegmentMeta>,
}

struct PendingBucket {
    lines: Vec<String>,
    count: u64,
    min_ts: f64,
    max_ts: f64,
}

pub struct SpanStoreWriter {
    dir: PathBuf,
    index: SegmentIndex,
    pending: BTreeMap<String, PendingBucket>,
    pending_count: usize,
    pub dropped_on_failure: u64,
    /// S3-F3b read-time attribute overlay (segmentedSpanStore.ts): `traceId:spanId` →
    /// {attrKey: stringValue}, merged into a span WHEN IT IS READ (load_range) — never by
    /// rewriting its persisted line. Order-independent (the gen_ai response content arrives as a
    /// separate log event, before OR after the span, on a different request). In-memory only
    /// (lost on restart — accepted for LOW-severity enrichment); insertion-ordered so the cap
    /// evicts oldest-first and a never-arriving span cannot leak memory.
    overlay: Vec<(String, Vec<(String, String)>)>,
}

/// segmentedSpanStore.ts OVERLAY_MAX.
const OVERLAY_MAX: usize = 500;

#[derive(Debug, Default)]
pub struct FlushResult {
    pub appended_spans: u64,
    pub appended_bytes: u64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Default)]
pub struct CompressResult {
    pub compressed: Vec<String>,
    pub bytes_saved: i64,
    pub warnings: Vec<String>,
    /// Sealed segments left uncompressed after this slice — either the `max_segments` budget
    /// ran out or the sweep paused under RSS pressure. Caller reschedules while this is > 0.
    pub remaining: usize,
    /// Set once the moment `under_pressure()` first returned true this call — logged once, not
    /// once per remaining segment (segmentedSpanStore.ts compressSealedSegments).
    pub paused_for_pressure: bool,
}

/// TS `RetentionDeletion` (segmentedSpanStore.ts runRetention).
#[derive(Debug, Clone, PartialEq)]
pub struct RetentionDeletion {
    pub segment: String,
    pub spans: u64,
    pub age_days: i64,
}

/// TS `spanTimestampMs` — the day-bucketing clock.
pub fn span_timestamp_ms(span: &serde_json::Map<String, Value>, now_ms: i64) -> i64 {
    if let Some(r) = span.get("receivedAt").and_then(Value::as_f64) {
        if r.is_finite() {
            return r as i64;
        }
    }
    for key in ["startTime", "endTime"] {
        let Some(t) = span.get(key).and_then(Value::as_str) else { continue };
        if t.is_empty() {
            continue;
        }
        if t.bytes().all(|b| b.is_ascii_digit()) {
            if let Ok(n) = t.parse::<f64>() {
                let ms = n / 1e6;
                if ms.is_finite() && ms > 0.0 {
                    return ms as i64;
                }
            }
        } else if let Some(ms) = parse_iso_ms(t) {
            return ms;
        }
    }
    now_ms
}

fn segment_key(ts_ms: i64) -> String {
    let days = ts_ms.div_euclid(DAY_MS);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// TS `atomicWriteFileSync`: unique temp + fsync + rename; temp removed on any failure.
fn atomic_write(file: &Path, data: &[u8]) -> std::io::Result<()> {
    let tmp = file.with_file_name(format!(
        "{}.tmp-{}-{}",
        file.file_name().and_then(|s| s.to_str()).unwrap_or("f"),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
    ));
    let write = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        let _ = f.sync_all(); // fsync unsupported on some FS — best effort, same as TS
        drop(f);
        fs::rename(&tmp, file)
    })();
    if write.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    write
}

/// Streamed line count, `.gz`-transparent; a truncated final line still counts (crash mid-append).
fn count_lines_streaming(file: &Path) -> std::io::Result<u64> {
    let f = fs::File::open(file)?;
    let mut reader: Box<dyn Read> = if file.extension().is_some_and(|e| e == "gz") {
        Box::new(flate2::read::GzDecoder::new(f))
    } else {
        Box::new(f)
    };
    let mut buf = [0u8; 64 * 1024];
    let mut count = 0u64;
    let mut last = 0x0au8;
    let mut saw = false;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        saw = true;
        count += buf[..n].iter().filter(|b| **b == 0x0a).count() as u64;
        last = buf[n - 1];
    }
    if saw && last != 0x0a {
        count += 1;
    }
    Ok(count)
}

/// Streamed gunzip-compare of a written `.gz` against the plain bytes it was made from.
fn gz_verifies_against(gz_file: &Path, plain: &[u8]) -> std::io::Result<bool> {
    let mut dec = flate2::read::GzDecoder::new(fs::File::open(gz_file)?);
    let mut buf = [0u8; 1 << 16];
    let mut off = 0usize;
    loop {
        let n = dec.read(&mut buf)?;
        if n == 0 {
            break;
        }
        if off + n > plain.len() || buf[..n] != plain[off..off + n] {
            return Ok(false);
        }
        off += n;
    }
    Ok(off == plain.len())
}

impl SpanStoreWriter {
    /// TS constructor: mkdir + loadOrRebuildIndex (reconcile the index against the files on
    /// disk — a crash between append and index-write leaves counts stale-low, so any segment
    /// whose byte size disagrees is recounted, streamed; missing segments are adopted with
    /// conservative day-bound timestamps; vanished entries are dropped).
    pub fn open(dir: &Path) -> Self {
        let _ = fs::create_dir_all(dir);
        let mut w = SpanStoreWriter {
            dir: dir.to_path_buf(),
            index: SegmentIndex { version: 1, segments: BTreeMap::new() },
            pending: BTreeMap::new(),
            pending_count: 0,
            dropped_on_failure: 0,
            overlay: Vec::new(),
        };
        w.load_or_rebuild_index();
        w
    }

    fn load_or_rebuild_index(&mut self) {
        if let Ok(raw) = fs::read_to_string(self.dir.join(INDEX_FILE)) {
            if let Ok(parsed) = serde_json::from_str::<SegmentIndex>(&raw) {
                if parsed.version == 1 {
                    self.index = parsed;
                }
            }
        }
        let mut by_key: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let Ok(rd) = fs::read_dir(&self.dir) else { return };
        for entry in rd.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if segment_day_ms(name).is_none() {
                continue;
            }
            by_key.entry(name[..10].to_owned()).or_default().push(name.to_owned());
        }
        let mut dirty = false;
        for (key, files) in &by_key {
            let mut size = 0u64;
            let mut stat_ok = true;
            for name in files {
                match fs::metadata(self.dir.join(name)) {
                    Ok(m) => size += m.len(),
                    Err(_) => stat_ok = false,
                }
            }
            if !stat_ok {
                continue;
            }
            if self.index.segments.get(key).is_some_and(|m| m.bytes == size) {
                continue; // index agrees with disk — trust it
            }
            let Some(day_ms) = segment_day_ms(&format!("{key}.ndjson")) else { continue };
            // Same simplification as TS countSpansForKey's common path: one file → streamed
            // count. The rare both-forms day sums counts; readers dedupe by span id anyway.
            let mut count = 0u64;
            for name in files {
                count += count_lines_streaming(&self.dir.join(name)).unwrap_or(0);
            }
            self.index.segments.insert(
                key.clone(),
                SegmentMeta { count, min_ts: day_ms as f64, max_ts: (day_ms + DAY_MS - 1) as f64, bytes: size },
            );
            dirty = true;
        }
        let stale: Vec<String> = self
            .index
            .segments
            .keys()
            .filter(|k| !by_key.contains_key(*k))
            .cloned()
            .collect();
        for k in stale {
            self.index.segments.remove(&k);
            dirty = true;
        }
        if dirty {
            self.write_index();
        }
    }

    fn write_index(&self) {
        if let Ok(json) = serde_json::to_vec(&self.index) {
            let _ = atomic_write(&self.dir.join(INDEX_FILE), &json);
        }
    }

    /// TS `stats()` — (segments, totalSpans, totalBytes) from the index.
    pub fn stats(&self) -> (usize, u64, u64) {
        let total_spans = self.index.segments.values().map(|m| m.count).sum();
        let total_bytes = self.index.segments.values().map(|m| m.bytes).sum();
        (self.index.segments.len(), total_spans, total_bytes)
    }

    /// TS `loadRange(sinceMs, untilMs)` (TRDD-DMWOBWFH P4h — the standalone server's boot load
    /// of the summary window): flush first (reads must see everything appended so far), visit
    /// ONLY the segments whose index min/max (else the day bounds) overlap the window, in key
    /// order; within a day, a rare dual-form key (`.ndjson` + `.ndjson.gz`) is de-duplicated by
    /// traceId:spanId across the forms; each span is kept iff its own timestamp is inside
    /// [since, until]. A corrupt tail line is skipped; an unreadable file is logged on stderr
    /// and that segment is MISSING from the result (never silently).
    pub fn load_range(&mut self, since_ms: i64, until_ms: i64, now_ms: i64) -> Vec<Value> {
        self.flush();
        let mut by_key: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let Ok(rd) = fs::read_dir(&self.dir) else { return Vec::new() };
        for entry in rd.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if segment_day_ms(name).is_some() {
                by_key.entry(name[..10].to_owned()).or_default().push(name.to_owned());
            }
        }
        let mut out: Vec<Value> = Vec::new();
        for (key, files) in &by_key {
            let Some(day_ms) = segment_day_ms(&format!("{key}.ndjson")) else { continue };
            let (lo, hi) = match self.index.segments.get(key) {
                Some(m) => (m.min_ts as i64, m.max_ts as i64),
                None => (day_ms, day_ms + DAY_MS),
            };
            if lo > until_ms || hi < since_ms {
                continue;
            }
            let mut seen: Option<std::collections::HashSet<String>> = if files.len() > 1 { Some(Default::default()) } else { None };
            let mut sorted = files.clone();
            sorted.sort();
            for name in &sorted {
                let path = self.dir.join(name);
                let Ok(f) = fs::File::open(&path) else {
                    eprintln!("span store: could NOT read {name} — that segment is MISSING from this query's result");
                    continue;
                };
                let reader: Box<dyn Read> = if name.ends_with(".gz") { Box::new(flate2::read::GzDecoder::new(f)) } else { Box::new(f) };
                for line in std::io::BufReader::with_capacity(1 << 20, reader).lines() {
                    let Ok(line) = line else { break };
                    let Ok(span) = serde_json::from_str::<Value>(&line) else { continue };
                    let Some(obj) = span.as_object() else { continue };
                    if let Some(seen) = seen.as_mut() {
                        let id = format!(
                            "{}:{}",
                            obj.get("traceId").and_then(Value::as_str).unwrap_or(""),
                            obj.get("spanId").and_then(Value::as_str).unwrap_or("")
                        );
                        if !seen.insert(id) {
                            continue;
                        }
                    }
                    let ts = span_timestamp_ms(obj, now_ms);
                    if ts < since_ms || ts > until_ms {
                        continue;
                    }
                    let mut span = span;
                    self.apply_overlay(&mut span);
                    out.push(span);
                }
            }
        }
        out
    }

    pub fn pending_appends(&self) -> usize {
        self.pending_count
    }

    /// injectSpanAttribute — record an attribute to merge into span `traceId:spanId` when it is
    /// next read (load_range), WITHOUT rewriting any persisted segment. Always true (recorded
    /// whether or not the span is in the store yet) — the boolean mirrors the legacy signature
    /// so callers stay uniform. Cap-evicts oldest when OVERLAY_MAX is exceeded.
    pub fn inject_span_attribute(&mut self, trace_id: &str, span_id: &str, key: &str, value: &str) -> bool {
        let k = format!("{trace_id}:{span_id}");
        match self.overlay.iter_mut().find(|(id, _)| *id == k) {
            Some((_, rec)) => match rec.iter_mut().find(|(rk, _)| rk == key) {
                Some((_, v)) => *v = value.to_owned(),
                None => rec.push((key.to_owned(), value.to_owned())),
            },
            None => {
                self.overlay.push((k, vec![(key.to_owned(), value.to_owned())]));
                if self.overlay.len() > OVERLAY_MAX {
                    self.overlay.remove(0);
                }
            }
        }
        true
    }

    /// applyOverlay — upsert the recorded attributes into a span read from disk (each read
    /// re-parses the line, so mutating here never contaminates the persisted segment or another
    /// read): an existing attribute of the same key is overwritten in place, else appended.
    fn apply_overlay(&self, span: &mut Value) {
        let Some(obj) = span.as_object() else { return };
        let k = format!(
            "{}:{}",
            obj.get("traceId").and_then(Value::as_str).unwrap_or(""),
            obj.get("spanId").and_then(Value::as_str).unwrap_or("")
        );
        let Some((_, rec)) = self.overlay.iter().find(|(id, _)| *id == k) else { return };
        let Some(attrs) = span.as_object_mut().and_then(|o| o.get_mut("attributes")).and_then(Value::as_array_mut) else { return };
        for (key, value) in rec {
            let wrapped = serde_json::json!({ "stringValue": value });
            match attrs.iter_mut().filter_map(Value::as_object_mut).find(|a| a.get("key").and_then(Value::as_str) == Some(key)) {
                Some(existing) => {
                    existing.insert("value".to_owned(), wrapped);
                }
                None => attrs.push(serde_json::json!({ "key": key, "value": wrapped })),
            }
        }
    }

    /// TS `clear()` — the user's "clear all" (POST /api/clear, /action clearAll): drop the
    /// buffered appends and unlink every segment (plain or gz) and the index; nothing else in
    /// the dir is touched. Destructive BY CONTRACT — it is the one place the store forgets.
    pub fn clear(&mut self) {
        self.pending.clear();
        self.pending_count = 0;
        self.dropped_on_failure = 0;
        self.overlay.clear();
        if let Ok(rd) = fs::read_dir(&self.dir) {
            for entry in rd.flatten() {
                let name = entry.file_name();
                let Some(name) = name.to_str() else { continue };
                if segment_day_ms(name).is_none() && name != INDEX_FILE {
                    continue;
                }
                let _ = fs::remove_file(entry.path()); // raced — ignore, as in TS
            }
        }
        self.index = SegmentIndex { version: 1, segments: BTreeMap::new() };
    }

    /// Buffer one span for its daily segment. O(record) — disk is touched only by flush().
    pub fn append(&mut self, span: &Value, now_ms: i64) {
        let Some(obj) = span.as_object() else { return };
        let ts = span_timestamp_ms(obj, now_ms);
        let key = segment_key(ts);
        let Ok(line) = serde_json::to_string(span) else { return };
        let bucket = self.pending.entry(key).or_insert_with(|| PendingBucket {
            lines: Vec::new(),
            count: 0,
            min_ts: f64::INFINITY,
            max_ts: f64::NEG_INFINITY,
        });
        bucket.lines.push(line);
        bucket.count += 1;
        let tsf = ts as f64;
        if tsf < bucket.min_ts {
            bucket.min_ts = tsf;
        }
        if tsf > bucket.max_ts {
            bucket.max_ts = tsf;
        }
        self.pending_count += 1;
        if self.pending_count > PENDING_FAILSAFE_MAX {
            // Drop the OLDEST buffered span — loud (counted), never silent.
            if let Some((_, oldest)) = self.pending.iter_mut().next() {
                if !oldest.lines.is_empty() {
                    oldest.lines.remove(0);
                    oldest.count -= 1;
                    self.pending_count -= 1;
                    self.dropped_on_failure += 1;
                }
            }
        }
    }

    /// Append every buffered span to its segment file and refresh the index (atomic write).
    /// Never fails the whole flush: a failed segment keeps its buffer for the next tick.
    pub fn flush(&mut self) -> FlushResult {
        let mut out = FlushResult::default();
        if self.pending_count == 0 {
            return out;
        }
        let keys: Vec<String> = self.pending.keys().cloned().collect();
        let mut index_dirty = false;
        for key in keys {
            let Some(bucket) = self.pending.get(&key) else { continue };
            if bucket.lines.is_empty() {
                self.pending.remove(&key);
                continue;
            }
            let chunk = format!("{}\n", bucket.lines.join("\n"));
            if self.dir.join(format!("{key}.ndjson.gz")).exists() {
                out.warnings.push(format!(
                    "late span(s) appended to {key} after it was already compressed — both forms now exist and are merged on read"
                ));
            }
            let _ = fs::create_dir_all(&self.dir);
            let append = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.dir.join(format!("{key}.ndjson")))
                .and_then(|mut f| f.write_all(chunk.as_bytes()));
            if let Err(e) = append {
                out.warnings.push(format!("could not append to {key}.ndjson: {e}"));
                continue; // keep the buffer — retried next tick
            }
            let bucket = self.pending.remove(&key).unwrap();
            let bytes = chunk.len() as u64;
            out.appended_spans += bucket.count;
            out.appended_bytes += bytes;
            self.pending_count -= bucket.count as usize;
            let meta = self.index.segments.entry(key).or_insert(SegmentMeta {
                count: 0,
                min_ts: bucket.min_ts,
                max_ts: bucket.max_ts,
                bytes: 0,
            });
            meta.count += bucket.count;
            meta.bytes += bytes;
            if bucket.min_ts < meta.min_ts {
                meta.min_ts = bucket.min_ts;
            }
            if bucket.max_ts > meta.max_ts {
                meta.max_ts = bucket.max_ts;
            }
            index_dirty = true;
        }
        if index_dirty {
            self.write_index();
        }
        out
    }

    /// Delete whole EXPIRED segments only (day older than retentionDays). Partial segments are
    /// never trimmed; every deletion is reported explicitly — a foreign file in the dir is never
    /// touched (segment_day_ms returns None for it). segmentedSpanStore.ts runRetention.
    ///
    /// `retention_days.max(1.0)` is a floor INSIDE this function, deliberately duplicating the
    /// `Knob.min` floor already applied by the caller (agentlens-core resolve_knob) — two
    /// independent guards against a misconfigured `retention.spansRetentionDays: 0` wiping the
    /// whole store: one at the config-resolution boundary, one here at the point of deletion,
    /// so a caller that forgets/bypasses the first floor still cannot nuke everything.
    pub fn run_retention(&mut self, retention_days: f64, now_ms: f64) -> Vec<RetentionDeletion> {
        let mut deleted = Vec::new();
        let now_ms = now_ms as i64;
        let retention_ms = (retention_days.max(1.0) * DAY_MS as f64) as i64;
        // Floor to the UTC day boundary, same value segment_key/civil_from_days would produce
        // for this instant — the cutoff is a day, not a millisecond.
        let cutoff_ms = (now_ms - retention_ms).div_euclid(DAY_MS) * DAY_MS;
        let Ok(rd) = fs::read_dir(&self.dir) else { return deleted };
        let mut names: Vec<String> = rd.flatten().filter_map(|e| e.file_name().to_str().map(str::to_owned)).collect();
        names.sort();
        let mut index_dirty = false;
        for name in names {
            let Some(day_ms) = segment_day_ms(&name) else { continue }; // not one of our segments — never delete a foreign file
            if day_ms >= cutoff_ms {
                continue;
            }
            let key = name[..10].to_owned();
            let file = self.dir.join(&name);
            let span_count = match self.index.segments.get(&key) {
                Some(m) => m.count,
                None => count_lines_streaming(&file).unwrap_or(0),
            };
            if let Err(e) = fs::remove_file(&file) {
                // Leave the segment AND its index entry alone (retried next sweep) — but say so.
                // The TS logs here too; a retention pass that quietly fails to delete is how a
                // store grows forever with a clean-looking empty manifest.
                eprintln!("alcore: retention could not delete {}: {e}", file.display());
                continue;
            }
            self.index.segments.remove(&key);
            index_dirty = true;
            let age_days = (now_ms - day_ms) / DAY_MS;
            deleted.push(RetentionDeletion { segment: name, spans: span_count, age_days });
        }
        if index_dirty {
            self.write_index();
        }
        deleted
    }

    /// Gzip every plain segment whose day is STRICTLY before today; verify before deleting the
    /// plain form. Resumes an interrupted compress; leaves both forms on ANY doubt.
    ///
    /// `under_pressure` pauses the sweep (segmentedSpanStore.ts: a big backlog's gunzip-verify
    /// round-trips can ratchet RSS by 1GB+/segment); `max_segments` bounds one call to a slice of
    /// the backlog so a caller can reschedule between slices instead of blocking on the whole
    /// thing. `touched` (the budget counter) increments BEFORE the "already-exists" resume branch
    /// on purpose, matching the TS ordering exactly — a resumed segment still consumes a slot in
    /// the slice. Get this ordering wrong and a resume-heavy backlog silently never drains: the
    /// budget looks spent on segments that produced no visible compression this slice.
    pub fn compress_sealed_segments(
        &mut self,
        now_ms: i64,
        max_segments: usize,
        under_pressure: &dyn Fn() -> bool,
    ) -> CompressResult {
        let mut out = CompressResult::default();
        let today_key = segment_key(now_ms);
        let Ok(rd) = fs::read_dir(&self.dir) else { return out };
        let mut names: Vec<String> = rd
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(str::to_owned))
            .filter(|n| n.ends_with(".ndjson") && segment_day_ms(n).is_some())
            .collect();
        names.sort();
        let mut index_dirty = false;
        let mut touched = 0usize;
        for name in names {
            let key = name[..10].to_owned();
            if key.as_str() >= today_key.as_str() {
                continue; // active/current day — never compress
            }
            if touched >= max_segments {
                out.remaining += 1;
                continue;
            }
            if under_pressure() {
                if !out.paused_for_pressure {
                    // Log the pause ONCE, not once per remaining segment.
                    out.warnings.push(format!(
                        "span store: compression sweep paused under RSS pressure after {} segment(s) — remaining sealed segments compress on the next sweep",
                        out.compressed.len()
                    ));
                }
                out.paused_for_pressure = true;
                out.remaining += 1;
                continue; // keep counting `remaining` so the caller knows work is left
            }
            touched += 1;
            let plain_file = self.dir.join(&name);
            let gz_file = self.dir.join(format!("{name}.gz"));
            let Ok(plain) = fs::read(&plain_file) else { continue };
            if plain.is_empty() {
                continue;
            }
            if gz_file.exists() {
                // Resume an interrupted compress: finish the delete IF the existing .gz still
                // verifies against the current plain bytes; otherwise leave both forms alone.
                match gz_verifies_against(&gz_file, &plain) {
                    Ok(true) => {
                        let _ = fs::remove_file(&plain_file);
                        if let (Some(meta), Ok(st)) = (self.index.segments.get_mut(&key), fs::metadata(&gz_file)) {
                            meta.bytes = st.len();
                            index_dirty = true;
                        }
                    }
                    Ok(false) => {}
                    Err(e) => out.warnings.push(format!("could not verify existing {key}.ndjson.gz: {e} — leaving both forms")),
                }
                continue;
            }
            let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            if enc.write_all(&plain).is_err() {
                continue;
            }
            let Ok(gz) = enc.finish() else { continue };
            if let Err(e) = atomic_write(&gz_file, &gz) {
                out.warnings.push(format!("could not compress {name}: {e}"));
                continue;
            }
            match gz_verifies_against(&gz_file, &plain) {
                Ok(true) => {}
                Ok(false) => {
                    out.warnings.push(format!("{name} compressed but did NOT verify — leaving both forms, NOT deleting the plain copy"));
                    continue;
                }
                Err(e) => {
                    out.warnings.push(format!("could not verify compressed {name}: {e} — leaving both forms"));
                    continue;
                }
            }
            if let Err(e) = fs::remove_file(&plain_file) {
                out.warnings.push(format!("compressed {name} but could not delete the plain copy: {e}"));
            }
            out.bytes_saved += plain.len() as i64 - gz.len() as i64;
            if let Some(meta) = self.index.segments.get_mut(&key) {
                meta.bytes = gz.len() as u64;
                index_dirty = true;
            }
            out.compressed.push(key);
        }
        if index_dirty {
            self.write_index();
        }
        out
    }
}
