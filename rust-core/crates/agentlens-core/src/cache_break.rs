//! Port of src/shared/cacheBreak.ts (TRDD-TKN5VALS, ported under TRDD-DMWOBWFH P4x.2d) — the
//! cache-break classifier shared by the MCP diagnostic tools and the webview.
//!
//! The prompt cache is a PREFIX cache: turn N reuses turn N-1's cached prefix only up to the FIRST
//! byte that differs; from that break point on everything is re-billed as `cache_creation` (full
//! write rate) instead of `cache_read` (~10% of input). This module diffs each turn's injected
//! blocks against the previous turn's, finds the first divergence, classifies the CAUSE, and sizes
//! the wasted write. Pure: no I/O, no globals — `now_ms` is threaded in so the oracle can pin it.
//!
//! LIMITATION carried over verbatim from the TS: the composition parser emits each turn's blocks
//! heaviest-first, not in true prompt position, so this is a SET diff (add / remove / resize by
//! stable identity). It localises the CAUSE; the breakpoint-verified answer is
//! get_cache_break_timeline, which reads the raw request bodies.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::pricing::lookup_rates;
use crate::summarize::helpers::{js_string, num, parse_iso_ms, truthy};

const DEFAULT_IDLE_TTL_MS: f64 = 5.0 * 60_000.0;

/// Kinds the composition parser emits that live in the STABLE prefix.
const CATALOG_KINDS: [&str; 2] = ["toolCatalog", "agentCatalog"];

/// Catalog kinds a `/reload-plugins` re-registers together. ≥2 diverging in ONE turn is the reload
/// signature — no organic single change touches more than one at once. (TRDD-EYA3X5MQ)
const RELOAD_CATALOG_KINDS: [&str; 4] = ["toolCatalog", "agentCatalog", "skill", "mcp"];

/// The break-cause taxonomy. An ENUM rather than `&str` because the TS types the three tables as
/// `Record<CacheBreakCause, string>` — the compiler is what guarantees every cause has a
/// remediation and a label. A `_ =>` fallback arm on strings would silently ship an empty
/// remediation for a cause someone added later.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Cause {
    ToolsChanged,
    ToolsReordered,
    SystemPromptTimestamp,
    ModelSwitched,
    EffortChanged,
    FastMode,
    McpServerToggle,
    PluginsReloaded,
    SkillsReloaded,
    PluginChanged,
    AccountSwitched,
    ToolDeny,
    InjectedBlockChanged,
    Compaction,
    Upgrade,
    ResumeAfterUpgrade,
    IdleTtlExpiry,
    Unattributable,
    Unknown,
}

impl Cause {
    /// The wire string — this is what serializes into `cause`.
    pub fn id(self) -> &'static str {
        match self {
            Cause::ToolsChanged => "TOOLS_CHANGED",
            Cause::ToolsReordered => "TOOLS_REORDERED",
            Cause::SystemPromptTimestamp => "SYSTEM_PROMPT_TIMESTAMP",
            Cause::ModelSwitched => "MODEL_SWITCHED",
            Cause::EffortChanged => "EFFORT_CHANGED",
            Cause::FastMode => "FAST_MODE",
            Cause::McpServerToggle => "MCP_SERVER_TOGGLE",
            Cause::PluginsReloaded => "PLUGINS_RELOADED",
            Cause::SkillsReloaded => "SKILLS_RELOADED",
            Cause::PluginChanged => "PLUGIN_CHANGED",
            Cause::AccountSwitched => "ACCOUNT_SWITCHED",
            Cause::ToolDeny => "TOOL_DENY",
            Cause::InjectedBlockChanged => "INJECTED_BLOCK_CHANGED",
            Cause::Compaction => "COMPACTION",
            Cause::Upgrade => "UPGRADE",
            Cause::ResumeAfterUpgrade => "RESUME_AFTER_UPGRADE",
            Cause::IdleTtlExpiry => "IDLE_TTL_EXPIRY",
            Cause::Unattributable => "UNATTRIBUTABLE",
            Cause::Unknown => "UNKNOWN",
        }
    }

    /// REMEDIATION — byte-identical to the TS table (it ships to the user verbatim).
    pub fn remediation(self) -> &'static str {
        match self {
            Cause::ToolsChanged => "Never remove tools mid-session; use defer-loading stubs + tool-search so the catalog stays byte-identical.",
            Cause::ToolsReordered => "Emit tools in a stable sorted order so the catalog bytes do not shuffle turn-to-turn.",
            Cause::SystemPromptTimestamp => "Move the moving clock/time out of the system prompt into a <system-reminder> in the next user message.",
            Cause::ModelSwitched => "Do not switch models mid-conversation — hand off to a sub-agent instead (caches are model-specific).",
            Cause::EffortChanged => "Keep the reasoning-effort level fixed within a conversation; changing it invalidates the prefix.",
            Cause::FastMode => "Toggling fast mode invalidates the cache — decide it once at session start.",
            Cause::McpServerToggle => "Keep MCP servers with non-deferred tools connected for the whole session, or make their tools deferred.",
            Cause::PluginsReloaded => "A /reload-plugins churned 2+ catalogs in one turn. It resets the prefix ONLY when a reloaded plugin supplies an MCP server whose tools load into the prefix — per the docs, \"skills, commands, agents, hooks, LSP servers, monitors, and themes never invalidate the cache\". Since v2.1.163 the command warns and skips such a reload unless --force, so check whether --force was passed before blaming the reload.",
            Cause::SkillsReloaded => "A /reload-skills re-registered the skill catalog. This is NOT documented as a cache event anywhere, and skills sit in the docs' never-invalidates list — treat this attribution as INFERRED and look for a co-occurring cause before acting on it.",
            Cause::PluginChanged => "Installing/removing/enabling/updating a plugin mid-session rewrites the tool+skill+agent catalogs. Do plugin surgery in a scratch session, then restart.",
            Cause::AccountSwitched => "A /login or /logout swapped the credential mid-session; the previous account's cache entry is unreachable. Finish the session on one account, or rotate at a natural boundary.",
            Cause::ToolDeny => "Avoid denying an entire tool mid-session; scope the deny narrower or set it before the session starts.",
            Cause::InjectedBlockChanged => "Move this volatile injected block (hook/file/rule/memory) into the message suffix, after the last cache breakpoint.",
            Cause::Compaction => "Compaction rebuilds the conversation layer — expected once; avoid compacting more than necessary.",
            Cause::Upgrade => "A Claude Code upgrade invalidates the cache once — unavoidable, but do not resume large sessions right after upgrading.",
            Cause::ResumeAfterUpgrade => "Resuming after an upgrade forces a full re-read (the most expensive turn) — avoid resuming huge sessions post-upgrade.",
            Cause::IdleTtlExpiry => "A >5-min idle gap let the cache expire; keep turns within the TTL or accept the one-time re-warm.",
            Cause::Unattributable => "A real cold write (more written than read) with nothing in the block diff to blame. Do NOT guess a culprit from timing or plausibility — run get_cache_break_timeline, which diffs the raw request bodies against their actual cache_control breakpoints.",
            Cause::Unknown => "Cause could not be localised from the block diff; inspect the raw prefix around this turn.",
        }
    }

    /// CAUSE_LABEL — the short human label the trace marker + Cache tab render.
    pub fn label(self) -> &'static str {
        match self {
            Cause::ToolsChanged => "Tools changed",
            Cause::ToolsReordered => "Tools reordered",
            Cause::SystemPromptTimestamp => "System-prompt timestamp",
            Cause::ModelSwitched => "Model switched",
            Cause::EffortChanged => "Effort changed",
            Cause::FastMode => "Fast mode toggled",
            Cause::McpServerToggle => "MCP server toggled",
            Cause::PluginsReloaded => "Plugins reloaded",
            Cause::SkillsReloaded => "Skills reloaded",
            Cause::PluginChanged => "Plugin changed",
            Cause::AccountSwitched => "Account switched",
            Cause::ToolDeny => "Tool denied",
            Cause::InjectedBlockChanged => "Injected block changed",
            Cause::Compaction => "Compaction",
            Cause::Upgrade => "Upgrade",
            Cause::ResumeAfterUpgrade => "Resume after upgrade",
            Cause::IdleTtlExpiry => "Idle TTL expiry",
            Cause::Unattributable => "Unattributable cold write",
            Cause::Unknown => "Unknown",
        }
    }
}

/// One turn's cache-relevant footprint. `sources` are the injected context blocks (raw JSON, so
/// `excerpt` presence — which decides whether the key is emitted at all — round-trips exactly).
#[derive(Clone, Debug, Default)]
pub struct CacheTurnInput {
    pub turn: f64,
    pub sources: Vec<Value>,
    pub cache_read_tokens: f64,
    pub cache_create_tokens: f64,
    pub input_tokens: f64,
    pub model: Option<String>,
    pub has_fast_mode: Option<bool>,
    pub timestamp_ms: Option<f64>,
}

/// Rates to price the wasted re-write. All optional exactly as in the TS: with no `write_rate` the
/// cost stays 0 while the token figure is still populated.
#[derive(Clone, Copy, Debug, Default)]
pub struct AnalyzeCacheBreaksOpts {
    pub write_rate_usd_per_mtok: Option<f64>,
    pub input_rate_usd_per_mtok: Option<f64>,
    /// The model's ACTUAL cache-read rate. Most Claude/OpenAI models read at 0.1× input but some do
    /// not (codex-mini at 0.25×), and hardcoding 0.1× overstates the waste for those.
    pub cache_read_rate_usd_per_mtok: Option<f64>,
    pub idle_ttl_ms: Option<f64>,
}

// ── small JS-shaped helpers ───────────────────────────────────────────────────

/// `${x}` on a possibly-absent property: an absent key stringifies to "undefined", not "".
fn tmpl(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".to_owned(), js_string)
}

/// Stable identity of an injected block across turns.
fn source_key(s: &Value) -> String {
    format!("{}::{}", tmpl(s.get("kind")), tmpl(s.get("label")))
}

/// `a !== b` for a property that may be absent. `undefined === undefined` is TRUE in JS (so two
/// blocks both missing `tokens` are "unchanged"), while `undefined !== null` — hence None being its
/// own case rather than folded into null.
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (None, _) | (_, None) => false,
        (Some(x), Some(y)) => match (x.as_f64(), y.as_f64()) {
            (Some(m), Some(n)) => m == n,
            _ => x == y,
        },
    }
}

/// Insert only when present — an `undefined` property DROPS its key from the JSON, which is a wire
/// difference `?? null` would not produce.
fn put_opt(dst: &mut Map<String, Value>, name: &str, v: Option<&Value>) {
    if let Some(x) = v {
        dst.insert(name.to_owned(), x.clone());
    }
}

/// Full turn-to-turn block set-diff (add / remove / resize / unchanged) with the FIRST divergence
/// flagged. Single source of truth for the diff: the classifier and the cache-break popup both
/// consume it, so the popup's highlighted offender can never disagree with the verdict.
///
/// Entries come back in `cur` order first, then blocks dropped from `prev`.
pub fn diff_turn_sources(prev: &[Value], cur: &[Value]) -> Vec<Value> {
    // `Map.set` overwrites, so a duplicate kind::label in prev resolves to the LAST one.
    let mut prev_by_key: HashMap<String, &Value> = HashMap::new();
    for s in prev {
        prev_by_key.insert(source_key(s), s);
    }
    let cur_keys: HashSet<String> = cur.iter().map(source_key).collect();

    // The first divergence, exactly as the classifier picked it: cur order, then prev-dropped.
    let mut first_key: Option<String> = None;
    for s in cur {
        let k = source_key(s);
        let diverges = match prev_by_key.get(&k) {
            None => true,
            Some(p) => !strict_eq(p.get("tokens"), s.get("tokens")),
        };
        if diverges {
            first_key = Some(k);
            break;
        }
    }
    if first_key.is_none() {
        for s in prev {
            let k = source_key(s);
            if !cur_keys.contains(&k) {
                first_key = Some(k);
                break;
            }
        }
    }

    // Flag only the FIRST entry carrying that key — a duplicate kind::label in one turn must not
    // double-flag, mirroring the classifier returning a single ContextSource.
    let mut first_marked = false;
    let mut mark_first = |key: &str| -> bool {
        if !first_marked && first_key.as_deref() == Some(key) {
            first_marked = true;
            return true;
        }
        false
    };

    let mut out: Vec<Value> = Vec::new();
    for s in cur {
        let key = source_key(s);
        let p = prev_by_key.get(&key).copied();
        let status = match p {
            None => "added",
            Some(p) if !strict_eq(p.get("tokens"), s.get("tokens")) => "resized",
            Some(_) => "unchanged",
        };
        let mut o = Map::new();
        o.insert("key".to_owned(), Value::String(key.clone()));
        put_opt(&mut o, "label", s.get("label"));
        put_opt(&mut o, "kind", s.get("kind"));
        o.insert("status".to_owned(), Value::String(status.to_owned()));
        // `p?.tokens ?? 0` — NULLISH, so a present-but-null tokens still becomes 0.
        o.insert(
            "prevTokens".to_owned(),
            p.and_then(|p| p.get("tokens")).filter(|v| !v.is_null()).cloned().unwrap_or_else(|| num(0.0)),
        );
        put_opt(&mut o, "curTokens", s.get("tokens"));
        put_opt(&mut o, "prevExcerpt", p.and_then(|p| p.get("excerpt")));
        put_opt(&mut o, "curExcerpt", s.get("excerpt"));
        o.insert("isFirstDivergence".to_owned(), Value::Bool(mark_first(&key)));
        out.push(Value::Object(o));
    }
    // A block present in prev but dropped in cur is also a divergence (the prefix shortened/shifted).
    for s in prev {
        let key = source_key(s);
        if cur_keys.contains(&key) {
            continue;
        }
        let mut o = Map::new();
        o.insert("key".to_owned(), Value::String(key.clone()));
        put_opt(&mut o, "label", s.get("label"));
        put_opt(&mut o, "kind", s.get("kind"));
        o.insert("status".to_owned(), Value::String("removed".to_owned()));
        // NOTE the asymmetry with the branch above: here `prevTokens: s.tokens` is RAW (no `?? 0`)
        // and `curTokens` is a literal 0, while `curExcerpt: undefined` drops the key outright.
        put_opt(&mut o, "prevTokens", s.get("tokens"));
        o.insert("curTokens".to_owned(), num(0.0));
        put_opt(&mut o, "prevExcerpt", s.get("excerpt"));
        o.insert("isFirstDivergence".to_owned(), Value::Bool(mark_first(&key)));
        out.push(Value::Object(o));
    }
    out
}

/// The first block that broke the prefix. Reuses `diff_turn_sources` so the classifier and the popup
/// can never disagree. Returns the cur block (added/resized) or, for a dropped block, the prev one.
fn first_divergent_block<'a>(prev: &'a [Value], cur: &'a [Value]) -> Option<&'a Value> {
    let d = diff_turn_sources(prev, cur).into_iter().find(|e| e.get("isFirstDivergence") == Some(&Value::Bool(true)))?;
    let key = d.get("key").and_then(Value::as_str).unwrap_or_default().to_owned();
    cur.iter().find(|s| source_key(s) == key).or_else(|| prev.iter().find(|s| source_key(s) == key))
}

/// Classify a divergent block's kind into a break cause.
fn cause_for_kind(kind: &str) -> Cause {
    if CATALOG_KINDS.contains(&kind) {
        return Cause::ToolsChanged;
    }
    if kind == "mcp" {
        return Cause::McpServerToggle;
    }
    Cause::InjectedBlockChanged
}

/// Price a wasted re-write. Only cache_creation above the cheap cache_read floor is "wasted".
fn price_waste(tokens: f64, opts: &AnalyzeCacheBreaksOpts) -> f64 {
    let Some(write) = opts.write_rate_usd_per_mtok else { return 0.0 };
    let input = opts.input_rate_usd_per_mtok.unwrap_or(0.0);
    // Credit back the cache-read the break avoided: the model's real rate when provided, else the
    // 0.1×-input default (correct for mainstream models, overstates waste for the rest).
    let cache_read = opts.cache_read_rate_usd_per_mtok.unwrap_or(0.1 * input);
    let per_tok = (write - cache_read) / 1_000_000.0;
    (tokens * per_tok).max(0.0)
}

/// Classify ONE transition (prev → cur) into a per-turn break verdict.
fn classify_turn(prev: &CacheTurnInput, cur: &CacheTurnInput, opts: &AnalyzeCacheBreaksOpts) -> Value {
    let idle_ttl = opts.idle_ttl_ms.unwrap_or(DEFAULT_IDLE_TTL_MS);
    let idle_gap_ms = match (cur.timestamp_ms, prev.timestamp_ms) {
        (Some(c), Some(p)) => Some(c - p),
        _ => None,
    };
    let wasted = cur.cache_create_tokens;

    let emit = |cause: Cause,
                label: Option<Value>,
                kind: Option<&str>,
                gap: Option<f64>,
                confidence: Option<&str>,
                attribution: Option<&str>|
     -> Value {
        let mut o = Map::new();
        o.insert("turn".to_owned(), num(cur.turn));
        o.insert("broke".to_owned(), Value::Bool(true));
        o.insert("cause".to_owned(), Value::String(cause.id().to_owned()));
        if let Some(l) = label {
            o.insert("breakSourceLabel".to_owned(), l);
        }
        if let Some(k) = kind {
            o.insert("breakSourceKind".to_owned(), Value::String(k.to_owned()));
        }
        o.insert("wastedTokens".to_owned(), num(wasted));
        o.insert("wastedCostUsd".to_owned(), num(price_waste(wasted, opts)));
        if let Some(g) = gap {
            o.insert("idleGapMs".to_owned(), num(g));
        }
        o.insert("remediation".to_owned(), Value::String(cause.remediation().to_owned()));
        if let Some(c) = confidence {
            o.insert("confidence".to_owned(), Value::String(c.to_owned()));
        }
        if let Some(a) = attribution {
            o.insert("attribution".to_owned(), Value::String(a.to_owned()));
        }
        if let Some(ts) = cur.timestamp_ms {
            o.insert("tsMs".to_owned(), num(ts));
        }
        Value::Object(o)
    };

    // 1. Model switch — a full, model-specific invalidation, dominates any block diff. TRUTHY on
    //    both sides, so an EMPTY model string means "unknown", not "switched to nothing".
    let cur_model = cur.model.as_deref().unwrap_or("");
    let prev_model = prev.model.as_deref().unwrap_or("");
    if !cur_model.is_empty() && !prev_model.is_empty() && cur_model != prev_model {
        return emit(Cause::ModelSwitched, None, None, None, None, None);
    }
    // 2. Fast mode turned on this turn.
    if cur.has_fast_mode.unwrap_or(false) && !prev.has_fast_mode.unwrap_or(false) {
        return emit(Cause::FastMode, None, None, None, None, None);
    }
    // 2.5 Plugin reload — /reload-plugins re-registers ≥2 catalogs at once. Detected BEFORE the
    // single-first-divergence pick (step 3), else it collapses to whichever catalog sorted first and
    // the reload is never named. (TRDD-EYA3X5MQ)
    //
    // SCOPE: this classifier only ever runs on a turn that ALREADY paid a real cache_creation, so
    // naming the reload as the culprit of an OBSERVED break is sound. What is NOT sound is claiming
    // a reload always rewrites the prefix — it does not, and the remediation text says so.
    let prev_kinds: HashSet<&str> = prev.sources.iter().filter_map(|s| s.get("kind").and_then(Value::as_str)).collect();
    let mut churned: Vec<String> = Vec::new();
    let mut churned_seen: HashSet<String> = HashSet::new();
    for d in diff_turn_sources(&prev.sources, &cur.sources) {
        let kind = d.get("kind").and_then(Value::as_str).unwrap_or_default();
        let changed = d.get("status").and_then(Value::as_str) != Some("unchanged");
        // The kind must have EXISTED in prev: a reload RE-registers already-present catalogs, so a
        // kind appearing for the FIRST time is session warmup, not a reload. This is what keeps
        // turn-2 cold-start churn from being mislabeled.
        if changed && RELOAD_CATALOG_KINDS.contains(&kind) && prev_kinds.contains(kind) && churned_seen.insert(kind.to_owned()) {
            churned.push(kind.to_owned());
        }
    }
    if churned.len() >= 2 {
        let mut kinds = churned.clone();
        kinds.sort();
        let label = format!("{} catalogs churned ({})", kinds.len(), kinds.join(", "));
        let confidence = if churned.len() >= 3 { "high" } else { "medium" };
        return emit(Cause::PluginsReloaded, Some(Value::String(label)), Some("catalog"), None, Some(confidence), None);
    }
    // 3. A localizable stable-block divergence (the common structural break).
    //
    // MARKED `block-diff-only` / confidence `low`, and that is not hedging — it is the honest
    // provenance. This is a SET DIFF with no breakpoint model, while the API caches the prefix
    // ending at a `cache_control` breakpoint and looks back at most 20 blocks. So a block changing
    // AFTER the governing breakpoint cannot have caused the miss, and a break can occur with NO
    // block changed. Measured 2026-08-04: `system[0]` changes on every request while those turns
    // bill 0.3-0.7% write. For a breakpoint-verified answer use get_cache_break_timeline.
    // (TRDD-V8YOWHVT)
    if let Some(diverged) = first_divergent_block(&prev.sources, &cur.sources) {
        let kind = diverged.get("kind").and_then(Value::as_str).unwrap_or_default();
        return emit(
            cause_for_kind(kind),
            diverged.get("label").cloned(),
            diverged.get("kind").and_then(Value::as_str),
            None,
            Some("low"),
            Some("block-diff-only"),
        );
    }
    // 4. No block diff but a long idle gap with a real re-write → the entry expired (one-time).
    if idle_gap_ms.is_some_and(|g| g > idle_ttl) && cur.cache_create_tokens > 0.0 {
        return emit(Cause::IdleTtlExpiry, None, None, idle_gap_ms, None, None);
    }
    // 5. Nothing localisable — but "nothing to point at" covers two situations that must not be
    //    conflated, because doing so hides the costliest event this analyzer exists to surface:
    //    - a MODEST write with no divergence is expected suffix writing. Not a break. Stays silent.
    //    - a write that DOMINATES the turn (more written than read) with nothing to blame is a real
    //      cold rewrite we cannot name. Reporting it as "no break" makes it invisible; inventing a
    //      culprit is worse. Report it, unnamed. (TRDD-V8YOWHVT)
    if wasted > 0.0 && wasted > cur.cache_read_tokens {
        return emit(Cause::Unattributable, None, None, idle_gap_ms, Some("low"), Some("block-diff-only"));
    }
    let mut o = Map::new();
    o.insert("turn".to_owned(), num(cur.turn));
    o.insert("broke".to_owned(), Value::Bool(false));
    o.insert("cause".to_owned(), Value::String(Cause::Unknown.id().to_owned()));
    o.insert("wastedTokens".to_owned(), num(0.0));
    o.insert("wastedCostUsd".to_owned(), num(0.0));
    if let Some(g) = idle_gap_ms {
        o.insert("idleGapMs".to_owned(), num(g));
    }
    Value::Object(o)
}

struct Offender {
    label: Value,
    kind: Value,
    cause: String,
    occurrences: f64,
    wasted_tokens: f64,
    wasted_cost_usd: f64,
}

/// Rank the avoidable breaks by cumulative wasted cost (tokens as tie-breaker), grouped by the
/// offending source + cause — the "which block cost me the most cache re-writes" leaderboard.
fn rank_offenders(turns: &[Value]) -> Vec<Value> {
    let mut by_key: IndexMap<String, Offender> = IndexMap::new();
    for t in turns {
        if !truthy(t.get("broke").unwrap_or(&Value::Null)) {
            continue;
        }
        let cause = t.get("cause").and_then(Value::as_str).unwrap_or_default().to_owned();
        let label = t
            .get("breakSourceLabel")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| Value::String(format!("({cause})")));
        let kind = t.get("breakSourceKind").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| Value::String("-".to_owned()));
        let key = format!("{}::{}::{}", cause, js_string(&kind), js_string(&label));
        let e = by_key.entry(key).or_insert_with(|| Offender {
            label,
            kind,
            cause,
            occurrences: 0.0,
            wasted_tokens: 0.0,
            wasted_cost_usd: 0.0,
        });
        e.occurrences += 1.0;
        e.wasted_tokens += t.get("wastedTokens").and_then(Value::as_f64).unwrap_or(0.0);
        e.wasted_cost_usd += t.get("wastedCostUsd").and_then(Value::as_f64).unwrap_or(0.0);
    }
    let mut list: Vec<Offender> = by_key.into_values().collect();
    // `(b.cost - a.cost) || (b.tokens - a.tokens)` under a STABLE sort — ties keep insertion order.
    list.sort_by(|a, b| {
        let d = b.wasted_cost_usd - a.wasted_cost_usd;
        if d != 0.0 && !d.is_nan() {
            return d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal);
        }
        let d2 = b.wasted_tokens - a.wasted_tokens;
        if d2.is_nan() {
            return std::cmp::Ordering::Equal;
        }
        d2.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    list.into_iter()
        .map(|o| {
            let mut m = Map::new();
            m.insert("label".to_owned(), o.label);
            m.insert("kind".to_owned(), o.kind);
            m.insert("cause".to_owned(), Value::String(o.cause));
            m.insert("occurrences".to_owned(), num(o.occurrences));
            m.insert("wastedTokens".to_owned(), num(o.wasted_tokens));
            m.insert("wastedCostUsd".to_owned(), num(o.wasted_cost_usd));
            Value::Object(m)
        })
        .collect()
}

/// Analyze a session's per-turn cache breaks. Pure: same input → same output, no side effects.
/// `turns` must be chronological; turn 1 never "breaks" (nothing precedes it).
pub fn analyze_cache_breaks(session_id: &str, turns: &[CacheTurnInput], opts: &AnalyzeCacheBreaksOpts) -> Value {
    let mut results: Vec<Value> = Vec::new();
    let mut total_read = 0.0_f64;
    let mut total_create = 0.0_f64;

    for (i, cur) in turns.iter().enumerate() {
        total_read += cur.cache_read_tokens;
        total_create += cur.cache_create_tokens;
        if i == 0 {
            // The first turn warms the cache from cold — not an avoidable break. NOTE this literal
            // carries no `idleGapMs` key at all, unlike the step-5 no-break object.
            let mut o = Map::new();
            o.insert("turn".to_owned(), num(cur.turn));
            o.insert("broke".to_owned(), Value::Bool(false));
            o.insert("cause".to_owned(), Value::String(Cause::Unknown.id().to_owned()));
            o.insert("wastedTokens".to_owned(), num(0.0));
            o.insert("wastedCostUsd".to_owned(), num(0.0));
            results.push(Value::Object(o));
            continue;
        }
        results.push(classify_turn(&turns[i - 1], cur, opts));
    }

    let offenders = rank_offenders(&results);
    let total_wasted_tokens: f64 = offenders.iter().map(|o| o.get("wastedTokens").and_then(Value::as_f64).unwrap_or(0.0)).sum();
    let total_wasted_cost_usd: f64 = offenders.iter().map(|o| o.get("wastedCostUsd").and_then(Value::as_f64).unwrap_or(0.0)).sum();
    let denom = total_read + total_create;
    let cache_hit_rate = if denom > 0.0 { total_read / denom } else { 0.0 };

    let mut out = Map::new();
    out.insert("sessionId".to_owned(), Value::String(session_id.to_owned()));
    out.insert("turns".to_owned(), Value::Array(results));
    out.insert("offenders".to_owned(), Value::Array(offenders));
    out.insert("totalWastedTokens".to_owned(), num(total_wasted_tokens));
    out.insert("totalWastedCostUsd".to_owned(), num(total_wasted_cost_usd));
    out.insert("cacheHitRate".to_owned(), num(cache_hit_rate));
    Value::Object(out)
}

#[derive(Default)]
struct Acc {
    cache_read: f64,
    cache_create: f64,
    input: f64,
    model: Option<String>,
    ts: Option<f64>,
}

/// Assemble the report from a session's timeline + composition: fold the timeline into per-turn
/// token buckets, overlay the composition's injected blocks, price the waste from the session
/// model's rates. Returns None when there isn't enough to diff (no composition, or a single turn).
///
/// `now_ms` is threaded through to `lookup_rates` because the TS calls the 1-arg `lookupRates`,
/// whose scheduled-rate-change branch reads the wall clock — pinning it is what makes the oracle
/// reproducible.
pub fn build_cache_break_report(
    session_id: &str,
    timeline: &[Value],
    composition: Option<&Value>,
    session_model: &str,
    now_ms: f64,
) -> Option<Value> {
    let composition = composition.filter(|c| truthy(c))?;
    let empty: Vec<Value> = Vec::new();
    let mut sources_by_turn: HashMap<u64, Vec<Value>> = HashMap::new();
    for t in composition.get("turns").and_then(Value::as_array).unwrap_or(&empty) {
        if let Some(turn) = t.get("turn").and_then(Value::as_f64) {
            sources_by_turn.insert(turn.to_bits(), t.get("sources").and_then(Value::as_array).cloned().unwrap_or_default());
        }
    }

    // Keyed by the turn's exact f64 bits so no integer narrowing is assumed; the paired f64 is what
    // the ascending sort below reads.
    let mut by_turn: IndexMap<u64, (f64, Acc)> = IndexMap::new();
    for e in timeline {
        if e.get("type").and_then(Value::as_str) == Some("background") {
            continue;
        }
        // `e.turn === undefined` skips; a non-numeric turn cannot key a numeric bucket, so it is
        // skipped too (the composition parser only ever emits numbers).
        let Some(turn) = e.get("turn").and_then(Value::as_f64) else { continue };
        let a = &mut by_turn.entry(turn.to_bits()).or_insert_with(|| (turn, Acc::default())).1;
        a.cache_read += e.get("cacheReadTokens").and_then(Value::as_f64).unwrap_or(0.0);
        a.cache_create += e.get("cacheCreateTokens").and_then(Value::as_f64).unwrap_or(0.0);
        a.input += e.get("inputTokens").and_then(Value::as_f64).unwrap_or(0.0);
        // `!a.model` is TRUTHY, so an empty model never sticks and never blocks a later real one.
        if a.model.as_deref().unwrap_or("").is_empty() && e.get("type").and_then(Value::as_str) == Some("llm") {
            if let Some(m) = e.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()) {
                a.model = Some(m.to_owned());
            }
        }
        if a.ts.is_none() {
            if let Some(ms) = e.get("timestamp").and_then(Value::as_str).filter(|s| !s.is_empty()).and_then(parse_iso_ms) {
                a.ts = Some(ms);
            }
        }
    }
    if by_turn.len() < 2 {
        return None;
    }

    let rates = lookup_rates(session_model, None, now_ms);
    let opts = rates.map_or_else(AnalyzeCacheBreaksOpts::default, |r| AnalyzeCacheBreaksOpts {
        write_rate_usd_per_mtok: Some(r.cache_write_per_mtok),
        input_rate_usd_per_mtok: Some(r.input_per_mtok),
        // The model's ACTUAL cache-read rate, not a hardcoded 0.1× input (wrong for e.g. codex-mini
        // at 0.25×), so the priced waste credits back the real avoided read.
        cache_read_rate_usd_per_mtok: Some(r.cache_read_per_mtok),
        idle_ttl_ms: None,
    });

    let mut entries: Vec<(f64, Acc)> = by_turn.into_values().collect();
    entries.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let inputs: Vec<CacheTurnInput> = entries
        .into_iter()
        .map(|(turn, a)| CacheTurnInput {
            turn,
            sources: sources_by_turn.get(&turn.to_bits()).cloned().unwrap_or_default(),
            cache_read_tokens: a.cache_read,
            cache_create_tokens: a.cache_create,
            input_tokens: a.input,
            model: Some(a.model.unwrap_or_else(|| session_model.to_owned())),
            has_fast_mode: None,
            timestamp_ms: a.ts,
        })
        .collect();

    Some(analyze_cache_breaks(session_id, &inputs, &opts))
}
