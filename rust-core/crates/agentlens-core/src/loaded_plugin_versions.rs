//! Port of src/loadedPluginVersions.ts (AgentlensPro#5, ported under TRDD-DMWOBWFH P4x.2d) —
//! which plugin VERSION is each Claude Code session actually running?
//!
//! The problem: a plugin update lands machine-wide, but hooks and skills are SESSION-LOADED — a
//! running session keeps executing the OLD cached code until its own `/reload-plugins`. A
//! fleet-wide rollout therefore leaves invisible "old-behavior ghosts", and a ghost is
//! indistinguishable from "the fix doesn't work".
//!
//! THE SOURCE is the `attachment` record, not prose. Claude Code writes a skill load as
//! `{type:"attachment", attachment:{type:"invoked_skills", skills:[{content:"Base directory for
//! this skill: …/plugins/cache/<marketplace>/<plugin>/<VERSION>/…"}]}}`. That header is emitted by
//! the HARNESS at load time, so — unlike a versioned path in assistant prose or a Bash argument —
//! it cannot be authored, quoted, or guessed by the model. Only the attachment is read.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::summarize::helpers::{num, parse_iso_ms};

/// Semver-ish compare; falls back to a string compare for non-numeric tails.
///
/// `parse_int` mirrors JS `parseInt(s, 10)`: it takes the LEADING digits and yields NaN when there
/// are none, so `3-beta` compares as 3 while `beta` falls through to the string branch. A missing
/// component reads as `"0"`, which is what makes `1.2` and `1.2.0` compare equal.
///
/// ponytail: the string branch is a BYTE compare, where the TS uses `localeCompare` (ICU). The two
/// agree across the realistic domain — lowercase-ASCII prerelease tails like `beta` / `rc1` — and
/// diverge only on mixed case or non-ASCII, which no plugin version dir on this substrate uses.
/// Named here rather than papered over; upgrade to a collation crate if a real version ever needs it.
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let (pa, pb): (Vec<&str>, Vec<&str>) = (a.split('.').collect(), b.split('.').collect());
    let parse_int = |s: &str| {
        let digits: String = s.chars().take_while(char::is_ascii_digit).collect();
        digits.parse::<i64>().ok()
    };
    for i in 0..pa.len().max(pb.len()) {
        let (sa, sb) = (pa.get(i).copied(), pb.get(i).copied());
        match (parse_int(sa.unwrap_or("0")), parse_int(sb.unwrap_or("0"))) {
            (Some(na), Some(nb)) if na != nb => return na.cmp(&nb),
            (Some(_), Some(_)) => {}
            // Either side is non-numeric: the whole comparison drops to the raw components, with a
            // MISSING one reading as the empty string — NOT as the "0" the numeric branch used.
            _ => return sa.unwrap_or("").cmp(sb.unwrap_or("")),
        }
    }
    std::cmp::Ordering::Equal
}

/// `Base directory for this skill:\s*\S*?/plugins/cache/<market>/<plugin>/<version>/`
fn basedir_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"Base directory for this skill:\s*\S*?/plugins/cache/([^/\s]+)/([^/\s]+)/([^/\s]+)/").unwrap()
    })
}

/// Newest cached version per `<marketplace>/<plugin>`, straight off the plugin cache dir.
///
/// Sorted at every level for determinism (the TS walks raw readdir order — observable only in the
/// KEY order of the returned map, which no consumer treats as a contract).
pub fn scan_plugin_cache(cache_root: &Path) -> IndexMap<String, String> {
    let mut out = IndexMap::new();
    let entries = |p: &Path| -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = std::fs::read_dir(p).into_iter().flatten().flatten().map(|e| e.path()).collect();
        v.sort();
        v
    };
    let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    for market in entries(cache_root) {
        for plugin in entries(&market) {
            // A version dir is one whose NAME starts with a digit — the cache also holds scratch
            // files (tsconfig.test.json, walkthrough/) that would otherwise sort as "newest".
            let mut real: Vec<String> =
                entries(&plugin).into_iter().map(|p| name(&p)).filter(|v| v.starts_with(|c: char| c.is_ascii_digit())).collect();
            if real.is_empty() {
                continue;
            }
            real.sort_by(|a, b| compare_versions(a, b));
            out.insert(format!("{}/{}", name(&market), name(&plugin)), real.pop().unwrap());
        }
    }
    out
}

struct Observation {
    ts: f64,
    version: String,
}

/// Report the plugin version each session has LOADED.
///
/// `loadedVersion` is the MAXIMUM version observed, deliberately NOT the latest-by-timestamp one.
/// A compaction REPLAYS earlier skill invocations as fresh attachment records carrying their
/// ORIGINAL content, so record order stops being chronological: measured on 40 real transcripts, 18
/// of 19 multi-version sessions are non-monotone in time and the latest-timestamp record is
/// routinely an OLD version. Max is sound because a session's loaded version only moves forward —
/// a replay can echo an old version but can never invent a newer one than was really loaded.
///
/// It can still UNDER-estimate: a session that reloaded and then invoked no skill from that plugin
/// left no trace. That case is `stale: "unknown"`, never a false `true` — the consumer contract is
/// fail-open, and a wrong staleness verdict is worse than an honest gap.
pub fn build_loaded_versions_report(
    dirs: &[PathBuf],
    cache_root: &Path,
    plugin_filter: Option<&str>,
    active_minutes: Option<f64>,
    stale_only: bool,
    now_ms: f64,
) -> Value {
    // `opts.plugin &&` is a TRUTHY guard at BOTH use sites, so an EMPTY filter means NO filter.
    // Normalized once here: an `Option<&str>` port that honours `Some("")` filters everything out
    // and reports a confidently empty fleet.
    let plugin_filter = plugin_filter.filter(|p| !p.is_empty());
    let newest_cached = scan_plugin_cache(cache_root);
    let active_cutoff = active_minutes.map(|m| now_ms - m * 60_000.0);

    // Reload commands are scanned ONCE for every session up front and indexed by session id. Doing
    // it per transcript inside the loop below would re-walk the whole projects tree for each of the
    // ~300 files — quadratic, and the reason this is a map and not a call site.
    let kinds = ["PLUGINS_RELOADED".to_owned(), "SKILLS_RELOADED".to_owned()];
    let mut last_reload: IndexMap<String, f64> = IndexMap::new();
    for c in crate::cache_risk_commands::scan_cache_risk_commands(dirs, active_cutoff, Some(&kinds), None) {
        let (Some(session), Some(ts)) = (c.get("session").and_then(Value::as_str), c.get("ts").and_then(Value::as_f64)) else {
            continue;
        };
        // `if (!c.session) continue` — an empty session id is falsy and indexes nothing.
        if session.is_empty() {
            continue;
        }
        let e = last_reload.entry(session.to_owned()).or_insert(ts);
        if ts > *e {
            *e = ts;
        }
    }

    let mut rows: Vec<Value> = Vec::new();
    let (mut scanned, mut with_evidence) = (0.0, 0.0);

    for file in crate::cache_risk_commands::transcript_files(dirs) {
        let Some(mtime) = std::fs::metadata(&file)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
        else {
            continue;
        };
        if active_cutoff.is_some_and(|c| mtime < c) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        // Counted BEFORE the evidence check: `sessionsScanned` is "transcripts examined", and the
        // gap to `sessionsWithSkillEvidence` is exactly the blind spot the note describes.
        scanned += 1.0;
        if !text.contains("invoked_skills") {
            continue;
        }

        let mut per_plugin: IndexMap<String, Vec<Observation>> = IndexMap::new();
        let (mut session, mut project, mut cc_version) = (String::new(), None::<String>, None::<String>);
        for line in text.split('\n') {
            if !line.contains("invoked_skills") {
                continue;
            }
            let Ok(rec) = serde_json::from_str::<Value>(line) else { continue };
            if rec.get("type").and_then(Value::as_str) != Some("attachment") {
                continue;
            }
            let att = rec.get("attachment");
            if att.and_then(|a| a.get("type")).and_then(Value::as_str) != Some("invoked_skills") {
                continue;
            }
            let Some(skills) = att.and_then(|a| a.get("skills")).and_then(Value::as_array) else { continue };
            // An unparseable timestamp drops the whole record: an observation that cannot be placed
            // in time cannot support `lastObservationTs`, which the staleness verdict compares
            // against the reload time.
            let Some(ts) = rec.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms) else { continue };
            // LAST matching record wins for each of these — they are re-read on every attachment.
            if let Some(v) = rec.get("sessionId").and_then(Value::as_str) {
                session = v.to_owned();
            }
            if let Some(v) = rec.get("cwd").and_then(Value::as_str) {
                project = Some(v.to_owned());
            }
            if let Some(v) = rec.get("version").and_then(Value::as_str) {
                cc_version = Some(v.to_owned());
            }
            for s in skills {
                let Some(content) = s.get("content").and_then(Value::as_str) else { continue };
                let Some(m) = basedir_re().captures(content) else { continue };
                if plugin_filter.is_some_and(|p| &m[2] != p) {
                    continue;
                }
                per_plugin
                    .entry(format!("{}/{}", &m[1], &m[2]))
                    .or_default()
                    .push(Observation { ts, version: m[3].to_owned() });
            }
        }
        if per_plugin.is_empty() {
            continue;
        }
        with_evidence += 1.0;
        if session.is_empty() {
            session = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        }
        let last_reload_ts = last_reload.get(&session).copied();

        for (key, obs) in &per_plugin {
            // Distinct versions in FIRST-SEEN order, then sorted — the Set/sort pair in the TS.
            let mut seen = HashSet::new();
            let mut versions: Vec<&str> = obs.iter().map(|o| o.version.as_str()).filter(|v| seen.insert(*v)).collect();
            versions.sort_by(|a, b| compare_versions(a, b));
            let loaded = *versions.last().unwrap();
            // The newest moment we have evidence of the version we are REPORTING — not of the
            // session. Comparing a reload against the session's newest record instead would call
            // every reloaded session blind.
            let last_observation_ts =
                obs.iter().filter(|o| o.version == loaded).map(|o| o.ts).fold(f64::NEG_INFINITY, f64::max);
            let newest = newest_cached.get(key);
            let behind = newest.is_some_and(|n| compare_versions(loaded, n) == std::cmp::Ordering::Less);
            // A reload AFTER our last evidence means the session may already have moved on unseen.
            let blind = last_reload_ts.is_some_and(|r| r > last_observation_ts);
            let stale = if behind {
                if blind {
                    Value::String("unknown".into())
                } else {
                    Value::Bool(true)
                }
            } else {
                Value::Bool(false)
            };
            if stale_only && stale == Value::Bool(false) {
                continue;
            }
            let (marketplace, plugin) = key.split_once('/').unwrap_or((key.as_str(), ""));
            let mut row = Map::new();
            row.insert("session".into(), Value::String(session.clone()));
            row.insert("marketplace".into(), Value::String(marketplace.to_owned()));
            row.insert("plugin".into(), Value::String(plugin.to_owned()));
            row.insert("loadedVersion".into(), Value::String(loaded.to_owned()));
            row.insert("versionsSeen".into(), Value::Array(versions.iter().map(|v| Value::String((*v).to_owned())).collect()));
            // Deliberately redundant with versionsSeen.length: the CLI's lean shaping truncates long
            // arrays, which made a lean row read as self-contradictory (loadedVersion absent from
            // its own versionsSeen). The count is what shows the list was CLIPPED, not the verdict wrong.
            row.insert("versionsSeenCount".into(), num(versions.len() as f64));
            row.insert("observations".into(), num(obs.len() as f64));
            row.insert("stale".into(), stale);
            row.insert("lastObservationTs".into(), num(last_observation_ts));
            row.insert("lastActivityTs".into(), num(mtime));
            // These four are ASSIGNED AFTER the literal, so they land at the END of the object in
            // this order — not at their interface positions. Key order is a wire contract.
            if let Some(p) = project.as_deref().filter(|p| !p.is_empty()) {
                row.insert("project".into(), Value::String(p.to_owned()));
            }
            if let Some(n) = newest {
                row.insert("newestCached".into(), Value::String(n.clone()));
            }
            if let Some(r) = last_reload_ts {
                row.insert("lastReloadTs".into(), num(r));
            }
            if let Some(v) = cc_version.as_deref().filter(|v| !v.is_empty()) {
                row.insert("ccVersion".into(), Value::String(v.to_owned()));
            }
            rows.push(Value::Object(row));
        }
    }

    // Ghosts first, then most-recently-active, then session id. The severity key is what makes the
    // list actionable AND survives the CLI's lean truncation (the rows that matter are the ones
    // kept). The session tie-break is not cosmetic: on a busy machine many live transcripts share
    // an mtime to the millisecond, so an mtime-only sort reorders itself between two runs seconds
    // apart. Stable, so two plugins of one session keep first-seen order.
    let severity = |v: &Value| match v.get("stale") {
        Some(Value::Bool(true)) => 0,
        Some(Value::String(_)) => 1,
        _ => 2,
    };
    let f = |v: &Value, k: &str| v.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    rows.sort_by(|a, b| {
        severity(a)
            .cmp(&severity(b))
            .then(f(b, "lastActivityTs").partial_cmp(&f(a, "lastActivityTs")).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| s(a, "session").cmp(&s(b, "session")))
    });

    let count = |want: Value| num(rows.iter().filter(|r| r.get("stale") == Some(&want)).count() as f64);
    let (n_stale, n_unknown) = (count(Value::Bool(true)), count(Value::String("unknown".into())));
    let filtered: Map<String, Value> = match plugin_filter {
        Some(p) => newest_cached
            .iter()
            .filter(|(k, _)| k.ends_with(&format!("/{p}")))
            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
            .collect(),
        None => newest_cached.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect(),
    };

    let mut out = Map::new();
    out.insert("rows".into(), Value::Array(rows));
    out.insert("sessionsScanned".into(), num(scanned));
    out.insert("sessionsWithSkillEvidence".into(), num(with_evidence));
    out.insert("stale".into(), n_stale);
    out.insert("unknown".into(), n_unknown);
    out.insert("newestCached".into(), Value::Object(filtered));
    out.insert("activeMinutes".into(), active_minutes.map_or(Value::Null, num));
    out.insert("note".into(), "No pid column: a session id cannot be mapped to an OS process from the transcript substrate, so lastActivityTs (transcript mtime) is the liveness proxy — use activeMinutes to scope it. sessionsScanned minus sessionsWithSkillEvidence is the blind spot: a session that invoked no plugin skill has no loaded-version evidence and is absent from rows, NOT current.".into());
    Value::Object(out)
}
