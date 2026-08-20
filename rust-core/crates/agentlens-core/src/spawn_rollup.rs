//! Port of src/shared/spawnRollup.ts (TRDD-62E8UU41, ported under TRDD-DMWOBWFH P4x.2d) — the
//! spawn-cost rollup + cache-friendly-spawn advisor.
//!
//! Pure aggregation over a parent's sub-agent children. It answers the question the founding
//! fable-5 burn made manual: "this ONE fan-out caused N children x M cache-create = X tokens / $Y —
//! and here is the cheaper spawn shape." The cost function is INJECTED so each runtime supplies its
//! own pricing without this module depending on either.

use serde_json::{Map, Value};

use crate::summarize::helpers::{js_to_fixed_num, num, truthy};

/// A child that WROTE a big prefix but did NOT read a comparably big one is cache-COLD: it re-billed
/// the inherited context at write rate (~1.25x) instead of reading the parent cache (~0.1x). 100k is
/// the "large inherited prefix" floor — below it the re-bill is not worth a flag.
pub const COLD_CACHE_CREATE_MIN: f64 = 100_000.0;
/// "near-zero cache-read": a cold child reads back at most this FRACTION of what it wrote. A fork
/// reads the parent cache so cache_read dominates — exactly what this ratio excludes.
pub const NEAR_ZERO_READ_RATIO: f64 = 0.2;
/// A fan-out is a "fleet" once this many cold children re-bill their own prefixes.
pub const FLEET_COLD_MIN_CHILDREN: usize = 3;
/// "Scatter" / "mix" need >=2 implicated children — one is not a pattern worth a fleet-level flag.
pub const WORKTREE_SCATTER_MIN_CHILDREN: usize = 2;
pub const MODEL_MIX_MIN_CHILDREN: usize = 2;

fn f(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(Value::as_f64).filter(|n| n.is_finite()).unwrap_or(0.0)
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// `c.spawnModelOverride || c.model || ''` — FALSY-or, so an EMPTY override falls through to the
/// model rather than making the child look like it has no model at all.
fn child_model(c: &Value) -> &str {
    let o = s(c, "spawnModelOverride");
    if o.is_empty() {
        s(c, "model")
    } else {
        o
    }
}

/// The cache-COLD signature, deliberately derived from the RECORDED buckets and NOT from spawnKind,
/// so a mislabeled or unknown-kind child that still re-billed a huge prefix is caught. The detection
/// is about observed cache behaviour, not the spawn label.
fn is_cold_child(c: &Value) -> bool {
    f(c, "cacheCreateTokens") >= COLD_CACHE_CREATE_MIN && f(c, "cacheReadTokens") <= f(c, "cacheCreateTokens") * NEAR_ZERO_READ_RATIO
}

/// `x.toFixed(d)` as a STRING — which is NOT `fmt_js_num(js_to_fixed_num(..))`: toFixed PADS
/// trailing zeros, so `(1.5).toFixed(2)` is "1.50" while the numeric round-trip prints "1.5".
/// `js_to_fixed_num` does the (exact, tie-aware) rounding; `{:.d}` only renders the already-rounded
/// value. Local because only these two formatters need it — and both are called on strictly
/// positive values, so JS's `(-0).toFixed(2) === "0.00"` (Rust would print "-0.00") is unreachable.
fn js_to_fixed_str(x: f64, digits: usize) -> String {
    format!("{:.*}", digits, js_to_fixed_num(x, digits as u32))
}

fn fmt_tokens(n: f64) -> String {
    if n >= 1_000_000.0 {
        format!("{}M", js_to_fixed_str(n / 1_000_000.0, 1))
    } else if n >= 1_000.0 {
        format!("{}k", crate::summarize::helpers::fmt_js_num(crate::summarize::helpers::js_math_round(n / 1_000.0)))
    } else {
        crate::summarize::helpers::fmt_js_num(n)
    }
}

fn fmt_usd(n: f64) -> String {
    if n <= 0.0 {
        "$0".to_owned()
    } else if n < 0.01 {
        "<$0.01".to_owned()
    } else {
        format!("${}", js_to_fixed_str(n, 2))
    }
}

/// Sigma cost of a child set, rounded ONCE — rounding per child would compound float noise across a
/// large fan-out, which is exactly the case this report exists for.
fn sum_cost(cards: &[&Value], cost_of: &dyn Fn(&Value) -> f64) -> f64 {
    js_to_fixed_num(cards.iter().map(|c| cost_of(c)).sum::<f64>(), 4)
}

fn sum_cache_create(cards: &[&Value]) -> f64 {
    cards.iter().map(|c| f(c, "cacheCreateTokens")).sum()
}

fn detection(code: &str, severity: &str, cards: &[&Value], cost_of: &dyn Fn(&Value) -> f64, message: String, remediation: &str) -> Value {
    let mut m = Map::new();
    m.insert("code".into(), Value::String(code.into()));
    m.insert("severity".into(), Value::String(severity.into()));
    m.insert("childCount".into(), num(cards.len() as f64));
    m.insert("wastedTokens".into(), num(sum_cache_create(cards)));
    m.insert("wastedCostUsd".into(), num(sum_cost(cards, cost_of)));
    m.insert("message".into(), Value::String(message));
    m.insert("remediation".into(), Value::String(remediation.into()));
    Value::Object(m)
}

pub fn detect_spawn_antipatterns(children: &[Value], parent_model: &str, cost_of: &dyn Fn(&Value) -> f64) -> Vec<Value> {
    let mut out = Vec::new();

    // FLEET-COLD — each child wrote a large prefix and read back almost none of it, re-billing the
    // inherited context instead of reading the parent cache: the founding fleet-of-cold-forks burn.
    let cold: Vec<&Value> = children.iter().filter(|c| is_cold_child(c)).collect();
    if cold.len() >= FLEET_COLD_MIN_CHILDREN {
        let msg = format!(
            "{} cold children each re-billed a large inherited prefix (Σ {} cache-create, {}) instead of reading the parent cache.",
            cold.len(),
            fmt_tokens(sum_cache_create(&cold)),
            fmt_usd(sum_cost(&cold, cost_of))
        );
        out.push(detection("FLEET-COLD", "HIGH", &cold, cost_of, msg,
            "Fork the children (subagent_type: \"fork\") so each reads the parent cache, or trim the inherited context before fanning out."));
    }

    // WORKTREE-SCATTER — a worktree has its own cwd, so the system-prompt prefix (cwd/OS/git) differs
    // from the parent's: a separate cache scope that shares NOTHING, and each such child pays a full
    // cold start.
    let wt: Vec<&Value> = children
        .iter()
        .filter(|c| (s(c, "spawnKind") == "worktree" || s(c, "spawnIsolation") == "worktree") && f(c, "cacheCreateTokens") >= COLD_CACHE_CREATE_MIN)
        .collect();
    if wt.len() >= WORKTREE_SCATTER_MIN_CHILDREN {
        let msg = format!(
            "{} worktree-isolated children ran cache-heavy work (Σ {} cache-create, {}); each worktree's own cwd is a separate cache scope that shares nothing with the parent.",
            wt.len(),
            fmt_tokens(sum_cache_create(&wt)),
            fmt_usd(sum_cost(&wt, cost_of))
        );
        out.push(detection("WORKTREE-SCATTER", "MEDIUM", &wt, cost_of, msg,
            "Run cache-heavy fan-out in the parent cwd (no worktree isolation) so children share the parent prefix; reserve worktrees for work that truly needs an isolated checkout."));
    }

    // MODEL-MIX — caches are MODEL-SPECIFIC, so a child on another model cannot reuse the parent
    // cache and must re-warm its own. An UNKNOWN parent model disables the check entirely rather than
    // comparing against '' and flagging every child.
    let mixed: Vec<&Value> = if parent_model.is_empty() {
        Vec::new()
    } else {
        children
            .iter()
            .filter(|c| {
                let m = child_model(c);
                !m.is_empty() && m != parent_model && f(c, "cacheCreateTokens") >= COLD_CACHE_CREATE_MIN
            })
            .collect()
    };
    if mixed.len() >= MODEL_MIX_MIN_CHILDREN {
        let msg = format!(
            "{} children ran on a different model than the parent ({}) with large prefixes (Σ {} cache-create, {}); caches are model-specific, so none reused the parent cache.",
            mixed.len(),
            parent_model,
            fmt_tokens(sum_cache_create(&mixed)),
            fmt_usd(sum_cost(&mixed, cost_of))
        );
        out.push(detection("MODEL-MIX", "MEDIUM", &mixed, cost_of, msg,
            "Keep the fan-out on the parent model unless a child truly needs another model — a model override starts a separate cache the child must re-warm."));
    }

    out
}

pub fn build_spawn_rollup(children: &[Value], parent_model: &str, cost_of: &dyn Fn(&Value) -> f64) -> Value {
    let (mut fresh, mut fork, mut worktree, mut fleet, mut model_override, mut unknown) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    let (mut input, mut output, mut read, mut create) = (0.0, 0.0, 0.0, 0.0);
    for c in children {
        input += f(c, "inputTokens");
        output += f(c, "outputTokens");
        read += f(c, "cacheReadTokens");
        create += f(c, "cacheCreateTokens");
        // FAIL-FAST: an absent or unrecognized spawnKind counts as `unknown`, NEVER as `fresh` — a
        // mislabeled cold fork must show up as unknown so the mix stays honest.
        match s(c, "spawnKind") {
            "fresh" => fresh += 1.0,
            "fork" => fork += 1.0,
            "worktree" => worktree += 1.0,
            "fleet" => fleet += 1.0,
            _ => unknown += 1.0,
        }
        // `if (c.spawnModelOverride)` — truthy, so an empty override does not count as one.
        if truthy(c.get("spawnModelOverride").unwrap_or(&Value::Null)) {
            model_override += 1.0;
        }
    }
    let async_unreported = children.iter().filter(|c| truthy(c.get("spawnAsync").unwrap_or(&Value::Null))).count() as f64;
    let all: Vec<&Value> = children.iter().collect();

    let mut mix = Map::new();
    mix.insert("fresh".into(), num(fresh));
    mix.insert("fork".into(), num(fork));
    mix.insert("worktree".into(), num(worktree));
    mix.insert("fleet".into(), num(fleet));
    mix.insert("modelOverride".into(), num(model_override));
    mix.insert("unknown".into(), num(unknown));

    let mut m = Map::new();
    m.insert("childCount".into(), num(children.len() as f64));
    m.insert("totalInputTokens".into(), num(input));
    m.insert("totalOutputTokens".into(), num(output));
    m.insert("totalCacheReadTokens".into(), num(read));
    m.insert("totalCacheCreateTokens".into(), num(create));
    m.insert("totalCostUsd".into(), num(sum_cost(&all, cost_of)));
    // Async children carry ZERO buckets by data ABSENCE (their usage never reaches the parent
    // transcript). Counting them is what stops the totals above from reading as complete coverage —
    // and `undefined` when there are none, so the key is OMITTED rather than emitting a 0 that would
    // read as "checked, none found" identically to "not applicable".
    if async_unreported > 0.0 {
        m.insert("asyncUnreportedChildren".into(), num(async_unreported));
    }
    m.insert("kindMix".into(), Value::Object(mix));
    m.insert("detections".into(), Value::Array(detect_spawn_antipatterns(children, parent_model, cost_of)));
    Value::Object(m)
}
