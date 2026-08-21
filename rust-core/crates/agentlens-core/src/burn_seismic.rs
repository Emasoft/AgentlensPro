//! Port of `src/burnSeismic.ts`, in slices (TRDD-DMWOBWFH P4x.2q / .2s). Landed here: the
//! arithmetic helpers and the report RENDERER (slice A), then transcript FILE SELECTION and the SQL
//! text (slice C). The statistical primitives live in `crate::seismic_stats`; the analysis itself
//! (TS 573-922) is the remaining slice.
//!
//! The renderer takes the result as a `Value` rather than a struct, deliberately: the analysis half
//! is not ported yet, so a struct here would be a second definition of a shape that does not exist
//! in Rust yet and would have to be reconciled later. Reading the fields the report actually prints
//! keeps the two slices independent.

use serde_json::{Map, Value};

use crate::pricing::lookup_rates;
use crate::summarize::helpers::{js_math_round, js_slice, js_to_fixed_str, pad_end, pad_start, utf16_len};

/// Per-component USD for one model's token sums, via the single pricing source. An unpriced model
/// yields zeros rather than a guess: this feeds the excess-cost ranking, and a fabricated rate would
/// invent a culprit.
pub fn cost_parts(model: &str, inp: f64, cc: f64, cr: f64, out: f64, now_ms: f64) -> CostParts {
    let Some(rates) = lookup_rates(model, None, now_ms) else {
        return CostParts::default();
    };
    CostParts {
        i: (inp / 1e6) * rates.input_per_mtok,
        r: (cr / 1e6) * rates.cache_read_per_mtok,
        w: (cc / 1e6) * rates.cache_write_per_mtok,
        o: (out / 1e6) * rates.output_per_mtok,
    }
}

#[derive(Default, Clone, Copy, PartialEq, Debug)]
pub struct CostParts {
    pub w: f64,
    pub r: f64,
    pub o: f64,
    pub i: f64,
}

/// DuckDB hands back a NAIVE UTC timestamp (`2026-08-21 06:00:00`); the TS re-reads it as an
/// instant by pasting the `T` and the `Z` back on. Getting this wrong shifts every bucket by the
/// local offset, which is a silent hours-long error in a time-series report.
pub fn iso_to_ms(iso_naive_utc: &str) -> Option<f64> {
    let s = format!("{}Z", iso_naive_utc.replacen(' ', "T", 1));
    crate::summarize::helpers::parse_iso_ms(&s)
}

/// The inverse: an instant back to the bucket's naive-UTC label, seconds resolution.
pub fn ms_to_bucket_iso(ms: f64) -> String {
    let iso = crate::summarize::helpers::iso_from_ms(ms);
    let no_frac = iso.split_once('.').map_or(iso.as_str(), |(head, _)| head);
    no_frac.replacen('T', " ", 1)
}

fn f(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).unwrap_or(0.0)
}

fn s(v: Option<&Value>) -> &str {
    v.and_then(Value::as_str).unwrap_or_default()
}

fn len_of(v: Option<&Value>) -> usize {
    v.and_then(Value::as_array).map_or(0, Vec::len)
}

fn money(x: f64) -> String {
    format!("${}", js_to_fixed_str(x, 2))
}

fn pct_of(a: f64, b: f64) -> String {
    let n = if b > 0.0 { js_math_round((100.0 * a) / b) } else { 0.0 };
    format!("{}%", crate::summarize::helpers::fmt_js_num(n))
}

/// `Number.prototype.toExponential(d)`. Rust's `{:.*e}` is the same shape minus the sign on a
/// positive exponent (`1.23e3` vs JS's `1.23e+3`), which is the whole difference.
fn to_exponential(x: f64, digits: usize) -> String {
    if !x.is_finite() {
        return crate::summarize::helpers::fmt_js_num(x);
    }
    let raw = format!("{x:.*e}", digits);
    match raw.split_once('e') {
        Some((mant, exp)) if !exp.starts_with('-') => format!("{mant}e+{exp}"),
        _ => raw,
    }
}

/// Seismology-styled text report of the analysis (the CLI + `investigate_burn` surface).
pub fn render_burn_seismic(r: &Value) -> String {
    let reason = s(r.get("reason"));
    if !reason.is_empty() {
        return format!("burn-seismic: no analysis ({reason})");
    }
    let mut l: Vec<String> = Vec::new();
    l.push("BURN EVENT — COST SEISMOGRAM v2 (marked-point-process null, calibrated statistics)".to_owned());
    l.push(format!(
        "  window since {}   bucket {}m   files {}",
        s(r.get("windowSinceIso")),
        crate::summarize::helpers::fmt_js_num(f(r.get("bucketMinutes"))),
        crate::summarize::helpers::fmt_js_num(f(r.get("filesAnalysed")))
    ));
    let total = f(r.get("totalUsd"));
    l.push(format!(
        "  series: {} buckets, {} costed turns, {} total",
        crate::summarize::helpers::fmt_js_num(f(r.get("bucketCount"))),
        crate::summarize::helpers::fmt_js_num(f(r.get("totalTurns"))),
        money(total)
    ));
    let (tw, tr, to) = (f(r.get("totalWriteUsd")), f(r.get("totalReadUsd")), f(r.get("totalOutputUsd")));
    l.push(format!(
        "    split: cache-WRITE(cold) {} ({})  cache-READ {} ({})  output {} ({})",
        money(tw),
        pct_of(tw, total),
        money(tr),
        pct_of(tr, total),
        money(to),
        pct_of(to, total)
    ));
    let rate_law = match s(r.get("rateLaw")) {
        "poisson" => "Poisson",
        "negative-binomial" => "NegBinom(over-dispersed)",
        _ => "NegBinom/Poisson per bucket",
    };
    l.push(format!(
        "  null model: turns ~ {rate_law}(λ̂={}/bucket, dispersion σ²/μ={}) × per-turn cost ~ lognormal (log-median {}, log-MAD {}); Fisher-combined (χ²₄)",
        js_to_fixed_str(f(r.get("poissonLambda")), 2),
        js_to_fixed_str(f(r.get("dispersionIndex")), 1),
        js_to_fixed_str(f(r.pointer("/intensityBaseline/median")), 2),
        js_to_fixed_str(f(r.pointer("/intensityBaseline/mad")), 2)
    ));
    l.push(format!(
        "  cost baseline (median/MAD): {}/min, MAD {}",
        money(f(r.pointer("/baseline/median"))),
        money(f(r.pointer("/baseline/mad")))
    ));
    let lb = r.get("localBaseline").filter(|v| !v.is_null());
    l.push(format!(
        "  background: {}",
        match lb {
            Some(b) => format!(
                "LOCAL CFAR ±{} buckets, guard ±{}, trim {} ({}% of buckets fell back to global)",
                crate::summarize::helpers::fmt_js_num(f(b.get("reference"))),
                crate::summarize::helpers::fmt_js_num(f(b.get("guard"))),
                crate::summarize::helpers::fmt_js_num(f(b.get("trim"))),
                js_to_fixed_str(100.0 * f(b.get("fallbackShare")), 0)
            ),
            None => "GLOBAL (stationary null — local background disabled)".to_owned(),
        }
    ));
    l.push(format!(
        "  p-value engine: {}",
        if s(r.get("pvalueEngine")) == "stochastic" {
            "stochastic community extension (independent)"
        } else {
            "internal TS core (unit-tested vs textbook + stochastic Δ≤2e-16)"
        }
    ));
    l.push(format!(
        "  significance: {} FDR α={} on combined p → {} significant buckets (crit p ≤ {})",
        s(r.get("fdrMethod")).to_uppercase(),
        crate::summarize::helpers::fmt_js_num(f(r.get("fdrAlpha"))),
        crate::summarize::helpers::fmt_js_num(f(r.get("fdrSignificantCount"))),
        to_exponential(f(r.get("fdrThreshold")), 2)
    ));
    // The calibration line is two independently-nullable halves: a background too small to measure
    // prints `n/a` and SUPPRESSES the π̂₀ clause entirely, rather than printing a 0 that reads as a
    // measured zero.
    let cal = r.get("calibration");
    let obs = cal.and_then(|c| c.get("observedBackgroundShare")).filter(|v| !v.is_null());
    let pi0 = cal.and_then(|c| c.get("pi0")).filter(|v| !v.is_null());
    let head = match obs {
        Some(v) => format!("{}%", js_to_fixed_str(100.0 * v.as_f64().unwrap_or(0.0), 1)),
        None => "n/a (background too small)".to_owned(),
    };
    let tail = match pi0 {
        Some(p) => {
            let p = p.as_f64().unwrap_or(0.0);
            format!(
                ", of which {}% is null-attributable (Storey π̂₀={} ⇒ ~{}% of active background is genuine signal); upper-half uniformity {}× (≈1 = well-specified null)",
                js_to_fixed_str(100.0 * f(cal.and_then(|c| c.get("nullAttributableShare"))), 1),
                js_to_fixed_str(p, 2),
                js_to_fixed_str(100.0 * (1.0 - p), 0),
                js_to_fixed_str(f(cal.and_then(|c| c.get("upperUniformity"))), 1)
            )
        }
        None => String::new(),
    };
    l.push(format!("  calibration: background p<0.05 = {head}{tail}"));
    l.push(format!(
        "  segmentation: PELT changepoints {}   |   CUSUM alarms {}",
        len_of(r.get("peltChangepoints")),
        len_of(r.get("changePoints"))
    ));
    let verdict = s(r.get("verdict"));
    if !verdict.is_empty() {
        l.push(format!("  VERDICT: {verdict}"));
    }

    let Some(m) = r.get("mainshock").filter(|v| v.is_object()) else {
        l.push("  no statistically significant event in window.".to_owned());
        return l.join("\n");
    };

    l.push(String::new());
    l.push("EVENT CATALOG (PELT segments with FDR-significant buckets, ranked by EXCESS $):".to_owned());
    l.push("   #  onset (UTC)          dur   excess$    total$   mag   p(comb)     cause".to_owned());
    let empty: Vec<Value> = Vec::new();
    for (i, e) in r.get("events").and_then(Value::as_array).unwrap_or(&empty).iter().enumerate() {
        l.push(format!(
            "  {}  {}  {}m  {}  {}  {}  {}   {}",
            pad_start(&(i + 1).to_string(), 2),
            s(e.get("fromIso")),
            pad_start(&crate::summarize::helpers::fmt_js_num(f(e.get("durMin"))), 4),
            pad_start(&money(f(e.get("excessUsd"))), 8),
            pad_start(&money(f(e.get("costUsd"))), 8),
            js_to_fixed_str(f(e.get("magnitude")), 1),
            pad_start(&to_exponential(f(e.get("minP")), 1), 9),
            s(e.get("cause"))
        ));
    }

    let cost_usd = f(m.get("costUsd"));
    l.push(String::new());
    l.push(format!(
        "MAINSHOCK  {} → {}  (~{} min)   excess {} of {}, {} turns",
        s(m.get("fromIso")),
        s(m.get("toIso")),
        crate::summarize::helpers::fmt_js_num(f(m.get("durMin"))),
        money(f(m.get("excessUsd"))),
        money(cost_usd),
        crate::summarize::helpers::fmt_js_num(f(m.get("turns")))
    ));
    l.push(format!(
        "  cause: {}   evidence: rate p {} vs intensity p {}   magnitude {}",
        s(m.get("cause")),
        to_exponential(f(m.get("minPRate")), 1),
        to_exponential(f(m.get("minPIntensity")), 1),
        js_to_fixed_str(f(m.get("magnitude")), 2)
    ));
    l.push(format!(
        "  peak {}/bucket at {}   intensity-z {}   STA/LTA {}",
        money(f(m.get("peakUsd"))),
        s(m.get("peakIso")),
        js_to_fixed_str(f(m.get("peakModZ")), 1),
        js_to_fixed_str(f(m.get("peakStaLta")), 1)
    ));
    let (mw, mr, mo) = (f(m.get("writeUsd")), f(m.get("readUsd")), f(m.get("outputUsd")));
    l.push(format!(
        "  decomposition: cold-WRITE {} ({})  READ {} ({})  output {} ({})   mode: {}",
        money(mw),
        pct_of(mw, cost_usd),
        money(mr),
        pct_of(mr, cost_usd),
        money(mo),
        pct_of(mo, cost_usd),
        s(m.get("dominantMode"))
    ));
    let culprits = m.get("culprits").and_then(Value::as_array).unwrap_or(&empty);
    if !culprits.is_empty() {
        l.push("  CULPRITS (sessions by excess inside this event):".to_owned());
        for c in culprits {
            let tags: Vec<&str> = c.get("tags").and_then(Value::as_array).unwrap_or(&empty).iter().map(|t| t.as_str().unwrap_or_default()).collect();
            let tag_str = if tags.is_empty() { String::new() } else { format!("  [{}]", tags.join(", ")) };
            let ev = f(c.get("eventUsd"));
            l.push(format!(
                "    {} excess of {}  {}t  W/R/O {}/{}/{}  {} · {}{}",
                pad_start(&money(f(c.get("excessUsd"))), 8),
                pad_start(&money(ev), 8),
                pad_start(&crate::summarize::helpers::fmt_js_num(f(c.get("turns"))), 4),
                pct_of(f(c.get("writeUsd")), ev),
                pct_of(f(c.get("readUsd")), ev),
                pct_of(f(c.get("outputUsd")), ev),
                js_slice(s(c.get("session")), 8),
                s(c.get("project")),
                tag_str
            ));
        }
    }

    l.push(String::new());
    l.push("TOP SESSIONS (ranked by accumulated EVENT EXCESS — who drove the anomalies):".to_owned());
    l.push("   evtExcess$    total$   turns   maxPrefix   W/R/O split       session · project".to_owned());
    for sess in r.get("sessions").and_then(Value::as_array).unwrap_or(&empty) {
        let c = f(sess.get("costUsd"));
        let split = format!(
            "{}/{}/{}",
            pct_of(f(sess.get("writeUsd")), c),
            pct_of(f(sess.get("readUsd")), c),
            pct_of(f(sess.get("outputUsd")), c)
        );
        l.push(format!(
            "  {}  {}  {}  {}   {}  {} · {}",
            pad_start(&money(f(sess.get("eventExcessUsd"))), 10),
            pad_start(&money(c), 9),
            pad_start(&crate::summarize::helpers::fmt_js_num(f(sess.get("turns"))), 5),
            pad_start(&crate::summarize::helpers::fmt_js_num(f(sess.get("maxPrefixTokens"))), 9),
            pad_end(&split, 15),
            js_slice(s(sess.get("session")), 8),
            s(sess.get("project"))
        ));
    }

    let spawns = r.get("spawnsInMainshock").and_then(Value::as_array).unwrap_or(&empty);
    l.push(String::new());
    l.push(format!("SPAWN CALLS INSIDE MAINSHOCK ({}) — verbatim, time-ordered:", spawns.len()));
    if spawns.is_empty() {
        l.push("  (none — the mainshock is cost-driven (cache thrash / re-read), not a new fan-out)".to_owned());
    } else {
        for c in spawns {
            // `.filter(Boolean)` — an absent subagent type or model drops its whole clause rather
            // than printing `subagent_type=undefined`.
            let mut parts: Vec<String> = Vec::new();
            let tool = s(c.get("tool"));
            if !tool.is_empty() {
                parts.push(tool.to_owned());
            }
            let sub = s(c.get("subagentType"));
            if !sub.is_empty() {
                parts.push(format!("subagent_type={sub}"));
            }
            let model = s(c.get("model"));
            if !model.is_empty() {
                parts.push(format!("model={model}"));
            }
            let input = s(c.get("input"));
            // UTF-16 length and slice: the cap is JS's, so a multi-byte character must count as JS
            // counts it or the "+Nb" tail disagrees on any non-ASCII prompt.
            let n = utf16_len(input);
            let shown = if n > 300 {
                format!("{}…(+{}b)", js_slice(input, 300), n - 300)
            } else {
                input.to_owned()
            };
            l.push(format!(
                "  {}. {}  [{}]  {}",
                crate::summarize::helpers::fmt_js_num(f(c.get("n"))),
                s(c.get("iso")),
                js_slice(s(c.get("sessionId")), 8),
                parts.join(" ")
            ));
            l.push(format!("       {shown}"));
        }
    }
    l.join("\n")
}

// ── SLICE C: transcript file selection (TS 77-138) ───────────────────────────────
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SeismicScope {
    Fleet,
    Workspace,
    Session,
}

pub struct ResolveSeismicOptions<'a> {
    pub scope: SeismicScope,
    /// For `Workspace`: the workspace path (its slug dir is scanned).
    pub workspace: Option<&'a str>,
    /// For `Session`: the session id, or a unique PREFIX of one.
    pub session_id: Option<&'a str>,
    /// Lower time bound (ms) — only transcripts touched at/after this (minus slack) are considered.
    pub since_ms: f64,
    /// `Fleet`: include subagent transcripts (`…/subagents/*.jsonl`). Default false (the spawners).
    pub include_subagents: bool,
    /// Cap the file set (most-recently-modified first). Default 300.
    pub max_files: Option<f64>,
    pub projects_dirs: Vec<PathBuf>,
}

/// A session file active in the window has mtime ≥ its last activity ≥ sinceMs; widen by an hour so
/// a session that went idle just after the window opens is not missed (the SQL re-filters by ts).
const MTIME_SLACK_MS: f64 = 3_600_000.0;

/// `/^[0-9a-f-]{36}\.jsonl$/i` — a main-session transcript is named for its uuid. Subagent files
/// (`agent-*.jsonl`) are NOT, which is exactly how the fleet scope excludes them by default.
fn is_uuid_jsonl(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".jsonl") else { return false };
    stem.len() == 36 && stem.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Resolve the transcript file set for a seismic analysis by scope. Never fails; returns empty.
pub fn resolve_seismic_files(o: &ResolveSeismicOptions<'_>) -> Vec<PathBuf> {
    let floor = o.since_ms - MTIME_SLACK_MS;
    let cap = o.max_files.unwrap_or(300.0).max(0.0) as usize;

    if o.scope == SeismicScope::Session {
        let Some(sid) = o.session_id.filter(|s| !s.is_empty()) else { return Vec::new() };
        let exact = format!("{sid}.jsonl");
        let mut out = Vec::new();
        for base in &o.projects_dirs {
            let Ok(subs) = std::fs::read_dir(base) else { continue };
            for sub in subs.flatten() {
                let dir = sub.path();
                let Ok(names) = std::fs::read_dir(&dir) else { continue };
                for e in names.flatten() {
                    let n = e.file_name().to_string_lossy().into_owned();
                    // A PREFIX match, not just the exact name: the caller may pass the first 8 chars
                    // of a session id, which is how every other surface here refers to one. No mtime
                    // filter — an explicitly named session is wanted however old it is.
                    if n.ends_with(".jsonl") && (n == exact || n.starts_with(sid)) {
                        out.push(dir.join(n));
                    }
                }
            }
        }
        return out;
    }

    let mut cand: Vec<(PathBuf, f64)> = Vec::new();
    let mut want_dirs: Vec<PathBuf> = Vec::new();
    if o.scope == SeismicScope::Workspace {
        let Some(ws) = o.workspace.filter(|s| !s.is_empty()) else { return Vec::new() };
        // Resolved against DISK, not derived: a workspace path long enough for Claude Code to
        // truncate and hash its slug yields a directory name no derivation can predict, and the
        // naive one matches nothing — so this scanned zero transcripts and reported no seismic
        // activity at all.
        for slug in crate::burn::causing_tool_call::resolve_project_slugs(ws, &o.projects_dirs) {
            for base in &o.projects_dirs {
                want_dirs.push(base.join(&slug));
            }
        }
    }

    let walk = |dir: &Path, allow_sub: bool, cand: &mut Vec<(PathBuf, f64)>| {
        fn go(dir: &Path, allow_sub: bool, o: &ResolveSeismicOptions<'_>, floor: f64, cand: &mut Vec<(PathBuf, f64)>) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for e in entries.flatten() {
                let full = e.path();
                let name = e.file_name().to_string_lossy().into_owned();
                if e.file_type().is_ok_and(|t| t.is_dir()) {
                    if allow_sub && name == "subagents" {
                        go(&full, true, o, floor, cand);
                    }
                    continue;
                }
                if !name.ends_with(".jsonl") {
                    continue;
                }
                if o.scope == SeismicScope::Fleet && !o.include_subagents && !is_uuid_jsonl(&name) {
                    continue;
                }
                let Some(m) = mtime_ms(&full) else { continue };
                if m < floor {
                    continue;
                }
                cand.push((full, m));
            }
        }
        go(dir, allow_sub, o, floor, cand);
    };

    if o.scope == SeismicScope::Workspace {
        for d in &want_dirs {
            walk(d, o.include_subagents, &mut cand);
        }
    } else {
        // fleet: every slug dir under every base.
        for base in &o.projects_dirs {
            let Ok(subs) = std::fs::read_dir(base) else { continue };
            for sub in subs.flatten() {
                walk(&sub.path(), o.include_subagents, &mut cand);
            }
        }
    }
    // Most recent first, then capped: a truncated set must keep the LIVE sessions, not an arbitrary
    // directory-order slice of them.
    cand.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    cand.into_iter().take(cap).map(|c| c.0).collect()
}

fn mtime_ms(p: &Path) -> Option<f64> {
    let t = std::fs::metadata(p).ok()?.modified().ok()?;
    Some(t.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as f64)
}

/// Single-quote a SQL literal (`sqlStr`). Every value reaching here is interpolated into DuckDB SQL.
fn sq(v: &str) -> String {
    format!("'{}'", v.replace('\'', "''"))
}

/// `transcriptReadSpec` (src/ndjsonDuck.ts) — the `read_json(...)` table-function text with the
/// shared column projection and `filename=true` so a multi-file scan can attribute each row back to
/// its source session.
pub fn transcript_read_spec(paths: &[PathBuf]) -> String {
    let list = paths.iter().map(|p| sq(&p.to_string_lossy())).collect::<Vec<_>>().join(", ");
    format!(
        "read_json([{list}], format='newline_delimited',\n      columns={{timestamp:'VARCHAR', type:'VARCHAR', message:'JSON'}},\n      maximum_object_size={}, ignore_errors=true, filename=true)",
        agentlens_store::transcript_sql::MAX_OBJECT_SIZE
    )
}

/// `ignore_errors=true` does NOT drop an unparseable NDJSON line — it lands as an ALL-NULL row, so
/// `count(*)` alone still passes while the data is silently degraded.
///
/// The compared column is `type`, NOT `timestamp`, and that is measured rather than chosen: over
/// 482,993 real transcript records `type` is missing from 0 and `timestamp` from 81,814 (16.9%,
/// because `attachment`, `queue-operation` and `last-prompt` records legitimately carry none). This
/// probe reads the UNFILTERED scan, so keying on `timestamp` would report roughly a sixth of a
/// healthy machine's records as "unparseable and excluded" — a disclosure that lies.
pub fn torn_line_sql(table: &str, required_col: &str) -> String {
    format!("SELECT count(*) AS total, count({required_col}) AS withCol FROM {table}")
}

// ── SLICE D: the analysis (TS 383-922) ───────────────────────────────────────────
use indexmap::IndexMap;

use crate::seismic_stats as ss;
use crate::summarize::helpers::{fmt_js_num, iso_from_ms, num};

/// The transport seam. The TS opens DuckDB inline and closes over the connection; the Rust takes the
/// same `(sql) -> rows` shape so the analysis can be exercised without a database and the production
/// implementation (`agentlens_store::transcript_sql::DuckSession`) stays in the crate that owns the
/// binding.
pub type Query<'a> = &'a dyn Fn(&str) -> Result<Vec<Value>, String>;

#[derive(Default)]
pub struct BurnSeismicOptions<'a> {
    pub files: Vec<PathBuf>,
    pub since_iso: Option<String>,
    pub bucket_minutes: Option<f64>,
    pub mod_z_threshold: Option<f64>,
    pub fdr_alpha: Option<f64>,
    pub fdr_method: Option<&'a str>,
    pub cfar_reference: Option<f64>,
    pub cfar_guard: Option<f64>,
    pub cfar_trim: Option<f64>,
    pub cfar_min_reference: Option<f64>,
    pub sta_minutes: Option<f64>,
    pub lta_minutes: Option<f64>,
    pub sta_lta_on: Option<f64>,
    pub sta_lta_off: Option<f64>,
    pub cusum_k_sigma: Option<f64>,
    pub cusum_h_sigma: Option<f64>,
    pub top_events: Option<f64>,
    pub top_sessions: Option<f64>,
    pub rate_law: Option<&'a str>,
    pub pelt_penalty: Option<f64>,
    pub pvalue_engine: Option<&'a str>,
}

fn obj(pairs: Vec<(&str, Value)>) -> Value {
    let mut m = Map::new();
    for (k, v) in pairs {
        m.insert(k.to_owned(), v);
    }
    Value::Object(m)
}

fn baseline_value(b: &ss::RobustBaseline) -> Value {
    obj(vec![
        ("median", num(b.median)),
        ("mad", num(b.mad)),
        ("meanAD", num(b.mean_ad)),
        ("sigmaHat", num(b.sigma_hat)),
    ])
}

/// `numOf` — a null/absent cell is 0, anything else goes through `Number()`.
fn num_of(v: Option<&Value>) -> f64 {
    match v {
        None | Some(Value::Null) => 0.0,
        Some(x) => x.as_f64().unwrap_or_else(|| x.as_str().and_then(|s| s.parse().ok()).unwrap_or(f64::NAN)),
    }
}

fn str_of(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => "undefined".to_owned(),
        Some(x) => x.to_string(),
    }
}

/// `path.basename(f, '.jsonl')`.
fn basename_no_ext(p: &str) -> String {
    Path::new(p).file_stem().map_or_else(String::new, |s| s.to_string_lossy().into_owned())
}

/// `path.basename(path.dirname(f))`.
fn parent_name(p: &str) -> String {
    Path::new(p)
        .parent()
        .and_then(Path::file_name)
        .map_or_else(String::new, |s| s.to_string_lossy().into_owned())
}

struct CellAgg {
    cost: f64,
    w: f64,
    r: f64,
    o: f64,
    turns: f64,
    max_cc: f64,
    models: std::collections::BTreeSet<String>,
}

struct SessAgg {
    cost: f64,
    w: f64,
    r: f64,
    o: f64,
    turns: f64,
    max_prefix: f64,
}

struct Bucket {
    iso: String,
    cost: f64,
    w: f64,
    r: f64,
    o: f64,
    turns: f64,
}

/// `LOAD stochastic`, or INSTALL-then-LOAD when that is allowed. Never fails unless the caller
/// REQUIRED the extension — an unavailable optional engine is a fallback, not an error.
fn load_stochastic(query: Query<'_>, require: bool) -> Result<bool, String> {
    if query("LOAD stochastic;").is_ok() {
        return Ok(true);
    }
    match query("INSTALL stochastic FROM community; LOAD stochastic;") {
        Ok(_) => Ok(true),
        Err(e) => {
            if require {
                let first = e.lines().next().unwrap_or_default().to_owned();
                return Err(format!(
                    "pvalueEngine='stochastic' requested but the extension could not be installed: {first}"
                ));
            }
            Ok(false)
        }
    }
}

/// Per-bucket tails computed BY the extension, independent of `seismic_stats`.
///
/// λ and the over-dispersion are PER ROW: each bucket carries its own LOCAL background, so the tail
/// must be evaluated against that bucket's λ̂ₜ, not one window-wide constant. Where the local
/// background is over-dispersed the row carries the method-of-moments negative binomial and SQL
/// takes the NB tail through the regularized incomplete beta — `dist_negative_binomial_*` takes an
/// INTEGER size while the method-of-moments r is fractional (the Pólya case), so casting it would
/// silently change the distribution.
fn ext_p_values(
    query: Query<'_>,
    turns: &[f64],
    z_intensity: &[f64],
    lambdas: &[f64],
    variances: &[f64],
) -> Result<(Vec<f64>, Vec<f64>), String> {
    let fin = |x: f64| if x.is_finite() { x } else { 0.0 };
    let rows: Vec<String> = turns
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let mu = fin(lambdas[i]);
            let v = fin(variances[i]);
            let over = v > mu && mu > 0.0;
            let r = if over { (mu * mu) / (v - mu) } else { 0.0 };
            let p = if over { mu / v } else { 0.5 };
            format!(
                "({i}, {}, {}, {}, {}, {})",
                fmt_js_num(js_math_round(*t).max(0.0)),
                fmt_js_num(fin(z_intensity[i])),
                fmt_js_num(mu),
                fmt_js_num(r),
                fmt_js_num(p)
            )
        })
        .collect();
    let sql = format!(
        "\n    WITH t(i, turns, modz, lam, nb_r, nb_p) AS (VALUES {})\n    SELECT i,\n      CASE\n        WHEN turns <= 0 THEN 1.0\n        WHEN nb_r > 0 THEN 1 - dist_beta_cdf(CAST(nb_r AS DOUBLE), CAST(turns AS DOUBLE), CAST(nb_p AS DOUBLE))\n        ELSE dist_poisson_cdf_complement(CAST(lam AS DOUBLE), CAST(turns AS DOUBLE))\n             + dist_poisson_pdf(CAST(lam AS DOUBLE), CAST(turns AS DOUBLE)) END AS p_pois,\n      dist_normal_cdf_complement(0.0, 1.0, CAST(modz AS DOUBLE)) AS p_norm\n    FROM t ORDER BY i;",
        rows.join(",")
    );
    let out = query(&sql)?;
    let mut p_rate = vec![1.0; turns.len()];
    let mut p_int = vec![1.0; turns.len()];
    for r in &out {
        let i = num_of(r.get("i")) as usize;
        if i < p_rate.len() {
            p_rate[i] = num_of(r.get("p_pois")).clamp(0.0, 1.0);
            p_int[i] = num_of(r.get("p_norm")).clamp(0.0, 1.0);
        }
    }
    Ok((p_rate, p_int))
}

/// Run the full seismic pipeline over the transcript set. Returns a structured, reproducible result
/// — or an empty one carrying a typed `reason`, never a fabricated event.
#[allow(clippy::too_many_lines)]
pub fn burn_seismic(opts: &BurnSeismicOptions<'_>, query: Query<'_>, now_ms: f64) -> Value {
    let bucket_minutes = opts.bucket_minutes.unwrap_or(1.0);
    let mod_z_threshold = opts.mod_z_threshold.unwrap_or(3.5);
    let fdr_alpha = opts.fdr_alpha.unwrap_or(0.01);
    let fdr_method = opts.fdr_method.unwrap_or("bh");
    let cfar_ref = opts.cfar_reference.unwrap_or(120.0).floor().max(0.0);
    let cfar_guard = opts.cfar_guard.unwrap_or(15.0).floor().max(0.0);
    let cfar_trim = opts.cfar_trim.unwrap_or(0.25);
    let cfar_min_ref = opts.cfar_min_reference.unwrap_or(30.0).floor().max(1.0);
    let sta_min = opts.sta_minutes.unwrap_or(3.0);
    let lta_min = opts.lta_minutes.unwrap_or(60.0);
    let sta_on = opts.sta_lta_on.unwrap_or(4.0);
    let sta_off = opts.sta_lta_off.unwrap_or(1.5);
    let cusum_k = opts.cusum_k_sigma.unwrap_or(0.5);
    let cusum_h = opts.cusum_h_sigma.unwrap_or(5.0);
    let top_events = opts.top_events.unwrap_or(10.0).max(0.0) as usize;
    let top_sessions = opts.top_sessions.unwrap_or(10.0).max(0.0) as usize;
    let since_iso = opts
        .since_iso
        .clone()
        .unwrap_or_else(|| iso_from_ms(now_ms - 24.0 * 3_600_000.0));

    let zero_baseline = ss::RobustBaseline::default();
    let empty = |reason: &str| -> Value {
        obj(vec![
            ("windowSinceIso", Value::String(since_iso.clone())),
            ("bucketMinutes", num(bucket_minutes)),
            ("filesAnalysed", num(opts.files.len() as f64)),
            ("totalUsd", num(0.0)),
            ("totalWriteUsd", num(0.0)),
            ("totalReadUsd", num(0.0)),
            ("totalOutputUsd", num(0.0)),
            ("totalTurns", num(0.0)),
            ("bucketCount", num(0.0)),
            ("baseline", baseline_value(&zero_baseline)),
            ("poissonLambda", num(0.0)),
            ("intensityBaseline", baseline_value(&zero_baseline)),
            ("rateLaw", Value::String("poisson".into())),
            ("dispersionIndex", num(1.0)),
            ("fdrAlpha", num(fdr_alpha)),
            ("fdrMethod", Value::String(fdr_method.to_owned())),
            ("fdrThreshold", num(0.0)),
            ("fdrSignificantCount", num(0.0)),
            (
                "calibration",
                obj(vec![
                    ("alpha", num(0.05)),
                    ("observedBackgroundShare", Value::Null),
                    ("pi0", Value::Null),
                    ("nullAttributableShare", Value::Null),
                    ("upperUniformity", Value::Null),
                ]),
            ),
            ("localBaseline", Value::Null),
            ("pvalueEngine", Value::String("internal".into())),
            ("dominantModeOverall", Value::String("MIXED".into())),
            ("verdict", Value::String(String::new())),
            ("changePoints", Value::Array(vec![])),
            ("peltChangepoints", Value::Array(vec![])),
            ("events", Value::Array(vec![])),
            ("sessions", Value::Array(vec![])),
            ("spawnsInMainshock", Value::Array(vec![])),
            ("buckets", Value::Array(vec![])),
            ("reason", Value::String(reason.to_owned())),
        ])
    };

    let files: Vec<PathBuf> = opts.files.iter().filter(|f| f.exists()).cloned().collect();
    if files.is_empty() {
        return empty("no-files");
    }

    let read_json = transcript_read_spec(&files);
    let bk = format!("INTERVAL '{} minute'", fmt_js_num(bucket_minutes));

    // A) ONE aggregation, per (bucket, filename, model): token sums + turn count + the MAX
    // single-turn cache_creation / cache_read. Session-resolved so per-event attribution needs no
    // second scan; the single-turn maxima are what the COLD_REWRITE signature (one turn's cc ≈ the
    // session's whole prefix) and the fatness figure are defined on — bucket SUMS express neither.
    let raw_sql = format!(
        "\n      WITH raw AS (\n        SELECT time_bucket({bk}, CAST(timestamp AS TIMESTAMP)) AS bucket, filename,\n               json_extract_string(message,'$.model') AS model,\n               TRY_CAST(json_extract_string(message,'$.usage.input_tokens') AS BIGINT) AS inp,\n               TRY_CAST(json_extract_string(message,'$.usage.cache_creation_input_tokens') AS BIGINT) AS cc,\n               TRY_CAST(json_extract_string(message,'$.usage.cache_read_input_tokens') AS BIGINT) AS cr,\n               TRY_CAST(json_extract_string(message,'$.usage.output_tokens') AS BIGINT) AS out\n        FROM {read_json}\n        WHERE type='assistant' AND timestamp >= {} AND json_extract(message,'$.usage') IS NOT NULL\n      )\n      SELECT CAST(bucket AS VARCHAR) AS bucket, filename, coalesce(model,'?') AS model,\n             sum(coalesce(inp,0)) AS inp, sum(coalesce(cc,0)) AS cc,\n             sum(coalesce(cr,0)) AS cr, sum(coalesce(out,0)) AS out, count(*) AS turns,\n             max(coalesce(cc,0)) AS maxcc, max(coalesce(cr,0)) AS maxcr\n      FROM raw GROUP BY 1,2,3 ORDER BY 1;",
        sq(&since_iso)
    );
    let Ok(raw_rows) = query(&raw_sql) else { return empty("duckdb-unavailable") };
    if raw_rows.is_empty() {
        return empty("no-costed-turns");
    }

    // Torn-line disclosure, only after the main query succeeded.
    let torn_lines = query(&torn_line_sql(&read_json, "type")).map_or(0.0, |rows| {
        rows.first().map_or(0.0, |r| num_of(r.get("total")) - num_of(r.get("withCol")))
    });

    let bucket_ms = bucket_minutes * 60_000.0;
    let mut per_bucket: IndexMap<String, Bucket> = IndexMap::new();
    let mut per_cell: IndexMap<String, CellAgg> = IndexMap::new();
    let mut per_session: IndexMap<String, SessAgg> = IndexMap::new();
    for row in &raw_rows {
        let bucket = str_of(row.get("bucket"));
        let filename = str_of(row.get("filename"));
        let model = str_of(row.get("model"));
        let (inp, cc, cr, out, turns, maxcc, maxcr) = (
            num_of(row.get("inp")),
            num_of(row.get("cc")),
            num_of(row.get("cr")),
            num_of(row.get("out")),
            num_of(row.get("turns")),
            num_of(row.get("maxcc")),
            num_of(row.get("maxcr")),
        );
        let p = cost_parts(&model, inp, cc, cr, out, now_ms);
        let row_cost = p.i + p.r + p.w + p.o;
        let acc = per_bucket.entry(bucket.clone()).or_insert(Bucket {
            iso: bucket.clone(),
            cost: 0.0,
            w: 0.0,
            r: 0.0,
            o: 0.0,
            turns: 0.0,
        });
        acc.cost += row_cost;
        acc.w += p.w;
        acc.r += p.r;
        acc.o += p.o;
        acc.turns += turns;
        let cell_key = format!("{bucket}|{filename}");
        let cell = per_cell.entry(cell_key).or_insert(CellAgg {
            cost: 0.0,
            w: 0.0,
            r: 0.0,
            o: 0.0,
            turns: 0.0,
            max_cc: 0.0,
            models: std::collections::BTreeSet::new(),
        });
        cell.cost += row_cost;
        cell.w += p.w;
        cell.r += p.r;
        cell.o += p.o;
        cell.turns += turns;
        cell.max_cc = cell.max_cc.max(maxcc);
        cell.models.insert(model);
        let sess = per_session.entry(filename).or_insert(SessAgg {
            cost: 0.0,
            w: 0.0,
            r: 0.0,
            o: 0.0,
            turns: 0.0,
            max_prefix: 0.0,
        });
        sess.cost += row_cost;
        sess.w += p.w;
        sess.r += p.r;
        sess.o += p.o;
        sess.turns += turns;
        sess.max_prefix = sess.max_prefix.max(maxcr);
    }

    let lo_ms = iso_to_ms(&str_of(raw_rows[0].get("bucket"))).unwrap_or(0.0);
    let hi_ms = iso_to_ms(&str_of(raw_rows[raw_rows.len() - 1].get("bucket"))).unwrap_or(0.0);
    let mut grid: Vec<Bucket> = Vec::new();
    let mut ms = lo_ms;
    while ms <= hi_ms {
        let iso = ms_to_bucket_iso(ms);
        let b = per_bucket.get(&iso);
        grid.push(Bucket {
            iso: iso.clone(),
            cost: b.map_or(0.0, |x| x.cost),
            w: b.map_or(0.0, |x| x.w),
            r: b.map_or(0.0, |x| x.r),
            o: b.map_or(0.0, |x| x.o),
            turns: b.map_or(0.0, |x| x.turns),
        });
        ms += bucket_ms;
    }

    let cost: Vec<f64> = grid.iter().map(|g| g.cost).collect();
    let turns: Vec<f64> = grid.iter().map(|g| g.turns).collect();
    let w_series: Vec<f64> = grid.iter().map(|g| g.w).collect();
    let r_series: Vec<f64> = grid.iter().map(|g| g.r).collect();
    let baseline = ss::robust_baseline(&cost);
    let median_w = ss::median(&w_series);
    let median_r = ss::median(&r_series);

    let cfar = |xs: &[f64], include: Option<&[bool]>, min_ref: f64| {
        ss::cfar_local_stats(
            xs,
            &ss::CfarOptions {
                reference: cfar_ref,
                guard: cfar_guard,
                trim: Some(cfar_trim),
                min_reference: Some(min_ref),
                include,
            },
        )
    };
    let loc_cost = cfar(&cost, None, cfar_min_ref);
    let loc_turns = cfar(&turns, None, cfar_min_ref);
    let loc_w = cfar(&w_series, None, cfar_min_ref);
    let loc_r = cfar(&r_series, None, cfar_min_ref);

    // RATE null: the trimmed Poisson MLE — the mean of the buckets whose count modified-z is not
    // extreme, so a burst cannot inflate its own baseline.
    let turn_mod_z = ss::modified_z_scores(&turns, Some(ss::robust_baseline(&turns)));
    let bg: Vec<f64> = turns
        .iter()
        .enumerate()
        .filter(|(i, _)| turn_mod_z[*i].abs() <= mod_z_threshold)
        .map(|(_, t)| *t)
        .collect();
    let lambda = if bg.is_empty() {
        turns.iter().sum::<f64>() / (turns.len().max(1)) as f64
    } else {
        bg.iter().sum::<f64>() / bg.len() as f64
    };
    // A FINITE window of zeros cannot prove the rate is exactly 0, and λ̂=0 would make any single
    // turn infinitely significant (P(X≥1|0) = 0 — a certainty the data does not support).
    let lambda_floor = |n: f64| 0.5 / n.max(1.0);
    let lambda_at: Vec<f64> = (0..grid.len())
        .map(|i| match &loc_turns[i] {
            Some(l) => l.trimmed_mean.max(lambda_floor(l.n as f64)),
            None => lambda.max(lambda_floor(turns.len() as f64)),
        })
        .collect();

    let global_turn_var = if bg.len() < 2 {
        0.0
    } else {
        let m = bg.iter().sum::<f64>() / bg.len() as f64;
        bg.iter().map(|v| (v - m) * (v - m)).sum::<f64>() / (bg.len() - 1) as f64
    };
    // `rateLaw:'poisson'` pins variance ≡ mean, which makes the NB tail degenerate to the exact
    // Poisson one everywhere — the falsifier that reproduces the pre-NB false-alarm rate on demand.
    let var_at: Vec<f64> = (0..grid.len())
        .map(|i| {
            if opts.rate_law == Some("poisson") {
                lambda_at[i]
            } else {
                loc_turns[i].map_or(global_turn_var, |c| c.winsor_var)
            }
        })
        .collect();
    let dispersion_at: Vec<f64> = (0..grid.len())
        .map(|i| if lambda_at[i] > 0.0 { var_at[i] / lambda_at[i] } else { 1.0 })
        .collect();
    let dispersion_index = ss::median(&dispersion_at);
    let over_dispersed_share =
        dispersion_at.iter().filter(|d| **d > 1.0).count() as f64 / (grid.len().max(1)) as f64;
    let rate_law = if over_dispersed_share == 0.0 {
        "poisson"
    } else if over_dispersed_share > 0.99 {
        "negative-binomial"
    } else {
        "mixed"
    };

    // INTENSITY null: log per-turn cost over ACTIVE buckets only (the hurdle — a quiet minute is a
    // zero of the OCCUPANCY process, not a tiny cost; folding it in would bias median/MAD low and
    // inflate every active minute's z).
    let active_mask: Vec<bool> = grid.iter().map(|g| g.turns > 0.0 && g.cost > 0.0).collect();
    let log_pt: Vec<f64> = (0..grid.len())
        .map(|i| if active_mask[i] { (cost[i] / turns[i]).ln() } else { 0.0 })
        .collect();
    let log_per_turn: Vec<f64> =
        log_pt.iter().enumerate().filter(|(i, _)| active_mask[*i]).map(|(_, v)| *v).collect();
    let intensity_baseline =
        if log_per_turn.is_empty() { zero_baseline } else { ss::robust_baseline(&log_per_turn) };
    let loc_int = cfar(&log_pt, Some(&active_mask), 12.0_f64.max((cfar_min_ref / 3.0).floor()));

    // LOCAL location, POOLED scale. A reference window can be perfectly flat (zero MAD *and* zero
    // meanAD), and a zero-width scale is not a measurement: it makes the robust z either 0 (a fat
    // turn beside 25 identical quiet ones would score NOTHING) or ±∞ (infinite confidence from 25
    // samples). Neither is honest, so when the local scale collapses the WINDOW-WIDE dispersion
    // supplies the scale while the local median still supplies the level.
    let z_intensity: Vec<f64> = (0..grid.len())
        .map(|i| {
            if !active_mask[i] {
                return 0.0;
            }
            let lb = loc_int[i].map(|c| c.baseline);
            let loc = lb.map_or(intensity_baseline.median, |b| b.median);
            let scale = match lb {
                Some(b) if b.mad > 0.0 || b.mean_ad > 0.0 => b,
                _ => intensity_baseline,
            };
            ss::modified_z(log_pt[i], loc, scale.mad, scale.mean_ad)
        })
        .collect();

    let base_at: Vec<f64> =
        (0..grid.len()).map(|i| loc_cost[i].map_or(baseline.median, |c| c.baseline.median)).collect();
    let w_base_at: Vec<f64> =
        (0..grid.len()).map(|i| loc_w[i].map_or(median_w, |c| c.baseline.median)).collect();
    let r_base_at: Vec<f64> =
        (0..grid.len()).map(|i| loc_r[i].map_or(median_r, |c| c.baseline.median)).collect();
    let local_cells = loc_turns.iter().filter(|c| c.is_some()).count();
    let local_baseline = if cfar_ref == 0.0 {
        Value::Null
    } else {
        obj(vec![
            ("reference", num(cfar_ref)),
            ("guard", num(cfar_guard)),
            ("trim", num(cfar_trim)),
            (
                "fallbackShare",
                num(if grid.is_empty() { 1.0 } else { 1.0 - local_cells as f64 / grid.len() as f64 }),
            ),
        ])
    };

    let want = opts.pvalue_engine.unwrap_or("auto");
    let use_ext = if want == "internal" {
        false
    } else {
        match load_stochastic(query, want == "stochastic") {
            Ok(v) => v,
            // A REQUIRED engine that could not be installed is the caller's error, not a silent
            // downgrade — the TS throws here and the reason travels in the message.
            Err(e) => return obj(vec![("error", Value::String(e))]),
        }
    };
    let (mut p_rate, mut p_intensity) = if use_ext {
        match ext_p_values(query, &turns, &z_intensity, &lambda_at, &var_at) {
            Ok(v) => v,
            Err(e) => return obj(vec![("error", Value::String(e))]),
        }
    } else {
        (
            turns.iter().enumerate().map(|(i, t)| ss::neg_binom_sf(*t, lambda_at[i], var_at[i])).collect(),
            z_intensity.iter().map(|z| ss::normal_sf(*z)).collect::<Vec<f64>>(),
        )
    };
    // An inactive bucket carries NO intensity evidence: p ≡ 1 regardless of engine (its z slot is a
    // placeholder 0 that would otherwise read as p=0.5 and dilute Fisher for the whole series).
    for i in 0..grid.len() {
        if !active_mask[i] {
            p_intensity[i] = 1.0;
        }
    }
    p_rate.truncate(grid.len());
    let pvalue_engine = if use_ext { "stochastic" } else { "internal" };

    let p_combined: Vec<f64> =
        (0..grid.len()).map(|i| ss::fisher_combine(p_rate[i], p_intensity[i])).collect();
    let bh = if fdr_method == "by" {
        ss::benjamini_yekutieli(&p_combined, fdr_alpha)
    } else {
        ss::benjamini_hochberg(&p_combined, fdr_alpha)
    };

    // STA/LTA (impulsive onset) + CUSUM (regime shift) on the COMPRESSED cost series — log1p tames
    // the heavy tail so one mega-spike cannot blind the windowed averages.
    let log_cost: Vec<f64> = cost.iter().map(|c| c.ln_1p()).collect();
    let log_base = ss::robust_baseline(&log_cost);
    let sta = ss::sta_lta(&log_cost, sta_min as usize, lta_min as usize, sta_on, sta_off);
    let k = cusum_k * log_base.sigma_hat;
    let h = cusum_h * log_base.sigma_hat;
    let cp_alarms = if h > 0.0 { ss::cusum(&log_cost, log_base.median, k, h).alarms } else { Vec::new() };
    let change_points: Vec<Value> =
        cp_alarms.iter().map(|i| Value::String(grid[*i].iso.clone())).collect();

    let buckets: Vec<Value> = grid
        .iter()
        .enumerate()
        .map(|(i, g)| {
            obj(vec![
                ("iso", Value::String(g.iso.clone())),
                ("costUsd", num(g.cost)),
                ("writeUsd", num(g.w)),
                ("readUsd", num(g.r)),
                ("outputUsd", num(g.o)),
                ("turns", num(g.turns)),
                ("modZ", num(z_intensity[i])),
                ("pValueRate", num(p_rate[i])),
                ("lambda", num(lambda_at[i])),
                ("baselineUsd", num(base_at[i])),
                ("pValueIntensity", num(p_intensity[i])),
                ("pValue", num(p_combined[i])),
                ("fdrSignificant", Value::Bool(bh.rejected[i])),
                ("staLtaRatio", num(sta.ratio[i])),
            ])
        })
        .collect();

    let pelt = ss::pelt(&log_cost, opts.pelt_penalty);
    let pelt_changepoints: Vec<Value> =
        pelt.changepoints.iter().map(|i| Value::String(grid[*i].iso.clone())).collect();

    let mode_of = |w: f64, r: f64, total: f64| -> &'static str {
        let wf = if total > 0.0 { w / total } else { 0.0 };
        let rf = if total > 0.0 { r / total } else { 0.0 };
        if wf >= 0.5 && wf >= rf {
            "CACHE_THRASH"
        } else if rf >= 0.5 && rf > wf {
            "MARATHON_REREAD"
        } else {
            "MIXED"
        }
    };
    // Magnitude uses a FIXED window-wide reference (like Richter's reference amplitude) so events
    // stay comparable across regimes; only the ENERGY (the excess) is measured locally.
    let ref_cost = baseline.median.max(1e-9);
    // Evidence score −ln p, capped so p=0 (underflow) stays finite and comparable.
    let ev_score = |x: f64| -(x.max(1e-320)).ln();

    let idx_of: std::collections::HashMap<&str, usize> =
        grid.iter().enumerate().map(|(i, g)| (g.iso.as_str(), i)).collect();
    let mut session_event_excess: IndexMap<String, f64> = IndexMap::new();

    let build_culprits = |from: usize, to: usize, sxs: &mut IndexMap<String, f64>| -> Vec<Value> {
        let dur_buckets = (to - from + 1) as f64;
        let mut agg: IndexMap<String, CellAgg> = IndexMap::new();
        for (key, cell) in &per_cell {
            // The bucket iso never contains '|'; the PATH after it may, which is why the split is on
            // the FIRST separator rather than a rsplit.
            let Some(sep) = key.find('|') else { continue };
            let Some(&idx) = idx_of.get(&key[..sep]) else { continue };
            if idx < from || idx > to {
                continue;
            }
            let filename = key[sep + 1..].to_owned();
            let a = agg.entry(filename).or_insert(CellAgg {
                cost: 0.0,
                w: 0.0,
                r: 0.0,
                o: 0.0,
                turns: 0.0,
                max_cc: 0.0,
                models: std::collections::BTreeSet::new(),
            });
            a.cost += cell.cost;
            a.w += cell.w;
            a.r += cell.r;
            a.o += cell.o;
            a.turns += cell.turns;
            a.max_cc = a.max_cc.max(cell.max_cc);
            for m in &cell.models {
                a.models.insert(m.clone());
            }
        }
        let mut out: Vec<(f64, Value)> = Vec::new();
        for (filename, a) in &agg {
            let Some(sess) = per_session.get(filename) else { continue };
            let outside_buckets = (grid.len() as f64 - dur_buckets).max(1.0);
            let baseline_rate = (sess.cost - a.cost).max(0.0) / outside_buckets;
            let excess = (a.cost - baseline_rate * dur_buckets).max(0.0);
            let mut tags: Vec<Value> = Vec::new();
            // COLD_REWRITE needs a REAL prefix (≥50k): without the floor a fresh session's first
            // turn (cc>0, max prefix≈0) would trivially satisfy cc ≥ 0.8·0 and tag every newborn.
            if sess.max_prefix >= 50_000.0 && a.max_cc >= 0.8 * sess.max_prefix {
                tags.push(Value::String("COLD_REWRITE".into()));
            }
            if a.models.len() > 1 {
                tags.push(Value::String("MODEL_SWITCH".into()));
            }
            out.push((
                excess,
                obj(vec![
                    ("session", Value::String(basename_no_ext(filename))),
                    ("project", Value::String(parent_name(filename))),
                    ("eventUsd", num(a.cost)),
                    ("excessUsd", num(excess)),
                    ("writeUsd", num(a.w)),
                    ("readUsd", num(a.r)),
                    ("outputUsd", num(a.o)),
                    ("turns", num(a.turns)),
                    ("tags", Value::Array(tags)),
                    (
                        "models",
                        Value::Array(a.models.iter().map(|m| Value::String(m.clone())).collect()),
                    ),
                ]),
            ));
            *sxs.entry(filename.clone()).or_insert(0.0) += excess;
        }
        out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        out.into_iter().take(5).map(|c| c.1).collect()
    };

    let finalize = |from: usize, to: usize, sxs: &mut IndexMap<String, f64>| -> (f64, Value) {
        let (mut cost_usd_e, mut w, mut r, mut o, mut tn) = (0.0, 0.0, 0.0, 0.0, 0.0);
        let (mut peak_usd, mut peak_iso, mut peak_idx) = (0.0, grid[from].iso.clone(), from);
        let (mut peak_mod_z, mut peak_sta) = (0.0_f64, 0.0_f64);
        let (mut min_p, mut min_p_rate, mut min_p_int) = (1.0_f64, 1.0_f64, 1.0_f64);
        let (mut base_sum, mut w_base_sum, mut r_base_sum) = (0.0, 0.0, 0.0);
        for i in from..=to {
            cost_usd_e += grid[i].cost;
            w += grid[i].w;
            r += grid[i].r;
            o += grid[i].o;
            tn += grid[i].turns;
            base_sum += base_at[i];
            w_base_sum += w_base_at[i];
            r_base_sum += r_base_at[i];
            if grid[i].cost > peak_usd {
                peak_usd = grid[i].cost;
                peak_iso = grid[i].iso.clone();
                peak_idx = i;
            }
            peak_mod_z = peak_mod_z.max(z_intensity[i]);
            peak_sta = peak_sta.max(sta.ratio[i]);
            min_p = min_p.min(p_combined[i]);
            min_p_rate = min_p_rate.min(p_rate[i]);
            min_p_int = min_p_int.min(p_intensity[i]);
        }
        // Excess against the LOCAL expectation summed over the event's own buckets — a busy-hour
        // event is not credited with the busy hour's normal spend, and a quiet-hour event is not
        // discounted.
        let excess_usd = (cost_usd_e - base_sum).max(0.0);
        let excess_w = (w - w_base_sum).max(0.0);
        let excess_r = (r - r_base_sum).max(0.0);
        let s_rate = ev_score(min_p_rate);
        let s_int = ev_score(min_p_int);
        let cause = if s_rate >= 2.0 * s_int {
            "FANOUT_RATE"
        } else if s_int >= 2.0 * s_rate {
            if excess_w >= excess_r { "FAT_TURN_THRASH" } else { "FAT_TURN_MARATHON" }
        } else {
            "COMPOUND"
        };
        let dur_min = (iso_to_ms(&grid[to].iso).unwrap_or(0.0) - iso_to_ms(&grid[from].iso).unwrap_or(0.0))
            / 60_000.0
            + bucket_minutes;
        (
            excess_usd,
            obj(vec![
                ("fromIso", Value::String(grid[from].iso.clone())),
                ("toIso", Value::String(grid[to].iso.clone())),
                ("durMin", num(dur_min)),
                ("costUsd", num(cost_usd_e)),
                ("excessUsd", num(excess_usd)),
                ("writeUsd", num(w)),
                ("readUsd", num(r)),
                ("outputUsd", num(o)),
                ("turns", num(tn)),
                ("peakUsd", num(peak_usd)),
                ("peakIso", Value::String(peak_iso)),
                ("peakModZ", num(peak_mod_z)),
                ("peakStaLta", num(peak_sta)),
                ("minP", num(min_p)),
                ("minPRate", num(min_p_rate)),
                ("minPIntensity", num(min_p_int)),
                ("magnitude", num(ss::magnitude((peak_usd - base_at[peak_idx]).max(0.0), ref_cost))),
                ("dominantMode", Value::String(mode_of(w, r, cost_usd_e).to_owned())),
                ("cause", Value::String(cause.to_owned())),
                ("culprits", Value::Array(build_culprits(from, to, sxs))),
            ]),
        )
    };

    // SEGMENTATION — an EVENT is a PELT segment containing ≥1 FDR-significant bucket. Boundaries
    // come from the changepoint method, significance from the calibrated per-bucket tests. When PELT
    // under-segments (a lone spike merged into a long quiet regime whose mean is NOT elevated) the
    // event shrinks to the significant core so quiet minutes cannot dilute it; an elevated segment
    // is taken WHOLE — that regime IS the event.
    let mut raw_events: Vec<(f64, Value)> = Vec::new();
    for seg in &pelt.segments {
        let (mut first, mut last) = (None, 0usize);
        for i in seg.from..=seg.to {
            if bh.rejected[i] {
                if first.is_none() {
                    first = Some(i);
                }
                last = i;
            }
        }
        let Some(first) = first else { continue };
        let (mut seg_cost, mut seg_base) = (0.0, 0.0);
        for i in seg.from..=seg.to {
            seg_cost += cost[i];
            seg_base += base_at[i];
        }
        let elevated = seg_cost > seg_base; // vs the LOCAL expectation of the same buckets
        let ev = if elevated {
            finalize(seg.from, seg.to, &mut session_event_excess)
        } else {
            finalize(first, last, &mut session_event_excess)
        };
        raw_events.push(ev);
    }
    // Events rank by EXCESS (the anomaly's energy), not raw $ — raw totals conflate the baseline.
    raw_events.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let events: Vec<Value> = raw_events.into_iter().map(|e| e.1).collect();
    let mainshock = events.first().cloned();

    let mut sessions: Vec<(f64, f64, Value)> = per_session
        .iter()
        .map(|(filename, s)| {
            let ee = session_event_excess.get(filename).copied().unwrap_or(0.0);
            (
                ee,
                s.cost,
                obj(vec![
                    ("session", Value::String(basename_no_ext(filename))),
                    ("project", Value::String(parent_name(filename))),
                    ("costUsd", num(s.cost)),
                    ("writeUsd", num(s.w)),
                    ("readUsd", num(s.r)),
                    ("outputUsd", num(s.o)),
                    ("turns", num(s.turns)),
                    ("maxPrefixTokens", num(s.max_prefix)),
                    ("eventExcessUsd", num(ee)),
                ]),
            )
        })
        .collect();
    // Ranked by ACCUMULATED EVENT EXCESS — "who drove the anomalies" — with total $ as the tiebreak;
    // a big spender at steady baseline is background, not a culprit.
    sessions.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal))
    });
    let sessions: Vec<Value> = sessions.into_iter().take(top_sessions).map(|s| s.2).collect();

    let mut spawns_in_mainshock: Vec<Value> = Vec::new();
    if let Some(m) = mainshock.as_ref() {
        let to_list = crate::burn::causing_tool_call::SPAWN_TOOLS
            .iter()
            .map(|t| sq(t))
            .collect::<Vec<_>>()
            .join(", ");
        // The window filter MUST compare CAST timestamps: the raw column is ISO-T ('…T11:27:00Z')
        // while the bucket bounds are naive ('… 11:27:00'), and a VARCHAR compare of the two formats
        // breaks at char 11 ('T' > ' '), silently passing EVERY line of the day.
        let sql = format!(
            "\n        WITH lines AS (\n          SELECT CAST(timestamp AS TIMESTAMP) AS ts, filename, message FROM {read_json}\n          WHERE type='assistant'\n            AND CAST(timestamp AS TIMESTAMP) >= TIMESTAMP {}\n            AND CAST(timestamp AS TIMESTAMP) < TIMESTAMP {} + {bk}\n        ),\n        blocks AS (SELECT ts, filename, UNNEST(json_extract(message,'$.content[*]')) AS block FROM lines)\n        SELECT CAST(ts AS VARCHAR) AS ts, json_extract_string(block,'$.name') AS tool,\n               json_extract_string(block,'$.input.subagent_type') AS subagent_type,\n               json_extract_string(block,'$.input.model') AS model,\n               CAST(json_extract(block,'$.input') AS VARCHAR) AS input, filename\n        FROM blocks WHERE json_extract_string(block,'$.type')='tool_use'\n          AND json_extract_string(block,'$.name') IN ({to_list}) ORDER BY ts;",
            sq(s(m.get("fromIso"))),
            sq(s(m.get("toIso")))
        );
        if let Ok(rows) = query(&sql) {
            spawns_in_mainshock = rows
                .iter()
                .enumerate()
                .map(|(i, r)| {
                    let nullable = |k: &str| match r.get(k) {
                        Some(Value::Null) | None => Value::Null,
                        Some(v) => Value::String(str_of(Some(v))),
                    };
                    obj(vec![
                        ("n", num((i + 1) as f64)),
                        ("iso", Value::String(str_of(r.get("ts")))),
                        ("tool", Value::String(str_of(r.get("tool")))),
                        ("subagentType", nullable("subagent_type")),
                        ("model", nullable("model")),
                        ("input", Value::String(str_of(r.get("input")))),
                        ("sessionId", Value::String(basename_no_ext(&str_of(r.get("filename"))))),
                    ])
                })
                .collect();
        }
    }

    // Calibration honesty check: among BACKGROUND (non-flagged) buckets the share with combined
    // p < 0.05 should be ≤ 0.05 under a calibrated null. Poisson discreteness makes the rate test
    // conservative, so slightly BELOW is expected; far ABOVE means the null is mis-specified.
    let bg_idx: Vec<usize> = (0..grid.len()).filter(|i| !bh.rejected[*i]).collect();
    let observed_background_share = if bg_idx.len() >= 20 {
        num(bg_idx.iter().filter(|i| p_combined[**i] < 0.05).count() as f64 / bg_idx.len() as f64)
    } else {
        Value::Null
    };
    // π̂₀ and the shape check run on the ACTIVE background only: an inactive bucket carries p ≡ 1 by
    // construction (the hurdle), and a pile of exact 1s would fake both a perfect π̂₀ and a broken
    // uniformity ratio in every configuration.
    let bg_active_p: Vec<f64> =
        bg_idx.iter().filter(|i| active_mask[**i]).map(|i| p_combined[*i]).collect();
    let (pi0, upper_uniformity) = if bg_active_p.len() >= 20 {
        (num(ss::storey_pi0(&bg_active_p, 0.5)), num(ss::upper_tail_uniformity(&bg_active_p, 10)))
    } else {
        (Value::Null, Value::Null)
    };
    let null_attributable = match pi0.as_f64() {
        Some(p) => num(0.05 * p),
        None => Value::Null,
    };

    let total_write: f64 = grid.iter().map(|g| g.w).sum();
    let total_read: f64 = grid.iter().map(|g| g.r).sum();
    let total_output: f64 = grid.iter().map(|g| g.o).sum();
    let total_usd: f64 = cost.iter().sum();
    let dominant = mode_of(total_write, total_read, total_usd);
    let rp = if total_usd > 0.0 { js_math_round((100.0 * total_read) / total_usd) } else { 0.0 };
    let wp = if total_usd > 0.0 { js_math_round((100.0 * total_write) / total_usd) } else { 0.0 };
    let fat_count = sessions
        .iter()
        .filter(|s| s.get("maxPrefixTokens").and_then(Value::as_f64).unwrap_or(0.0) >= 300_000.0)
        .count();
    let cause_is = |e: &Value, c: &str| e.get("cause").and_then(Value::as_str) == Some(c);
    let fanout_events = events.iter().filter(|e| cause_is(e, "FANOUT_RATE")).count();
    let thrash_events = events.iter().filter(|e| cause_is(e, "FAT_TURN_THRASH")).count();
    let cause_tail = format!(
        "{thrash_events} thrash spike(s), {fanout_events} fan-out burst(s) among {} event(s).",
        events.len()
    );
    let verdict = match dominant {
        "MARATHON_REREAD" => format!(
            "MARATHON RE-READ dominates: {}% of $ is sustained cache-READ across {fat_count} fat (≥300k-prefix) sessions re-reading every turn; cold-WRITE adds {}%. {cause_tail}",
            fmt_js_num(rp),
            fmt_js_num(wp)
        ),
        "CACHE_THRASH" => format!(
            "CACHE_THRASH dominates: {}% of $ is cold cache-WRITE (prefix cold-invalidation); sustained re-read is {}%. {cause_tail}",
            fmt_js_num(wp),
            fmt_js_num(rp)
        ),
        _ => format!(
            "MIXED: cache-READ {}% (re-read) vs cold-WRITE {}% (thrash) are comparable. {cause_tail}",
            fmt_js_num(rp),
            fmt_js_num(wp)
        ),
    } + &(if torn_lines > 0.0 {
        format!(" {} line(s) unparseable and excluded.", fmt_js_num(torn_lines))
    } else {
        String::new()
    });

    let mut out = vec![
        ("windowSinceIso", Value::String(since_iso.clone())),
        ("bucketMinutes", num(bucket_minutes)),
        ("filesAnalysed", num(files.len() as f64)),
        ("totalUsd", num(total_usd)),
        ("totalWriteUsd", num(total_write)),
        ("totalReadUsd", num(total_read)),
        ("totalOutputUsd", num(total_output)),
        ("totalTurns", num(turns.iter().sum::<f64>())),
        ("bucketCount", num(grid.len() as f64)),
        ("baseline", baseline_value(&baseline)),
        ("poissonLambda", num(lambda)),
        ("intensityBaseline", baseline_value(&intensity_baseline)),
        ("rateLaw", Value::String(rate_law.to_owned())),
        ("dispersionIndex", num(dispersion_index)),
        ("fdrAlpha", num(fdr_alpha)),
        ("fdrMethod", Value::String(fdr_method.to_owned())),
        ("fdrThreshold", num(bh.threshold)),
        ("fdrSignificantCount", num(bh.n_rejected as f64)),
        (
            "calibration",
            obj(vec![
                ("alpha", num(0.05)),
                ("observedBackgroundShare", observed_background_share),
                ("pi0", pi0),
                ("nullAttributableShare", null_attributable),
                ("upperUniformity", upper_uniformity),
            ]),
        ),
        ("localBaseline", local_baseline),
        ("pvalueEngine", Value::String(pvalue_engine.to_owned())),
        ("dominantModeOverall", Value::String(dominant.to_owned())),
        ("verdict", Value::String(verdict)),
        ("changePoints", Value::Array(change_points)),
        ("peltChangepoints", Value::Array(pelt_changepoints)),
        ("events", Value::Array(events.iter().take(top_events).cloned().collect())),
    ];
    // `mainshock` is `events[0]`; when there is none the TS assigns `undefined`, which
    // `JSON.stringify` OMITS — so the KEY must be absent here, not null.
    if let Some(m) = mainshock {
        out.push(("mainshock", m));
    }
    out.push(("sessions", Value::Array(sessions)));
    out.push(("spawnsInMainshock", Value::Array(spawns_in_mainshock)));
    out.push(("buckets", Value::Array(buckets)));
    obj(out)
}
