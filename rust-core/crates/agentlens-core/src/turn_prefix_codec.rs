//! turn_prefix_codec — the v:1 envelope for the serialized TurnPrefix persisted on the api_call
//! request row (QSFYIHUO step 2).
//!
//! WHY A CODEC MODULE: `TurnPrefix::to_value` is fixed by the TS parity oracle (its key ORDER is
//! the wire contract), so the envelope cannot live on the struct — `prefix_json` = `{"v":1,"p":<to_value>}`.
//! The reader (S1 policy) accepts ONLY the version it knows: a missing or unknown `v` routes THAT
//! ROW to the body-scan fallback. No shape tolerance across versions — that is the forbidden
//! compat shim; a shape change bumps [`PREFIX_VERSION`] and old rows fall back, which is the only
//! cross-upgrade defense (the round-trip test proves same-version parity and structurally cannot
//! catch version skew).
//!
//! S3 (round-2, mandatory): `from_prefix_json` is the EXACT inverse of `to_prefix_json` — deep
//! equality, proven by the exhaustive round-trip test over EVERY enum variant (`Layer`,
//! `BlockContentKind`, `GitAnchor`), not representative ones. This is what makes mixed-provenance
//! classification sound: a store-fed prefix must behave identically to a body-extracted one.

use serde_json::{Map, Value};

use crate::cache_break_timeline::{BlockContentKind, GitAnchor, Layer, PrefixBlock, PrefixTool, TurnPrefix};

/// The envelope version persisted inside `prefix_json`. Bump on any TurnPrefix SHAPE change.
pub const PREFIX_VERSION: u32 = 1;

/// Serialize a TurnPrefix into the `prefix_json` column value: `{"v":1,"p":<TurnPrefix::to_value>}`.
/// The key order of the inner object is `to_value`'s own (the TS oracle contract); the envelope is
/// ours. `None` is never returned — an unserializable prefix is a bug, surfaced by the caller.
pub fn to_prefix_json(p: &TurnPrefix) -> String {
    let mut m = Map::new();
    m.insert("v".into(), Value::from(PREFIX_VERSION));
    m.insert("p".into(), p.to_value());
    serde_json::to_string(&Value::Object(m)).unwrap_or_else(|_| String::new())
}

/// Parse a `prefix_json` column value back into a TurnPrefix. THE S1 POLICY, enforced here so the
/// read site cannot forget it: returns `None` — meaning "fall back to the body scan, never fail the
/// query" — for a NULL input, an unparseable string, a missing `v`, a `v` from another version, a
/// missing `p`, or a `p` that does not deserialize into today's shape.
pub fn from_prefix_json(raw: Option<&str>) -> Option<TurnPrefix> {
    let raw = raw?;
    let v: Value = serde_json::from_str(raw).ok()?;
    if v.get("v").and_then(Value::as_u64)? != PREFIX_VERSION as u64 {
        return None;
    }
    from_value_exact(v.get("p")?)
}

/// The exact-inverse rebuild (S3). Every field is read under its own key; anything missing or of
/// the wrong shape makes the WHOLE prefix None (the row falls back), never a partial prefix with
/// silently-defaulted fields.
fn from_value_exact(p: &Value) -> Option<TurnPrefix> {
    let tools = value_array(p.get("tools")?)?
        .iter()
        .map(|t| {
            Some(PrefixTool {
                name: t.get("name")?.as_str()?.to_owned(),
                deferred: t.get("deferred")?.as_bool()?,
                is_mcp: t.get("isMcp")?.as_bool()?,
                fp: t.get("fp")?.as_str()?.to_owned(),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let system_blocks = blocks(p.get("systemBlocks")?)?;
    let message_blocks = blocks(p.get("messageBlocks")?)?;
    Some(TurnPrefix {
        model: str_field(p.get("model")?)?.to_owned(),
        thinking: str_field(p.get("thinking")?)?.to_owned(),
        effort_param: str_field(p.get("effortParam")?)?.to_owned(),
        tool_choice: str_field(p.get("toolChoice")?)?.to_owned(),
        speed: str_field(p.get("speed")?)?.to_owned(),
        env_fp: str_field(p.get("envFp")?)?.to_owned(),
        env_norm: str_field(p.get("envNorm")?)?.to_owned(),
        git_fp: str_field(p.get("gitFp")?)?.to_owned(),
        git_norm: str_field(p.get("gitNorm")?)?.to_owned(),
        git_anchor: git_anchor_of(p.get("gitAnchor")?)?,
        cc_version: str_field(p.get("ccVersion")?)?.to_owned(),
        has_cache_control: p.get("hasCacheControl")?.as_bool()?,
        prompt_tokens_approx: u64_of(p.get("promptTokensApprox")?)?,
        message_count: usize::try_from(u64_of(p.get("messageCount")?)?).ok()?,
        tools,
        system_blocks,
        message_blocks,
    })
}

fn blocks(v: &Value) -> Option<Vec<PrefixBlock>> {
    value_array(v)?
        .iter()
        .map(|b| {
            Some(PrefixBlock {
                layer: layer_of(b.get("layer")?)?,
                kind: kind_of(b.get("kind")?)?,
                label: str_field(b.get("label")?)?.to_owned(),
                fp: str_field(b.get("fp")?)?.to_owned(),
                norm: str_field(b.get("norm")?)?.to_owned(),
                len: usize::try_from(u64_of(b.get("len")?)?).ok()?,
                tokens_approx: u64_of(b.get("tokensApprox")?)?,
            })
        })
        .collect()
}

fn str_field(v: &Value) -> Option<&str> {
    v.as_str()
}

fn u64_of(v: &Value) -> Option<u64> {
    v.as_u64()
}

fn value_array(v: &Value) -> Option<&Vec<Value>> {
    v.as_array()
}

fn layer_of(v: &Value) -> Option<Layer> {
    Some(match v.as_str()? {
        "system" => Layer::System,
        "message" => Layer::Message,
        _ => return None,
    })
}

fn kind_of(v: &Value) -> Option<BlockContentKind> {
    Some(match v.as_str()? {
        "claudemd" => BlockContentKind::ClaudeMd,
        "rule" => BlockContentKind::Rule,
        "memory" => BlockContentKind::Memory,
        "agentmeta" => BlockContentKind::AgentMeta,
        "skillcatalog" => BlockContentKind::SkillCatalog,
        "agentcatalog" => BlockContentKind::AgentCatalog,
        "hook" => BlockContentKind::Hook,
        "date" => BlockContentKind::Date,
        "execresult" => BlockContentKind::ExecResult,
        "postcompact" => BlockContentKind::PostCompact,
        "system" => BlockContentKind::System,
        "usertext" => BlockContentKind::UserText,
        "history" => BlockContentKind::History,
        "attachment" => BlockContentKind::Attachment,
        _ => return None,
    })
}

fn git_anchor_of(v: &Value) -> Option<GitAnchor> {
    Some(match v.as_str()? {
        "system" => GitAnchor::System,
        "msg0" => GitAnchor::Msg0,
        "none" => GitAnchor::None,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache_break_timeline::{extract_turn_prefix, BlockContentKind, GitAnchor, Layer};

    /// A maximal synthetic prefix: every enum variant of Layer / BlockContentKind / GitAnchor
    /// appears at least once (S3: the round-trip is EXHAUSTIVE, not representative — F2, the
    /// load-bearing invariant that makes mixed-provenance classification sound).
    fn exhaustive_prefix() -> TurnPrefix {
        let kinds = [
            BlockContentKind::ClaudeMd,
            BlockContentKind::Rule,
            BlockContentKind::Memory,
            BlockContentKind::AgentMeta,
            BlockContentKind::SkillCatalog,
            BlockContentKind::AgentCatalog,
            BlockContentKind::Hook,
            BlockContentKind::Date,
            BlockContentKind::ExecResult,
            BlockContentKind::PostCompact,
            BlockContentKind::System,
            BlockContentKind::UserText,
            BlockContentKind::History,
            BlockContentKind::Attachment,
        ];
        let mk = |layer: Layer, kind: BlockContentKind, i: usize| PrefixBlock {
            layer,
            kind,
            label: format!("block-{i}"),
            fp: format!("fp{i:016x}"),
            norm: format!("norm{i:016x}"),
            len: i * 7,
            tokens_approx: (i as u64) * 13,
        };
        let system_blocks: Vec<PrefixBlock> = kinds
            .iter()
            .enumerate()
            .map(|(i, k)| mk(Layer::System, *k, i))
            .collect();
        let message_blocks: Vec<PrefixBlock> = kinds
            .iter()
            .enumerate()
            .map(|(i, k)| mk(Layer::Message, *k, 100 + i))
            .collect();
        let tools = vec![
            PrefixTool { name: "Bash".into(), deferred: false, is_mcp: false, fp: "tfp1".into() },
            PrefixTool { name: "mcp__srv__tool".into(), deferred: true, is_mcp: true, fp: "tfp2".into() },
        ];
        TurnPrefix {
            model: "claude-opus-5".into(),
            thinking: "enabled:10000".into(),
            effort_param: "high".into(),
            tool_choice: "auto".into(),
            speed: "fast".into(),
            env_fp: "envfp".into(),
            env_norm: "envnorm".into(),
            git_fp: "gitfp".into(),
            git_norm: "gitnorm".into(),
            git_anchor: GitAnchor::System,
            cc_version: "2.1.294".into(),
            has_cache_control: true,
            prompt_tokens_approx: 123_456,
            message_count: 42,
            tools,
            system_blocks,
            message_blocks,
        }
    }

    #[test]
    fn round_trip_is_the_exact_inverse_for_every_enum_variant() {
        let mut p = exhaustive_prefix();
        // All three GitAnchor variants.
        for anchor in [GitAnchor::System, GitAnchor::Msg0, GitAnchor::None] {
            p.git_anchor = anchor;
            let s = to_prefix_json(&p);
            let back = from_prefix_json(Some(&s)).expect("same-version value must parse");
            assert_eq!(back.git_anchor, anchor);
            assert_eq!(back.system_blocks, p.system_blocks, "git_anchor={anchor:?}: system blocks must survive");
            assert_eq!(back.message_blocks, p.message_blocks, "git_anchor={anchor:?}: message blocks must survive");
            assert_eq!(back.tools, p.tools);
            // Deep equality on the serialized form: the rebuilt prefix serializes to the SAME bytes.
            assert_eq!(to_prefix_json(&back), s, "git_anchor={anchor:?}: round trip must be byte-stable");
        }
    }

    #[test]
    fn round_trip_survives_a_real_body_extraction() {
        // A minimal realistic request body through the REAL extractor, then through the codec —
        // the mixed-provenance invariant on real extractor output.
        let body: Value = serde_json::from_str(
            r#"{"model":"claude-opus-5","system":[{"type":"text","text":"sys block one"},{"type":"text","text":"CLAUDE.md contents here"}],"tools":[{"name":"Bash","description":"run"},{"name":"Read","defer_loading":true}],"messages":[{"role":"user","content":[{"type":"text","text":"hello","cache_control":{"type":"ephemeral"}}]},{"role":"user","content":[{"type":"text","text":"tail"}]}],"thinking":{"type":"enabled","budget_tokens":4096}}"#,
        )
        .unwrap();
        let p = extract_turn_prefix(Some(&body)).expect("body extracts");
        let s = to_prefix_json(&p);
        let back = from_prefix_json(Some(&s)).expect("same-version value must parse");
        assert_eq!(to_prefix_json(&back), s);
    }

    /// S1: the reader policy. Every malformed/foreign shape routes to None (the body-scan
    /// fallback signal) — never an error, never a guessed prefix.
    #[test]
    fn unknown_missing_or_foreign_versions_fall_back_to_none() {
        let p = exhaustive_prefix();
        let inner = p.to_value();
        let s = to_prefix_json(&p);
        assert!(from_prefix_json(Some(&s)).is_some(), "v1 parses");

        // A FUTURE version: unknown v → None.
        let future = serde_json::json!({ "v": PREFIX_VERSION as u64 + 1, "p": inner });
        assert_eq!(from_prefix_json(Some(future.to_string().as_str())), None, "unknown v must fall back");

        // v MISSING (pre-extractor row would be NULL; a NULL never reaches here, but a hand-made
        // row without the envelope must not parse as a prefix either).
        let no_v = serde_json::json!({ "p": inner });
        assert_eq!(from_prefix_json(Some(no_v.to_string().as_str())), None, "missing v must fall back");

        // v1 envelope with NO `p` at all: the envelope is present but carries no prefix.
        let no_p = serde_json::json!({ "v": PREFIX_VERSION });
        assert_eq!(from_prefix_json(Some(no_p.to_string().as_str())), None, "missing p must fall back");

        // Not an object at all / garbage string / NULL.
        assert_eq!(from_prefix_json(Some("[1,2,3]")), None);
        assert_eq!(from_prefix_json(Some("not json")), None);
        assert_eq!(from_prefix_json(None), None);

        // v1 envelope but a `p` of yesterday's shape: a field missing → whole prefix None
        // (never a partial prefix with silently-defaulted fields).
        let mut broken_inner = inner.clone();
        if let Value::Object(m) = &mut broken_inner {
            m.remove("gitAnchor");
        }
        let broken = serde_json::json!({ "v": PREFIX_VERSION, "p": broken_inner });
        assert_eq!(from_prefix_json(Some(broken.to_string().as_str())), None, "missing field must fall back, not default");

        // A enum value from a future shape (kind id unknown today) → None.
        let mut future_kind = inner;
        if let Value::Object(m) = &mut future_kind {
            if let Some(Value::Array(blocks)) = m.get_mut("systemBlocks") {
                if let Some(Value::Object(b)) = blocks.first_mut() {
                    b.insert("kind".into(), Value::String("brandnewkind".into()));
                }
            }
        }
        let fk = serde_json::json!({ "v": PREFIX_VERSION, "p": future_kind });
        assert_eq!(from_prefix_json(Some(fk.to_string().as_str())), None, "unknown enum id must fall back");
    }

    #[test]
    fn empty_strings_and_zero_counts_round_trip() {
        // "" and 0 are REAL values (absent parameter, empty prefix) — not absence. The codec must
        // carry them as faithfully as it carries the populated ones.
        let p = TurnPrefix {
            model: String::new(),
            thinking: String::new(),
            effort_param: String::new(),
            tool_choice: String::new(),
            speed: String::new(),
            env_fp: String::new(),
            env_norm: String::new(),
            git_fp: String::new(),
            git_norm: String::new(),
            git_anchor: GitAnchor::None,
            cc_version: String::new(),
            has_cache_control: false,
            prompt_tokens_approx: 0,
            message_count: 0,
            tools: Vec::new(),
            system_blocks: Vec::new(),
            message_blocks: Vec::new(),
        };
        let s = to_prefix_json(&p);
        let back = from_prefix_json(Some(&s)).expect("empty prefix must parse");
        assert_eq!(to_prefix_json(&back), s);
    }
}
