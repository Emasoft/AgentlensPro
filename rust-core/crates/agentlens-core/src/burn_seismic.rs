//! Port of `src/burnSeismic.ts` SLICE A of 3 (TRDD-DMWOBWFH P4x.2q) — the arithmetic helpers and
//! the report RENDERER. SLICE B is `resolveSeismicFiles` + the DuckDB query, SLICE C the statistics
//! (CFAR / FDR / PELT).
//!
//! The renderer takes the result as a `Value` rather than a struct, deliberately: the analysis half
//! is not ported yet, so a struct here would be a second definition of a shape that does not exist
//! in Rust yet and would have to be reconciled later. Reading the fields the report actually prints
//! keeps the two slices independent.

use serde_json::Value;

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
