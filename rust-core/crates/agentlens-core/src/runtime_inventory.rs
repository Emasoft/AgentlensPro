//! Port of src/runtimeInventory.ts (TRDD-O981ZJKV item 13, ported under TRDD-DMWOBWFH P4x.2d) —
//! "what Claude Code instances are running on this machine, and what is EACH one's total memory
//! footprint including everything it spawned?"
//!
//! Method: ONE `ps` snapshot, then pure tree math. The snapshot-first approach is the point — a
//! live pgrep pipeline matches its own shell (the classic self-match trap), while a snapshot taken
//! before the search cannot contain the searcher.
//!
//! The pure functions take the snapshot TEXT, exactly like the TS test seam, so the oracle drives
//! both engines over the same fixture and no test ever scans a live process table.

use serde_json::{Map, Value};

use crate::summarize::helpers::{js_slice, num};

/// One `ps -axo pid=,ppid=,rss=,etime=,command=` row.
#[derive(Clone, Debug)]
pub struct PsRow {
    pub pid: i64,
    pub ppid: i64,
    /// Resident set size in KB (as ps reports it).
    pub rss_kb: f64,
    pub etime: String,
    pub command: String,
}

/// `^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$` — the TS row regex, verbatim. A regex rather than a
/// hand-rolled split, because `splitn(5, whitespace)` splits at each whitespace CHARACTER and ps
/// pads its columns with RUNS of spaces — the split version yields empty fields and drops every
/// real row. Hoisted (the clippy regex_creation_in_loops shape).
fn row_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$").unwrap())
}

/// Parse the snapshot. Lines that do not match the row shape (headers, blanks, torn lines) are
/// SKIPPED, not errors — a snapshot of a live table is allowed to be ragged at the edges.
pub fn parse_ps_snapshot(text: &str) -> Vec<PsRow> {
    let mut rows = Vec::new();
    for line in text.split('\n') {
        let Some(m) = row_re().captures(line) else { continue };
        let n = |i: usize| m[i].parse::<i64>().unwrap_or(0);
        rows.push(PsRow {
            pid: n(1),
            ppid: n(2),
            rss_kb: n(3) as f64,
            etime: m[4].to_owned(),
            command: m[5].to_owned(),
        });
    }
    rows
}

/// A claude MAIN process: argv0's basename is exactly `claude`. Matching the whole command line
/// would false-positive on every process whose ARGS mention ~/.claude/... paths.
pub fn is_claude_root(command: &str) -> bool {
    // `split_whitespace` already skips leading whitespace, so the TS `.trim()` is redundant here.
    let argv0 = command.split_whitespace().next().unwrap_or("");
    let base = argv0.rsplit('/').next().unwrap_or("");
    base == "claude"
}

/// `Math.round(kb / 1024 * 10) / 10` — one decimal of MB.
fn mb(kb: f64) -> f64 {
    crate::summarize::helpers::js_math_round(kb / 1024.0 * 10.0) / 10.0
}

/// Pure tree math over a snapshot: an instance = a claude process with NO claude ancestor; a
/// nested claude process (a subagent CLI) folds into its parent instance rather than being counted
/// twice. Ranked by total tree RSS, descending.
pub fn build_claude_instances(rows: &[PsRow]) -> Vec<Value> {
    let by_pid: std::collections::HashMap<i64, &PsRow> = rows.iter().map(|r| (r.pid, r)).collect();
    let mut children: std::collections::HashMap<i64, Vec<&PsRow>> = std::collections::HashMap::new();
    for r in rows {
        children.entry(r.ppid).or_default().push(r);
    }
    let has_claude_ancestor = |r: &PsRow| -> bool {
        let mut cur = by_pid.get(&r.ppid);
        let mut hops = 0;
        // Hop cap: a ppid cycle in a TORN snapshot must not hang the server. 64 is far beyond any
        // real process depth, so hitting it means the snapshot lied, not that the tree is deep.
        while let Some(c) = cur {
            if hops >= 64 {
                break;
            }
            hops += 1;
            if is_claude_root(&c.command) {
                return true;
            }
            cur = by_pid.get(&c.ppid);
        }
        false
    };
    let roots: Vec<&PsRow> = rows.iter().filter(|r| is_claude_root(&r.command) && !has_claude_ancestor(r)).collect();

    let mut instances: Vec<Value> = roots
        .iter()
        .map(|root| {
            // BFS the descendant tree; the seen-set guards the same torn-snapshot cycles.
            let mut tree: Vec<&PsRow> = Vec::new();
            let mut queue = std::collections::VecDeque::from([root.pid]);
            let mut seen: std::collections::HashSet<i64> = std::collections::HashSet::new();
            while let Some(pid) = queue.pop_front() {
                if !seen.insert(pid) {
                    continue;
                }
                for c in children.get(&pid).map(Vec::as_slice).unwrap_or(&[]) {
                    tree.push(c);
                    queue.push_back(c.pid);
                }
            }
            let total_kb = root.rss_kb + tree.iter().map(|r| r.rss_kb).sum::<f64>();
            let mut ranked = tree.clone();
            // Stable, like Array.prototype.sort — equal-RSS siblings keep BFS order.
            ranked.sort_by(|a, b| b.rss_kb.partial_cmp(&a.rss_kb).unwrap_or(std::cmp::Ordering::Equal));
            let top: Vec<Value> = ranked
                .iter()
                .take(5)
                .map(|r| {
                    let mut m = Map::new();
                    m.insert("pid".into(), num(r.pid as f64));
                    m.insert("rssMb".into(), num(mb(r.rss_kb)));
                    m.insert("etime".into(), Value::String(r.etime.clone()));
                    // First ~120 chars — enough to identify, small enough to list.
                    m.insert("command".into(), Value::String(js_slice(&r.command, 120).to_owned()));
                    Value::Object(m)
                })
                .collect();
            let mut m = Map::new();
            m.insert("pid".into(), num(root.pid as f64));
            m.insert("etime".into(), Value::String(root.etime.clone()));
            m.insert("ownRssMb".into(), num(mb(root.rss_kb)));
            m.insert("totalRssMb".into(), num(mb(total_kb)));
            m.insert("processCount".into(), num(1.0 + tree.len() as f64));
            m.insert("topProcesses".into(), Value::Array(top));
            // Filled by the caller when lsof is available.
            m.insert("cwd".into(), Value::Null);
            Value::Object(m)
        })
        .collect();
    instances.sort_by(|a, b| {
        let t = |v: &Value| v.get("totalRssMb").and_then(Value::as_f64).unwrap_or(0.0);
        t(b).partial_cmp(&t(a)).unwrap_or(std::cmp::Ordering::Equal)
    });
    instances
}

fn resolve_cwd(pid: i64) -> Option<String> {
    // -a AND: this pid's cwd descriptor only; -Fn = machine-parsable name lines. lsof absent or
    // denied leaves the field null — never fatal.
    let out = std::process::Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().find_map(|l| l.strip_prefix('n')).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn claude_version() -> Option<String> {
    let out = std::process::Command::new("claude").arg("--version").output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| js_slice(trimmed, 120).to_owned())
}

/// `get_runtime_inventory` — the full report. `ps_text` is the test seam (replaces the live
/// snapshot); `no_subprocess` skips lsof/claude-version so tests never spawn anything.
pub fn build_runtime_inventory(ps_text: Option<&str>, no_subprocess: bool, now_ms: f64) -> Value {
    let err = |text: String| {
        let mut m = Map::new();
        m.insert("error".into(), Value::String(text));
        Value::Object(m)
    };
    if cfg!(windows) && ps_text.is_none() {
        return err("runtime inventory is POSIX-only for now (ps/lsof) — on Windows run it inside WSL. Native support is tracked by the cross-platform follow-up.".to_owned());
    }
    let owned;
    let text = match ps_text {
        Some(t) => t,
        None => {
            let out = std::process::Command::new("ps").args(["-axo", "pid=,ppid=,rss=,etime=,command="]).output();
            match out {
                Err(e) => return err(format!("ps snapshot failed: {e}")),
                Ok(o) if !o.status.success() => return err(format!("ps snapshot failed: exit {:?}", o.status.code())),
                Ok(o) => {
                    owned = String::from_utf8_lossy(&o.stdout).into_owned();
                    &owned
                }
            }
        }
    };
    let mut instances = build_claude_instances(&parse_ps_snapshot(text));
    if !no_subprocess {
        for inst in &mut instances {
            let pid = inst.get("pid").and_then(Value::as_i64).unwrap_or(0);
            if let Some(obj) = inst.as_object_mut() {
                obj.insert("cwd".into(), resolve_cwd(pid).map_or(Value::Null, Value::String));
            }
        }
    }
    let total: f64 = instances.iter().map(|i| i.get("totalRssMb").and_then(Value::as_f64).unwrap_or(0.0)).sum();
    let mut m = Map::new();
    m.insert("checkedAtIso".into(), Value::String(crate::summarize::helpers::iso_from_ms(now_ms)));
    m.insert(
        "claudeCodeVersion".into(),
        if no_subprocess { Value::Null } else { claude_version().map_or(Value::Null, Value::String) },
    );
    m.insert("instanceCount".into(), num(instances.len() as f64));
    m.insert("totalRssMb".into(), num(crate::summarize::helpers::js_math_round(total)));
    m.insert("instances".into(), Value::Array(instances));
    m.insert("note".into(), "instances ranked by total tree RSS. Each tree includes EVERYTHING the instance spawned (subshells, worktree/subagent processes, plugin crons, MCP servers, background tasks). cwd identifies the project (null when lsof is unavailable). For each instance's live MODEL and token burn, join on workspace via get_burn_status / get_cost_rollup --liveOnly.".into());
    Value::Object(m)
}
