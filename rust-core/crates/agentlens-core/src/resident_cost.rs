//! Port of src/shared/residentCost.ts (TRDD-W0RRL2FZ, ported under TRDD-DMWOBWFH) — resident-cost
//! itemization over an existing ContextHistory (see `context_history.rs`). No I/O, no new
//! ingestion. The cost model is `cost ≈ turns × per-turn-context`: every block occurrence rides
//! forward in the transcript from the step it was added until the next compaction evicts it (or
//! the session ends), and is re-read (cache-read billed) on every turn in between. This module
//! multiplies the two dimensions the history already knows (per-block tokens × turns-resident) and
//! ranks the result, itemizing the "conversation remainder" of the inflation report.

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::summarize::helpers::num;

/// Per-kind one-line remediation hints (TRDD-W0RRL2FZ spec 4). The TS source types this as a
/// `Record<ContextBlockKind, string>` so the compiler forces a hint for every kind in the union —
/// here the union is enforced by the fact every branch of `ContextBlockKind` (context_history.rs)
/// has an explicit arm; an unrecognized kind (never emitted by our own builder) falls back to the
/// 'other' text rather than an empty string.
fn kind_remediation(kind: &str) -> &'static str {
    match kind {
        "postCompact" => "The compaction summary rides every turn after the compaction — compact earlier (smaller transcript to summarize) or keep the summary shorter.",
        "toolOutput" => "This tool output rode the transcript for many turns — extract the needed fact and drop the blob (scope reads, filter command output).",
        "bashOutput" => "Command output rides forward every turn — pipe through head/grep so only the needed lines enter the transcript.",
        "subagentOutput" => "The sub-agent report rides forward — have agents return a one-line summary plus a report path instead of the full report body.",
        "file" => "Pasted/loaded file content rides the transcript — read only the needed line range and avoid re-pasting files.",
        "hook" => "Per-turn hook injections accumulate one copy per fire — shorten the hook output or fire it less often.",
        "cron" => "Each scheduled/local-command ping adds a copy that rides until the next compaction — lengthen the ping interval or compact periodically.",
        "harness" => "Harness-injected reminders accumulate per turn — keep injected rules/reminders short.",
        "reminder" => "Task reminders re-inject each turn — keep the todo list short.",
        "userMsg" => "Long user messages ride the whole session — reference files by path instead of pasting content.",
        "assistantMsg" => "Long responses ride forward every later turn — keep answers terse in long sessions.",
        "reasoning" => "Extended thinking rides forward in the transcript — lower the reasoning effort for mechanical steps.",
        "toolInput" => "Large tool inputs (e.g. full-file Write payloads) ride forward — prefer targeted edits over full-content writes.",
        "bashInput" => "Long command lines ride forward — move complex scripts into files and invoke them by path.",
        "toolCatalog" => "The tool catalog sits in the prefix — avoid toggling tools/MCP servers mid-session (each change re-caches the prefix).",
        "skillCatalog" => "The skill catalog sits in the prefix every turn — trim unused skills.",
        "agentCatalog" => "The agent catalog sits in the prefix every turn — trim unused agent definitions.",
        "mcp" => "MCP instructions sit in the prefix every turn — disconnect servers the task does not need.",
        "skillPrompt" => "A loaded skill prompt stays resident for the rest of the session — load only the skills the task needs.",
        "agentPrompt" => "The agent prompt is charged every turn — keep agent definitions lean.",
        "system" => "The system prompt is charged every turn — keep global instructions lean.",
        "claudemd" => "CLAUDE.md is injected every turn — keep it lean and move detail into on-demand files.",
        "rule" => "Rule files are injected every turn — keep always-on rules short and move detail into skills.",
        _ => "Unclassified content riding the transcript — drill into the block to identify and trim it.",
    }
}

fn turn_of(step: &Value) -> i64 {
    step.get("turn").and_then(Value::as_i64).unwrap_or(0)
}

struct BlockAgg {
    kind: String,
    label: String,
    tokens: f64,
    peak_tokens: f64,
    occurrences: f64,
    first_seen_turn: i64,
    last_resident_turn: i64,
    resident_cost: f64,
    remediation: &'static str,
}

/// Rank every distinct context block of a session by resident cost = Σ over its occurrences of
/// tokens × turns-resident.
///
/// Residency model: content attributed to turn T stays in the live context until the turn BEFORE
/// the first compaction turn > T (compaction turns = steps carrying a postCompact block: the
/// summary is attributed to the first post-compaction turn, so everything attributed to EARLIER
/// turns was dropped by that compaction), else until the last turn. This is an approximation —
/// compaction preserves a few anchor messages (preservedMessages) that ride longer than modeled —
/// which is why the report reconciles against exact usage totals and labels the gap (`note`).
///
/// `history` is a ContextHistory JSON value (the shape `context_history::build_context_history`
/// returns): `{sessionId, steps: [{turn, usage?, blocks: [{id, kind, label, tokens}], ...}],
/// truncated}`.
pub fn build_resident_cost_report(history: &Value) -> Value {
    let empty: Vec<Value> = Vec::new();
    let steps = history.get("steps").and_then(Value::as_array).unwrap_or(&empty);
    let last_turn: i64 = steps.last().map(turn_of).unwrap_or(0);

    let mut compaction_turns: Vec<i64> = Vec::new();
    for s in steps {
        let has_post_compact = s
            .get("blocks")
            .and_then(Value::as_array)
            .is_some_and(|bs| bs.iter().any(|b| b.get("kind").and_then(Value::as_str) == Some("postCompact")));
        if has_post_compact {
            compaction_turns.push(turn_of(s));
        }
    }
    // steps are turn-ordered, so compaction_turns is ascending; residency_end scans forward.
    let residency_end = |turn: i64| -> i64 {
        for &c in &compaction_turns {
            if c > turn {
                return c - 1;
            }
        }
        last_turn
    };

    let mut agg: IndexMap<String, BlockAgg> = IndexMap::new();
    let mut total_context_tokens = 0.0_f64;
    let mut steps_with_usage = 0.0_f64;

    for s in steps {
        // `if (s.usage)` — an object is always truthy in JS regardless of its own fields.
        if let Some(usage) = s.get("usage").filter(|u| u.is_object()) {
            // input already EXCLUDES the cache buckets in the transcript usage shape, so the
            // per-turn context (what the model actually read that call) is the sum of all three.
            total_context_tokens += usage.get("input").and_then(Value::as_f64).unwrap_or(0.0)
                + usage.get("cacheRead").and_then(Value::as_f64).unwrap_or(0.0)
                + usage.get("cacheCreate").and_then(Value::as_f64).unwrap_or(0.0);
            steps_with_usage += 1.0;
        }
        let turn = turn_of(s);
        let end = residency_end(turn);
        // max(1, …) guards a same-turn eviction edge (a block attributed to the exact turn a later
        // compaction lands on still counted for its own turn) — a 0-turn residency would silently
        // erase real tokens from the itemization.
        let turns_res = (end - turn + 1).max(1) as f64;

        if let Some(blocks) = s.get("blocks").and_then(Value::as_array) {
            for b in blocks {
                let id = b.get("id").and_then(Value::as_str).unwrap_or("").to_owned();
                let kind = b.get("kind").and_then(Value::as_str).unwrap_or("").to_owned();
                let label = b.get("label").and_then(Value::as_str).unwrap_or("").to_owned();
                let tokens = b.get("tokens").and_then(Value::as_f64).unwrap_or(0.0);

                let a = agg.entry(id).or_insert_with(|| {
                    let remediation = kind_remediation(&kind);
                    BlockAgg {
                        kind,
                        label,
                        tokens: 0.0,
                        peak_tokens: 0.0,
                        occurrences: 0.0,
                        first_seen_turn: turn,
                        last_resident_turn: end,
                        resident_cost: 0.0,
                        remediation,
                    }
                });
                a.tokens += tokens;
                a.peak_tokens = a.peak_tokens.max(tokens);
                a.occurrences += 1.0;
                a.last_resident_turn = a.last_resident_turn.max(end);
                a.resident_cost += tokens * turns_res;
            }
        }
    }

    // Rank heaviest-first; Rust's sort_by is stable, matching V8's guaranteed-stable Array.sort —
    // ties keep first-seen (IndexMap insertion) order.
    let mut ranked: Vec<(String, BlockAgg)> = agg.into_iter().collect();
    ranked.sort_by(|a, b| b.1.resident_cost.partial_cmp(&a.1.resident_cost).unwrap_or(std::cmp::Ordering::Equal));

    let mut itemized_resident_tokens = 0.0_f64;
    let blocks: Vec<Value> = ranked
        .into_iter()
        .map(|(id, a)| {
            itemized_resident_tokens += a.resident_cost;
            let turns_resident = a.last_resident_turn - a.first_seen_turn + 1;
            let mut m = Map::new();
            m.insert("id".into(), Value::String(id));
            m.insert("kind".into(), Value::String(a.kind));
            m.insert("label".into(), Value::String(a.label));
            m.insert("tokens".into(), num(a.tokens));
            m.insert("peakTokens".into(), num(a.peak_tokens));
            m.insert("occurrences".into(), num(a.occurrences));
            m.insert("firstSeenTurn".into(), num(a.first_seen_turn as f64));
            m.insert("lastResidentTurn".into(), num(a.last_resident_turn as f64));
            m.insert("turnsResident".into(), num(turns_resident as f64));
            m.insert("residentCost".into(), num(a.resident_cost));
            m.insert("remediation".into(), Value::String(a.remediation.to_owned()));
            Value::Object(m)
        })
        .collect();

    // The remainder stays SIGNED and labeled: a positive gap is content invisible to the transcript
    // (system prompt + tool definitions are never written to the .jsonl) plus estimator drift on
    // uncalibrated steps; a negative gap means the estimates overshot the exact usage. Clamping to 0
    // would hide a real reconciliation failure (FAIL-FAST).
    let unattributed_tokens = total_context_tokens - itemized_resident_tokens;
    let note = if total_context_tokens > 0.0 {
        "unattributedTokens = exact per-step usage minus the itemized resident-cost. The positive part is context invisible to the transcript (system prompt + tool definitions ride every turn but are never logged) plus token-estimator drift; the residency model also approximates compaction (a few preserved anchor messages ride longer than modeled). A negative value means the estimates overshot the exact usage."
    } else {
        "No step carried exact usage buckets — totalContextTokens is 0 and the itemization cannot be reconciled against ground truth (per-block figures remain estimates)."
    };

    let mut m = Map::new();
    m.insert(
        "sessionId".into(),
        Value::String(history.get("sessionId").and_then(Value::as_str).unwrap_or("").to_owned()),
    );
    m.insert("stepCount".into(), num(steps.len() as f64));
    m.insert("stepsWithUsage".into(), num(steps_with_usage));
    m.insert("lastTurn".into(), num(last_turn as f64));
    m.insert(
        "compactionTurns".into(),
        Value::Array(compaction_turns.iter().map(|&t| num(t as f64)).collect()),
    );
    m.insert("totalContextTokens".into(), num(total_context_tokens));
    m.insert("itemizedResidentTokens".into(), num(itemized_resident_tokens));
    m.insert("unattributedTokens".into(), num(unattributed_tokens));
    m.insert("note".into(), Value::String(note.to_owned()));
    m.insert("blocks".into(), Value::Array(blocks));
    m.insert("estimated".into(), Value::Bool(true));
    m.insert("truncated".into(), Value::Bool(history.get("truncated").and_then(Value::as_bool).unwrap_or(false)));
    Value::Object(m)
}
