//! Port of src/leanResponse.ts (TRDD-DMWOBWFH P4x.2c) — the single choke point every MCP tool
//! response passes through before it leaves the server.
//!
//! WHY IT MATTERS HERE: a tool result lands in the CALLER's transcript, and the API is stateless —
//! the whole transcript is re-sent on every later turn. A 12 KB blob is not paid once, it is paid
//! again every turn until compaction. The Rust core served 9 tools raw before this landed, which
//! made every one of them a different (and more expensive) wire shape than the TS it replaces.
//!
//! Two rules the TS states and this port must not quietly "improve":
//!   - the answer/derivation split is DECLARED in `DROP_KEYS` and nowhere else. It is a DENY-list on
//!     purpose: a missing deny entry costs a few visible tokens, a missing allow entry would
//!     silently delete a tool's answer. Keep-by-default fails safe; drop-by-default fails silent.
//!   - truncation is NEVER silent. Every cut discloses itself, and the full payload stays one
//!     `verbosity: "full"` away.
//!
//! JS-ISM: every length and slice here is UTF-16 code units (`String.prototype.length`/`.slice`),
//! never bytes and never chars. The elision markers themselves contain a `…` (1 UTF-16 unit, 3
//! UTF-8 bytes), so measuring in bytes would drift the ceiling on exactly the payloads the ceiling
//! is meant to bound.

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::summarize::helpers::{js_slice, utf16_len};

const CHARS_PER_TOKEN: f64 = 4.0;
const DEFAULT_MAX_TOKENS: f64 = 1200.0;
const MAX_ROWS: usize = 5;
const MAX_STR: usize = 400;
const MAX_NESTED_ROWS: usize = 3;
/// Recursion guard ONLY — a pathology backstop, never the semantic filter. `fiveHour.pctConsumed`
/// (answer) and `fiveHour.breakdown` (derivation) sit at the SAME depth and are both all-scalar, so
/// no structural rule can separate them; `DROP_KEYS` does.
const MAX_DEPTH: usize = 4;

/// The machine-identity keys each have a human-readable sibling that survives (culpritSummary,
/// actor, cause). `remediation` is deliberately NOT here — it is genuinely part of four tools'
/// advertised answer, and dropping it made them promise a fix hint they never delivered.
const DROP_KEYS: [&str; 7] = ["rawDiffSummary", "culpritId", "actorId", "ttlTier", "bodyRef", "ref", "breakdown"];

/// `Math.ceil(JSON.stringify(v ?? '').length / 4)`. The `?? ''` matters: a null payload measures as
/// `""` (2 units → 1 token), NOT as the 4 units of `null`.
fn approx_tokens(v: &Value) -> f64 {
    let s = if v.is_null() { "\"\"".to_owned() } else { v.to_string() };
    (utf16_len(&s) as f64 / CHARS_PER_TOKEN).ceil()
}

fn clip_str(s: &str, max: usize) -> String {
    let n = utf16_len(s);
    if n <= max {
        s.to_owned()
    } else {
        format!("{}… (+{} chars)", js_slice(s, max), n - max)
    }
}

/// Collapse a verbose `coverage` object into ONE honest line — the scan scope must never be hidden,
/// but it also never needs 8 fields to be understood.
fn coverage_line(cov: Option<&Value>) -> Option<String> {
    let c = cov?.as_object()?;
    if let Some(note) = c.get("note").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        return Some(clip_str(note, 240));
    }
    if c.get("complete") == Some(&Value::Bool(true)) {
        return Some("complete scan".to_owned());
    }
    None
}

/// Row-level shaping: keep the fields carrying the ANSWER, drop the ones carrying the derivation.
///
/// `depth` is passed EXPLICITLY at every call site. The TS carries a comment about this twice
/// because `.map(shapeRow)` hands JS the array INDEX as `depth`, so element N would be shaped as if
/// it sat N levels deep and its answer would vanish at the depth guard. Rust closures do not have
/// that hazard, but the depth values must still match the TS exactly for the markers to agree.
fn shape_row(row: &Value, depth: usize) -> Value {
    match row {
        Value::String(s) => Value::String(clip_str(s, MAX_STR)),
        Value::Array(a) => Value::Array(a.iter().take(MAX_ROWS).map(|r| shape_row(r, depth)).collect()),
        Value::Object(o) => {
            let mut out = Map::new();
            for (k, v) in o {
                if DROP_KEYS.contains(&k.as_str()) || v.is_null() {
                    continue;
                }
                match v {
                    Value::String(s) => {
                        out.insert(k.clone(), Value::String(clip_str(s, 160)));
                    }
                    Value::Number(_) | Value::Bool(_) => {
                        out.insert(k.clone(), v.clone());
                    }
                    Value::Array(a) => {
                        let mut kept: Vec<Value> = a.iter().take(MAX_NESTED_ROWS).map(|r| shape_row(r, depth + 1)).collect();
                        // Disclose the cut — truncation is NEVER silent.
                        if a.len() > MAX_NESTED_ROWS {
                            kept.push(Value::String(format!(
                                "… +{} more — use verbosity:\"full\"",
                                a.len() - MAX_NESTED_ROWS
                            )));
                        }
                        out.insert(k.clone(), Value::Array(kept));
                    }
                    // Nested object: KEPT (recursing) — for a structured tool the nested object IS
                    // the answer (accounts[].budget.fiveHour.pctConsumed, risks[].evidence).
                    _ => {
                        if depth + 1 >= MAX_DEPTH {
                            out.insert(k.clone(), Value::String(format!(
                                "… {} field(s) elided at depth {MAX_DEPTH} — use verbosity:\"full\"",
                                v.as_object().map_or(0, Map::len)
                            )));
                        } else {
                            out.insert(k.clone(), shape_row(v, depth + 1));
                        }
                    }
                }
            }
            Value::Object(out)
        }
        _ => row.clone(),
    }
}

/// Truncate an array to its significant head, DISCLOSING what was dropped.
fn head_of(arr: &[Value], limit: usize, label: &str) -> (Vec<Value>, Option<String>) {
    let rows: Vec<Value> = arr.iter().take(limit).map(|r| shape_row(r, 0)).collect();
    if arr.len() <= limit {
        (rows, None)
    } else {
        (rows, Some(format!("showing top {limit} of {} {label} — call with verbosity:\"full\" for all", arr.len())))
    }
}

/// Generic shaper: verdict/notes first, then the significant head of each ranked array, then the
/// nested objects. The THREE PASSES are the wire's key ORDER — scalars, arrays, objects, coverage,
/// `_truncated` — not the input's order, so they cannot be merged into one loop.
fn shape_generic(result: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    let mut notes: Vec<Value> = Vec::new();

    // 1. Scalars + the verdict-bearing fields lead the payload — this IS the answer.
    for (k, v) in result {
        if k == "coverage" {
            continue;
        }
        match v {
            Value::String(s) => {
                out.insert(k.clone(), Value::String(clip_str(s, if k == "verdict" { 600 } else { MAX_STR })));
            }
            Value::Number(_) | Value::Bool(_) => {
                out.insert(k.clone(), v.clone());
            }
            _ => {}
        }
    }

    // 2. Arrays → truncated heads, each disclosing its own truncation.
    for (k, v) in result {
        let Some(a) = v.as_array().filter(|a| !a.is_empty()) else { continue };
        let (rows, note) = head_of(a, MAX_ROWS, k);
        out.insert(k.clone(), Value::Array(rows));
        if let Some(n) = note {
            notes.push(Value::String(format!("{k}: {n}")));
        }
    }

    // 3. Nested objects.
    for (k, v) in result {
        if k == "coverage" || !v.is_object() {
            continue;
        }
        let shaped = shape_row(v, 0);
        if shaped.as_object().is_some_and(|o| !o.is_empty()) {
            out.insert(k.clone(), shaped);
        }
    }

    if let Some(cov) = coverage_line(result.get("coverage")) {
        out.insert("coverage".into(), Value::String(cov));
    }
    if !notes.is_empty() {
        out.insert("_truncated".into(), Value::Array(notes));
    }
    out
}

/// Deepest object-nesting level (a flat object is 1; arrays are transparent).
fn object_depth(v: &Value) -> usize {
    match v {
        Value::Array(a) => a.iter().map(object_depth).max().unwrap_or(0),
        Value::Object(o) => o.values().map(object_depth).max().unwrap_or(0) + 1,
        _ => 0,
    }
}

/// Replace every nested object at or below `max_level` with a disclosed marker. Root is level 0, so
/// `max_level = 2` keeps the root's direct children and elides THEIR children.
fn prune_below(v: &Value, max_level: usize, level: usize) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(|x| prune_below(x, max_level, level)).collect()),
        Value::Object(o) => {
            let mut out = Map::new();
            for (k, x) in o {
                if x.is_object() {
                    out.insert(
                        k.clone(),
                        if level + 1 >= max_level {
                            Value::String(format!(
                                "… {} field(s) elided — use verbosity:\"full\"",
                                x.as_object().map_or(0, Map::len)
                            ))
                        } else {
                            prune_below(x, max_level, level + 1)
                        },
                    );
                } else {
                    out.insert(k.clone(), prune_below(x, max_level, level));
                }
            }
            Value::Object(out)
        }
        _ => v.clone(),
    }
}

/// Clip long strings at EVERY level — a deep payload's bulk is rarely top-level.
fn clip_deep(v: &Value, max: usize) -> Value {
    match v {
        Value::String(s) => Value::String(clip_str(s, max)),
        Value::Array(a) => Value::Array(a.iter().map(|x| clip_deep(x, max)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), clip_deep(x, max))).collect()),
        _ => v.clone(),
    }
}

/// Keep the first `max_keys` entries of every object, disclosing the count dropped. The last resort:
/// a payload can be too big by being WIDE rather than deep or array-heavy, and by the time this runs
/// the deep values are already elision markers, so little is lost.
fn narrow_to(v: &Value, max_keys: usize) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(|x| narrow_to(x, max_keys)).collect()),
        Value::Object(o) => {
            let mut out = Map::new();
            for (k, x) in o.iter().take(max_keys) {
                out.insert(k.clone(), narrow_to(x, max_keys));
            }
            if o.len() > max_keys {
                out.insert(
                    "_elidedKeys".into(),
                    Value::String(format!("+{} more field(s) — use verbosity:\"full\"", o.len() - max_keys)),
                );
            }
            Value::Object(out)
        }
        _ => v.clone(),
    }
}

/// Hard backstop: degrade until the payload fits, disclosing every step that changes anything.
/// Arrays shrink first (most compressible), then object DEPTH, then object WIDTH, then strings.
///
/// ONE ceiling note, REWRITTEN IN PLACE — never one per iteration. The TS records why twice over:
/// the intermediate lines are FALSE by the time a loop settles ("arrays reduced to 3" when they
/// ended at 1), and ~15 of them at ~110 chars is ~190 tokens of disclosure the ceiling then cannot
/// absorb — a payload degraded against a 60-token ceiling came out at 203 tokens, of which 7 notes
/// WERE essentially the whole payload: the function breaching its own promise with the text
/// explaining that it had not.
fn enforce_ceiling(shaped: Map<String, Value>, max_tokens: f64) -> Map<String, Value> {
    const CEILING_NOTE: &str = "payload exceeded";
    let mut out = Value::Object(shaped);
    // IndexMap, not HashMap: the note lists the applied stages in the order they were applied, and
    // re-applying a stage must keep its ORIGINAL position (JS `Map.set` on an existing key does).
    let mut applied: IndexMap<String, String> = IndexMap::new();

    // Apply a degradation; keep it only if it actually shrank the payload — DISCLOSURE INCLUDED, so
    // a stage that cannot pay for its own note is rejected and the next iteration degrades harder.
    // No-op stages (a payload with no arrays) never emit a note for work they did not do.
    let mut stage = |candidate: Value, kind: &str, detail: String, out: &mut Value| -> bool {
        let mut merged = applied.clone();
        merged.insert(kind.to_owned(), detail);
        let note = format!(
            "{CEILING_NOTE} ~{} tokens — {}; use verbosity:\"full\"",
            crate::summarize::helpers::fmt_js_num(max_tokens),
            merged.iter().map(|(k, d)| format!("{k} {d}")).collect::<Vec<_>>().join(", ")
        );
        // Notes from EARLIER phases (the shaper's own coverage note) are preserved; only the
        // ceiling's own line is replaced.
        let mut kept: Vec<Value> = out
            .get("_truncated")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter(|n| !n.as_str().is_some_and(|s| s.starts_with(CEILING_NOTE))).cloned().collect())
            .unwrap_or_default();
        kept.push(Value::String(note));
        let mut next = candidate.as_object().cloned().unwrap_or_default();
        next.insert("_truncated".into(), Value::Array(kept));
        let next = Value::Object(next);
        if approx_tokens(&next) >= approx_tokens(out) {
            return false;
        }
        applied = merged;
        *out = next;
        true
    };

    let mut limit = MAX_ROWS;
    while limit >= 1 && approx_tokens(&out) > max_tokens {
        let mut next = Map::new();
        for (k, v) in out.as_object().unwrap() {
            next.insert(
                k.clone(),
                match v.as_array() {
                    Some(a) => Value::Array(a.iter().take(limit).cloned().collect()),
                    None => v.clone(),
                },
            );
        }
        stage(Value::Object(next), "arrays", format!("→ {limit} row(s)"), &mut out);
        limit -= 1;
    }

    // `objectDepth(out)` is the JS for-INIT — evaluated ONCE, against the payload as it stood when
    // the loop began, not re-measured after each prune.
    let mut level = object_depth(&out).saturating_sub(1);
    while level >= 1 && approx_tokens(&out) > max_tokens {
        let candidate = prune_below(&out, level, 0);
        stage(candidate, "nesting", format!("→ elided below level {level}"), &mut out);
        level -= 1;
    }

    let mut keys = 16usize;
    while keys >= 1 && approx_tokens(&out) > max_tokens {
        let candidate = narrow_to(&out, keys);
        stage(candidate, "width", format!("→ {keys} field(s)"), &mut out);
        keys /= 2;
    }

    if approx_tokens(&out) > max_tokens {
        let candidate = clip_deep(&out, 120);
        stage(candidate, "strings", "→ clipped to 120 chars".to_owned(), &mut out);
    }
    out.as_object().cloned().unwrap_or_default()
}

/// Shape a tool result for the caller's context.
///
/// `verbosity: "full"` returns the payload untouched (the escape hatch for a genuine deep drill).
/// Otherwise: scalars + verdict + the head of each ranked array + a one-line coverage note, under a
/// hard token ceiling, with every truncation disclosed in `_truncated`.
pub fn leanify(result: &Value, verbosity_full: bool, max_tokens: Option<f64>) -> Value {
    if verbosity_full || result.is_null() {
        return result.clone();
    }
    let max_tokens = max_tokens.unwrap_or(DEFAULT_MAX_TOKENS);

    // A pre-rendered text payload ({format,text}) is the tool's OWN compact rendering — only cap it.
    // Re-shaping it would destroy a table the tool deliberately formatted.
    if let Some(o) = result.as_object() {
        if let Some(text) = o.get("text").and_then(Value::as_str) {
            let budget = (max_tokens * CHARS_PER_TOKEN) as usize;
            let n = utf16_len(text);
            if n <= budget {
                return result.clone();
            }
            let mut out = o.clone();
            out.insert(
                "text".into(),
                Value::String(format!("{}\n… truncated ({n} chars) — use verbosity:\"full\"", js_slice(text, budget))),
            );
            return Value::Object(out);
        }
        return Value::Object(enforce_ceiling(shape_generic(o), max_tokens));
    }
    if let Some(a) = result.as_array() {
        let (rows, note) = head_of(a, MAX_ROWS, "rows");
        let mut m = Map::new();
        m.insert("rows".into(), Value::Array(rows));
        if let Some(n) = note {
            m.insert("_truncated".into(), Value::Array(vec![Value::String(n)]));
        }
        return Value::Object(enforce_ceiling(m, max_tokens));
    }
    result.clone()
}
