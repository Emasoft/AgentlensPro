//! Port of `src/contextCompositionIndex.ts` (TRDD-DMWOBWFH P4w.1c) — the LAZY context-composition
//! query layer over Claude Code's raw OTEL request bodies. This slice ports the PURE half:
//! window-size inference, the response-usage reader, block classification, and one call's
//! composition record. The session aggregation, the LRU index and routes 36-37 follow.
//!
//! POINTER-ONLY, exactly as the TS: records carry token counts + refs (body path + block index),
//! NEVER blob bytes. Image weight comes from base64 LENGTH, which `build_call_context` already
//! reduced to a metadata stub.
//!
//! Wire objects are `serde_json::Value` mirroring the TS object literals key-for-key in insertion
//! order, per this port's design law; an `undefined` field is OMITTED, never null.

use serde_json::{Map, Value};
use std::sync::OnceLock;

use crate::pricing::{calc_token_cost_usd, lookup_rates};
use crate::raw_body_context::{build_call_context, build_call_context_from_json, IMAGE_BLOCK_LABEL_PREFIX};
use crate::summarize::helpers::{fmt_js_num, js_to_fixed_num, num};
use crate::token_estimator::calibrate_tokens;

// ── Window-size inference ────────────────────────────────────────────────────
// The request body carries no context-window size (max_tokens is the OUTPUT cap), so it is
// inferred from the model — but from the PRICING TABLE, which already declares
// `contextWindowTokens` per model. A private regex here would be a SECOND source of truth that
// silently falls behind: that is the exact defect the TS comment records, where every 1M-native
// model shipped after the regex was written got scored against a 200k window and reported ~5x
// fuller than it was.
pub const DEFAULT_WINDOW_TOKENS: f64 = 200_000.0;
pub const LONG_CONTEXT_TOKENS: f64 = 1_000_000.0;
const LONG_CONTEXT_BETA: &str = "context-1m";

/// The request opted into a 1M window. PROOF, and the only in-band proof there is: the `[1m]` a
/// user selects is stripped before the call, so the beta is what actually carries it.
///
/// The asymmetry is load-bearing and must NOT be "tidied" into an if/else: presence proves 1M,
/// absence proves NOTHING. Measured on this machine's spool, all 180 `claude-opus-5` requests
/// carried the beta while 137 `claude-fable-5` requests carried none — and fable still reached
/// 645,803 input tokens in one call, which a downgrade-on-absence would have reported as 323% of
/// a 200k window.
fn opted_into_long_context(betas: Option<&Vec<Value>>) -> bool {
    betas.is_some_and(|list| {
        list.iter().any(|b| b.as_str().is_some_and(|s| s.contains(LONG_CONTEXT_BETA)))
    })
}

pub fn window_size_for(model: Option<&str>, betas: Option<&Vec<Value>>, now_ms: f64) -> f64 {
    if opted_into_long_context(betas) {
        return LONG_CONTEXT_TOKENS;
    }
    let Some(model) = model.filter(|m| !m.is_empty()) else { return DEFAULT_WINDOW_TOKENS };
    // `lookup_rates` prefix-matches longer ids, so a `[1m]`-tagged variant resolves to its family.
    // TS tests the result for TRUTHINESS, so a table row declaring 0 falls through rather than
    // reporting a zero-sized window.
    if let Some(w) = lookup_rates(model, None, now_ms).map(|r| r.context_window_tokens) {
        if w != 0.0 {
            return w;
        }
    }
    // An id the table does not carry: an explicit long-context tag is still a signal worth
    // honouring rather than silently defaulting a 1M session to 200k.
    static TAG: OnceLock<regex::Regex> = OnceLock::new();
    // `(?-u:\b)` — a non-`/u` JS regex's `\b` is an ASCII boundary; Rust's default `\b` is
    // Unicode-aware and would disagree on a non-ASCII neighbour.
    let re = TAG.get_or_init(|| regex::Regex::new(r"(?i)fable|\[1m\]|-1m(?-u:\b)").expect("valid regex"));
    if re.is_match(model) { LONG_CONTEXT_TOKENS } else { DEFAULT_WINDOW_TOKENS }
}

// ── Response-usage reader (bounded, cheap — response bodies are small) ────────
const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;

/// `typeof v === 'number' && isFinite(v) ? v : 0` — a numeric STRING is 0 here, not 5.
fn num_or_0(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).filter(|f| f.is_finite()).unwrap_or(0.0)
}

/// Read the EXACT usage from a paired response body. Returns None (caller falls back to the
/// estimate) when the file is missing/oversized/unparseable or carries no usage — never errors.
pub fn read_response_usage(response_ref: Option<&str>) -> Option<Value> {
    let path = response_ref.filter(|s| !s.is_empty())?;
    let md = std::fs::metadata(path).ok()?;
    if !md.is_file() || md.len() > MAX_RESPONSE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let parsed: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()?;
    let u = parsed.get("usage")?;
    // TS guards with `!u || typeof u !== 'object'`, and `typeof [] === 'object'` — so an ARRAY
    // usage passes the guard and every field read yields 0. Mirrored, because rejecting it here
    // would return None where the TS returns an all-zero usage, which is a different call total.
    if !(u.is_object() || u.is_array()) {
        return None;
    }
    let mut m = Map::new();
    m.insert("inputTokens".into(), num(num_or_0(u.get("input_tokens"))));
    m.insert("outputTokens".into(), num(num_or_0(u.get("output_tokens"))));
    m.insert("cacheReadTokens".into(), num(num_or_0(u.get("cache_read_input_tokens"))));
    m.insert("cacheCreateTokens".into(), num(num_or_0(u.get("cache_creation_input_tokens"))));
    if let Some(t) = u.get("service_tier").and_then(Value::as_str) {
        m.insert("serviceTier".into(), Value::String(t.to_owned()));
    }
    if let Some(id) = parsed.get("id").and_then(Value::as_str) {
        m.insert("responseId".into(), Value::String(id.to_owned()));
    }
    Some(Value::Object(m))
}

// ── Block classification (image re-detection without a re-parse) ─────────────
/// `build_call_context` emits image blocks as kind `other` with label `"image <media_type>"` — the
/// stable IMAGE_BLOCK_LABEL_PREFIX contract. Re-classify those into the first-class `image`
/// category. The composition taxonomy is a SUPERSET of ContextBlockKind for exactly this reason.
fn classify(b: &Value) -> (String, bool, Option<String>) {
    let kind = b.get("kind").and_then(Value::as_str).unwrap_or("");
    let label = b.get("label").and_then(Value::as_str).unwrap_or("");
    let prefix = format!("{IMAGE_BLOCK_LABEL_PREFIX} ");
    if kind == "other" && label.starts_with(&prefix) {
        let media = &label[prefix.len()..];
        // `media || undefined` — an empty media type is omitted, not stored as "".
        return ("image".to_owned(), true, (!media.is_empty()).then(|| media.to_owned()));
    }
    (kind.to_owned(), false, None)
}

const TOOL_RESULT_KINDS: [&str; 2] = ["toolOutput", "bashOutput"];
const SYSTEM_KINDS: [&str; 3] = ["system", "claudemd", "rule"];
const TEXT_KINDS: [&str; 2] = ["userMsg", "assistantMsg"];

/// Build one call's composition record from its request-body file. When exact usage is supplied,
/// the per-block estimates are CALIBRATED to the exact prompt-side total and the call total is
/// authoritative. Returns None when the body is unreadable.
///
/// `raw_text`: when the caller already holds the body text (the forensics path, where `body_ref`
/// may be a store-only name with no file on disk), pass it to skip the disk read entirely. A parse
/// failure degrades to None — the same contract as an unreadable file.
// The TS packs the trailing five in an `opts` object; a dedicated struct for them would be
// scaffolding around a call site that reads fine positionally, so the arity is accepted here the
// same way `push_block` accepts its own.
#[allow(clippy::too_many_arguments)]
pub fn build_call_composition(
    body_ref: &str,
    turn: f64,
    ts: f64,
    project_hint: Option<&str>,
    exact: Option<&Value>,
    model_hint: Option<&str>,
    raw_text: Option<&str>,
    now_ms: f64,
) -> Option<Value> {
    let ctx = match raw_text {
        Some(t) => serde_json::from_str::<Value>(t).ok().and_then(|v| build_call_context_from_json(&v, false)),
        None => build_call_context(body_ref, false),
    }?;

    let model = ctx
        .get("model")
        .and_then(Value::as_str)
        .or(model_hint)
        .map(str::to_owned);

    // Prompt-side (context) total = uncached input + cacheRead + cacheCreate. Output is the
    // RESPONSE, not context, so it is excluded — including it would overstate every call.
    let exact_context = exact.map(|e| {
        num_or_0(e.get("inputTokens")) + num_or_0(e.get("cacheReadTokens")) + num_or_0(e.get("cacheCreateTokens"))
    });

    let empty: Vec<Value> = Vec::new();
    let ctx_blocks = ctx.get("blocks").and_then(Value::as_array).unwrap_or(&empty);
    let raw_tokens: Vec<f64> = ctx_blocks.iter().map(|b| num_or_0(b.get("tokens"))).collect();
    let cal = calibrate_tokens(&raw_tokens, exact_context, Some(0.2), Some(5.0));

    let mut blocks: Vec<Value> = Vec::new();
    for (i, b) in ctx_blocks.iter().enumerate() {
        let (kind, is_image, media) = classify(b);
        let mut m = Map::new();
        m.insert("index".into(), num(i as f64));
        m.insert("kind".into(), Value::String(kind));
        m.insert("label".into(), b.get("label").cloned().unwrap_or(Value::Null));
        m.insert("tokens".into(), num(cal.tokens.get(i).copied().unwrap_or(0.0)));
        m.insert("tokenSource".into(), Value::String(cal.source.to_string()));
        m.insert("bytes".into(), b.get("bytes").cloned().unwrap_or(Value::Null));
        m.insert("role".into(), b.get("role").cloned().unwrap_or(Value::Null));
        if let Some(tn) = b.get("toolName") {
            m.insert("toolName".into(), tn.clone());
        }
        m.insert("isImage".into(), Value::Bool(is_image));
        if let Some(md) = media {
            m.insert("mediaType".into(), Value::String(md));
        }
        blocks.push(Value::Object(m));
    }

    let tok = |b: &Value| num_or_0(b.get("tokens"));
    let kind_of = |b: &Value| b.get("kind").and_then(Value::as_str).unwrap_or("").to_owned();
    let is_img = |b: &Value| b.get("isImage").and_then(Value::as_bool).unwrap_or(false);
    let sum_of = |pred: &dyn Fn(&Value) -> bool| -> f64 { blocks.iter().filter(|b| pred(b)).map(tok).sum() };

    let image_count = blocks.iter().filter(|b| is_img(b)).count();
    let image_tokens: f64 = blocks.iter().filter(|b| is_img(b)).map(tok).sum();
    let est_total: f64 = blocks.iter().map(tok).sum();
    let context_tokens = exact_context.unwrap_or(est_total);
    let betas = ctx.get("betas").and_then(Value::as_array);
    let window_size = window_size_for(model.as_deref(), betas, now_ms);

    let mut out = Map::new();
    out.insert("sessionId".into(), ctx.get("sessionId").cloned().unwrap_or(Value::Null));
    if let Some(a) = ctx.get("accountUuid") {
        out.insert("accountUuid".into(), a.clone());
    }
    out.insert("project".into(), Value::String(project_hint.unwrap_or("unknown").to_owned()));
    if let Some(m) = &model {
        out.insert("model".into(), Value::String(m.clone()));
    }
    out.insert("turn".into(), num(turn));
    out.insert("ts".into(), num(ts));
    out.insert("bodyRef".into(), Value::String(body_ref.to_owned()));
    out.insert("contextTokens".into(), num(context_tokens));
    out.insert("contextPct".into(), num(if window_size > 0.0 { context_tokens / window_size } else { 0.0 }));
    out.insert("windowSize".into(), num(window_size));
    // NOTE this is the CALL's source and it is deliberately NOT `cal.source`: when exact usage was
    // present but calibration REFUSED it (scale outside the 0.2–5 band), the per-block sources stay
    // 'estimated' while the call total is still the exact figure. Collapsing the two would either
    // discard a known-exact total or claim exactness for refused blocks.
    out.insert("tokenSource".into(), Value::String(if exact_context.is_some() { "exact".into() } else { "estimated".to_string() }));
    out.insert("blocks".into(), Value::Array(blocks.clone()));
    let mut img = Map::new();
    img.insert("count".into(), num(image_count as f64));
    img.insert("tokens".into(), num(image_tokens));
    out.insert("images".into(), Value::Object(img));
    out.insert(
        "toolResultTokens".into(),
        num(sum_of(&|b| {
            let k = kind_of(b);
            TOOL_RESULT_KINDS.contains(&k.as_str())
                || (k == "mcp" && b.get("role").and_then(Value::as_str) == Some("output"))
        })),
    );
    out.insert("textTokens".into(), num(sum_of(&|b| TEXT_KINDS.contains(&kind_of(b).as_str()))));
    out.insert("thinkingTokens".into(), num(sum_of(&|b| kind_of(b) == "reasoning")));
    out.insert("systemTokens".into(), num(sum_of(&|b| SYSTEM_KINDS.contains(&kind_of(b).as_str()))));
    out.insert("toolCatalogTokens".into(), num(sum_of(&|b| kind_of(b) == "toolCatalog")));
    if let Some(e) = exact {
        out.insert("exact".into(), e.clone());
    }
    out.insert("truncated".into(), ctx.get("truncated").cloned().unwrap_or(Value::Bool(false)));
    Some(Value::Object(out))
}

/// Read one block's real content on demand (the get_block_content drill). An image returns
/// metadata + a ref, NEVER the base64 bytes — they were never stored, and the response keeps it
/// that way. `full` lifts the per-block text cap.
pub fn read_block_content(body_ref: &str, block_index: i64, full: bool) -> Option<Value> {
    let ctx = build_call_context(body_ref, full)?;
    let blocks = ctx.get("blocks").and_then(Value::as_array)?;
    // TS indexes with a raw number: a negative or out-of-range index is `undefined` → null. usize
    // conversion alone would panic or silently wrap, so the bounds check is explicit.
    if block_index < 0 || block_index as usize >= blocks.len() {
        return None;
    }
    let b = &blocks[block_index as usize];
    let (kind, is_image, media) = classify(b);
    let mut m = Map::new();
    m.insert("index".into(), num(block_index as f64));
    m.insert("kind".into(), Value::String(kind));
    m.insert("label".into(), b.get("label").cloned().unwrap_or(Value::Null));
    m.insert("tokens".into(), b.get("tokens").cloned().unwrap_or(Value::Null));
    m.insert("bytes".into(), b.get("bytes").cloned().unwrap_or(Value::Null));
    m.insert("role".into(), b.get("role").cloned().unwrap_or(Value::Null));
    m.insert("isImage".into(), Value::Bool(is_image));
    if let Some(md) = media {
        m.insert("mediaType".into(), Value::String(md));
    }
    m.insert("bodyRef".into(), Value::String(body_ref.to_owned()));
    // `{ ...base, text }` puts text LAST, and only for a non-image.
    if !is_image {
        m.insert("text".into(), b.get("text").cloned().unwrap_or(Value::Null));
    }
    Some(Value::Object(m))
}

/// The cache-read cost of re-reading `tokens` — the wasted-re-read unit the resident-blob ranking
/// is built on. `tokens <= 0` is free, mirroring the TS early return.
pub fn cost_of_cache_read(tokens: f64, model: Option<&str>, now_ms: f64) -> f64 {
    if tokens <= 0.0 {
        return 0.0;
    }
    calc_token_cost_usd(0.0, tokens, 0.0, 0.0, model.unwrap_or(""), 0.0, None, now_ms)
}

// ── Resident-block + image aggregation across a session's calls ───────────────

/// JS `.sort((x,y) => (A) || (B))`: a 0 OR NaN first comparator falls through to the second, and
/// the sort is STABLE, so equal rows keep their prior order. Both properties are load-bearing —
/// see `aggregate_residents`, where "prior order" is `bySig`'s INSERTION order.
fn cmp_desc_then(a1: f64, b1: f64, a2: f64, b2: f64) -> std::cmp::Ordering {
    let d = b1 - a1;
    if d != 0.0 && !d.is_nan() {
        return d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal);
    }
    (b2 - a2).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
}

fn f(v: &Value, k: &str) -> f64 {
    num_or_0(v.get(k))
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_owned()
}

/// A block signature (`kind|label`) tracked across a session's calls — the eviction-candidate unit.
/// A block riding forward is cache-read billed on EVERY turn it is present, so `cumulativeRead*`
/// is the true wasted re-read weight: Σ over every occurrence across every call.
///
/// `by_sig` is an IndexMap, NOT a HashMap: the result is stable-sorted by (cost, tokens), so rows
/// that tie on BOTH keep their map order — which is insertion order in JS. A HashMap would emit a
/// different, run-to-run-unstable order for every tied group and no test of a tie-free fixture
/// would ever notice.
pub fn aggregate_residents(calls: &[Value], model: Option<&str>, now_ms: f64) -> Vec<Value> {
    struct Acc {
        kind: String,
        label: String,
        is_image: bool,
        peak: f64,
        occ: f64,
        turns: std::collections::HashSet<u64>,
        first: f64,
        last: f64,
        cum: f64,
    }
    let mut by_sig: indexmap::IndexMap<String, Acc> = indexmap::IndexMap::new();
    for call in calls {
        let turn = f(call, "turn");
        let empty: Vec<Value> = Vec::new();
        for b in call.get("blocks").and_then(Value::as_array).unwrap_or(&empty) {
            let kind = s(b, "kind");
            let label = s(b, "label");
            let sig = format!("{kind}|{label}");
            let tokens = f(b, "tokens");
            let a = by_sig.entry(sig).or_insert_with(|| Acc {
                kind,
                label,
                is_image: b.get("isImage").and_then(Value::as_bool).unwrap_or(false),
                peak: 0.0,
                occ: 0.0,
                turns: std::collections::HashSet::new(),
                first: turn,
                last: turn,
                cum: 0.0,
            });
            a.peak = a.peak.max(tokens);
            a.occ += 1.0;
            a.turns.insert(turn.to_bits());
            a.first = a.first.min(turn);
            a.last = a.last.max(turn);
            a.cum += tokens;
        }
    }
    let mut rows: Vec<Value> = by_sig
        .into_iter()
        .map(|(signature, a)| {
            let mut m = Map::new();
            m.insert("signature".into(), Value::String(signature));
            m.insert("kind".into(), Value::String(a.kind));
            m.insert("label".into(), Value::String(a.label));
            m.insert("isImage".into(), Value::Bool(a.is_image));
            m.insert("peakTokens".into(), num(a.peak));
            m.insert("occurrences".into(), num(a.occ));
            m.insert("residentTurns".into(), num(a.turns.len() as f64));
            m.insert("firstSeenTurn".into(), num(a.first));
            m.insert("lastSeenTurn".into(), num(a.last));
            m.insert("cumulativeReadTokens".into(), num(a.cum));
            m.insert("cumulativeReadCostUsd".into(), num(cost_of_cache_read(a.cum, model, now_ms)));
            Value::Object(m)
        })
        .collect();
    rows.sort_by(|x, y| {
        cmp_desc_then(
            f(x, "cumulativeReadCostUsd"),
            f(y, "cumulativeReadCostUsd"),
            f(x, "cumulativeReadTokens"),
            f(y, "cumulativeReadTokens"),
        )
    });
    rows
}

/// Per-call image weight: count/tokens are the MAX across calls (the worst single call — the "half
/// the window is images" story), while cumulative is the Σ across every call (what re-reading them
/// actually cost). `firstSeenTurn` uses 0 as its "unset" sentinel, exactly as the TS does.
pub fn summarize_images(calls: &[Value], model: Option<&str>, now_ms: f64) -> Value {
    let (mut count, mut tokens, mut resident_turns, mut cumulative, mut first_seen): (f64, f64, f64, f64, f64) =
        (0.0, 0.0, 0.0, 0.0, 0.0);
    for call in calls {
        let images = call.get("images").cloned().unwrap_or(Value::Null);
        let c = num_or_0(images.get("count"));
        if c == 0.0 {
            continue;
        }
        let t = num_or_0(images.get("tokens"));
        resident_turns += 1.0;
        cumulative += t;
        if first_seen == 0.0 {
            first_seen = f(call, "turn");
        }
        count = count.max(c);
        tokens = tokens.max(t);
    }
    let mut m = Map::new();
    m.insert("count".into(), num(count));
    m.insert("tokens".into(), num(tokens));
    m.insert("firstSeenTurn".into(), num(first_seen));
    m.insert("residentTurns".into(), num(resident_turns));
    m.insert("cumulativeReadTokens".into(), num(cumulative));
    m.insert("cumulativeReadCostUsd".into(), num(cost_of_cache_read(cumulative, model, now_ms)));
    Value::Object(m)
}

/// Build a whole session's composition from an ordered list of request refs (oldest→newest).
///
/// A call whose body is unreadable is SKIPPED, but `callsTotal` counts the REFS, not the parsed
/// calls. That gap is not a bug — it IS the coverage honesty: `callsTotal` vs `calls.len()` is how
/// a consumer sees that some bodies were purged from under us.
pub fn build_session_composition(
    session_id: &str,
    refs: &[Value],
    project_hint: Option<&str>,
    now_ms: f64,
) -> Value {
    let mut calls: Vec<Value> = Vec::new();
    let mut calls_with_exact = 0.0;
    let mut model: Option<String> = None;
    let mut account: Option<String> = None;
    for (i, r) in refs.iter().enumerate() {
        let exact = read_response_usage(r.get("responseRef").and_then(Value::as_str));
        if exact.is_some() {
            calls_with_exact += 1.0;
        }
        let Some(cc) = build_call_composition(
            r.get("bodyRef").and_then(Value::as_str).unwrap_or(""),
            (i + 1) as f64,
            num_or_0(r.get("ts")),
            project_hint,
            exact.as_ref(),
            r.get("model").and_then(Value::as_str),
            None,
            now_ms,
        ) else {
            continue;
        };
        // `model ?? cc.model` — the FIRST call that names one wins; later calls never overwrite it.
        if model.is_none() {
            model = cc.get("model").and_then(Value::as_str).map(str::to_owned);
        }
        if account.is_none() {
            account = cc.get("accountUuid").and_then(Value::as_str).map(str::to_owned);
        }
        calls.push(cc);
    }
    let mut m = Map::new();
    m.insert("sessionId".into(), Value::String(session_id.to_owned()));
    if let Some(a) = &account {
        m.insert("accountUuid".into(), Value::String(a.clone()));
    }
    m.insert("project".into(), Value::String(project_hint.unwrap_or("unknown").to_owned()));
    if let Some(md) = &model {
        m.insert("model".into(), Value::String(md.clone()));
    }
    let residents = aggregate_residents(&calls, model.as_deref(), now_ms);
    let images = summarize_images(&calls, model.as_deref(), now_ms);
    m.insert("calls".into(), Value::Array(calls));
    m.insert("residentBlobs".into(), Value::Array(residents));
    m.insert("images".into(), images);
    m.insert("callsTotal".into(), num(refs.len() as f64));
    m.insert("callsWithExactUsage".into(), num(calls_with_exact));
    Value::Object(m)
}

/// A compact per-session summary for the dashboard panel: the peak-context call's block-type
/// split, the image rollup, and the top eviction-candidate blobs — each with a sample
/// (turn, blockIndex) so a UI row can drill to real content. Pointer-only: no per-block arrays and
/// no bytes cross to the browser.
pub fn session_composition_summary(comp: &Value) -> Value {
    let empty: Vec<Value> = Vec::new();
    let calls = comp.get("calls").and_then(Value::as_array).unwrap_or(&empty);

    // Representative call for the breakdown bar = the peak-context call. STRICT `>`, so the FIRST
    // call at the maximum wins; `>=` would silently report the LAST one instead.
    let mut peak: Option<&Value> = None;
    for c in calls {
        if peak.is_none_or(|p| f(c, "contextTokens") > f(p, "contextTokens")) {
            peak = Some(c);
        }
    }

    let peak_call = peak.map_or(Value::Null, |p| {
        let images = p.get("images").cloned().unwrap_or(Value::Null);
        let image_tokens = num_or_0(images.get("tokens"));
        let image_count = num_or_0(images.get("count"));
        // otherTokens is the remainder the six named categories don't name (tool_use blocks,
        // attachments, mcp input …) — clamped ≥0 so a small estimate drift can't make it negative.
        let classified = image_tokens
            + f(p, "toolResultTokens")
            + f(p, "textTokens")
            + f(p, "thinkingTokens")
            + f(p, "systemTokens")
            + f(p, "toolCatalogTokens");
        let mut m = Map::new();
        m.insert("turn".into(), num(f(p, "turn")));
        m.insert("contextTokens".into(), num(f(p, "contextTokens")));
        // Already ×100 from the fraction — the UI receives a percent, not a ratio.
        m.insert("contextPct".into(), num(js_to_fixed_num(f(p, "contextPct") * 100.0, 1)));
        m.insert("windowSize".into(), num(f(p, "windowSize")));
        m.insert("tokenSource".into(), p.get("tokenSource").cloned().unwrap_or(Value::Null));
        m.insert("imageTokens".into(), num(image_tokens));
        m.insert("imageCount".into(), num(image_count));
        m.insert("toolResultTokens".into(), num(f(p, "toolResultTokens")));
        m.insert("textTokens".into(), num(f(p, "textTokens")));
        m.insert("thinkingTokens".into(), num(f(p, "thinkingTokens")));
        m.insert("systemTokens".into(), num(f(p, "systemTokens")));
        m.insert("toolCatalogTokens".into(), num(f(p, "toolCatalogTokens")));
        m.insert("otherTokens".into(), num((f(p, "contextTokens") - classified).max(0.0)));
        Value::Object(m)
    });

    // For each top blob find ONE occurrence so a UI row can drill to it. (0, -1) is the explicit
    // "no occurrence found" pair — not a valid turn/index, so a consumer cannot mistake it for one.
    let find_sample = |signature: &str| -> (f64, f64) {
        for c in calls {
            let blocks = c.get("blocks").and_then(Value::as_array).unwrap_or(&empty);
            if let Some(i) = blocks.iter().position(|b| format!("{}|{}", s(b, "kind"), s(b, "label")) == signature) {
                return (f(c, "turn"), i as f64);
            }
        }
        (0.0, -1.0)
    };
    let resident_blobs: Vec<Value> = comp
        .get("residentBlobs")
        .and_then(Value::as_array)
        .unwrap_or(&empty)
        .iter()
        .take(15)
        .map(|b| {
            let (turn, idx) = find_sample(&s(b, "signature"));
            let mut m = b.as_object().cloned().unwrap_or_default();
            m.insert("sampleTurn".into(), num(turn));
            m.insert("sampleBlockIndex".into(), num(idx));
            Value::Object(m)
        })
        .collect();

    let calls_total = f(comp, "callsTotal");
    let mut out = Map::new();
    out.insert("sessionId".into(), comp.get("sessionId").cloned().unwrap_or(Value::Null));
    if let Some(a) = comp.get("accountUuid") {
        out.insert("accountUuid".into(), a.clone());
    }
    out.insert("project".into(), comp.get("project").cloned().unwrap_or(Value::Null));
    if let Some(m) = comp.get("model") {
        out.insert("model".into(), m.clone());
    }
    out.insert("callsTotal".into(), num(calls_total));
    out.insert("callsWithExactUsage".into(), num(f(comp, "callsWithExactUsage")));
    out.insert("peakCall".into(), peak_call);
    out.insert("images".into(), comp.get("images").cloned().unwrap_or(Value::Null));
    out.insert("residentBlobs".into(), Value::Array(resident_blobs));
    if calls_total == 0.0 {
        out.insert("coverageNote".into(), Value::String(
            "No raw OTEL request bodies for this session in the live registry (lazy — historical bodies are not indexed). Set OTEL_LOG_RAW_API_BODIES to capture them.".into(),
        ));
    }
    Value::Object(out)
}

/// Resolve a session's request bodies + their paired responses from the registry — the LAZY path.
/// PURE and cheap: it only reads the in-memory registry, so it is the part a route runs while
/// holding the CoreState lock. The expensive file parsing happens afterwards, off the lock.
pub fn resolve_refs(registry: &crate::call_body_registry::CallBodyRegistry, session_id: &str) -> Vec<Value> {
    registry
        .request_pointers(session_id)
        .into_iter()
        .filter(|p| p.body_ref.as_deref().is_some_and(|b| !b.is_empty()))
        .map(|p| {
            let resp = registry.response_for(session_id, p.span_id.as_deref(), p.request_id.as_deref());
            let mut m = Map::new();
            m.insert("bodyRef".into(), Value::String(p.body_ref.clone().unwrap_or_default()));
            m.insert("ts".into(), num(p.ts as f64));
            if let Some(v) = &p.span_id {
                m.insert("spanId".into(), Value::String(v.clone()));
            }
            if let Some(v) = &p.request_id {
                m.insert("requestId".into(), Value::String(v.clone()));
            }
            if let Some(r) = resp.and_then(|r| r.body_ref.clone()) {
                m.insert("responseRef".into(), Value::String(r));
            }
            if let Some(v) = &p.model {
                m.insert("model".into(), Value::String(v.clone()));
            }
            Value::Object(m)
        })
        .collect()
}

/// The lazy, LRU-cached index. IndexMap because the eviction order IS the JS Map's insertion
/// order: a cache HIT re-inserts to move that session to the MRU end, so the oldest key is always
/// the eviction candidate. `shift_remove`, never `swap_remove` — swapping would destroy the very
/// ordering the LRU depends on.
pub struct ContextCompositionIndex {
    cache: indexmap::IndexMap<String, Value>,
    max_sessions: usize,
}

impl Default for ContextCompositionIndex {
    fn default() -> Self {
        ContextCompositionIndex { cache: indexmap::IndexMap::new(), max_sessions: 64 }
    }
}

impl ContextCompositionIndex {
    pub fn new(max_sessions: usize) -> Self {
        ContextCompositionIndex { cache: indexmap::IndexMap::new(), max_sessions }
    }

    /// A cached composition, moved to the MRU end on hit.
    pub fn get_cached(&mut self, session_id: &str) -> Option<Value> {
        let v = self.cache.shift_remove(session_id)?;
        self.cache.insert(session_id.to_owned(), v.clone());
        Some(v)
    }

    pub fn put(&mut self, session_id: &str, comp: Value) {
        self.cache.shift_remove(session_id);
        self.cache.insert(session_id.to_owned(), comp);
        while self.cache.len() > self.max_sessions {
            let Some(oldest) = self.cache.keys().next().cloned() else { break };
            self.cache.shift_remove(&oldest);
        }
    }

    pub fn len(&self) -> usize {
        self.cache.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cache.is_empty()
    }
}

/// `DEFAULT_SCOPE_CAP` — the most-recent N sessions a scope query will parse.
///
/// The cap is a COVERAGE statement, not an optimisation: every scoped answer carries a `coverage`
/// block saying how many sessions matched, how many were scanned, and whether that was all of them.
/// A scoped tool that silently sampled would read as a complete answer.
pub const DEFAULT_SCOPE_CAP: usize = 25;

/// resolveScope — a bounded, most-recent set of session ids + the coverage note that describes it.
///
/// A scope that EXACTLY names a known session is a single-session scope, checked FIRST: a session id
/// is also a valid `startsWith` prefix of itself, so without the exact check a drill into one
/// session would silently widen to every session whose id shares its prefix.
pub fn resolve_scope(session_ids: &[&str], scope: Option<&str>, project_for: &dyn Fn(&str) -> Option<String>, scope_cap: usize) -> (Vec<String>, Value) {
    let mut cov = Map::new();
    if let Some(s) = scope.filter(|s| !s.is_empty() && session_ids.contains(s)) {
        cov.insert("sessionsMatched".into(), Value::from(1));
        cov.insert("sessionsScanned".into(), Value::from(1));
        cov.insert("scanCap".into(), Value::from(scope_cap));
        cov.insert("complete".into(), Value::Bool(true));
        cov.insert("note".into(), Value::String(format!("Single session {s}.")));
        return (vec![s.to_owned()], Value::Object(cov));
    }
    let matched: Vec<String> = match scope.filter(|s| !s.is_empty()) {
        Some(s) => session_ids
            .iter()
            .filter(|id| project_for(id).unwrap_or_default().starts_with(s) || id.starts_with(s))
            .map(|id| (*id).to_owned())
            .collect(),
        None => session_ids.iter().map(|id| (*id).to_owned()).collect(),
    };
    let scanned: Vec<String> = matched.iter().take(scope_cap).cloned().collect();
    let complete = scanned.len() == matched.len();
    cov.insert("sessionsMatched".into(), Value::from(matched.len()));
    cov.insert("sessionsScanned".into(), Value::from(scanned.len()));
    cov.insert("scanCap".into(), Value::from(scope_cap));
    cov.insert("complete".into(), Value::Bool(complete));
    cov.insert(
        "note".into(),
        Value::String(if complete {
            format!(
                "Scanned all {} live-registry session(s) in scope{}. Historical sessions not in the live registry are not scanned (lazy).",
                matched.len(),
                scope.filter(|s| !s.is_empty()).map_or(String::new(), |s| format!(" \"{s}\""))
            )
        } else {
            format!(
                "SAMPLE: {} most-recent of {} in-scope sessions scanned (cap {scope_cap}). Lazy — no full-disk sweep; not full history.",
                scanned.len(),
                matched.len()
            )
        }),
    );
    (scanned, Value::Object(cov))
}

/// imageReport — "how many images were sent, when, and what did re-reading them cost".
///
/// The rank is cumulative READ cost, not image count: an image is expensive because it is RESIDENT
/// and re-read every turn, so one image in a 200-turn session outranks ten in a 3-turn one.
pub fn image_report(comps: &[Value], scope: Option<&str>, coverage: Value) -> Value {
    let mut sessions: Vec<Value> = comps
        .iter()
        .filter(|c| f(&c["images"], "count") > 0.0)
        .map(|c| {
            let img = &c["images"];
            let mut m = Map::new();
            for (k, src) in [("sessionId", "sessionId"), ("project", "project"), ("model", "model"), ("accountUuid", "accountUuid")] {
                m.insert(k.into(), c.get(src).cloned().unwrap_or(Value::Null));
            }
            m.insert("images".into(), num(f(img, "count")));
            m.insert("perCallTokens".into(), num(f(img, "tokens")));
            m.insert("firstSeenTurn".into(), img.get("firstSeenTurn").cloned().unwrap_or(Value::Null));
            m.insert("residentTurns".into(), num(f(img, "residentTurns")));
            m.insert("cumulativeReadTokens".into(), num(f(img, "cumulativeReadTokens")));
            m.insert("cumulativeReadCostUsd".into(), num(js_to_fixed_num(f(img, "cumulativeReadCostUsd"), 4)));
            m.insert("callsWithExactUsage".into(), c.get("callsWithExactUsage").cloned().unwrap_or(Value::Null));
            m.insert("callsTotal".into(), c.get("callsTotal").cloned().unwrap_or(Value::Null));
            Value::Object(m)
        })
        .collect();
    // STABLE sort with the SAME tie-break as the TS (cost, then tokens) — Array.prototype.sort is
    // stable, so an unstable sort here could reorder genuinely-equal rows.
    sessions.sort_by(|a, b| {
        f(b, "cumulativeReadCostUsd")
            .partial_cmp(&f(a, "cumulativeReadCostUsd"))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| f(b, "cumulativeReadTokens").partial_cmp(&f(a, "cumulativeReadTokens")).unwrap_or(std::cmp::Ordering::Equal))
    });
    let mut m = Map::new();
    m.insert("scope".into(), Value::String(scope.filter(|s| !s.is_empty()).unwrap_or("all").to_owned()));
    m.insert("totalImageSessions".into(), Value::from(sessions.len()));
    m.insert("totalCumulativeReadTokens".into(), num(sessions.iter().map(|s| f(s, "cumulativeReadTokens")).sum()));
    m.insert(
        "totalCumulativeReadCostUsd".into(),
        num(js_to_fixed_num(sessions.iter().map(|s| f(s, "cumulativeReadCostUsd")).sum(), 4)),
    );
    m.insert("coverage".into(), coverage);
    m.insert("sessions".into(), Value::Array(sessions));
    Value::Object(m)
}

/// findResidentBlobs — the "what should I compact / move to a sub-agent" list.
///
/// `topN` is CLAMPED to [1, 100] with a default of 20. The default is token-lean on purpose (it was
/// a hardcoded 50), and the clamp is what stops a caller from pulling an unbounded list into their
/// transcript by asking for one — the same cost the whole leanResponse layer exists to bound.
pub fn find_resident_blobs(comps: &[Value], scope: Option<&str>, coverage: Value, kind: Option<&str>, min_tokens: Option<f64>, min_resident_turns: Option<f64>, top_n: Option<f64>) -> Value {
    let min_resident = min_resident_turns.unwrap_or(2.0);
    let min_tokens = min_tokens.unwrap_or(0.0);
    let mut rows: Vec<Value> = Vec::new();
    for c in comps {
        for b in c["residentBlobs"].as_array().unwrap_or(&Vec::new()) {
            if f(b, "residentTurns") < min_resident || f(b, "peakTokens") < min_tokens {
                continue;
            }
            if kind.is_some_and(|k| b.get("kind").and_then(Value::as_str) != Some(k)) {
                continue;
            }
            // `{ sessionId, project, model, ...b, cumulativeReadCostUsd }` — the spread puts the
            // blob's own keys after these three, and the rounded cost OVERWRITES the blob's raw one
            // IN PLACE (keeping its position), because the key already exists.
            let mut m = Map::new();
            m.insert("sessionId".into(), c.get("sessionId").cloned().unwrap_or(Value::Null));
            m.insert("project".into(), c.get("project").cloned().unwrap_or(Value::Null));
            m.insert("model".into(), c.get("model").cloned().unwrap_or(Value::Null));
            if let Some(o) = b.as_object() {
                for (k, v) in o {
                    m.insert(k.clone(), v.clone());
                }
            }
            m.insert("cumulativeReadCostUsd".into(), num(js_to_fixed_num(f(b, "cumulativeReadCostUsd"), 4)));
            rows.push(Value::Object(m));
        }
    }
    rows.sort_by(|a, b| {
        f(b, "cumulativeReadCostUsd")
            .partial_cmp(&f(a, "cumulativeReadCostUsd"))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| f(b, "cumulativeReadTokens").partial_cmp(&f(a, "cumulativeReadTokens")).unwrap_or(std::cmp::Ordering::Equal))
    });
    let top = top_n.unwrap_or(20.0).clamp(1.0, 100.0) as usize;
    let blobs: Vec<Value> = rows.iter().take(top).cloned().collect();
    let mut m = Map::new();
    m.insert("scope".into(), Value::String(scope.filter(|s| !s.is_empty()).unwrap_or("all").to_owned()));
    m.insert("count".into(), Value::from(rows.len()));
    m.insert("coverage".into(), coverage);
    m.insert("blobs".into(), Value::Array(blobs.clone()));
    // `note: undefined` drops from JSON — the key exists only when something was actually cut.
    if rows.len() > blobs.len() {
        m.insert(
            "note".into(),
            Value::String(format!(
                "Showing top {} of {} by wasted cache-read cost; raise topN to see more (max 100).",
                blobs.len(),
                rows.len()
            )),
        );
    }
    Value::Object(m)
}

/// queryBlocks — filter every call's blocks by any dimension, group by any dimension.
///
/// `filter` is echoed back VERBATIM in the payload: a grouped aggregate is meaningless without the
/// filter that produced it, and a caller comparing two runs needs to see which one they are holding.
#[allow(clippy::too_many_arguments)] // mirrors the TS BlockFilter field-for-field (see push_block)
pub fn query_blocks(comps: &[Value], filter: &Value, group_by: &str, coverage: Value, now_ms: f64) -> Value {
    let s = |k: &str| filter.get(k).and_then(Value::as_str).filter(|v| !v.is_empty());
    let n = |k: &str| filter.get(k).and_then(Value::as_f64);
    // IndexMap, not HashMap: the TS builds a `Map` and iterates it in INSERTION order before
    // sorting, so ties between equal-token groups resolve the same way on both engines.
    let mut groups: indexmap::IndexMap<String, (f64, f64, f64)> = indexmap::IndexMap::new();
    let mut matched_blocks = 0usize;
    let empty: Vec<Value> = Vec::new();
    for c in comps {
        let project = c.get("project").and_then(Value::as_str).unwrap_or("");
        let session_id = c.get("sessionId").and_then(Value::as_str).unwrap_or("");
        let model = c.get("model").and_then(Value::as_str);
        if s("project").is_some_and(|p| !project.starts_with(p)) {
            continue;
        }
        if s("sessionId").is_some_and(|sid| session_id != sid) {
            continue;
        }
        // `(c.model ?? '').includes(...)` — a SUBSTRING match, so "opus" selects every opus
        // variant. An equality check would silently return nothing for the obvious query.
        if s("model").is_some_and(|m| !model.unwrap_or("").contains(m)) {
            continue;
        }
        for call in c["calls"].as_array().unwrap_or(&empty) {
            let turn = f(call, "turn");
            if n("turnFrom").is_some_and(|v| turn < v) || n("turnTo").is_some_and(|v| turn > v) {
                continue;
            }
            for b in call["blocks"].as_array().unwrap_or(&empty) {
                if s("kind").is_some_and(|k| b.get("kind").and_then(Value::as_str) != Some(k)) {
                    continue;
                }
                let tokens = f(b, "tokens");
                if n("minTokens").is_some_and(|v| tokens < v) {
                    continue;
                }
                matched_blocks += 1;
                let key = match group_by {
                    "kind" => b.get("kind").and_then(Value::as_str).unwrap_or("").to_owned(),
                    "session" => session_id.to_owned(),
                    "project" => project.to_owned(),
                    "model" => model.unwrap_or("unknown").to_owned(),
                    _ => fmt_js_num(turn),
                };
                let g = groups.entry(key).or_insert((0.0, 0.0, 0.0));
                g.0 += tokens;
                g.1 += 1.0;
                g.2 += cost_of_cache_read(tokens, model, now_ms);
            }
        }
    }
    let mut rows: Vec<Value> = groups
        .iter()
        .map(|(k, (tokens, count, cost))| {
            let mut m = Map::new();
            m.insert("key".into(), Value::String(k.clone()));
            m.insert("tokens".into(), num(*tokens));
            m.insert("count".into(), num(*count));
            m.insert("estCostUsd".into(), num(js_to_fixed_num(*cost, 4)));
            Value::Object(m)
        })
        .collect();
    rows.sort_by(|a, b| f(b, "tokens").partial_cmp(&f(a, "tokens")).unwrap_or(std::cmp::Ordering::Equal));
    let top = n("topN").unwrap_or(20.0).clamp(1.0, 100.0) as usize;
    let shown: Vec<Value> = rows.iter().take(top).cloned().collect();
    let mut m = Map::new();
    m.insert("groupBy".into(), Value::String(group_by.to_owned()));
    m.insert("filter".into(), filter.clone());
    m.insert("matchedBlocks".into(), Value::from(matched_blocks));
    m.insert("distinctGroups".into(), Value::from(rows.len()));
    m.insert("coverage".into(), coverage);
    m.insert("groups".into(), Value::Array(shown.clone()));
    if rows.len() > shown.len() {
        m.insert(
            "note".into(),
            Value::String(format!("Showing top {} of {} groups by tokens; raise topN to see more (max 100).", shown.len(), rows.len())),
        );
    }
    Value::Object(m)
}
