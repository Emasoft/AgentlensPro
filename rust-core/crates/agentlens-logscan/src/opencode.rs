//! OpenCode SQLite parser (TRDD-DMWOBWFH P3d) — a faithful port of `_parseOpenCodeDb`
//! (src/logReader.ts). rusqlite (bundled SQLite) opens the LIVE database read-only with
//! NATIVE WAL handling — this REPLACES the TS path's byte-copy + hand-rolled `_mergeWal`
//! frame merge entirely (SQLite ≥3.22 reads a WAL-mode db read-only, rebuilding the wal-index
//! in heap memory when the -shm file is absent).
//!
//! Parity contract (same one-source-of-truth split as the other parsers):
//! - Rust emits the card exactly as `_buildCard` shapes it; the TS wrapper adds accountId.
//! - `last_timestamp_ms` is deliberately 0: the TS opencode path applies NO hot-age strip
//!   (unlike the Claude parser), and 0 disarms `finishRustTranscript`'s boundary strip so the
//!   two engines stay byte-identical. The per-card retention bound (capTimeline) still applies.

use indexmap::{IndexMap, IndexSet};
use rusqlite::types::Value as Sv;
use rusqlite::{Connection, OpenFlags};

use crate::{cap_text, cap_timeline, iso_from_ms, parse_ts_ms, snip, Card, ParsedTranscript, TimelineEntry, FIELD_MAX_CHARS};

pub struct OpenCodeParse {
    pub results: Vec<ParsedTranscript>,
    /// The newer OpenCode schema moved model/token columns off `session` — the TS parser logs
    /// once and SKIPS (no JSON fallback, which targets an even-older format). Mirrored here so
    /// the CLI can warn on stderr without treating it as an error.
    pub schema_unsupported: bool,
}

// ── SQL value coercions (sql.js hands JS numbers/strings; mirror the TS Number()/String()) ────

/// TS `Number(v ?? 0)` for the value shapes these columns actually carry. A non-numeric TEXT
/// would be NaN in TS; it collapses to 0 here — the only divergence, and only on garbage rows.
fn v_num(v: &Sv) -> f64 {
    match v {
        Sv::Integer(i) => *i as f64,
        Sv::Real(f) => *f,
        Sv::Text(s) => s.trim().parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// TS `String(v ?? '')` — NULL → ''.
fn v_str(v: &Sv) -> String {
    match v {
        Sv::Text(s) => s.clone(),
        Sv::Integer(i) => i.to_string(),
        Sv::Real(f) => f.to_string(),
        _ => String::new(),
    }
}

/// TS `v != null ? String(v) : null`.
fn v_str_opt(v: &Sv) -> Option<String> {
    match v {
        Sv::Null => None,
        other => Some(v_str(other)),
    }
}

/// tokenBuckets.ts `clamp`: finite positive, else 0.
fn clampf(n: f64) -> f64 {
    if n.is_finite() && n > 0.0 {
        n
    } else {
        0.0
    }
}

/// JS `${n}` for an epoch-ms number used inside a spanId (integer ms in practice).
fn js_num_string(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 9.0e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

struct MsgInfo {
    msg_id: String,
    t_created: f64,
    t_completed: f64,
    tok_in: f64,
    tok_out: f64,
    tok_cr: f64,
    tok_cw: f64,
}

struct PartInfo {
    part_ts: f64,
    msg_role: String,
    ptype: String,
    text: Option<String>,
    tool_name: Option<String>,
    call_id: Option<String>,
    file_path: Option<String>,
    tool_input_json: Option<String>,
    tool_output: Option<String>,
    tool_status: Option<String>,
}

struct Ev {
    ts: f64,
    entry: TimelineEntry,
}

fn all_rows(conn: &Connection, sql: &str) -> Result<Vec<Vec<Sv>>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let ncols = stmt.column_count();
    let rows = stmt
        .query_map([], |row| {
            let mut out = Vec::with_capacity(ncols);
            for i in 0..ncols {
                out.push(row.get::<_, Sv>(i)?);
            }
            Ok(out)
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn parse_opencode_db(db_path: &str, max_entries: usize, max_bytes: usize) -> Result<OpenCodeParse, String> {
    let file_size = std::fs::metadata(db_path).map(|m| m.len()).unwrap_or(0);
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;

    // Schema-drift guard — same detection and same skip-cleanly behavior as the TS parser.
    let cols = all_rows(&conn, "PRAGMA table_info(session)")?;
    let names: Vec<String> = cols.iter().map(|r| v_str(&r[1])).collect();
    if !names.iter().any(|n| n == "model") || !names.iter().any(|n| n == "tokens_input") {
        return Ok(OpenCodeParse { results: Vec::new(), schema_unsupported: true });
    }

    // ── Session rows (verbatim TS SQL) ─────────────────────────────────────────
    let sess_rows = all_rows(
        &conn,
        "SELECT s.id, s.directory, s.title, s.time_created,
                json_extract(s.model, '$.id') AS model_id,
                s.tokens_input, s.tokens_output, s.tokens_reasoning,
                s.tokens_cache_read, s.tokens_cache_write
         FROM session s
         WHERE (s.parent_id IS NULL OR s.parent_id = '')
           AND (s.tokens_input + s.tokens_output + s.tokens_cache_read + s.tokens_cache_write) > 0
         ORDER BY s.time_created DESC",
    )?;
    if sess_rows.is_empty() {
        return Ok(OpenCodeParse { results: Vec::new(), schema_unsupported: false });
    }
    let session_ids: Vec<String> = sess_rows.iter().map(|r| v_str(&r[0])).collect();

    // Same inline-quoted IN list as TS (ids come from the same DB — trusted, same-source).
    let in_list = session_ids
        .iter()
        .map(|id| format!("'{}'", id.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");

    // ── Message rows ───────────────────────────────────────────────────────────
    let msg_rows = all_rows(
        &conn,
        &format!(
            "SELECT session_id, id AS msg_id,
                    json_extract(data,'$.role')           AS role,
                    json_extract(data,'$.time.created')   AS t_created,
                    json_extract(data,'$.time.completed') AS t_completed,
                    json_extract(data,'$.tokens.input')   AS tok_in,
                    json_extract(data,'$.tokens.output')  AS tok_out,
                    json_extract(data,'$.tokens.cache.read')  AS tok_cr,
                    json_extract(data,'$.tokens.cache.write') AS tok_cw
             FROM message WHERE session_id IN ({in_list})
             ORDER BY time_created ASC"
        ),
    )?;

    // ── Part rows (absent table in older DBs → gracefully skip, like the TS try/catch) ────
    let part_rows = all_rows(
        &conn,
        &format!(
            "SELECT p.session_id, p.message_id, p.time_created AS part_ts,
                    json_extract(m.data,'$.role')                 AS msg_role,
                    json_extract(p.data,'$.type')                 AS type,
                    json_extract(p.data,'$.text')                 AS text,
                    json_extract(p.data,'$.tool')                 AS tool_name,
                    json_extract(p.data,'$.callID')               AS call_id,
                    json_extract(p.data,'$.state.input.filePath') AS file_path,
                    json_extract(p.data,'$.state.input')          AS tool_input_json,
                    substr(json_extract(p.data,'$.state.output'),1,2000) AS tool_output,
                    json_extract(p.data,'$.state.status')         AS tool_status
             FROM part p JOIN message m ON m.id = p.message_id
             WHERE p.session_id IN ({in_list})
             ORDER BY p.time_created ASC"
        ),
    )
    .unwrap_or_default();

    // Index by session (assistant messages only, like the TS accumulation).
    let mut msgs_by_sess: IndexMap<String, Vec<MsgInfo>> = IndexMap::new();
    for r in &msg_rows {
        if v_str(&r[2]) != "assistant" {
            continue;
        }
        msgs_by_sess.entry(v_str(&r[0])).or_default().push(MsgInfo {
            msg_id: v_str(&r[1]),
            t_created: v_num(&r[3]),
            t_completed: v_num(&r[4]),
            tok_in: v_num(&r[5]),
            tok_out: v_num(&r[6]),
            tok_cr: v_num(&r[7]),
            tok_cw: v_num(&r[8]),
        });
    }
    let mut parts_by_sess: IndexMap<String, Vec<PartInfo>> = IndexMap::new();
    for r in &part_rows {
        parts_by_sess.entry(v_str(&r[0])).or_default().push(PartInfo {
            part_ts: v_num(&r[2]),
            msg_role: v_str(&r[3]),
            ptype: v_str(&r[4]),
            text: v_str_opt(&r[5]),
            tool_name: v_str_opt(&r[6]),
            call_id: v_str_opt(&r[7]),
            file_path: v_str_opt(&r[8]),
            tool_input_json: v_str_opt(&r[9]),
            tool_output: v_str_opt(&r[10]),
            tool_status: v_str_opt(&r[11]),
        });
    }

    // ── Build cards ─────────────────────────────────────────────────────────────
    let empty_msgs: Vec<MsgInfo> = Vec::new();
    let empty_parts: Vec<PartInfo> = Vec::new();
    let mut results = Vec::new();
    for row in &sess_rows {
        let session_id = v_str(&row[0]);
        if session_id.is_empty() {
            continue;
        }
        let time_ms = v_num(&row[3]);
        let start_ts = if time_ms > 0.0 { iso_from_ms(time_ms as i64) } else { String::new() };
        let model_id = v_str(&row[4]);
        let workspace = v_str(&row[1]);
        let tok_in = v_num(&row[5]);
        let tok_out = v_num(&row[6]);
        let tok_reason = v_num(&row[7]);
        let tok_cr = v_num(&row[8]);
        let tok_cw = v_num(&row[9]);
        let title = v_str(&row[2]);

        let msgs = msgs_by_sess.get(&session_id).unwrap_or(&empty_msgs);
        let parts = parts_by_sess.get(&session_id).unwrap_or(&empty_parts);

        // User request: last user-typed text part wins (parts are ASC); falls back to the title.
        let mut user_request = snip(&title, 500);
        for p in parts {
            if p.msg_role == "user" && p.ptype == "text" {
                if let Some(t) = &p.text {
                    if !t.is_empty() {
                        user_request = snip(t, 500);
                    }
                }
            }
        }

        let mut tool_counts: IndexMap<String, u64> = IndexMap::new();
        let mut files_read: IndexSet<String> = IndexSet::new();
        let mut files_written: IndexSet<String> = IndexSet::new();
        let mut files_changed: IndexSet<String> = IndexSet::new();
        let mut total_tool_calls: u64 = 0;

        let mut llm_events: Vec<Ev> = Vec::new();
        let mut tool_events: Vec<Ev> = Vec::new();

        // LLM entries from assistant messages.
        let mut llm_idx = 0u64;
        let mut last_completed = 0.0f64;
        for m in msgs {
            let duration_ms = if m.t_completed > m.t_created { m.t_completed - m.t_created } else { 0.0 };
            // Anthropic-shaped buckets: passthrough with the clamp (already disjoint at source).
            let (eb_in, eb_out, eb_cr, eb_cw) =
                (clampf(m.tok_in), clampf(m.tok_out), clampf(m.tok_cr), clampf(m.tok_cw));
            llm_idx += 1;
            llm_events.push(Ev {
                ts: m.t_created,
                entry: TimelineEntry {
                    entry_type: "llm",
                    span_id: format!("oc-{}", m.msg_id),
                    label: format!("Turn {llm_idx}"),
                    turn: None,
                    action: None,
                    tool_input: None,
                    model: if model_id.is_empty() { None } else { Some(model_id.clone()) },
                    input_tokens: Some(eb_in),
                    output_tokens: Some(eb_out),
                    cache_read_tokens: if eb_cr > 0.0 { Some(eb_cr) } else { None },
                    cache_create_tokens: if eb_cw > 0.0 { Some(eb_cw) } else { None },
                    duration_ms,
                    is_error: false,
                    error_message: None,
                    timestamp: if m.t_created > 0.0 { iso_from_ms(m.t_created as i64) } else { start_ts.clone() },
                    response_text: None,
                    result_summary: None,
                    full_result: None,
                },
            });
            if m.t_completed > last_completed {
                last_completed = m.t_completed;
            }
        }

        // Tool entries from tool parts.
        for p in parts {
            let Some(tool_name) = p.tool_name.as_deref().filter(|t| !t.is_empty()) else { continue };
            if p.ptype != "tool" {
                continue;
            }
            *tool_counts.entry(tool_name.to_owned()).or_insert(0) += 1;
            total_tool_calls += 1;
            let file_path = p.file_path.as_deref().filter(|f| !f.is_empty());
            if let Some(fp) = file_path {
                let t = tool_name.to_lowercase();
                if t == "read" || t == "glob" || t == "grep" {
                    files_read.insert(fp.to_owned());
                } else if t == "write" || t == "edit" || t == "patch" {
                    files_written.insert(fp.to_owned());
                    files_changed.insert(fp.to_owned());
                }
            }
            let is_error = p.tool_status.as_deref() == Some("error");
            let label = match file_path {
                Some(fp) => format!("{tool_name}: {}", fp.rsplit('/').next().unwrap_or(fp)),
                None => tool_name.to_owned(),
            };
            // TS truthiness: '' is falsy for resultSummary/fullResult, but `?? undefined` keeps
            // an empty-string errorMessage — mirror both exactly.
            let out_nonempty = p.tool_output.as_deref().filter(|o| !o.is_empty());
            tool_events.push(Ev {
                ts: p.part_ts,
                entry: TimelineEntry {
                    entry_type: "tool",
                    span_id: format!(
                        "oc-tool-{}",
                        p.call_id.clone().unwrap_or_else(|| js_num_string(p.part_ts))
                    ),
                    label,
                    turn: None,
                    action: Some(tool_name.to_owned()),
                    tool_input: p.tool_input_json.clone(),
                    model: None,
                    input_tokens: None,
                    output_tokens: None,
                    cache_read_tokens: None,
                    cache_create_tokens: None,
                    duration_ms: 0.0,
                    is_error,
                    error_message: if is_error { p.tool_output.clone() } else { None },
                    timestamp: if p.part_ts > 0.0 { iso_from_ms(p.part_ts as i64) } else { start_ts.clone() },
                    response_text: None,
                    result_summary: out_nonempty.map(|o| snip(o, 200)),
                    full_result: out_nonempty.map(|o| cap_text(o, FIELD_MAX_CHARS)),
                },
            });
        }

        // Merge chronologically — llm before tool at equal ts (JS sort and Vec::sort_by are
        // both stable, and TS concatenates llmEvents first).
        let mut all: Vec<Ev> = llm_events;
        all.extend(tool_events);
        all.sort_by(|a, b| a.ts.partial_cmp(&b.ts).unwrap_or(std::cmp::Ordering::Equal));
        let mut timeline: Vec<TimelineEntry> = all.into_iter().map(|e| e.entry).collect();
        let oc_evicted = cap_timeline(&mut timeline, max_entries, max_bytes as i64);

        let end_ts = if last_completed > 0.0 { iso_from_ms(last_completed as i64) } else { start_ts.clone() };

        // _buildCard, inlined for the opencode accumulator shape.
        let start_ms = parse_ts_ms(&start_ts);
        let end_ms = parse_ts_ms(&end_ts);
        let duration_ms = if end_ms > 0 && start_ms > 0 { (end_ms - start_ms).max(0) as f64 } else { 0.0 };
        let (b_in, b_out, b_cr, b_cw) =
            (clampf(tok_in), clampf(tok_out + tok_reason), clampf(tok_cr), clampf(tok_cw));
        let total_context = b_in + b_cr + b_cw;
        let turns = msgs.len() as u64;

        let card = Card {
            session_id: session_id.clone(),
            trace_id: session_id,
            source: "opencode",
            data_source: "log",
            tokens_source: "log",
            initiator: "user",
            parent_session_id: None,
            spawned_by_turn: None,
            spawn_kind: None,
            spawn_model_override: None,
            spawn_isolation: None,
            spawn_subagent_type: None,
            spawn_async: None,
            workspace: workspace.clone(),
            title: None,
            entrypoint: None,
            timeline_truncated_count: if oc_evicted > 0 { Some(oc_evicted) } else { None },
            user_request: snip(&user_request, 500),
            model: if model_id.is_empty() { "opencode".to_owned() } else { model_id.clone() },
            turns,
            input_tokens: b_in,
            output_tokens: b_out,
            cache_read_tokens: b_cr,
            cache_create_tokens: b_cw,
            cache_hit_rate: if total_context > 0.0 { b_cr / total_context } else { 0.0 },
            duration_ms,
            start_time: if start_ms > 0 { iso_from_ms(start_ms) } else { String::new() },
            files_read: files_read.into_iter().collect(),
            files_searched: Vec::new(),
            files_changed: files_changed.into_iter().collect(),
            files_written: files_written.into_iter().collect(),
            file_ops: None,
            tool_counts,
            total_tool_calls,
            total_llm_calls: turns,
            errors: 0,
            outcome: if total_tool_calls > 0 { "tool_calls" } else { "text_response" },
            timeline,
            timeline_retained_bytes: None,
            background_spans: Vec::new(),
            loop_signals: Vec::new(),
            peak_context_per_turn: if turns > 1 { Some(0.0) } else { None },
        };
        results.push(ParsedTranscript {
            file: db_path.to_owned(),
            workspace,
            card,
            child_cards: Vec::new(),
            gen_files: Vec::new(),
            blend_turns: None,
            // 0 on purpose — the TS opencode path applies NO hot-age strip; a real timestamp
            // here would arm finishRustTranscript's boundary strip and break parity.
            last_timestamp_ms: 0,
            file_size_bytes: file_size,
        });
    }
    Ok(OpenCodeParse { results, schema_unsupported: false })
}
