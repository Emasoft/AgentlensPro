//! Port of src/skillAttribution.ts (TRDD-A4BA8IU5, ported under TRDD-DMWOBWFH P4x.2d) — per-skill
//! and per-plugin COST attribution, read straight from the Claude Code transcript.
//!
//! Claude Code stamps assistant records with `attributionSkill` / `attributionPlugin` naming the
//! skill or plugin whose invocation produced that turn. No release note mentions these fields —
//! they were found by scanning real transcripts — and they answer the question this product exists
//! for: WHICH skill or plugin is spending the money. Not academic: a heartbeat loop drained three
//! OAuth accounts and no report could name the skill responsible.
//!
//! Same substrate as `cache_risk_commands` and for the same reasons: the transcript is on disk,
//! exact, and retroactive over the whole history — no hook, no migration, no ingest change.

use std::collections::HashSet;
use std::path::PathBuf;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::summarize::helpers::{js_to_fixed_num, num, truthy};

/// One skill's or plugin's accumulator. `models` is an IndexMap because the emitted list is sorted
/// by count with a STABLE tie-break — first-seen order has to survive.
#[derive(Default)]
struct Acc {
    messages: f64,
    input: f64,
    cache_read: f64,
    cache_write: f64,
    output: f64,
    cost: f64,
    models: IndexMap<String, f64>,
    first: Option<f64>,
    last: Option<f64>,
}

/// Roll each accumulator into its wire object, ranked by cost. `firstTs`/`lastTs` are OMITTED when
/// never set (the TS leaves them `undefined`), so a rollup with no parseable timestamps says so by
/// absence rather than by a 0 that reads as 1970.
fn finish(map: &IndexMap<String, Acc>) -> Vec<Value> {
    let mut out: Vec<Value> = map
        .iter()
        .map(|(name, a)| {
            let mut models: Vec<(&String, f64)> = a.models.iter().map(|(m, c)| (m, *c)).collect();
            models.sort_by(|x, y| y.1.partial_cmp(&x.1).unwrap_or(std::cmp::Ordering::Equal));
            let mut m = Map::new();
            m.insert("name".into(), Value::String(name.clone()));
            m.insert("messages".into(), num(a.messages));
            m.insert("inputTokens".into(), num(a.input));
            m.insert("cacheReadTokens".into(), num(a.cache_read));
            m.insert("cacheWriteTokens".into(), num(a.cache_write));
            m.insert("outputTokens".into(), num(a.output));
            m.insert("costUsd".into(), num(js_to_fixed_num(a.cost, 4)));
            m.insert("models".into(), Value::Array(models.iter().map(|(name, _)| Value::String((*name).clone())).collect()));
            if let Some(t) = a.first {
                m.insert("firstTs".into(), num(t));
            }
            if let Some(t) = a.last {
                m.insert("lastTs".into(), num(t));
            }
            Value::Object(m)
        })
        .collect();
    out.sort_by(|x, y| {
        let c = |v: &Value| v.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0);
        c(y).partial_cmp(&c(x)).unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

/// Roll up the token/cost footprint per attributed skill and plugin.
///
/// **THE DEDUPE IS LOAD-BEARING.** Claude Code writes ONE assistant message as MULTIPLE JSONL rows
/// — one per content block (thinking / text / each tool_use) — and repeats the FULL `usage` on
/// every row. Summing per row over-counts 2-5x, worst on exactly the tool-heavy sessions this
/// report exists to explain (logReader documents the same trap costing a 2.4-4.5x over-count on a
/// real session). So usage is counted ONCE per `message.id`, and the rows skipped are REPORTED
/// rather than hidden — a silent dedupe is indistinguishable from data loss.
pub fn build_attribution_report(dirs: &[PathBuf], since_ms: Option<f64>, top_n: Option<f64>, now_ms: f64) -> Value {
    let mut by_skill: IndexMap<String, Acc> = IndexMap::new();
    let mut by_plugin: IndexMap<String, Acc> = IndexMap::new();
    let mut seen: HashSet<String> = HashSet::new();
    let (mut attributed, mut priced, mut dupes, mut total) = (0.0, 0.0, 0.0, 0.0);

    for file in crate::cache_risk_commands::transcript_files(dirs) {
        if let Some(since) = since_ms {
            // Whole files are skipped by MTIME before being read — the cheap filter that makes a
            // windowed report affordable over a full history. An unreadable stat SKIPS the file
            // (the TS `catch { continue }`), it does not fall through to reading it.
            let mtime = std::fs::metadata(&file)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as f64);
            match mtime {
                Some(m) if m >= since => {}
                _ => continue,
            }
        }
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        // A whole-file substring pre-filter before any JSON parsing: most transcripts carry no
        // attribution at all, and parsing them line by line to discover that is the slow path.
        if !text.contains("attributionSkill") && !text.contains("attributionPlugin") {
            continue;
        }

        for line in text.split('\n') {
            if !line.contains("attribution") {
                continue;
            }
            let Ok(rec) = serde_json::from_str::<Value>(line) else { continue };
            if rec.get("type").and_then(Value::as_str) != Some("assistant") {
                continue;
            }
            // `if (!skill && !plugin)` and `if (!key) continue` are both TRUTHY tests, so an EMPTY
            // stamp is indistinguishable from an absent one. Filtering here makes both sites agree
            // — `is_none()` alone would have let `""` past the guard and then minted a rollup
            // named "".
            let nonempty = |k: &str| rec.get(k).and_then(Value::as_str).filter(|s| !s.is_empty());
            let (skill, plugin) = (nonempty("attributionSkill"), nonempty("attributionPlugin"));
            if skill.is_none() && plugin.is_none() {
                continue;
            }
            let ts = rec.get("timestamp").and_then(Value::as_str).and_then(crate::summarize::helpers::parse_iso_ms);
            if let Some(since) = since_ms {
                // An UNPARSEABLE timestamp is excluded when a window is asked for (`!isFinite(ts)`
                // fails the guard) — a record that cannot be placed in time cannot be claimed to
                // fall inside the window.
                match ts {
                    Some(t) if t >= since => {}
                    _ => continue,
                }
            }

            let msg = rec.get("message");
            // `if (id)` — an EMPTY id is falsy, so such a row is never deduped against. A record
            // with no id at all is likewise always counted; the dedupe can only ever merge rows
            // that positively agree on a real id.
            if let Some(id) = msg.and_then(|m| m.get("id")).and_then(Value::as_str).filter(|s| !s.is_empty()) {
                if !seen.insert(id.to_owned()) {
                    dupes += 1.0;
                    continue;
                }
            }
            attributed += 1.0;

            // `usage ? … : 0` is a TRUTHY test, not an is-object test: a malformed non-object
            // `usage` still counts as PRICED (at $0, since no field reads out of it). Filtering on
            // `is_object()` would move that row into unpriced and make the two counters disagree
            // with the TS on exactly the corrupt records where the difference is visible.
            let usage = msg.and_then(|m| m.get("usage")).filter(|u| truthy(u));
            let model = msg.and_then(|m| m.get("model")).and_then(Value::as_str).unwrap_or("");
            let n = |k: &str| usage.and_then(|u| u.get(k)).and_then(Value::as_f64).filter(|v| v.is_finite()).unwrap_or(0.0);
            let (input, cache_read, cache_write, output) =
                (n("input_tokens"), n("cache_read_input_tokens"), n("cache_creation_input_tokens"), n("output_tokens"));
            // A record with NO usage block is still an attributed message — counted, just not
            // priced — so `attributedMessages` never silently shrinks to only the priceable ones.
            let cost = if usage.is_some() {
                crate::pricing::calc_token_cost_usd(input, cache_read, cache_write, output, model, 0.0, None, now_ms)
            } else {
                0.0
            };
            if usage.is_some() {
                priced += 1.0;
                total += cost;
            }

            for (key, map) in [(skill, &mut by_skill), (plugin, &mut by_plugin)] {
                let Some(key) = key else { continue };
                let a = map.entry(key.to_owned()).or_default();
                a.messages += 1.0;
                a.input += input;
                a.cache_read += cache_read;
                a.cache_write += cache_write;
                a.output += output;
                a.cost += cost;
                if !model.is_empty() {
                    *a.models.entry(model.to_owned()).or_insert(0.0) += 1.0;
                }
                if let Some(t) = ts {
                    a.first = Some(a.first.map_or(t, |f| f.min(t)));
                    a.last = Some(a.last.map_or(t, |l| l.max(t)));
                }
            }
        }
    }

    // `Math.max(1, topN)` — no UPPER clamp in the TS, and no default: absent means UNCAPPED.
    let cap = top_n.map(|n| n.max(1.0) as usize);
    let take = |v: Vec<Value>| -> Vec<Value> { cap.map_or(v.clone(), |c| v.into_iter().take(c).collect()) };
    let mut m = Map::new();
    m.insert("attributedMessages".into(), num(attributed));
    m.insert("pricedMessages".into(), num(priced));
    m.insert("totalCostUsd".into(), num(js_to_fixed_num(total, 4)));
    m.insert("bySkill".into(), Value::Array(take(finish(&by_skill))));
    m.insert("byPlugin".into(), Value::Array(take(finish(&by_plugin))));
    m.insert("duplicateRowsSkipped".into(), num(dupes));
    m.insert("windowHours".into(), Value::Null);
    Value::Object(m)
}

/// `get_skill_attribution` — the report with `windowHours` overwritten by the caller's own window.
/// The engine always emits null there; the tool is the layer that knows what was asked for.
pub fn get_skill_attribution(dirs: &[PathBuf], window_hours: Option<f64>, top_n: Option<f64>, now_ms: f64) -> Value {
    // `a.window ? now - a.window*h : undefined` — TRUTHY, so `window: 0` means NO window at all,
    // not a zero-length one.
    let since = window_hours.filter(|w| *w != 0.0).map(|w| now_ms - w * 3_600_000.0);
    let mut report = build_attribution_report(dirs, since, top_n, now_ms);
    if let Some(o) = report.as_object_mut() {
        // `{...rep, windowHours}` — the key already exists, so it keeps its LITERAL position and
        // only the value changes.
        o.insert("windowHours".into(), window_hours.map_or(Value::Null, num));
    }
    report
}
