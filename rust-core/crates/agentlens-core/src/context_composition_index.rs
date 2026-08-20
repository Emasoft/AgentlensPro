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
use crate::summarize::helpers::num;
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
