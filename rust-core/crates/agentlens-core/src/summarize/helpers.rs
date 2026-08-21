//! Port of src/summarizers/helpers.ts (TRDD-DMWOBWFH P4d) — the shared attribute accessors and
//! formatting utilities every session builder leans on. Parity is the law here, and the traps
//! are all JS coercion semantics:
//!   - `String(doubleValue)` prints integral doubles WITHOUT ".0" (String(2) === "2");
//!   - `a || b` chains pick the first NON-ZERO/non-empty value, not the first present one;
//!   - `BigInt(nanos) / 1_000_000n` truncates toward zero, and a non-digit string falls back to
//!     `parseInt(...)/1e6` (prefix parse);
//!   - `Date.parse` here only ever sees ISO strings in real spans — the strict ISO parser
//!     matches the logscan/ingest precedent (exotic Date.parse forms are deliberately out).
//!
//! Spans are `serde_json::Value` objects (the same shape the store persists), not a typed
//! struct: the builders read a handful of fields and the wire keeps whatever else is there.

use serde_json::{Map, Value};
use std::sync::OnceLock;

pub const CLAUDE_WRITE_TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
pub const FULL_WRITE_TOOLS: [&str; 2] = ["Write", "create_file"];

/// JS number → JSON value: integral prints bare (JSON.stringify(2) === "2").
pub fn num(v: f64) -> Value {
    if v.fract() == 0.0 && v.is_finite() && v.abs() < 9.007_199_254_740_992e15 {
        Value::from(v as i64)
    } else {
        Value::from(v)
    }
}

/// new Date(ms).toISOString() — always the .000Z millisecond form.
pub fn iso_from_ms(ms: f64) -> String {
    let ms = ms as i64;
    let (days, mut rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    let (y, mo, d) = civil_from_days(days);
    let h = rem / 3_600_000;
    rem %= 3_600_000;
    let mi = rem / 60_000;
    rem %= 60_000;
    let s = rem / 1000;
    let msec = rem % 1000;
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{msec:03}Z")
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// JS truthiness for the `if (x)` guards — '' and 0 and null are falsy.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

// ── Span-shape accessors shared by the session builders ──────────────────────

pub fn name_of(s: &Value) -> &str {
    s.get("name").and_then(Value::as_str).unwrap_or("")
}

pub fn start_time(s: &Value) -> &str {
    s.get("startTime").and_then(Value::as_str).unwrap_or("")
}

pub fn status_is_error(s: &Value) -> bool {
    s.get("status").and_then(|st| st.get("code")).and_then(Value::as_i64) == Some(2)
}

pub fn status_message(s: &Value) -> Option<&str> {
    s.get("status").and_then(|st| st.get("message")).and_then(Value::as_str).filter(|m| !m.is_empty())
}

/// Insert `spanId` only when the span carries one — TS writes the raw field and stringify drops
/// an undefined.
pub fn put_span_id(obj: &mut Map<String, Value>, span: &Value) {
    if let Some(id) = span.get("spanId") {
        if !id.is_null() {
            obj.insert("spanId".into(), id.clone());
        }
    }
}

/// Insertion-ordered mirror of a JS `Set<any>`: dedup by the JSON serialization, which matches
/// SameValueZero for the strings and numbers real tool args carry (a string "5" serializes as
/// `"5"`, the number 5 as `5` — distinct, exactly as in JS).
#[derive(Default)]
pub struct JsSet {
    seen: std::collections::HashSet<String>,
    items: Vec<Value>,
}

impl JsSet {
    pub fn add(&mut self, v: Value) {
        if self.seen.insert(v.to_string()) {
            self.items.push(v);
        }
    }
    pub fn add_str(&mut self, s: String) {
        self.add(Value::String(s));
    }
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
    pub fn into_value(self) -> Value {
        Value::Array(self.items)
    }
}

fn attrs(span: &Value) -> &[Value] {
    span.get("attributes").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn attr_value<'a>(span: &'a Value, key: &str) -> Option<&'a Value> {
    attrs(span)
        .iter()
        .find(|a| a.get("key").and_then(Value::as_str) == Some(key))
        .and_then(|a| a.get("value"))
}

/// `String(x)` for the JSON values an attribute can carry — the integral-double case must print
/// "2", never "2.0", or every stringified numeric attr diverges from the TS wire.
pub fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(f) = n.as_f64() {
                if f.fract() == 0.0 && f.is_finite() && f.abs() < 1e21 {
                    format!("{}", f as i64)
                } else {
                    format!("{f}")
                }
            } else {
                n.to_string()
            }
        }
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_owned(),
        other => other.to_string(),
    }
}

/// `Number(x)` for the same values — NaN-producing inputs coerce to 0 at the call sites
/// (`Number(...) || 0`), so this returns 0.0 where TS would produce NaN.
pub fn js_number(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                0.0 // Number('') === 0
            } else {
                t.parse::<f64>().unwrap_or(0.0)
            }
        }
        Value::Bool(true) => 1.0,
        _ => 0.0,
    }
}

/// getAttrStr: String(stringValue ?? intValue ?? doubleValue ?? '').
pub fn get_attr_str(span: &Value, key: &str) -> String {
    let Some(v) = attr_value(span, key) else { return String::new() };
    for k in ["stringValue", "intValue", "doubleValue"] {
        if let Some(x) = v.get(k) {
            if !x.is_null() {
                return js_string(x);
            }
        }
    }
    String::new()
}

/// getAttrInt: Number(intValue ?? doubleValue ?? stringValue ?? 0) || 0. Returns f64 because
/// Number("1.5") is 1.5 in TS and the sum flows into the wire as-is.
pub fn get_attr_num(span: &Value, key: &str) -> f64 {
    let Some(v) = attr_value(span, key) else { return 0.0 };
    for k in ["intValue", "doubleValue", "stringValue"] {
        if let Some(x) = v.get(k) {
            if !x.is_null() {
                let n = js_number(x);
                return if n.is_finite() { n } else { 0.0 };
            }
        }
    }
    0.0
}

/// getFirstAttr: first key whose getAttrStr is non-empty.
pub fn get_first_attr(span: &Value, keys: &[&str]) -> String {
    for key in keys {
        let v = get_attr_str(span, key);
        if !v.is_empty() {
            return v;
        }
    }
    String::new()
}

/// gen_ai.system → gen_ai.provider.name rename shim.
pub fn get_gen_ai_system(span: &Value) -> String {
    get_first_attr(span, &["gen_ai.system", "gen_ai.provider.name"])
}

pub fn get_gen_ai_model(span: &Value) -> String {
    get_first_attr(span, &["gen_ai.request.model", "gen_ai.response.model", "model"])
}

/// nanoToMs: BigInt(s || '0') / 1_000_000n (truncation toward zero); non-digit input falls back
/// to parseInt(s)/1e6 (prefix parse), else 0.
pub fn nano_to_ms(nano: &str) -> f64 {
    let s = if nano.is_empty() { "0" } else { nano };
    let (neg, digits) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s),
    };
    if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
        if let Ok(n) = digits.parse::<i128>() {
            let q = n / 1_000_000;
            return if neg { -(q as f64) } else { q as f64 };
        }
    }
    // parseInt: leading whitespace + optional sign + digit prefix.
    let t = s.trim_start();
    let (sign, rest) = match t.as_bytes().first() {
        Some(b'-') => (-1.0, &t[1..]),
        Some(b'+') => (1.0, &t[1..]),
        _ => (1.0, t),
    };
    let end = rest.bytes().position(|b| !b.is_ascii_digit()).unwrap_or(rest.len());
    if end == 0 {
        return 0.0;
    }
    rest[..end].parse::<f64>().map(|n| sign * n / 1e6).unwrap_or(0.0)
}

/// Strict-ISO Date.parse subset — the only string form real spans carry. Same contract as the
/// ingest/logscan parsers (which are pinned by their own parity tests).
pub fn parse_iso_ms(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> { s.get(r).and_then(|x| x.parse().ok()) };
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (mut h, mut mi, mut sec, mut ms) = (0i64, 0i64, 0i64, 0i64);
    let mut tz_offset_min = 0i64;
    if b.len() > 10 {
        if b[10] != b'T' && b[10] != b' ' {
            return None;
        }
        h = num(11..13)?;
        mi = num(14..16)?;
        if b.len() >= 19 && b[16] == b':' {
            sec = num(17..19)?;
        }
        let mut i = 19;
        if b.len() > i && b[i] == b'.' {
            let start = i + 1;
            let mut end = start;
            while end < b.len() && b[end].is_ascii_digit() {
                end += 1;
            }
            let frac = &s[start..end];
            let scaled = format!("{:0<3}", &frac[..frac.len().min(3)]);
            ms = scaled.parse().ok()?;
            i = end;
        }
        if b.len() > i {
            match b[i] {
                b'Z' | b'z' => {}
                b'+' | b'-' => {
                    let sign = if b[i] == b'+' { 1 } else { -1 };
                    let hh: i64 = s.get(i + 1..i + 3)?.parse().ok()?;
                    let rest = i + 3 + usize::from(b.get(i + 3) == Some(&b':'));
                    let mm: i64 = s.get(rest..rest + 2)?.parse().ok()?;
                    tz_offset_min = sign * (hh * 60 + mm);
                }
                _ => return None,
            }
        }
    }
    let days = days_from_civil(y, mo, d);
    Some(((days * 86_400 + h * 3600 + mi * 60 + sec - tz_offset_min * 60) * 1000 + ms) as f64)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// timestampToMs: number → itself; all-digit string → nanoToMs; else Date.parse (ISO subset).
pub fn timestamp_to_ms(value: Option<&Value>) -> f64 {
    let Some(v) = value else { return 0.0 };
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) if s.is_empty() => 0.0,
        Value::String(s) => {
            if s.bytes().all(|b| b.is_ascii_digit()) && !s.is_empty() {
                nano_to_ms(s)
            } else {
                parse_iso_ms(s).unwrap_or(0.0)
            }
        }
        _ => 0.0,
    }
}

fn re(cell: &'static OnceLock<regex::Regex>, pattern: &str) -> &'static regex::Regex {
    cell.get_or_init(|| regex::Regex::new(pattern).expect("static regex compiles"))
}

/// extractUserRequest: the <userRequest> wrap, the Codex "## My request:" form, then IDE-tag
/// stripping, each capped at 5000 UTF-16 code units (js_slice — JS .slice semantics).
pub fn extract_user_request(raw: &str) -> String {
    static USER_REQ: OnceLock<regex::Regex> = OnceLock::new();
    static CODEX: OnceLock<regex::Regex> = OnceLock::new();
    static CAVEAT: OnceLock<regex::Regex> = OnceLock::new();
    static IDE: OnceLock<regex::Regex> = OnceLock::new();
    let trimmed = raw.trim();
    let cap = |s: &str| -> String { js_slice(s, 5000).to_owned() };
    if trimmed.contains("<userRequest>") {
        let r = re(&USER_REQ, r"(?s)<userRequest>\s*(.*?)\s*</userRequest>");
        if let Some(m) = r.captures(trimmed).and_then(|c| c.get(1)) {
            let t = m.as_str().trim();
            if !t.is_empty() {
                return t.to_owned();
            }
        }
        return cap(trimmed);
    }
    let r = re(&CODEX, r"(?si)(?:^|\n)##\s+My request(?:\s+for\s+[^\n:]+)?:\s*\n(.*)$");
    if let Some(m) = r.captures(trimmed).and_then(|c| c.get(1)) {
        let t = m.as_str().trim();
        if !t.is_empty() {
            return cap(t);
        }
    }
    let stripped = re(&CAVEAT, r"(?si)<local-command-caveat>.*?</local-command-caveat>\s*").replace_all(trimmed, "");
    let stripped = re(&IDE, r"(?si)<ide_[^>]*>.*?</ide_[^>]*>").replace_all(&stripped, "");
    let stripped = stripped.trim();
    if !stripped.is_empty() {
        return cap(stripped);
    }
    cap(trimmed)
}

pub fn is_codex_tool_span_name(name: &str) -> bool {
    name == "codex.tool_result"
        || name == "codex.tool"
        || name == "codex.tool_decision"
        || name == "codex.tool.call"
        || name == "exec_command"
        || name == "apply_patch"
        || name.contains(".tool")
}

pub fn is_codex_tool_exec_span(span: &Value) -> bool {
    if is_codex_tool_span_name(span.get("name").and_then(Value::as_str).unwrap_or("")) {
        return true;
    }
    !get_attr_str(span, "call_id").is_empty() && !get_attr_str(span, "tool_name").is_empty()
}

pub fn is_codex_llm_span_name(name: &str) -> bool {
    name == "codex.stream_event"
        || name == "codex.completion"
        || name == "codex.response"
        || name == "codex.sse_event"
        || name.contains("stream")
        || name.contains("completion")
        || name.contains("response")
}

/// isCodexPromptSpanName — TS re-exports isCodexPromptEventName from codexSessionNormalizer;
/// the Rust single source is the ingest crate's normalizer, delegated to directly (this crate
/// already depends on it — the earlier hand-mirrored list had silently drifted from the TS one,
/// which is exactly the failure mode single-sourcing exists to prevent).
pub fn is_codex_prompt_span_name(name: &str) -> bool {
    agentlens_ingest::is_codex_prompt_event_name(name)
}

pub fn is_codex_tool_decision_span(name: &str) -> bool {
    name == "codex.tool_decision"
}

pub fn is_codex_tool_call_span(name: &str) -> bool {
    name == "codex.tool.call"
}

pub fn is_codex_tool_result_span(name: &str) -> bool {
    name == "codex.tool_result"
}

/// extractTokenCounts — the `||` chains are FIRST-NON-ZERO, and output falls back to the sum of
/// Codex's split counters only when every standard key is zero.
pub struct TokenCounts {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_create: f64,
}

pub fn first_nonzero(span: &Value, keys: &[&str]) -> f64 {
    for k in keys {
        let v = get_attr_num(span, k);
        if v != 0.0 {
            return v;
        }
    }
    0.0
}

pub fn extract_token_counts(span: &Value) -> TokenCounts {
    let input = first_nonzero(span, &[
        "gen_ai.usage.input_tokens", "input_tokens", "prompt_tokens", "input_token_count",
        "codex.turn.token_usage.input_tokens",
    ]);
    let cache_read = first_nonzero(span, &[
        "gen_ai.usage.cache_read.input_tokens", "cache_read_tokens", "cached_token_count",
        "codex.turn.token_usage.cached_input_tokens",
    ]);
    let cache_create = first_nonzero(span, &["gen_ai.usage.cache_creation.input_tokens", "cache_creation_tokens"]);
    let output_std = first_nonzero(span, &[
        "gen_ai.usage.output_tokens", "output_tokens", "completion_tokens",
        "codex.turn.token_usage.output_tokens",
    ]);
    let output = if output_std != 0.0 {
        output_std
    } else {
        get_attr_num(span, "output_token_count") + get_attr_num(span, "reasoning_token_count")
    };
    TokenCounts { input, output, cache_read, cache_create }
}

/// normalizeUserRequest — redaction labels mirror the TS strings byte-for-byte.
pub fn normalize_user_request(raw: &str, length: f64, fallback: &str, redaction_note: Option<&str>) -> String {
    let is_redacted = raw.is_empty() || raw == "<REDACTED>" || raw == "[REDACTED]";
    if !is_redacted {
        return extract_user_request(raw);
    }
    if length > 0.0 {
        return match redaction_note {
            Some(note) => format!("[{} chars — {note}]", fmt_js_num(length)),
            None => format!("[~{} chars]", fmt_js_num(length)),
        };
    }
    fallback.to_owned()
}

/// JS number→string for interpolation (`${n}`): integral prints bare.
pub fn fmt_js_num(n: f64) -> String {
    if n.fract() == 0.0 && n.is_finite() && n.abs() < 1e21 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// `Number.prototype.toLocaleString()` under the en-US default — thousands grouping, and AT MOST
/// THREE fraction digits (`Intl.NumberFormat`'s `maximumFractionDigits` default), rounded half away
/// from zero. What Node on this machine produces; a different ICU default fails the pinning
/// fixtures loudly.
///
/// The fraction half is load-bearing, not decoration: `formatCostPeaks` renders `bucketValue`
/// through this, and under `bucket=billable_weighted` that value is a USD cost — 4.5585 must read
/// "4.559". Truncating instead (which this did while every caller happened to pass an integer)
/// silently prints "4" for a $4.56 group.
///
/// Intl rounds the double's SHORTEST decimal representation — the same digits `toString` emits —
/// so `fmt_js_num` is the right source string, and comparing the FOURTH fraction digit against '5'
/// reproduces halfExpand exactly (a trailing "4999…" rounds down, an exact "…5" rounds up).
pub fn to_locale_en(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_owned();
    }
    if n.is_infinite() {
        return if n < 0.0 { "-∞".to_owned() } else { "∞".to_owned() };
    }
    let neg = n < 0.0;
    let s = fmt_js_num(n.abs());
    let (int_s, frac_s) = match s.split_once('.') {
        Some((i, f)) => (i.to_owned(), f.to_owned()),
        None => (s, String::new()),
    };
    let (int_s, frac_s) = round_fraction(&int_s, &frac_s, 3);

    let mut grouped = String::new();
    let bytes = int_s.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 && (bytes.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(*b as char);
    }
    let sign = if neg && !(grouped == "0" && frac_s.is_empty()) { "-" } else { "" };
    if frac_s.is_empty() {
        format!("{sign}{grouped}")
    } else {
        format!("{sign}{grouped}.{frac_s}")
    }
}

/// Round a decimal already split into integer/fraction DIGIT STRINGS to `digits` fraction places,
/// half away from zero, carrying into the integer part. Trailing zeros are dropped afterwards
/// because Intl's `minimumFractionDigits` default is 0.
fn round_fraction(int_s: &str, frac_s: &str, digits: usize) -> (String, String) {
    if frac_s.len() <= digits {
        return (int_s.to_owned(), frac_s.trim_end_matches('0').to_owned());
    }
    let mut kept: Vec<u8> = frac_s.as_bytes()[..digits].to_vec();
    let round_up = frac_s.as_bytes()[digits] >= b'5';
    let mut int_digits: Vec<u8> = int_s.as_bytes().to_vec();
    if round_up {
        let mut carry = true;
        for d in kept.iter_mut().rev() {
            if !carry {
                break;
            }
            if *d == b'9' {
                *d = b'0';
            } else {
                *d += 1;
                carry = false;
            }
        }
        if carry {
            for d in int_digits.iter_mut().rev() {
                if *d == b'9' {
                    *d = b'0';
                } else {
                    *d += 1;
                    carry = false;
                    break;
                }
            }
            if carry {
                int_digits.insert(0, b'1');
            }
        }
    }
    let kept = String::from_utf8(kept).unwrap_or_default();
    (String::from_utf8(int_digits).unwrap_or_default(), kept.trim_end_matches('0').to_owned())
}

/// `String.prototype.padStart` — pads to a length in UTF-16 units. Every value padded through here
/// is ASCII (formatted numbers, ids), so char count and code-unit count coincide.
pub fn pad_start(s: &str, width: usize) -> String {
    let len = s.chars().count();
    if len >= width {
        return s.to_owned();
    }
    format!("{}{}", " ".repeat(width - len), s)
}

/// `String.prototype.padEnd` — the same contract, padding on the right.
pub fn pad_end(s: &str, width: usize) -> String {
    let len = s.chars().count();
    if len >= width {
        return s.to_owned();
    }
    format!("{}{}", s, " ".repeat(width - len))
}

/// `x.toFixed(d)` as a STRING — which is NOT `fmt_js_num(js_to_fixed_num(..))`: toFixed PADS
/// trailing zeros, so `(1.5).toFixed(2)` is "1.50" while the numeric round-trip prints "1.5".
/// `js_to_fixed_num` does the (exact, tie-aware) rounding; `{:.d}` only renders the already-rounded
/// value. The `-0` guard is load-bearing: JS `(-0).toFixed(2)` is "0.00" while Rust's formatter
/// prints "-0.00", and a share/fill percentage that rounds down to zero from a tiny negative is
/// exactly where that shows up.
pub fn js_to_fixed_str(x: f64, digits: usize) -> String {
    let v = js_to_fixed_num(x, digits as u32);
    let v = if v == 0.0 { 0.0 } else { v };
    format!("{:.*}", digits, v)
}

/// `+x.toFixed(f)` — JS toFixed read back as a number. The spec rounds on the EXACT decimal
/// expansion of the double (nearest n/10^f, ties to the LARGER n), which neither `(x*p).round()`
/// nor Rust's `{:.f}` reproduces: the float product can land on the wrong side of the half
/// (1.86805.toFixed(4) is "1.8680" — the double is just under the tie — while ×10⁴ rounds up),
/// and Rust's formatter breaks exact ties to EVEN where JS goes AWAY (0.125 → "0.12" vs "0.13").
/// So decompose the double as m×2^e and round m·10^f / 2^-e in integer arithmetic — exact.
pub fn js_to_fixed_num(x: f64, digits: u32) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let neg = x.is_sign_negative();
    let ax = x.abs();
    let bits = ax.to_bits();
    let exp_field = ((bits >> 52) & 0x7ff) as i64;
    let frac = bits & ((1u64 << 52) - 1);
    let (m, e): (u64, i64) = if exp_field == 0 { (frac, -1074) } else { (frac | (1u64 << 52), exp_field - 1075) };
    if e >= 0 {
        // An integer-valued double: every fractional digit is 0, toFixed returns x itself.
        return x;
    }
    let pow10 = 10u128.pow(digits);
    let k = (-e) as u32;
    let q: u128 = if k > 100 {
        // x < 2^53 / 2^100 ≈ 7e-15 — rounds to 0 at every precision this codebase uses (≤6).
        0
    } else {
        let n = (m as u128) * pow10; // ≤ 2^53 · 10^6 < 2^73 — exact in u128
        let q = n >> k;
        let r = n - (q << k);
        if r >= (1u128 << (k - 1)) { q + 1 } else { q }
    };
    let v = q as f64 / pow10 as f64;
    if neg { -v } else { v }
}

/// `Math.round` — half toward +∞ (Rust's `round` is half away from zero, which differs on
/// negative halves: Math.round(-2.5) = -2).
pub fn js_math_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// commonPathPrefix — including the trailing-file pop (a last segment containing a dot).
pub fn common_path_prefix(paths: &[String]) -> String {
    let abs: Vec<Vec<&str>> = paths
        .iter()
        .filter(|p| p.starts_with('/'))
        .map(|p| p.split('/').filter(|s| !s.is_empty()).collect())
        .collect();
    if abs.is_empty() {
        return String::new();
    }
    let first = &abs[0];
    let mut common = 0;
    for i in 0..first.len() {
        if abs.iter().all(|parts| parts.get(i) == Some(&first[i])) {
            common = i + 1;
        } else {
            break;
        }
    }
    if common == 0 {
        return String::new();
    }
    let mut prefix: Vec<&str> = first[..common].to_vec();
    if prefix.last().is_some_and(|s| s.contains('.')) {
        prefix.pop();
    }
    if prefix.is_empty() {
        String::new()
    } else {
        format!("/{}", prefix.join("/"))
    }
}

/// findProjectRoot — walks up to the first dir holding .git or package.json.
pub fn find_project_root(start_dir: &str) -> String {
    if start_dir.is_empty() || !start_dir.starts_with('/') {
        return start_dir.to_owned();
    }
    let mut dir = std::path::PathBuf::from(start_dir);
    loop {
        if dir.join(".git").exists() || dir.join("package.json").exists() {
            return dir.to_string_lossy().into_owned();
        }
        match dir.parent() {
            Some(p) if p != dir => dir = p.to_path_buf(),
            _ => break,
        }
    }
    start_dir.to_owned()
}

/// extractResponseText — first assistant message's text (string content or text parts).
pub fn extract_response_text(output_messages: &str) -> Option<String> {
    if output_messages.is_empty() {
        return None;
    }
    let msgs: Value = serde_json::from_str(output_messages).ok()?;
    for msg in msgs.as_array()? {
        if msg.get("role").and_then(Value::as_str) == Some("assistant") {
            if let Some(c) = msg.get("content").and_then(Value::as_str) {
                if !c.trim().is_empty() {
                    return Some(c.to_owned());
                }
            }
            if let Some(parts) = msg.get("content").and_then(Value::as_array) {
                let texts: Vec<&str> = parts
                    .iter()
                    .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                    .filter(|t| !t.is_empty())
                    .collect();
                if !texts.is_empty() {
                    return Some(texts.join("\n"));
                }
            }
        }
    }
    None
}

/// detectOutputAction — the tool-name scrape mirrors the TS global regex.
pub fn detect_output_action(output_messages: &str) -> String {
    static NAME: OnceLock<regex::Regex> = OnceLock::new();
    if output_messages.is_empty() {
        return "unknown".to_owned();
    }
    if output_messages.contains("\"tool_call\"") {
        let r = re(&NAME, r#""name"\s*:\s*"([^"]+)""#);
        let names: Vec<&str> = r.captures_iter(output_messages).filter_map(|c| c.get(1)).map(|m| m.as_str()).collect();
        if !names.is_empty() {
            return format!("called {}", names.join(", "));
        }
        return "tool_calls".to_owned();
    }
    "text response".to_owned()
}

/// `${x}` interpolation for possibly-absent JSON values — JS prints the literal "undefined",
/// and read_file summaries really do render "Lundefined-undefined" when args lack the lines.
fn interp(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "undefined".to_owned(),
        Some(x) => js_string(x),
    }
}

fn str_or<'a>(v: Option<&'a Value>, default: &'a str) -> &'a str {
    v.and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(default)
}

/// `.slice(0, n)` counting UTF-16 CODE UNITS exactly as JS `.length`/`.slice` do. The byte-cap
/// shortcut this replaced diverged on EVERY long string containing an em-dash or smart quote —
/// the P4d e2e real-window replay caught truncated userRequests immediately. The one remaining
/// divergence: a cap landing mid-surrogate-pair keeps the whole char out (JS would keep a lone
/// surrogate, which a Rust String cannot represent).
/// JS `.length` — UTF-16 CODE UNITS, not bytes and not chars. An emoji is 1 char, 4 bytes, and
/// **2** here, so every cap, offset and hash that must agree with the TS measures through this.
///
/// Was duplicated privately in seven modules; they agreed by luck rather than by construction
/// (one had drifted to `encode_utf16().count()` — same answer, different code to keep in step).
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(n)` — the REST of the string from UTF-16 offset `n`. The mirror of `js_slice`, which
/// takes the first `n`. `s.slice(-n)` (the LAST n units) is `js_slice_from(s, utf16_len(s) - n)`.
pub fn js_slice_from(s: &str, n: usize) -> &str {
    let mut units = 0usize;
    for (i, c) in s.char_indices() {
        if units >= n {
            return &s[i..];
        }
        units += c.len_utf16();
    }
    ""
}

/// `s.slice(0, n)` — the FIRST `n` UTF-16 code units. This IS the "utf16_slice" other crates
/// define privately; it lives here under the JS name it ports.
pub fn js_slice(s: &str, n: usize) -> &str {
    let mut units = 0usize;
    for (i, c) in s.char_indices() {
        let u = c.len_utf16();
        if units + u > n {
            return &s[..i];
        }
        units += u;
    }
    s
}

fn basename(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

/// summarizeToolArgs — port of the per-tool switch, JS-quirks included.
pub fn summarize_tool_args(tool_name: &str, args_json: &str) -> String {
    static PATCH_LINE: OnceLock<regex::Regex> = OnceLock::new();
    let Ok(args) = serde_json::from_str::<Value>(args_json) else {
        return js_slice(args_json, 80).to_owned();
    };
    match tool_name {
        "read_file" => {
            let fp = args.get("filePath").and_then(Value::as_str).unwrap_or("");
            let file = basename(fp);
            let file = if file.is_empty() { interp(args.get("filePath")) } else { file.to_owned() };
            format!("{file} L{}-{}", interp(args.get("startLine")), interp(args.get("endLine")))
        }
        "file_search" => str_or(args.get("query"), js_slice(args_json, 80)).to_owned(),
        "grep_search" => {
            format!("\"{}\" in {}", str_or(args.get("query"), "?"), str_or(args.get("includePattern"), "*"))
        }
        "list_dir" => {
            let p = args.get("path").and_then(Value::as_str).unwrap_or("");
            let last = p.split('/').filter(|s| !s.is_empty()).next_back().unwrap_or(p);
            last.to_owned()
        }
        "manage_todo_list" => {
            let items = args.get("todoList").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
            // Insertion-order status counts (Object key order in JS).
            let mut counts: Vec<(String, u64)> = Vec::new();
            for it in items {
                let s = it.get("status").map(js_string).unwrap_or_else(|| "undefined".to_owned());
                match counts.iter_mut().find(|(k, _)| *k == s) {
                    Some((_, n)) => *n += 1,
                    None => counts.push((s, 1)),
                }
            }
            let parts: Vec<String> = counts.iter().map(|(s, n)| format!("{n} {s}")).collect();
            format!("{} items ({})", items.len(), parts.join(", "))
        }
        "semantic_search" => format!("\"{}\"", js_slice(args.get("query").and_then(Value::as_str).unwrap_or(""), 60)),
        "replace_string_in_file" | "multi_replace_string_in_file" => {
            let f = basename(args.get("filePath").and_then(Value::as_str).unwrap_or(""));
            if f.is_empty() { "edit".to_owned() } else { f.to_owned() }
        }
        "create_file" => {
            let f = basename(args.get("filePath").and_then(Value::as_str).unwrap_or(""));
            if f.is_empty() { "new file".to_owned() } else { f.to_owned() }
        }
        "apply_patch" => {
            let content = ["command", "patch", "input"]
                .iter()
                .find_map(|k| args.get(*k).and_then(Value::as_str).filter(|s| !s.is_empty()))
                .unwrap_or("");
            let r = re(&PATCH_LINE, r"^\*\*\*\s+(?:Update File:|Add File:|Delete File:)?\s*(.+)");
            let mut files: Vec<String> = Vec::new();
            for line in content.split('\n') {
                if let Some(m) = r.captures(line).and_then(|c| c.get(1)) {
                    let fp = m.as_str().trim();
                    if fp.contains('/') {
                        files.push(basename(fp).to_owned());
                    }
                }
            }
            files.retain(|f| !f.is_empty());
            if files.is_empty() { "patch".to_owned() } else { files.join(", ") }
        }
        "run_in_terminal" => js_slice(args.get("command").and_then(Value::as_str).unwrap_or(""), 80).to_owned(),
        "vscode_askQuestions" => {
            let n = args.get("questions").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
            format!("{n} question(s)")
        }
        "explore_subagent" | "runSubagent" => {
            let d = ["description", "query"]
                .iter()
                .find_map(|k| args.get(*k).and_then(Value::as_str).filter(|s| !s.is_empty()))
                .unwrap_or("");
            js_slice(d, 60).to_owned()
        }
        _ => js_slice(args_json, 80).to_owned(),
    }
}

/// summarizeToolResult — NOTE `${(len/1024).toFixed(1)}KB`: Rust's {:.1} rounds half-to-even
/// where toFixed leans half-away; a real divergence needs len to land exactly on a 51.2-byte
/// half-boundary, accepted and documented.
pub fn summarize_tool_result(tool_name: &str, result: &str) -> String {
    static GREP_N: OnceLock<regex::Regex> = OnceLock::new();
    static FILE_N: OnceLock<regex::Regex> = OnceLock::new();
    if result.is_empty() {
        return "empty".to_owned();
    }
    if result == "No todo list found." {
        return "no list".to_owned();
    }
    let len = result.chars().map(|c| c.len_utf16()).sum::<usize>();
    if len < 50 {
        return result.to_owned();
    }
    if tool_name == "grep_search" {
        if let Some(m) = re(&GREP_N, r"(\d+)\s+match").captures(result).and_then(|c| c.get(1)) {
            return format!("{} matches", m.as_str());
        }
    }
    if tool_name == "file_search" {
        if let Some(m) = re(&FILE_N, r"(\d+)\s+total result").captures(result).and_then(|c| c.get(1)) {
            return format!("{} result(s)", m.as_str());
        }
    }
    if len > 1000 {
        return format!("{:.1}KB", len as f64 / 1024.0);
    }
    format!("{len} chars")
}

#[cfg(test)]
mod utf16_tests {
    use super::{js_slice, js_slice_from, utf16_len};

    /// The three measures DISAGREE, and that is the whole point: JS `.length` is the UTF-16 one.
    /// A port that reaches for `.len()` (bytes) or `.chars().count()` (scalars) reads the same on
    /// ASCII and silently diverges the moment a caption, a path or a tool description carries an
    /// emoji — which is exactly where a cap or an offset stops matching the TS.
    #[test]
    fn utf16_len_counts_code_units_not_bytes_or_chars() {
        assert_eq!(utf16_len("abc"), 3);
        // An astral char: 1 char, 4 bytes, 2 UTF-16 units.
        assert_eq!("🔥".chars().count(), 1);
        assert_eq!("🔥".len(), 4);
        assert_eq!(utf16_len("🔥"), 2);
        // A BMP multi-byte char: 1 char, 2 bytes, 1 unit.
        assert_eq!(utf16_len("é"), 1);
        assert_eq!("é".len(), 2);
        assert_eq!(utf16_len("a🔥b"), 4);
    }

    /// They ARE complements at every boundary that does not fall inside a surrogate pair.
    #[test]
    fn js_slice_and_js_slice_from_are_complements_off_pair_boundaries() {
        let s = "a🔥bc";
        // Unit 2 is inside the pair — the one boundary where this does not hold (next test).
        for n in [0, 1, 3, 4, 5] {
            assert_eq!(format!("{}{}", js_slice(s, n), js_slice_from(s, n)), s, "split at {n}");
        }
    }

    /// **A boundary INSIDE a surrogate pair drops the character from BOTH halves.** JS splits it
    /// into two lone surrogates that re-concatenate losslessly; a Rust `&str` cannot hold a lone
    /// surrogate, so each side takes whole chars and the pair belongs to neither.
    ///
    /// This is DELIBERATE, not a bug to fix: whole-pair truncation is the honest equivalent of a
    /// lone surrogate, which JSON-encodes to U+FFFD anyway. It is pinned because it is invisible
    /// on ASCII and silently lossy on real text — anyone reassembling a string from a
    /// `js_slice` + `js_slice_from` pair at an arbitrary offset must know the char can vanish.
    #[test]
    fn a_boundary_inside_a_surrogate_pair_drops_the_char_from_both_halves() {
        let s = "a🔥bc";
        assert_eq!(js_slice(s, 2), "a");
        assert_eq!(js_slice_from(s, 2), "bc");
        assert_eq!(format!("{}{}", js_slice(s, 2), js_slice_from(s, 2)), "abc", "the emoji is gone");
        // Either side of the pair, both halves behave normally.
        assert_eq!(js_slice(s, 1), "a");
        assert_eq!(js_slice_from(s, 1), "🔥bc");
        assert_eq!(js_slice(s, 3), "a🔥");
        assert_eq!(js_slice_from(s, 3), "bc");
    }

    /// `s.slice(-n)` — the LAST n units — is `js_slice_from(s, utf16_len(s) - n)`. This is the
    /// form the burn scanner's chunk carry needs, so it is pinned here rather than re-derived.
    #[test]
    fn last_n_units_is_js_slice_from_of_the_difference() {
        let s = "hello🔥world";
        let take_last = |n: usize| js_slice_from(s, utf16_len(s).saturating_sub(n));
        assert_eq!(take_last(5), "world");
        assert_eq!(take_last(7), "🔥world");
        // A request for MORE units than exist yields the whole string, never a panic.
        assert_eq!(take_last(9999), s);
    }
}
