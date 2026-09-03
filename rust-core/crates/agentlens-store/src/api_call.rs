//! api_call — the per-call cache facts, extracted at the bodies-pass ingest site (TRDD-9SYRK6SW).
//!
//! WHY HERE: the bodies pass DELETES a body once it is durable, so every per-call cache fact
//! (miss reason, token buckets, the 5m/1h tier split, the prefix fingerprints) evaporates unless
//! it is captured before the delete gate. `append_body_row` already parses each body's JSON once;
//! this module is the second reader of that SAME `Value` — no extra I/O, no second parse.
//!
//! TWO ROW KINDS, each keyed by its OWN filename stem: requests are `<uuid>.request.json` and
//! responses are `req_<id>.response.json`, so the two files of one call do NOT share a stem and
//! cannot be paired here (orchestrator-verified on 80 captured bodies, 2026-09-03). Pairing is
//! TRDD-N6A8VX3G's OTLP-side link; this module only records what each file itself carries.
//!
//! NO `cost_usd`: pricing lives in `agentlens-core`, which depends on THIS crate — the reverse
//! edge would be a cycle. OTEL's own harness-reported cost is preferred anyway (CLAUDE.md
//! doctrine 2).
//!
//! NO `device_id`/`account_uuid`: requests carry both in `metadata.user_id`; persisting them
//! would violate the no-identities doctrine. Only `session_id` is kept.

use serde_json::Value;

use crate::sections::sha256_hex;

/// 64 bits of sha256, hex. Change detection only — never an identity anyone dereferences — and
/// a request row carries one of these per system block, so the full 64 chars would be pure bloat.
/// At ~10^6 distinct prefixes a year the collision probability is ~10^-8.
fn fp(text: &str) -> String {
    sha256_hex(text)[..16].to_owned()
}

/// 0x1F between joined parts: a control char no prompt text or tool name contains, so two
/// different block splits can never hash to the same canonical string.
const SEP: char = '\u{1f}';

/// The stand-in a per-turn-mutating billing block contributes to `system_fps`, in place of its
/// hash. Claude Code rewrites that block on EVERY turn (it carries `cc_prev_req=`), yet it sits
/// BEFORE every `cache_control` breakpoint and is therefore cache-NEUTRAL — measured in
/// TRDD-POLG0613 across three consecutive turns whose system[1..4], tool list and messages[0]
/// were byte-identical, with no cold write. Hashing it would make the fingerprint differ on every
/// single turn, which answers nothing; emitting a constant AT ITS POSITION keeps the list
/// positional (so a diff can still say "system[3] diverged") and loses nothing, because the whole
/// block is stored verbatim in `billing_header`.
const AGENTMETA_FP: &str = "agentmeta";

/// One ingested body FILE's durable facts. Request-only and response-only fields are `None` on
/// the other kind; the table keeps both kinds so `union_by_name` reads coalesce them per call.
#[derive(Debug, Default, PartialEq)]
pub struct ApiCallRow {
    pub stem: String,
    pub kind: &'static str,
    pub ts_ms: i64,
    pub model: Option<String>,
    pub raw_bytes: i64,

    // ── request-only ────────────────────────────────────────────────────────────
    pub session_id: Option<String>,
    /// The `x-anthropic-billing-header` block, VERBATIM (~195 bytes, ZSTD-compresses to near
    /// nothing because it is near-identical across turns). Stored whole rather than parsed into
    /// per-token columns because it carries SEVEN keys — `cc_version`, `cc_entrypoint`, `cch`,
    /// `cc_is_subagent`, `cc_prev_req`, `cc_prompt_id`, `cc_workload` (measured across 39 real
    /// captured requests) — and a column set fixed today goes blind the moment the harness adds
    /// an eighth. DuckDB reads any of them with `regexp_extract(billing_header, 'cc_workload=([^;]+)', 1)`,
    /// which is exactly the 7YPQWKPG principle: the store holds the fact, SQL derives the answer.
    /// `cc_is_subagent` in particular is ABSENT on a main-thread request (24/39 carried it), not
    /// `false` — a BOOLEAN column would have erased that distinction.
    pub billing_header: Option<String>,
    /// Pulled out of `billing_header` because it is a JOIN KEY, not a datum: it names the
    /// previous request of the same conversation, which is the chain a cache-break timeline walks.
    pub cc_prev_req: Option<String>,
    pub previous_message_id: Option<String>,
    /// Comma-joined, ONE ENTRY PER SYSTEM BLOCK IN ORDER (`agentmeta,3f2a…,9b1c…`). A scalar
    /// fingerprint could only say "the system region changed"; the positional list says WHICH
    /// block diverged, which is the question a cache-break diff actually asks.
    pub system_fps: Option<String>,
    pub tools_fp: Option<String>,
    pub first_user_fp: Option<String>,
    /// Comma-joined `tier:index` (`system:1,system:2,messages:7`) — a VARCHAR list, never a
    /// STRUCT, so `union_by_name := true` stays stable as the schema grows.
    pub breakpoint_positions: Option<String>,
    pub tool_choice: Option<String>,
    pub thinking_config: Option<String>,

    // ── response-only ───────────────────────────────────────────────────────────
    pub msg_id: Option<String>,
    pub stop_reason: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub cache_creation_tokens: Option<i64>,
    pub tier_5m_tokens: Option<i64>,
    pub tier_1h_tokens: Option<i64>,
    pub cache_missed_input_tokens: Option<i64>,
    pub cache_miss_reason: Option<String>,
    pub service_tier: Option<String>,
}

/// The row key: the filename with its shared `.request.json`/`.response.json` suffix stripped.
/// The stems themselves differ per kind (uuid vs `req_<id>`) — this strips the suffix, it does
/// not manufacture a pairing key.
pub fn stem_of(src_name: &str) -> &str {
    src_name
        .strip_suffix(".request.json")
        .or_else(|| src_name.strip_suffix(".response.json"))
        .unwrap_or(src_name)
}

/// Non-empty string, or None — an empty id is as absent as a missing one.
fn nes(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// A JSON number as i64. Token counts are integers; a non-number is absence, never 0 (a
/// fabricated 0 is indistinguishable from a measured 0).
fn num(v: Option<&Value>) -> Option<i64> {
    v.and_then(Value::as_f64).map(|n| n as i64)
}

/// The real header measures 195 bytes across all 39 captured requests. The bound is two orders
/// of magnitude above that and two orders BELOW an injected document block, which is the whole
/// point: it is the discriminator, not a truncation (nothing is ever cut — a block over the
/// bound is simply not the header).
const MAX_BILLING_HEADER_BYTES: usize = 4096;

/// The three markers are `agentlens-core`'s own `AgentMeta` test (`classify_content_kind` in
/// `cache_break_timeline.rs`), reproduced rather than shared because that crate depends on THIS
/// one so the edge cannot go the other way — keeping the marker set identical is what lets a
/// later consumer compare the two classifications.
///
/// THE SIZE BOUND IS NOT DECORATION. A substring test alone SELF-MATCHES: any injected block
/// that merely QUOTES `cc_version=` — a CLAUDE.md, a rule file, a memory page documenting this
/// very mechanism — would classify as the billing header. Two consequences, both bad and both
/// silent: that block's real hash would be replaced by the `agentmeta` placeholder, blinding
/// `system_fps` to changes in the LARGEST block in the prefix; and its whole text (a CLAUDE.md
/// runs ~65k tokens) would be copied verbatim into `billing_header` on every request row.
/// `classify_content_kind` documents an analogous self-match of its own ("reminder") that it
/// reproduces deliberately for TS parity; here the same shape is a correctness bug, so it is
/// bounded instead. Latent, not live: measured 0 divergent blocks across the 39 captures.
fn is_agent_meta(text: &str) -> bool {
    text.len() <= MAX_BILLING_HEADER_BYTES
        && (text.contains("x-anthropic-billing-header")
            || text.contains("cc_version=")
            || text.contains("cc_entrypoint="))
}

/// Every `system` block's text, in order — the string form counts as one block.
fn system_texts(body: &Value) -> Vec<&str> {
    match body.get("system") {
        Some(Value::String(s)) => vec![s.as_str()],
        Some(Value::Array(blocks)) => {
            blocks.iter().filter_map(|b| b.get("text").and_then(Value::as_str)).collect()
        }
        _ => Vec::new(),
    }
}

/// `key=value` out of the billing block. The value runs to the next `;`, `,` or whitespace —
/// the shape the harness emits (`…; cc_prev_req=req_011Cef…; cc_prompt_id=…;`).
fn kv(text: &str, key: &str) -> Option<String> {
    let needle = format!("{key}=");
    let i = text.find(&needle)?;
    let rest = &text[i + needle.len()..];
    let end = rest.find([';', ',', ' ', '\t', '\n', '\r']).unwrap_or(rest.len());
    let v = rest[..end].trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_owned())
    }
}

/// A stable signature for one request parameter, ported from `agentlens-core`'s
/// `cache_break_timeline::param_signature` (unreachable from here — that crate depends on this
/// one). Keys on `type` (+ budget/name) rather than the raw JSON so key-ORDER churn in the body
/// can never read as a parameter change; the documented THINKING_CONFIG_CHANGED cause is
/// "type or budget_tokens", which is exactly what this captures. `None` means ABSENT, which per
/// the API docs is NOT distinguishable from "explicitly set to this model's default" — only two
/// different explicit values are decidable.
fn param_signature(v: Option<&Value>) -> Option<String> {
    let v = v?;
    if v.is_null() {
        return None;
    }
    if v.is_object() || v.is_array() {
        if let Some(t) = v.get("type").and_then(Value::as_str) {
            let extra = if let Some(b) = v.get("budget_tokens").and_then(Value::as_i64) {
                format!(":{b}")
            } else if let Some(n) = v.get("name").and_then(Value::as_str) {
                format!(":{n}")
            } else {
                String::new()
            };
            return Some(format!("{t}{extra}"));
        }
        return serde_json::to_string(v).ok();
    }
    match v {
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

fn has_cache_control(v: &Value) -> bool {
    (v.is_object() || v.is_array()) && v.get("cache_control").is_some()
}

/// Where the request declares its `cache_control` breakpoints — a port of `ctxVisual.ts`'s
/// `findBreakpoints`, same tier order (tools, system, messages). LOAD-BEARING: what survives a
/// prefix change is the last breakpoint STRICTLY BEFORE it, not the change's own position, so
/// the positions are the only way a later diff can price a break (measured: a system[0] change
/// with breakpoints at system[1]/system[2] re-wrote all 84,158 tokens).
fn breakpoint_positions(body: &Value) -> Option<String> {
    let mut out: Vec<String> = Vec::new();
    for tier in ["tools", "system"] {
        if let Some(arr) = body.get(tier).and_then(Value::as_array) {
            for (i, v) in arr.iter().enumerate() {
                if has_cache_control(v) {
                    out.push(format!("{tier}:{i}"));
                }
            }
        }
    }
    if let Some(msgs) = body.get("messages").and_then(Value::as_array) {
        for (i, m) in msgs.iter().enumerate() {
            let hit = match m.get("content") {
                Some(Value::Array(blocks)) => blocks.iter().any(has_cache_control),
                Some(c) => has_cache_control(c),
                None => false,
            };
            if hit {
                out.push(format!("messages:{i}"));
            }
        }
    }
    if out.is_empty() {
        // An empty string would read as "no breakpoints found", which is also what an unparseable
        // body would produce; NULL says the request declared none — itself a cause
        // (CACHING_DISABLED) a consumer must be able to see.
        None
    } else {
        Some(out.join(","))
    }
}

/// The first `user` message's text — the boundary between the cached frontmatter and the
/// conversation. Non-text blocks contribute nothing (their bytes are the attachment's, not the
/// prompt's).
fn first_user_fp(body: &Value) -> Option<String> {
    let msgs = body.get("messages").and_then(Value::as_array)?;
    let m = msgs.iter().find(|m| m.get("role").and_then(Value::as_str) == Some("user"))?;
    let text = match m.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(&SEP.to_string()),
        _ => String::new(),
    };
    if text.is_empty() {
        None
    } else {
        Some(fp(&text))
    }
}

/// Every fact this file itself carries. Takes the ALREADY-PARSED body — a body that is not JSON
/// gets no api_call row at all (its `body` row still lands, and the bytes stay reconstructible
/// from the store, so the facts are re-derivable; a row carrying only a filename would be junk
/// every consumer then has to filter out).
pub fn extract_api_call_meta(
    body: &Value,
    src_name: &str,
    ts_ms: i64,
    raw_bytes: u64,
    session_id: Option<&str>,
) -> ApiCallRow {
    let kind = if src_name.contains(".response.") { "response" } else { "request" };
    let mut row = ApiCallRow {
        stem: stem_of(src_name).to_owned(),
        kind,
        ts_ms,
        raw_bytes: raw_bytes as i64,
        model: nes(body.get("model")),
        ..Default::default()
    };

    if kind == "response" {
        row.msg_id = nes(body.get("id"));
        row.stop_reason = nes(body.get("stop_reason"));
        if let Some(u) = body.get("usage") {
            row.input_tokens = num(u.get("input_tokens"));
            row.output_tokens = num(u.get("output_tokens"));
            row.cache_read_tokens = num(u.get("cache_read_input_tokens"));
            row.cache_creation_tokens = num(u.get("cache_creation_input_tokens"));
            row.service_tier = nes(u.get("service_tier"));
            if let Some(tier) = u.get("cache_creation") {
                row.tier_5m_tokens = num(tier.get("ephemeral_5m_input_tokens"));
                row.tier_1h_tokens = num(tier.get("ephemeral_1h_input_tokens"));
            }
        }
        if let Some(reason) = body.pointer("/diagnostics/cache_miss_reason") {
            // The token count is NESTED under the type, as it is everywhere else in this
            // codebase: a missed-token count with no reason beside it is a number nothing
            // explains.
            if let Some(t) = reason.get("type").and_then(Value::as_str) {
                row.cache_miss_reason = Some(t.to_owned());
                row.cache_missed_input_tokens = num(reason.get("cache_missed_input_tokens"));
            }
        }
        // A response carries NO session id (verified on 80 captured bodies) — resolving one is
        // TRDD-N6A8VX3G's OTLP-side link, never a guess here.
        return row;
    }

    row.session_id = session_id.map(str::to_owned);
    row.previous_message_id = nes(body.pointer("/diagnostics/previous_message_id"));
    row.tool_choice = param_signature(body.get("tool_choice"));
    row.thinking_config = param_signature(body.get("thinking"));
    row.breakpoint_positions = breakpoint_positions(body);
    row.first_user_fp = first_user_fp(body);

    let sys = system_texts(body);
    if !sys.is_empty() {
        row.system_fps = Some(
            sys.iter()
                .map(|t| if is_agent_meta(t) { AGENTMETA_FP.to_owned() } else { fp(t) })
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    if let Some(meta) = sys.iter().find(|t| is_agent_meta(t)) {
        row.billing_header = Some((*meta).to_owned());
        row.cc_prev_req = kv(meta, "cc_prev_req");
    }

    // ORDER IS PRESERVED: the prompt cache keys on bytes, so a reordered tool list IS a
    // different prefix and must fingerprint differently.
    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        let names: Vec<&str> = tools.iter().filter_map(|t| t.get("name").and_then(Value::as_str)).collect();
        if !names.is_empty() {
            row.tools_fp = Some(fp(&names.join(",")));
        }
    }
    row
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Value {
        serde_json::from_str(s).expect("fixture parses")
    }

    /// The real header, verbatim from a captured request
    /// (`reports/cache-coldwrite/bodies-20260903_044257+0200/`), with the ids replaced.
    const REAL_HEADER: &str = "x-anthropic-billing-header: cc_version=2.1.258.c18; cc_entrypoint=cli; cch=00000; cc_is_subagent=true; cc_prev_req=req_011aaaa; cc_prompt_id=bbbb2222; cc_workload=cron;";

    #[test]
    fn stem_strips_only_the_shared_suffix_and_never_pairs_the_two_kinds() {
        assert_eq!(stem_of("2f8c.request.json"), "2f8c");
        assert_eq!(stem_of("req_011x.response.json"), "req_011x");
        // The whole point of the re-spec: the two stems of ONE call are different strings.
        assert_ne!(stem_of("2f8c.request.json"), stem_of("req_011x.response.json"));
    }

    #[test]
    fn a_request_yields_request_only_fields_and_no_response_fields() {
        let body = v(&format!(
            r#"{{
              "model": "claude-opus-5",
              "system": [
                {{"type":"text","text":"{REAL_HEADER}"}},
                {{"type":"text","text":"stable rules block","cache_control":{{"type":"ephemeral"}}}}
              ],
              "tools": [{{"name":"Bash"}},{{"name":"Read"}}],
              "messages": [{{"role":"user","content":[{{"type":"text","text":"hello"}}]}}],
              "thinking": {{"type":"enabled","budget_tokens":10000}},
              "tool_choice": {{"type":"auto"}},
              "diagnostics": {{"previous_message_id":"msg_01prev"}}
            }}"#
        ));
        let r = extract_api_call_meta(&body, "2f8c.request.json", 1_700_000_000_000, 512, Some("sess-1"));

        assert_eq!(r.kind, "request");
        assert_eq!(r.stem, "2f8c");
        assert_eq!(r.ts_ms, 1_700_000_000_000);
        assert_eq!(r.raw_bytes, 512);
        assert_eq!(r.model.as_deref(), Some("claude-opus-5"));
        assert_eq!(r.session_id.as_deref(), Some("sess-1"));
        assert_eq!(r.billing_header.as_deref(), Some(REAL_HEADER));
        assert_eq!(r.cc_prev_req.as_deref(), Some("req_011aaaa"));
        assert_eq!(r.previous_message_id.as_deref(), Some("msg_01prev"));
        assert_eq!(r.thinking_config.as_deref(), Some("enabled:10000"));
        assert_eq!(r.tool_choice.as_deref(), Some("auto"));
        assert_eq!(r.breakpoint_positions.as_deref(), Some("system:1"));
        // Positional: block 0 is the churning billing block, block 1 is a real hash.
        let fps = r.system_fps.clone().expect("system_fps");
        let cols: Vec<&str> = fps.split(',').collect();
        assert_eq!(cols.len(), 2);
        assert_eq!(cols[0], AGENTMETA_FP);
        assert_eq!(cols[1].len(), 16);
        assert!(r.tools_fp.is_some() && r.first_user_fp.is_some());

        // Response-only fields stay NULL on a request row.
        assert_eq!(r.msg_id, None);
        assert_eq!(r.input_tokens, None);
        assert_eq!(r.cache_miss_reason, None);
        assert_eq!(r.tier_1h_tokens, None);
    }

    /// The header carries SEVEN keys and a fixed column set would go blind on the eighth, so it
    /// is stored whole and read with SQL. This pins that every measured key survives the round
    /// trip — including `cc_workload`, which no other code in the repo knows about.
    #[test]
    fn every_billing_header_token_survives_verbatim_for_sql_to_extract() {
        let body = v(&format!(r#"{{"system":[{{"type":"text","text":"{REAL_HEADER}"}}]}}"#));
        let r = extract_api_call_meta(&body, "a.request.json", 0, 0, None);
        let h = r.billing_header.expect("billing_header");
        for key in ["cc_version", "cc_entrypoint", "cch", "cc_is_subagent", "cc_prev_req", "cc_prompt_id", "cc_workload"] {
            assert!(h.contains(&format!("{key}=")), "{key} must survive verbatim in: {h}");
        }
        assert_eq!(kv(&h, "cc_workload").as_deref(), Some("cron"));
        // ABSENT is not false: a main-thread request simply omits cc_is_subagent (measured 24/39).
        let plain = v(r#"{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.258; cc_prev_req=req_z;"}]}"#);
        let r2 = extract_api_call_meta(&plain, "b.request.json", 0, 0, None);
        assert_eq!(kv(r2.billing_header.as_deref().unwrap(), "cc_is_subagent"), None);
    }

    #[test]
    fn a_response_yields_the_token_buckets_tier_split_and_miss_reason() {
        let body = v(r#"{
          "id": "msg_01resp",
          "model": "claude-opus-5",
          "stop_reason": "end_turn",
          "usage": {
            "input_tokens": 12,
            "output_tokens": 340,
            "cache_read_input_tokens": 80000,
            "cache_creation_input_tokens": 4200,
            "service_tier": "standard",
            "cache_creation": {"ephemeral_5m_input_tokens": 200, "ephemeral_1h_input_tokens": 4000}
          },
          "diagnostics": {"cache_miss_reason": {"type":"messages_changed","cache_missed_input_tokens": 4200}}
        }"#);
        let r = extract_api_call_meta(&body, "req_011x.response.json", 42, 900, None);

        assert_eq!(r.kind, "response");
        assert_eq!(r.stem, "req_011x");
        assert_eq!(r.msg_id.as_deref(), Some("msg_01resp"));
        assert_eq!(r.stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(r.input_tokens, Some(12));
        assert_eq!(r.output_tokens, Some(340));
        assert_eq!(r.cache_read_tokens, Some(80000));
        assert_eq!(r.cache_creation_tokens, Some(4200));
        assert_eq!(r.tier_5m_tokens, Some(200));
        assert_eq!(r.tier_1h_tokens, Some(4000));
        assert_eq!(r.cache_missed_input_tokens, Some(4200));
        assert_eq!(r.cache_miss_reason.as_deref(), Some("messages_changed"));
        assert_eq!(r.service_tier.as_deref(), Some("standard"));

        // Request-only fields stay NULL on a response row.
        assert_eq!(r.session_id, None);
        assert_eq!(r.system_fps, None);
        assert_eq!(r.billing_header, None);
        assert_eq!(r.breakpoint_positions, None);
    }

    /// The billing block mutates every turn but sits before every breakpoint, so it must NOT move
    /// the fingerprint list — otherwise the column differs on every single turn and answers
    /// nothing (TRDD-POLG0613 measured exactly this churn with no cold write).
    #[test]
    fn the_per_turn_billing_block_does_not_move_the_system_fingerprints() {
        let turn = |prev: &str| {
            v(&format!(
                r#"{{"system":[
                  {{"type":"text","text":"x-anthropic-billing-header: cc_prev_req={prev};"}},
                  {{"type":"text","text":"stable rules block"}}
                ]}}"#
            ))
        };
        let a = extract_api_call_meta(&turn("req_1"), "a.request.json", 0, 0, None);
        let b = extract_api_call_meta(&turn("req_2"), "b.request.json", 0, 0, None);
        assert_eq!(a.system_fps, b.system_fps, "cache-neutral churn must not change system_fps");
        assert_ne!(a.cc_prev_req, b.cc_prev_req, "the churn itself is still recorded, verbatim");
        assert_ne!(a.billing_header, b.billing_header);
    }

    /// A real prefix change — a rule block edited — MUST move the fingerprint AT ITS OWN INDEX,
    /// or the column is blind to the thing it exists to catch and cannot localise it.
    #[test]
    fn a_changed_system_block_moves_only_its_own_fingerprint() {
        let turn = |rules: &str| {
            v(&format!(
                r#"{{"system":[
                  {{"type":"text","text":"x-anthropic-billing-header: cc_prev_req=req_1;"}},
                  {{"type":"text","text":"constant block"}},
                  {{"type":"text","text":"{rules}"}}
                ]}}"#
            ))
        };
        let a = extract_api_call_meta(&turn("rules v1"), "a.request.json", 0, 0, None);
        let b = extract_api_call_meta(&turn("rules v2"), "b.request.json", 0, 0, None);
        let (fa, fb) = (a.system_fps.unwrap(), b.system_fps.unwrap());
        let (ca, cb): (Vec<&str>, Vec<&str>) = (fa.split(',').collect(), fb.split(',').collect());
        assert_eq!(ca[0], cb[0], "billing block: unchanged");
        assert_eq!(ca[1], cb[1], "constant block: unchanged");
        assert_ne!(ca[2], cb[2], "the edited block, and only it, must diverge");
    }

    /// Tool ORDER is part of the cached bytes, so a reorder is a different prefix.
    #[test]
    fn reordered_tools_fingerprint_differently() {
        let a = extract_api_call_meta(&v(r#"{"tools":[{"name":"Bash"},{"name":"Read"}]}"#), "a.request.json", 0, 0, None);
        let b = extract_api_call_meta(&v(r#"{"tools":[{"name":"Read"},{"name":"Bash"}]}"#), "b.request.json", 0, 0, None);
        assert_ne!(a.tools_fp, b.tools_fp);
    }

    /// A big injected block that merely QUOTES `cc_version=` (a CLAUDE.md, a rule file, a memory
    /// page about this mechanism) must NOT be mistaken for the billing header: it would lose its
    /// own fingerprint to the placeholder AND be copied whole into `billing_header` on every row.
    #[test]
    fn a_large_block_quoting_the_markers_is_not_mistaken_for_the_billing_header() {
        let doc = format!("Contents of CLAUDE.md — the harness appends cc_version= to system[0]. {}", "d".repeat(5000));
        let body = v(&serde_json::json!({
            "system": [
                { "type": "text", "text": REAL_HEADER },
                { "type": "text", "text": doc }
            ]
        })
        .to_string());
        let r = extract_api_call_meta(&body, "a.request.json", 0, 0, None);
        // The real header is still found, and only it.
        assert_eq!(r.billing_header.as_deref(), Some(REAL_HEADER));
        let fps = r.system_fps.expect("system_fps");
        let cols: Vec<&str> = fps.split(',').collect();
        assert_eq!(cols[0], AGENTMETA_FP);
        assert_ne!(cols[1], AGENTMETA_FP, "the document block must keep its own hash");
        assert_eq!(cols[1].len(), 16);
    }

    /// `tool_choice: null` is ABSENT, not a value — measured on 39/39 real requests. Recording
    /// it as the string "null" would make every request look like it set the parameter.
    #[test]
    fn an_absent_parameter_is_null_not_the_string_null() {
        let r = extract_api_call_meta(&v(r#"{"tool_choice": null, "thinking": {"type":"adaptive"}}"#), "a.request.json", 0, 0, None);
        assert_eq!(r.tool_choice, None);
        assert_eq!(r.thinking_config.as_deref(), Some("adaptive"));
    }
}
