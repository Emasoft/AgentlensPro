//! Port of src/loopDetector.ts (TRDD-DMWOBWFH P4d) — the 5 loop/malfunction signals computed
//! over a finished session card. Signals are Value literals (same key order as the TS objects);
//! every user-facing string is transcribed VERBATIM and pinned by the TS-oracle parity test —
//! a transcription typo fails the fixture, not a reader's eyes.
//!
//! JS-semantics notes: string lengths/slices are UTF-16-minded (js_slice byte-cap divergence
//! documented in helpers); `toLocaleString()` is en-US digit grouping (what Node on this
//! machine produces — the parity fixture would fail loudly under a different ICU default);
//! `toFixed(1)` maps to `{:.1}` (tie-rounding divergence documented in helpers). The TS
//! detectors would throw on a card missing `timeline`/file arrays; this port treats absent
//! fields as empty — real cards always carry them.

use serde_json::{Map, Value};
use std::collections::HashSet;

use super::helpers::{fmt_js_num, js_slice, num, truthy};

const ACTION_EXACT_TOOL_REPEAT: &str = "The agent is calling the same tool with identical arguments repeatedly, usually because it isn't using or retaining the result. Add explicit context-retention instructions: \"After reading a file, do not re-read it unless you have made changes.\" Or scope the task more narrowly so the agent can complete it without re-querying the same resource.";
const ACTION_EDIT_REVERT_CYCLE: &str = "The agent is oscillating between two file states — a sign it is trying to reconcile conflicting constraints. Clarify success criteria upfront: provide the exact final state you want, not iterative instructions. If you are using \"make it pass the tests\", ensure the tests are deterministic and not themselves the source of the conflict.";
const ACTION_ERROR_RECURRENCE: &str = "The same error is repeating, which means the agent's fix attempts are not resolving the root cause. This often happens with missing packages, wrong file paths, or hallucinated API names. Verify the package/function exists before asking the agent to use it. If the error persists after 2 attempts, intervene manually rather than asking the agent to retry.";
const ACTION_RUNAWAY_STEPS: &str = "The session used far more steps than expected for this type of task — a sign of unclear success criteria, escalating scope, or a loop. Break the task into smaller, explicitly scoped subtasks with clear completion conditions. Avoid open-ended instructions like \"fix all the bugs\" or \"clean up the code\" with no stopping condition.";
const ACTION_TOKEN_RUNAWAY: &str = "Input context is growing rapidly while useful output is declining — the agent is accumulating context without making forward progress. This pattern often accompanies tool-call loops or repeated failed fixes. Start a fresh session with a focused prompt, or explicitly tell the agent what it has already tried and what to do differently.";

fn timeline(session: &Value) -> &[Value] {
    session.get("timeline").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn signal(kind: &str, severity: &str, evidence: String, count: Value, examples: Vec<String>, pattern_name: &str, action: &str) -> Value {
    let mut s = Map::new();
    s.insert("type".into(), kind.into());
    s.insert("severity".into(), severity.into());
    s.insert("evidence".into(), evidence.into());
    s.insert("count".into(), count);
    s.insert("examples".into(), Value::Array(examples.into_iter().map(Value::from).collect()));
    s.insert("patternName".into(), pattern_name.into());
    s.insert("action".into(), action.into());
    Value::Object(s)
}

pub fn detect_loop_signals(session: &Value) -> Vec<Value> {
    let mut signals = Vec::new();
    detect_exact_tool_repeat(session, &mut signals);
    detect_edit_revert_cycle(session, &mut signals);
    detect_error_recurrence(session, &mut signals);
    detect_runaway_steps(session, &mut signals);
    detect_token_runaway(session, &mut signals);
    signals
}

/// Detector 1 — identical tool label 3+ times (5+ → critical). Insertion-order counts, stable
/// descending sort, exactly the Object.entries + Array.sort pipeline.
fn detect_exact_tool_repeat(session: &Value, signals: &mut Vec<Value>) {
    let mut counts: Vec<(String, u64)> = Vec::new();
    for entry in timeline(session) {
        if entry.get("type").and_then(Value::as_str) != Some("tool") {
            continue;
        }
        let key = entry.get("label").and_then(Value::as_str).unwrap_or("").trim();
        if key.is_empty() {
            continue;
        }
        match counts.iter_mut().find(|(k, _)| k.as_str() == key) {
            Some((_, n)) => *n += 1,
            None => counts.push((key.to_owned(), 1)),
        }
    }
    let mut repeated: Vec<&(String, u64)> = counts.iter().filter(|(_, n)| *n >= 3).collect();
    repeated.sort_by_key(|e| std::cmp::Reverse(e.1));
    if repeated.is_empty() {
        return;
    }
    let top_count = repeated[0].1;
    signals.push(signal(
        "exact_tool_repeat",
        if top_count >= 5 { "critical" } else { "warning" },
        format!("{} tool call(s) executed identically 3+ times", repeated.len()),
        Value::from(top_count),
        repeated.iter().take(3).map(|(label, n)| format!("\"{}\" ×{n}", js_slice(label, 60))).collect(),
        "Tool Call Deadlock",
        ACTION_EXACT_TOOL_REPEAT,
    ));
}

/// Detector 2 — a file edited A→B and later B→A. Always critical.
fn detect_edit_revert_cycle(session: &Value, signals: &mut Vec<Value>) {
    let mut file_edits: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for entry in timeline(session) {
        if entry.get("type").and_then(Value::as_str) != Some("tool") || !entry.get("editDetails").is_some_and(truthy) {
            continue;
        }
        let details = entry.get("editDetails").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        for detail in details {
            let fp = detail.get("filePath").and_then(Value::as_str).unwrap_or("");
            let old = detail.get("oldString").and_then(Value::as_str).unwrap_or("");
            let new = detail.get("newString").and_then(Value::as_str).unwrap_or("");
            if fp.is_empty() || old.is_empty() || new.is_empty() {
                continue;
            }
            match file_edits.iter_mut().find(|(k, _)| k.as_str() == fp) {
                Some((_, v)) => v.push((old.to_owned(), new.to_owned())),
                None => file_edits.push((fp.to_owned(), vec![(old.to_owned(), new.to_owned())])),
            }
        }
    }
    let mut reverted_files: Vec<&str> = Vec::new();
    for (file, edits) in &file_edits {
        if edits.len() < 2 {
            continue;
        }
        let mut reverted = false;
        'outer: for j in 1..edits.len() {
            for i in 0..j {
                if edits[j].0 == edits[i].1 && edits[j].1 == edits[i].0 {
                    reverted = true;
                    break 'outer;
                }
            }
        }
        if reverted {
            reverted_files.push(file);
        }
    }
    if reverted_files.is_empty() {
        return;
    }
    signals.push(signal(
        "edit_revert_cycle",
        "critical",
        format!("{} file(s) were edited then reverted to a prior state", reverted_files.len()),
        Value::from(reverted_files.len()),
        reverted_files
            .iter()
            .take(3)
            .map(|f| {
                let base = f.rsplit('/').next().unwrap_or("");
                if base.is_empty() { (*f).to_owned() } else { base.to_owned() }
            })
            .collect(),
        "State Corruption Spiral",
        ACTION_EDIT_REVERT_CYCLE,
    ));
}

/// Detector 3 — the same error message 3+ times (5+ → critical); count sums every recurrence.
fn detect_error_recurrence(session: &Value, signals: &mut Vec<Value>) {
    let mut counts: Vec<(String, u64)> = Vec::new();
    for entry in timeline(session) {
        if !entry.get("isError").is_some_and(truthy) {
            continue;
        }
        let raw = {
            let m = entry.get("errorMessage").and_then(Value::as_str).unwrap_or("");
            if !m.is_empty() {
                m
            } else {
                let l = entry.get("label").and_then(Value::as_str).unwrap_or("");
                if !l.is_empty() { l } else { "unknown error" }
            }
        };
        let key = js_slice(raw.trim(), 200);
        match counts.iter_mut().find(|(k, _)| k.as_str() == key) {
            Some((_, n)) => *n += 1,
            None => counts.push((key.to_owned(), 1)),
        }
    }
    let mut recurring: Vec<&(String, u64)> = counts.iter().filter(|(_, n)| *n >= 3).collect();
    recurring.sort_by_key(|e| std::cmp::Reverse(e.1));
    if recurring.is_empty() {
        return;
    }
    let top_count = recurring[0].1;
    signals.push(signal(
        "error_recurrence",
        if top_count >= 5 { "critical" } else { "warning" },
        format!("{} error(s) recurring 3+ times", recurring.len()),
        Value::from(recurring.iter().map(|(_, n)| n).sum::<u64>()),
        recurring.iter().take(3).map(|(msg, n)| format!("\"{}\" ×{n}", js_slice(msg, 60))).collect(),
        "Hallucination Amplification Loop",
        ACTION_ERROR_RECURRENCE,
    ));
}

// ── Detector 4: Runaway steps ────────────────────────────────────────────────

const COMPLEX_KEYWORDS: [&str; 11] = [
    "implement", "refactor", "build", "design", "migrate", "convert",
    "rewrite", "integrate", "architect", "scaffold", "rework",
];
const SIMPLE_KEYWORDS: [&str; 9] = [
    "fix typo", "rename", "delete", "move file", "add comment",
    "add line", "update string", "change message", "add import",
];

fn step_threshold(complexity: &str) -> f64 {
    match complexity {
        "simple" => 15.0,
        "medium" => 35.0,
        _ => 80.0,
    }
}

/// inferTaskComplexity — behavioral file-count signals override keyword matching; request
/// lengths are UTF-16 code units (JS .length).
fn infer_task_complexity(request: &str, session: Option<&Value>) -> &'static str {
    let lower = request.to_lowercase();
    let files_affected = match session {
        Some(s) => {
            let mut seen: HashSet<String> = HashSet::new();
            for key in ["filesRead", "filesChanged", "filesSearched"] {
                if let Some(arr) = s.get(key).and_then(Value::as_array) {
                    for v in arr {
                        seen.insert(v.to_string());
                    }
                }
            }
            seen.len()
        }
        None => 0,
    };
    if files_affected >= 8 {
        return "complex";
    }
    if files_affected >= 4 {
        return "medium";
    }
    if SIMPLE_KEYWORDS.iter().any(|k| lower.contains(k)) {
        return "simple";
    }
    let complex_matches = COMPLEX_KEYWORDS.iter().filter(|k| lower.contains(*k)).count();
    let req_len: usize = request.chars().map(char::len_utf16).sum();
    if req_len > 150 || complex_matches >= 2 {
        return "complex";
    }
    if complex_matches >= 1 || req_len > 80 {
        return "medium";
    }
    if req_len <= 20 {
        return "simple";
    }
    "medium"
}

fn detect_runaway_steps(session: &Value, signals: &mut Vec<Value>) {
    let llm = session.get("totalLlmCalls").and_then(Value::as_f64).unwrap_or(0.0);
    let tools = session.get("totalToolCalls").and_then(Value::as_f64).unwrap_or(0.0);
    let total_steps = llm + tools;
    let user_request = session.get("userRequest").and_then(Value::as_str).unwrap_or("");
    let complexity = infer_task_complexity(user_request, Some(session));
    let threshold = step_threshold(complexity);
    if total_steps <= threshold {
        return;
    }
    signals.push(signal(
        "runaway_steps",
        if total_steps >= threshold * 2.0 { "critical" } else { "warning" },
        format!("{} steps for a {complexity} task (threshold: {})", fmt_js_num(total_steps), fmt_js_num(threshold)),
        num(total_steps),
        vec![
            format!("{} LLM calls", fmt_js_num(llm)),
            format!("{} tool calls", fmt_js_num(tools)),
            format!("\"{}\"", js_slice(user_request, 60)),
        ],
        "Ambiguous Success / Escalating Scope",
        ACTION_RUNAWAY_STEPS,
    ));
}

// ── Detector 5: Token runaway ────────────────────────────────────────────────

// `toLocaleString()` (en-US grouping) moved to helpers::to_locale_en (P4r.2 — the burn monitor
// formats alert details with it too; one source, pinned by BOTH fixtures).
use crate::summarize::helpers::to_locale_en;

fn detect_token_runaway(session: &Value, signals: &mut Vec<Value>) {
    let llm_calls: Vec<&Value> = timeline(session)
        .iter()
        .filter(|e| {
            e.get("type").and_then(Value::as_str) == Some("llm")
                && e.get("inputTokens").and_then(Value::as_f64).unwrap_or(0.0) > 0.0
        })
        .collect();
    if llm_calls.len() < 4 {
        return;
    }
    let inputs: Vec<f64> = llm_calls.iter().map(|e| e.get("inputTokens").and_then(Value::as_f64).unwrap_or(0.0)).collect();
    let outputs: Vec<f64> = llm_calls.iter().map(|e| e.get("outputTokens").and_then(Value::as_f64).unwrap_or(0.0)).collect();
    let input_growth = inputs[inputs.len() - 1] - inputs[0];
    if input_growth < 15000.0 {
        return;
    }
    let early_ratio = outputs[0] / inputs[0].max(1.0);
    let late_ratio = outputs[outputs.len() - 1] / inputs[inputs.len() - 1].max(1.0);
    let ratio_drop = early_ratio > 0.01 && late_ratio < early_ratio * 0.3;
    if !ratio_drop {
        return;
    }
    signals.push(signal(
        "token_runaway",
        if input_growth > 50000.0 { "critical" } else { "warning" },
        format!(
            "Input grew {} tokens across {} LLM calls while output ratio collapsed ({:.1}% → {:.1}%)",
            to_locale_en(input_growth),
            llm_calls.len(),
            early_ratio * 100.0,
            late_ratio * 100.0
        ),
        Value::from(llm_calls.len()),
        vec![
            format!("First call: {} in → {} out", to_locale_en(inputs[0]), to_locale_en(outputs[0])),
            format!("Last call:  {} in → {} out", to_locale_en(inputs[inputs.len() - 1]), to_locale_en(outputs[outputs.len() - 1])),
        ],
        "Infinite Loop — Context Accumulation",
        ACTION_TOKEN_RUNAWAY,
    ));
}
