//! Port of src/heartbeatCost.ts — `get_heartbeat_cost` (TRDD-DMWOBWFH P4x.2d).
//!
//! The exact cost of ONE heartbeat fire. `defaultBodiesDir()` is deliberately not ported — the
//! bodies dir is a required parameter and the route already resolves it once.
//!
//! WHY THE DEFAULT IS `last-complete`: a call's usage is only written once the NEXT call happens
//! (requests carry no request_id; the only link is `previous_message_id`), so the in-flight fire
//! cannot be measured exactly from inside itself. The unsettled tail is reported under `inFlight`
//! and EXCLUDED from the totals rather than being guessed at.

use std::path::Path;

use indexmap::{IndexMap, IndexSet};
use serde_json::{Map, Value};

use crate::pricing::calc_token_cost_usd;
use crate::session_burn_profile::session_id_of;
use crate::summarize::helpers::{fmt_js_num, iso_from_ms, js_to_fixed_num, js_to_fixed_str, num, to_locale_en};

const MAX_BYTES: u64 = 8 * 1024 * 1024;
pub const DEFAULT_MARKER: &str = "[janitor-heartbeat]";

fn re(cell: &'static std::sync::OnceLock<regex::Regex>, pattern: &str) -> &'static regex::Regex {
    cell.get_or_init(|| regex::Regex::new(pattern).expect("static regex"))
}

macro_rules! rx {
    ($name:ident, $pat:expr) => {
        fn $name() -> &'static regex::Regex {
            static C: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
            re(&C, $pat)
        }
    };
}
rx!(rx_msg_id, r#""id"\s*:\s*"(msg_[A-Za-z0-9]+)""#);
rx!(rx_prev, r#""previous_message_id"\s*:\s*"(msg_[A-Za-z0-9]+)""#);
rx!(rx_model, r#""model"\s*:\s*"([^"]+)""#);
rx!(rx_in, r#""input_tokens"\s*:\s*(\d+)"#);
rx!(rx_out, r#""output_tokens"\s*:\s*(\d+)"#);
rx!(rx_read, r#""cache_read_input_tokens"\s*:\s*(\d+)"#);
rx!(rx_create, r#""cache_creation_input_tokens"\s*:\s*(\d+)"#);
rx!(rx_5m, r#""ephemeral_5m_input_tokens"\s*:\s*(\d+)"#);
rx!(rx_1h, r#""ephemeral_1h_input_tokens"\s*:\s*(\d+)"#);

fn cap1(rx: &regex::Regex, hay: &str) -> Option<String> {
    rx.captures(hay).map(|c| c[1].to_owned())
}
fn cap_num(rx: &regex::Regex, hay: &str) -> f64 {
    cap1(rx, hay).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0)
}

#[derive(Clone, Debug, Default)]
struct Tokens {
    input: f64,
    output: f64,
    read: f64,
    create: f64,
    e5m: f64,
    e1h: f64,
    total: f64,
}

impl Tokens {
    fn add(&mut self, u: &Usage) {
        self.input += u.input;
        self.output += u.output;
        self.read += u.read;
        self.create += u.create;
        self.e5m += u.e5m;
        self.e1h += u.e1h;
        // NOTE the total EXCLUDES the ephemeral split — those are a breakdown OF `create`, not
        // additional tokens. Adding them would double-count every cache write.
        self.total += u.input + u.output + u.read + u.create;
    }

    fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("inputTokens".into(), num(self.input));
        m.insert("outputTokens".into(), num(self.output));
        m.insert("cacheReadTokens".into(), num(self.read));
        m.insert("cacheCreateTokens".into(), num(self.create));
        m.insert("ephemeral5mTokens".into(), num(self.e5m));
        m.insert("ephemeral1hTokens".into(), num(self.e1h));
        m.insert("totalTokens".into(), num(self.total));
        Value::Object(m)
    }
}

#[derive(Clone, Debug, Default)]
struct Cost {
    input: f64,
    output: f64,
    read: f64,
    write: f64,
    total: f64,
}

impl Cost {
    fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("inputUsd".into(), num(self.input));
        m.insert("outputUsd".into(), num(self.output));
        m.insert("cacheReadUsd".into(), num(self.read));
        m.insert("cacheWriteUsd".into(), num(self.write));
        m.insert("totalUsd".into(), num(self.total));
        Value::Object(m)
    }
}

#[derive(Clone, Debug, Default)]
struct Usage {
    input: f64,
    output: f64,
    read: f64,
    create: f64,
    e5m: f64,
    e1h: f64,
    model: String,
}

/// Per-component dollars: isolate each bucket through the SAME pricing table the rest of AgentLens
/// uses, so the four numbers always sum to the total the dashboard reports.
fn cost_of(u: &Usage, now_ms: f64) -> Cost {
    let one = |i: f64, r: f64, w: f64, o: f64| calc_token_cost_usd(i, r, w, o, &u.model, 0.0, None, now_ms);
    let input = one(u.input, 0.0, 0.0, 0.0);
    let read = one(0.0, u.read, 0.0, 0.0);
    let write = one(0.0, 0.0, u.create, 0.0);
    let output = one(0.0, 0.0, 0.0, u.output);
    Cost { input, output, read, write, total: input + output + read + write }
}

#[derive(Clone, Debug)]
struct Req {
    path: std::path::PathBuf,
    mtime: f64,
    model: String,
    prev: Option<String>,
    session: Option<String>,
}

/// `flattenText` — a string is itself; an array maps each block to its `.text` (a non-string or
/// missing `.text` becomes `''`) joined by newlines; anything else is `''`.
///
/// tool_result / tool_use / image blocks carry no `.text`, so they flatten to `''` — which is
/// exactly what makes a FOLLOW-UP call (whose last user block is a tool_result) correctly NOT look
/// like a fire start.
fn flatten_text(c: &Value) -> String {
    if let Some(s) = c.as_str() {
        return s.to_owned();
    }
    let Some(arr) = c.as_array() else { return String::new() };
    arr.iter()
        .map(|b| b.get("text").and_then(Value::as_str).unwrap_or("").to_owned())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Injected context the harness appends AFTER the real user message (UserPromptSubmit / PostToolUse
/// hook output, system-reminders). It must be SKIPPED when looking for what the user actually said.
fn is_injected_context(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("UserPromptSubmit hook additional context")
        || t.starts_with("PostToolUse")
        || t.starts_with("<system-reminder>")
}

/// Is this request the FIRST call of a fire? True iff the CURRENT TURN's real user message starts
/// with the marker.
///
/// TWO TRAPS, both hit for real:
///  1. `raw.includes(marker)` is WRONG — the marker persists in the transcript history of every
///     later call, and appears in any conversation that merely discusses the janitor. Measured:
///     1412 request bodies contained the literal marker; ZERO were fires.
///  2. The LAST message is NOT the user's. Claude Code appends the UserPromptSubmit hook's output
///     as a trailing message, so a naive last-message check never matches a real fire. Walk
///     BACKWARDS past injected context to the real user message, stopping at the first assistant
///     message (which means the current turn's user block has been left behind).
fn is_fire_start(path: &Path, marker: &str) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else { return false };
    let Ok(body) = serde_json::from_str::<Value>(&raw) else { return false };
    let empty: Vec<Value> = Vec::new();
    let msgs = body.get("messages").and_then(Value::as_array).unwrap_or(&empty);
    for m in msgs.iter().rev() {
        let role = m.get("role").and_then(Value::as_str);
        if role == Some("assistant") {
            return false; // left the current turn's user block
        }
        if role != Some("user") {
            continue; // trailing hook/system context
        }
        let text = flatten_text(m.get("content").unwrap_or(&Value::Null));
        if is_injected_context(&text) {
            continue; // hook context delivered as a user message
        }
        return text.trim_start().starts_with(marker); // the real current user message
    }
    false
}

/// Count Agent/Task spawns plus the tool surface of a call. A sub-agent's calls carry the PARENT
/// session id but a DIFFERENT tool count, which is how they surface in `callsByToolSurface`.
fn inspect_call(path: &Path) -> (f64, f64) {
    let Ok(raw) = std::fs::read_to_string(path) else { return (0.0, 0.0) };
    let Ok(body) = serde_json::from_str::<Value>(&raw) else { return (0.0, 0.0) };
    let tool_count = body.get("tools").and_then(Value::as_array).map_or(0.0, |t| t.len() as f64);
    let mut spawns = 0.0;
    // Only the LAST message — a spawn issued earlier in the transcript belongs to an earlier turn.
    if let Some(last) = body.get("messages").and_then(Value::as_array).and_then(|m| m.last()) {
        if let Some(content) = last.get("content").and_then(Value::as_array) {
            for b in content {
                let name = b.get("name").and_then(Value::as_str);
                if b.get("type").and_then(Value::as_str) == Some("tool_use")
                    && (name == Some("Agent") || name == Some("Task"))
                {
                    spawns += 1.0;
                }
            }
        }
    }
    (spawns, tool_count)
}

fn coverage_of(bodies_dir: &str, files_scanned: f64, window_hours: f64, note: &str) -> Value {
    let mut m = Map::new();
    m.insert("bodiesDir".into(), Value::String(bodies_dir.to_owned()));
    m.insert("filesScanned".into(), num(files_scanned));
    m.insert("windowHours".into(), num(window_hours));
    m.insert("complete".into(), Value::Bool(true));
    m.insert("note".into(), Value::String(note.to_owned()));
    Value::Object(m)
}

fn empty_report(marker: &str, bodies_dir: &str, window_hours: f64, note: &str) -> Value {
    let mut concurrent = Map::new();
    concurrent.insert("calls".into(), num(0.0));
    concurrent.insert("sessions".into(), num(0.0));
    concurrent.insert("note".into(), Value::String("no data".to_owned()));

    let mut m = Map::new();
    m.insert("marker".into(), Value::String(marker.to_owned()));
    m.insert("sessionId".into(), Value::Null);
    m.insert("fireDetected".into(), Value::Bool(false));
    m.insert("fireStartedAt".into(), Value::Null);
    m.insert("fireEndedAt".into(), Value::Null);
    m.insert("durationSeconds".into(), num(0.0));
    m.insert("apiCalls".into(), num(0.0));
    m.insert("agentSpawns".into(), num(0.0));
    m.insert("callsByToolSurface".into(), Value::Array(Vec::new()));
    m.insert("byModel".into(), Value::Array(Vec::new()));
    m.insert("tokens".into(), Tokens::default().to_value());
    m.insert("cost".into(), Cost::default().to_value());
    m.insert("inFlight".into(), Value::Null);
    m.insert("concurrent".into(), Value::Object(concurrent));
    m.insert("verdict".into(), Value::String(format!("No {marker} fire found in the scanned window.")));
    m.insert("coverage".into(), coverage_of(bodies_dir, 0.0, window_hours, note));
    Value::Object(m)
}

#[derive(Clone, Debug, Default)]
pub struct HeartbeatCostOptions {
    pub marker: Option<String>,
    pub session_id: Option<String>,
    pub window_hours: Option<f64>,
    /// `"last-complete"` (default) or `"current"`.
    pub fire: Option<String>,
}

const IN_FLIGHT_NOTE: &str = "A call's usage is only written once the NEXT call happens (requests carry no request_id; the only link is previous_message_id). These calls have not settled yet and are EXCLUDED from the totals above — re-run after the next fire for their exact cost.";

/// Exact cost of one heartbeat fire.
pub fn build_heartbeat_cost(bodies_dir: &Path, opts: &HeartbeatCostOptions, now_ms: f64) -> Value {
    let dir_str = bodies_dir.to_string_lossy().into_owned();
    let marker = opts.marker.as_deref().unwrap_or(DEFAULT_MARKER);
    let window_hours = opts.window_hours.unwrap_or(3.0);
    let want_current = opts.fire.as_deref() == Some("current");
    if !bodies_dir.exists() {
        return empty_report(
            marker,
            &dir_str,
            window_hours,
            &format!("No OTEL raw-body directory at {dir_str} — set OTEL_LOG_RAW_API_BODIES to capture bodies."),
        );
    }

    let cutoff = now_ms - window_hours * 3_600_000.0;
    let mut reqs: Vec<Req> = Vec::new();
    let mut resp_by_id: IndexMap<String, Usage> = IndexMap::new();
    let mut scanned = 0.0;

    // Sorted, unlike `readdirSync`: Node's order is filesystem-dependent, and `Map.set` overwrites,
    // so the TS's winner for two responses carrying the SAME msg id is whatever the filesystem
    // listed last. A sorted walk is the only reproducible version of that tie.
    let mut names: Vec<String> = match std::fs::read_dir(bodies_dir) {
        Ok(entries) => entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    for name in names {
        let is_req = name.ends_with(".request.json");
        let is_resp = name.ends_with(".response.json");
        if !is_req && !is_resp {
            continue;
        }
        let p = bodies_dir.join(&name);
        let Ok(st) = std::fs::metadata(&p) else { continue };
        let mtime = st
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        if mtime < cutoff || st.len() > MAX_BYTES {
            continue;
        }
        let Ok(s) = std::fs::read_to_string(&p) else { continue };
        scanned += 1.0;
        if is_resp {
            // `if (!id) continue` — a response with no msg id can never be joined, so it is not
            // even stored.
            let Some(id) = cap1(rx_msg_id(), &s) else { continue };
            resp_by_id.insert(
                id,
                Usage {
                    input: cap_num(rx_in(), &s),
                    output: cap_num(rx_out(), &s),
                    read: cap_num(rx_read(), &s),
                    create: cap_num(rx_create(), &s),
                    e5m: cap_num(rx_5m(), &s),
                    e1h: cap_num(rx_1h(), &s),
                    model: cap1(rx_model(), &s).unwrap_or_default(),
                },
            );
        } else {
            reqs.push(Req {
                path: p,
                mtime,
                model: cap1(rx_model(), &s).unwrap_or_default(),
                prev: cap1(rx_prev(), &s),
                session: session_id_of(&s),
            });
        }
    }
    reqs.sort_by(|a, b| a.mtime.partial_cmp(&b.mtime).unwrap_or(std::cmp::Ordering::Equal));
    let note = format!(
        "Scanned {} body file(s) modified in the last {}h (files >{}MB skipped).",
        fmt_js_num(scanned),
        fmt_js_num(window_hours),
        fmt_js_num(MAX_BYTES as f64 / 1e6),
    );

    // `!opts.sessionId || …` is TRUTHY, so an EMPTY sessionId is no filter at all.
    let want_session = opts.session_id.as_deref().filter(|s| !s.is_empty());
    let candidates: Vec<&Req> = reqs
        .iter()
        .filter(|r| want_session.is_none_or(|s| r.session.as_deref().unwrap_or("").starts_with(s)))
        .collect();

    // The fire starts, newest first, capped at 3 — enough to name the current fire, the last
    // complete one, and its end boundary. Collected backwards and unshifted, so the result is in
    // ASCENDING index order.
    let mut fire_starts: Vec<usize> = Vec::new();
    for i in (0..candidates.len()).rev() {
        if fire_starts.len() >= 3 {
            break;
        }
        if is_fire_start(&candidates[i].path, marker) {
            fire_starts.insert(0, i);
        }
    }
    if fire_starts.is_empty() {
        return empty_report(marker, &dir_str, window_hours, &note);
    }

    // 'current' = the NEWEST fire (its tail may be unsettled). 'last-complete' = the fire BEFORE it
    // when a newer one exists; otherwise the newest, with its unsettled tail under `inFlight`.
    let last = fire_starts.len() - 1;
    let single = fire_starts.len() == 1;
    let start_idx = if want_current || single { fire_starts[last] } else { fire_starts[last - 1] };
    let end_idx: i64 =
        if want_current || single { candidates.len() as i64 - 1 } else { fire_starts[last] as i64 - 1 };
    let session_id = candidates[start_idx].session.clone();

    let mut tokens = Tokens::default();
    let mut cost = Cost::default();
    let mut by_model: IndexMap<String, (f64, f64, f64)> = IndexMap::new();
    let mut tool_surface: IndexMap<u64, f64> = IndexMap::new();
    let (mut api_calls, mut agent_spawns, mut unsettled) = (0.0, 0.0, 0.0);

    let mut i = start_idx as i64;
    while i <= end_idx {
        let r = candidates[i as usize];
        api_calls += 1.0;
        let (spawns, tool_count) = inspect_call(&r.path);
        agent_spawns += spawns;
        *tool_surface.entry(tool_count as u64).or_insert(0.0) += 1.0;

        // Usage of call i lives on the response whose id == call i+1's previous_message_id — the
        // proven chain. No successor, or no matching response, means UNSETTLED, and an unsettled
        // call is excluded from the totals rather than counted as zero.
        let next_prev = candidates.get(i as usize + 1).and_then(|n| n.prev.clone());
        let Some(u) = next_prev.and_then(|p| resp_by_id.get_mut(&p)) else {
            unsettled += 1.0;
            i += 1;
            continue;
        };
        // MUTATES the stored usage, exactly as the TS does: a response body that carried no model
        // adopts the REQUEST's, and the write is visible to any later call that joins the same
        // response. Cloning here would silently diverge on that (admittedly rare) shape.
        if u.model.is_empty() {
            u.model = r.model.clone();
        }
        let u = u.clone();
        tokens.add(&u);
        let c = cost_of(&u, now_ms);
        cost.input += c.input;
        cost.output += c.output;
        cost.read += c.read;
        cost.write += c.write;
        cost.total += c.total;
        let m = by_model.entry(u.model.clone()).or_insert((0.0, 0.0, 0.0));
        m.0 += 1.0;
        m.1 += u.input + u.output + u.read + u.create;
        m.2 += c.total;
        i += 1;
    }

    let start_ms = candidates[start_idx].mtime;
    let end_ms = candidates[(start_idx as i64).max(end_idx) as usize].mtime;
    cost.input = js_to_fixed_num(cost.input, 4);
    cost.output = js_to_fixed_num(cost.output, 4);
    cost.read = js_to_fixed_num(cost.read, 4);
    cost.write = js_to_fixed_num(cost.write, 4);
    cost.total = js_to_fixed_num(cost.total, 4);

    // Concurrent activity: other sessions' calls inside the same span — DISCLOSED, never folded in.
    // They are not the heartbeat's cost, but they did compete for the same rate-limit window.
    let mut other_sessions: IndexSet<String> = IndexSet::new();
    let mut other_calls = 0.0;
    for r in &reqs {
        if r.mtime < start_ms || r.mtime > end_ms {
            continue;
        }
        let Some(s) = r.session.as_deref().filter(|s| !s.is_empty()) else { continue };
        if Some(s) == session_id.as_deref() {
            continue;
        }
        other_sessions.insert(s.to_owned());
        other_calls += 1.0;
    }

    let plural = |n: f64| if n == 1.0 { "" } else { "s" };
    let label = if want_current { "Current heartbeat (in flight)" } else { "The last heartbeat" };
    let verdict = format!(
        "{label} [{}] cost {} tokens = ${} — input {} | output {} | cache_read {} | cache_write {} ({} API call{}, {} agent spawn{}, {}s){}",
        iso_from_ms(start_ms),
        to_locale_en(tokens.total),
        js_to_fixed_str(cost.total, 4),
        to_locale_en(tokens.input),
        to_locale_en(tokens.output),
        to_locale_en(tokens.read),
        to_locale_en(tokens.create),
        fmt_js_num(api_calls),
        plural(api_calls),
        fmt_js_num(agent_spawns),
        plural(agent_spawns),
        js_to_fixed_str((end_ms - start_ms) / 1000.0, 1),
        if unsettled > 0.0 {
            format!(" ⚠ {} call(s) not yet settled — EXCLUDED", fmt_js_num(unsettled))
        } else {
            String::new()
        },
    );

    let mut surface: Vec<(u64, f64)> = tool_surface.into_iter().collect();
    surface.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    // The rounding happens in the SAME `.map` the sort consumes, so the ranking compares ROUNDED
    // dollars — two models differing past the 4th decimal are ties, in first-seen order.
    let mut models: Vec<(String, f64, f64, f64)> =
        by_model.into_iter().map(|(model, v)| (model, v.0, v.1, js_to_fixed_num(v.2, 4))).collect();
    models.sort_by(|a, b| b.3.partial_cmp(&a.3).unwrap_or(std::cmp::Ordering::Equal));

    let mut concurrent = Map::new();
    concurrent.insert("calls".into(), num(other_calls));
    concurrent.insert("sessions".into(), num(other_sessions.len() as f64));
    concurrent.insert(
        "note".into(),
        Value::String(if other_calls > 0.0 {
            format!(
                "{} call(s) from {} OTHER session(s) overlapped this fire's time span. They are NOT included in the totals (they are not the heartbeat's cost), but they did compete for the same rate-limit window.",
                fmt_js_num(other_calls),
                fmt_js_num(other_sessions.len() as f64)
            )
        } else {
            "No other session made API calls during this fire.".to_owned()
        }),
    );

    let mut m = Map::new();
    m.insert("marker".into(), Value::String(marker.to_owned()));
    m.insert("sessionId".into(), session_id.map_or(Value::Null, Value::String));
    m.insert("fireDetected".into(), Value::Bool(true));
    m.insert("fireStartedAt".into(), Value::String(iso_from_ms(start_ms)));
    m.insert("fireEndedAt".into(), Value::String(iso_from_ms(end_ms)));
    m.insert("durationSeconds".into(), num(js_to_fixed_num((end_ms - start_ms) / 1000.0, 1)));
    m.insert("apiCalls".into(), num(api_calls));
    m.insert("agentSpawns".into(), num(agent_spawns));
    m.insert(
        "callsByToolSurface".into(),
        Value::Array(
            surface
                .into_iter()
                .map(|(tools, calls)| {
                    let mut r = Map::new();
                    r.insert("tools".into(), num(tools as f64));
                    r.insert("calls".into(), num(calls));
                    Value::Object(r)
                })
                .collect(),
        ),
    );
    m.insert(
        "byModel".into(),
        Value::Array(
            models
                .into_iter()
                .map(|(model, calls, toks, cost_usd)| {
                    let mut r = Map::new();
                    r.insert("model".into(), Value::String(model));
                    r.insert("calls".into(), num(calls));
                    r.insert("tokens".into(), num(toks));
                    r.insert("costUsd".into(), num(cost_usd));
                    Value::Object(r)
                })
                .collect(),
        ),
    );
    m.insert("tokens".into(), tokens.to_value());
    m.insert("cost".into(), cost.to_value());
    m.insert(
        "inFlight".into(),
        if unsettled > 0.0 {
            let mut f = Map::new();
            f.insert("calls".into(), num(unsettled));
            f.insert("note".into(), Value::String(IN_FLIGHT_NOTE.to_owned()));
            Value::Object(f)
        } else {
            Value::Null
        },
    );
    m.insert("concurrent".into(), Value::Object(concurrent));
    m.insert("verdict".into(), Value::String(verdict));
    m.insert("coverage".into(), coverage_of(&dir_str, scanned, window_hours, &note));
    Value::Object(m)
}
