//! agentlens-spanstore — parallel reader for the segmented span store (TRDD-DMWOBWFH Phase 1).
//!
//! On-disk contract (mirrors `src/segmentedSpanStore.ts`, which stays the writer for now):
//! - `<spansDir>/<YYYY-MM-DD>.ndjson` — one span JSON object per line, UTC day segments.
//! - `<YYYY-MM-DD>.ndjson.gz` — the same day, sealed (day strictly before today) and gzipped.
//! - Foreign files are ignored; a calendar-invalid day name is not a segment.
//!
//! The extraction contract mirrors `src/otelCallEvents.ts::scanOtelCallEvents`: keep only
//! `claude_code.api_request` / `claude_code.compaction` spans, substring-prefilter each raw line
//! before parsing (conservative-safe: a JSON line whose parse would yield one of those names
//! necessarily contains it as a substring), event time = `event.timestamp` attr → `receivedAt` →
//! span startTime(ns)/1e6. Parity is pinned by the TS-vs-Rust test in `tests/parity.rs` and, on a
//! real store, by `alscan --parity-json` diffed against the TS scan's output.
//!
//! Parallelism: segments are walked with rayon (one file per task — segments are independent),
//! which is the multi-core behavior the single-threaded TS loop could not have.

use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

pub const API_REQUEST_SPAN: &str = "claude_code.api_request";
pub const COMPACTION_SPAN: &str = "claude_code.compaction";
const DAY_MS: i64 = 86_400_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CallEvent {
    pub ts: i64,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_tokens: i64,
    /// Claude Code's own tier-aware figure — carried through, never recomputed (doctrine).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CompactionEvent {
    pub ts: i64,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_tokens: Option<i64>,
}

#[derive(Debug, Default, Serialize)]
pub struct ScanResult {
    pub events: Vec<CallEvent>,
    pub compactions: Vec<CompactionEvent>,
    /// Parsed candidate lines only — non-candidates are skipped before JSON parse, same
    /// deliberately-uncountable contract as the TS prefilter (TRDD-9NAUEUUR).
    pub spans_scanned: u64,
    pub segments_visited: u64,
}

// ── raw span shape (only the fields the extraction reads) ────────────────────────

#[derive(Deserialize)]
struct RawAttrValue {
    #[serde(rename = "stringValue")]
    string_value: Option<String>,
    #[serde(rename = "intValue")]
    int_value: Option<serde_json::Value>, // OTLP writes ints as numbers OR strings
    #[serde(rename = "doubleValue")]
    double_value: Option<f64>,
}

#[derive(Deserialize)]
struct RawAttr {
    key: String,
    value: Option<RawAttrValue>,
}

#[derive(Deserialize)]
struct RawSpan {
    name: String,
    #[serde(rename = "startTime")]
    start_time: Option<serde_json::Value>,
    #[serde(rename = "receivedAt")]
    received_at: Option<f64>,
    attributes: Option<Vec<RawAttr>>,
}

struct Attrs<'a>(Vec<(&'a str, &'a RawAttrValue)>);

impl<'a> Attrs<'a> {
    fn get(&self, key: &str) -> Option<&'a RawAttrValue> {
        self.0.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
    }
    fn s(&self, key: &str) -> Option<String> {
        self.get(key)
            .and_then(|v| v.string_value.as_deref())
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    }
    fn n(&self, key: &str) -> Option<f64> {
        let v = self.get(key)?;
        if let Some(iv) = &v.int_value {
            if let Some(f) = iv.as_f64() {
                return Some(f);
            }
            if let Some(s) = iv.as_str() {
                return s.parse::<f64>().ok();
            }
        }
        if let Some(d) = v.double_value {
            return Some(d);
        }
        v.string_value.as_deref().and_then(|s| s.parse::<f64>().ok())
    }
    fn n0(&self, key: &str) -> i64 {
        self.n(key).map(|f| f as i64).unwrap_or(0)
    }
}

/// Same precedence as the TS `eventTimeMs`: `event.timestamp` ISO → `receivedAt` → startTime ns.
fn event_time_ms(span: &RawSpan, attrs: &Attrs) -> i64 {
    if let Some(iso) = attrs.s("event.timestamp") {
        if let Some(ms) = parse_iso_ms(&iso) {
            return ms;
        }
    }
    if let Some(r) = span.received_at {
        if r > 0.0 {
            return r as i64;
        }
    }
    let start = match &span.start_time {
        Some(serde_json::Value::String(s)) => s.parse::<f64>().unwrap_or(0.0),
        Some(serde_json::Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    };
    if start.is_finite() && start > 0.0 {
        (start / 1e6) as i64
    } else {
        0
    }
}

/// Minimal RFC3339/ISO-8601 (UTC or offset) → epoch ms. No chrono dependency: the harness writes
/// `YYYY-MM-DDTHH:MM:SS(.fff)?(Z|±HH:MM)`; anything else returns None and falls through, exactly
/// like the TS `Date.parse` NaN path. Pub: agentlens-logscan reuses it (one date impl, not two).
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> { s.get(from..to)?.parse::<i64>().ok() };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let mut idx = 19;
    let mut millis: i64 = 0;
    if b.get(idx) == Some(&b'.') {
        let frac_start = idx + 1;
        let mut frac_end = frac_start;
        while frac_end < b.len() && b[frac_end].is_ascii_digit() {
            frac_end += 1;
        }
        let frac = s.get(frac_start..frac_end)?;
        let scaled = format!("{:0<3}", &frac[..frac.len().min(3)]);
        millis = scaled.parse().ok()?;
        idx = frac_end;
    }
    let offset_min: i64 = match b.get(idx) {
        Some(b'Z') => 0,
        Some(sign @ (b'+' | b'-')) => {
            let oh = num(idx + 1, idx + 3)?;
            let om = if b.get(idx + 3) == Some(&b':') { num(idx + 4, idx + 6)? } else { num(idx + 3, idx + 5)? };
            let m = oh * 60 + om;
            if *sign == b'+' { m } else { -m }
        }
        _ => return None,
    };
    // Days since epoch (proleptic Gregorian, valid for the harness's date range).
    let days = days_from_civil(y, mo, d)?;
    Some((((days * 24 + h) * 60 + mi - offset_min) * 60 + sec) * 1000 + millis)
}

/// Howard Hinnant's days_from_civil — exact for all Gregorian dates.
fn days_from_civil(y: i64, m: i64, d: i64) -> Option<i64> {
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146097 + doe - 719468)
}

/// `2026-08-18.ndjson(.gz)` → UTC day-start ms; None for anything that is not a segment of ours.
pub fn segment_day_ms(filename: &str) -> Option<i64> {
    let stem = filename
        .strip_suffix(".ndjson.gz")
        .or_else(|| filename.strip_suffix(".ndjson"))?;
    let b = stem.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    if !b.iter().enumerate().all(|(i, c)| matches!(i, 4 | 7) || c.is_ascii_digit()) {
        return None;
    }
    let (y, m, d) = (
        stem[0..4].parse().ok()?,
        stem[5..7].parse().ok()?,
        stem[8..10].parse().ok()?,
    );
    // Round-trip rejects calendar-invalid names ('2026-13-99') — the store's own lesson.
    let days = days_from_civil(y, m, d)?;
    let ms = days * DAY_MS;
    if d > 28 {
        // cheap validity check: rebuild the civil date and compare
        let (ry, rm, rd) = civil_from_days(days);
        if (ry, rm, rd) != (y, m, d) {
            return None;
        }
    }
    Some(ms)
}

pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn extract_line(line: &str, out: &mut ScanResult, since: i64, until: i64) {
    // Conservative-safe prefilter, identical rationale to the TS scan: any line whose parse would
    // yield one of the two names necessarily contains it as a substring; false positives are
    // discarded by the name check after one parse, false negatives are impossible.
    if !(line.contains(API_REQUEST_SPAN) || line.contains(COMPACTION_SPAN)) {
        return;
    }
    let Ok(span) = serde_json::from_str::<RawSpan>(line) else { return };
    if span.name != API_REQUEST_SPAN && span.name != COMPACTION_SPAN {
        return;
    }
    out.spans_scanned += 1;
    let attrs = Attrs(
        span.attributes
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .filter_map(|a| a.value.as_ref().map(|v| (a.key.as_str(), v)))
            .collect(),
    );
    let Some(session_id) = attrs.s("session.id") else { return };
    let ts = event_time_ms(&span, &attrs);
    if ts < since || ts > until {
        return;
    }
    if span.name == COMPACTION_SPAN {
        out.compactions.push(CompactionEvent {
            ts,
            session_id,
            trigger: attrs.s("trigger"),
            pre_tokens: attrs.n("pre_tokens").map(|f| f as i64),
            post_tokens: attrs.n("post_tokens").map(|f| f as i64),
        });
        return;
    }
    let cost_usd = attrs
        .n("cost_usd_micros")
        .map(|m| m / 1e6)
        .or_else(|| attrs.n("cost_usd"));
    out.events.push(CallEvent {
        ts,
        session_id,
        request_id: attrs.s("request_id"),
        model: attrs.s("model"),
        input_tokens: attrs.n0("input_tokens"),
        output_tokens: attrs.n0("output_tokens"),
        cache_read_tokens: attrs.n0("cache_read_tokens"),
        cache_create_tokens: attrs.n0("cache_creation_tokens"),
        cost_usd,
        query_source: attrs.s("query_source"),
        speed: attrs.s("speed"),
        effort: attrs.s("effort"),
        agent_name: attrs.s("agent.name"),
    });
}

fn scan_segment(path: &Path, since: i64, until: i64) -> std::io::Result<ScanResult> {
    let mut out = ScanResult { segments_visited: 1, ..Default::default() };
    let file = fs::File::open(path)?;
    let reader: Box<dyn Read> = if path.extension().is_some_and(|e| e == "gz") {
        Box::new(flate2::read::GzDecoder::new(file))
    } else {
        Box::new(file)
    };
    for line in BufReader::with_capacity(1 << 20, reader).lines() {
        // A truncated/corrupt tail line is skipped, never fatal — same contract as the TS store.
        let Ok(line) = line else { break };
        extract_line(&line, &mut out, since, until);
    }
    Ok(out)
}

/// Walk every segment whose day could overlap [since, until], one rayon task per file.
/// Segment selection is by DAY (±1 day slack for edge-ts spans living in a neighbor segment),
/// per-event filtering by the event's own ts — the same two-level windowing the TS store uses.
pub fn scan_call_events(spans_dir: &Path, since: i64, until: i64) -> std::io::Result<ScanResult> {
    let mut segments: Vec<PathBuf> = Vec::new();
    for entry in fs::read_dir(spans_dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(day_ms) = segment_day_ms(name) else { continue };
        if day_ms.saturating_sub(DAY_MS) <= until && day_ms + 2 * DAY_MS > since {
            segments.push(entry.path());
        }
    }
    let parts: Vec<ScanResult> = segments
        .par_iter()
        .map(|p| scan_segment(p, since, until).unwrap_or_default())
        .collect();

    let mut out = ScanResult::default();
    for p in parts {
        out.spans_scanned += p.spans_scanned;
        out.segments_visited += p.segments_visited;
        out.events.extend(p.events);
        out.compactions.extend(p.compactions);
    }
    // A day present as BOTH .ndjson and .ndjson.gz (mid-compression) would double its events —
    // dedupe by request identity, then time-order, matching the TS assembly.
    out.events.sort_by(|a, b| a.ts.cmp(&b.ts).then_with(|| a.session_id.cmp(&b.session_id)));
    out.events.dedup_by(|a, b| match (&a.request_id, &b.request_id) {
        (Some(x), Some(y)) => x == y,
        _ => a == b,
    });
    out.compactions.sort_by_key(|c| c.ts);
    out.compactions.dedup();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_parse_matches_known_epochs() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_ms("2026-06-01T12:00:00Z"), Some(1_780_315_200_000));
        assert_eq!(parse_iso_ms("2026-06-01T14:00:00+02:00"), Some(1_780_315_200_000));
        assert_eq!(parse_iso_ms("2026-06-01T12:00:00.250Z"), Some(1_780_315_200_250));
        assert_eq!(parse_iso_ms("not a date"), None);
    }

    #[test]
    fn segment_names_follow_the_store_contract() {
        assert!(segment_day_ms("2026-08-18.ndjson").is_some());
        assert!(segment_day_ms("2026-08-17.ndjson.gz").is_some());
        assert_eq!(segment_day_ms("2026-13-99.ndjson"), None, "calendar-invalid must be rejected");
        assert_eq!(segment_day_ms("index.json"), None);
        assert_eq!(segment_day_ms("2026-08-18.calls.json"), None);
    }
}
