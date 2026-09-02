//! Port of src/burnInvestigator.ts SLICE 2 (TRDD-DMWOBWFH P4x.2f): the DETECTORS and the final
//! assembly, built on slice 1's `investigator_scan::ScanOutcome`. Together they are
//! `investigateBurn` — the one-command window-burn investigation behind `investigate_burn` and
//! `burn_seismic`.
//!
//! KEY ORDER IS NOT UNIFORM ACROSS FINDINGS AND THAT IS THE WIRE CONTRACT. The storm/boot/rewrite
//! findings are built by SPREADING a `base` object, so their keys run
//! `equivTokens, shareOfWindow, evidence, cause, confidence, verdict`; every other detector writes
//! its literal in the natural order `cause, equivTokens, shareOfWindow, confidence, verdict,
//! evidence`. A port that normalized them would be equal field-by-field and wrong on the wire.
//!
//! Honesty invariants carried over from the TS: every finding states its evidence numbers and a
//! confidence, and whatever the detectors cannot claim stays in the explicit unattributed
//! remainder that the verdict names out loud.

use serde_json::{json, Value};

use super::investigator_scan::{
    equiv_of, fmt_k, scan_window, InvestigateOptions, ReqRec, RespRec, ScanOutcome, CLUSTER_MS, SPIKE_CC,
};
use crate::pricing::calc_token_cost_usd;
use crate::summarize::helpers::{iso_from_ms, js_math_round, js_to_fixed_num, js_to_fixed_str, num};

pub const BURN_CAUSES: &[&str] = &[
    "FORK_STORM",
    "SUBAGENT_BOOT_TAX",
    "PREMIUM_MODEL_FANOUT",
    "FAT_SESSION_REWRITES",
    "IDLE_FLEET_KEEPWARM",
    "IMAGE_BLOB_RESIDENT",
    "RATE_LIMIT_COLD_RESUME",
];

fn mins(ms: f64) -> String {
    format!("{}min", js_math_round(ms / 60_000.0).max(1.0))
}

/// `(x * 100).toFixed(0)` — JS rounds half toward +Infinity, which `js_to_fixed_str` reproduces.
fn pct0(x: f64) -> String {
    js_to_fixed_str(x * 100.0, 0)
}

// ── detectors ─────────────────────────────────────────────────────────────────

struct Cluster {
    spikes: Vec<RespRec>,
    from_ts: f64,
    to_ts: f64,
    cc: f64,
    cold_spikes: f64,
}

/// Spikes within CLUSTER_MS belong to one event (a fan-out wave). `resps` is ts-ascending, which
/// is what makes the single backward look at the last cluster sufficient.
fn cluster_spikes(resps: &[RespRec]) -> Vec<Cluster> {
    let mut clusters: Vec<Cluster> = Vec::new();
    for s in resps.iter().filter(|r| r.cc > SPIKE_CC) {
        let cold = s.cr < s.cc * 0.1;
        match clusters.last_mut() {
            Some(last) if s.ts - last.to_ts <= CLUSTER_MS => {
                last.spikes.push(s.clone());
                last.to_ts = s.ts;
                last.cc += s.cc;
                if cold {
                    last.cold_spikes += 1.0;
                }
            }
            _ => clusters.push(Cluster {
                spikes: vec![s.clone()],
                from_ts: s.ts,
                to_ts: s.ts,
                cc: s.cc,
                cold_spikes: if cold { 1.0 } else { 0.0 },
            }),
        }
    }
    clusters
}

fn reqs_in(reqs: &[ReqRec], from_ts: f64, to_ts: f64, pad_ms: f64) -> Vec<&ReqRec> {
    reqs.iter().filter(|r| r.ts >= from_ts - pad_ms && r.ts <= to_ts + pad_ms).collect()
}

fn detect_storms_and_rewrites(
    resps: &[RespRec],
    reqs: &[ReqRec],
    total_equiv: f64,
    stop_failures: &[f64],
) -> Vec<Value> {
    let mut findings = Vec::new();
    for c in cluster_spikes(resps) {
        // The cluster's write cost — cache READS are deliberately excluded here (a rewrite's bill
        // IS its writes), which is why this equiv differs from the window's.
        let equiv = equiv_of(c.cc, 0.0);
        if equiv < total_equiv * 0.02 && c.cc < 1_000_000.0 {
            continue; // below reporting floor
        }
        // ≥~2 bytes/token of a spike: a request too small to have carried a full prefix cannot be
        // the one that wrote it.
        let nearby: Vec<&ReqRec> =
            reqs_in(reqs, c.from_ts, c.to_ts, 60_000.0).into_iter().filter(|r| r.size > SPIKE_CC * 2.0).collect();
        // Insertion-ordered tally: `fams.size` and `biggestFam` are both read below. Each family
        // also carries the DISTINCT session ids seen in it — the FORK_STORM vs
        // FAT_SESSION_REWRITES discriminator (TRDD-YBJGIYI1): sharing a fingerprint only proves a
        // shared transcript, not who wrote it. `>=2` distinct sessions means real siblings each
        // cold-wrote the inherited prefix; exactly 1 (or none extractable) means one session paid
        // the same write repeatedly, which is a fat session, not a fan-out.
        let mut fams: Vec<(String, f64, std::collections::HashSet<&str>)> = Vec::new();
        for r in &nearby {
            match fams.iter_mut().find(|(f, _, _)| *f == r.fingerprint) {
                Some((_, n, sids)) => {
                    *n += 1.0;
                    if let Some(sid) = r.session_id.as_deref() {
                        sids.insert(sid);
                    }
                }
                None => {
                    let mut sids = std::collections::HashSet::new();
                    if let Some(sid) = r.session_id.as_deref() {
                        sids.insert(sid);
                    }
                    fams.push((r.fingerprint.clone(), 1.0, sids));
                }
            }
        }
        let biggest_fam = fams.iter().map(|(_, n, _)| *n).fold(0.0f64, f64::max);
        // Sessions in the biggest family (ties: the widest span — the strongest storm evidence).
        let biggest_fam_sessions =
            fams.iter().filter(|(_, n, _)| *n == biggest_fam).map(|(_, _, s)| s.len()).max().unwrap_or(0);
        let mut wss: Vec<&str> = Vec::new();
        for r in &nearby {
            if !r.workspace.is_empty() && !wss.contains(&r.workspace.as_str()) {
                wss.push(&r.workspace);
            }
        }
        let post_stall = stop_failures.iter().any(|t| c.from_ts - t >= 0.0 && c.from_ts - t <= 15.0 * 60_000.0);
        let largest = c.spikes.iter().map(|s| s.cc).fold(f64::NEG_INFINITY, f64::max);
        let share = if total_equiv > 0.0 { equiv / total_equiv } else { 0.0 };
        let evidence = json!({
            "window": format!("{} → {}", iso_from_ms(c.from_ts), iso_from_ms(c.to_ts)),
            // Machine-readable anchor for attach_causing_calls: the burst START and END, so the
            // causing-call scan covers the WHOLE sustained burst (a fan-out is many spawns over
            // time, not one).
            "peakStartMs": num(c.from_ts),
            "peakEndMs": num(c.to_ts),
            "fullPrefixWrites": num(c.spikes.len() as f64),
            "coldWrites": num(c.cold_spikes),
            "cacheCreationTokens": num(c.cc),
            "largestWriteTokens": num(largest),
            "sharedTranscriptRequests": num(biggest_fam),
            "distinctFingerprints": num(fams.len() as f64),
            "workspaces": wss.iter().take(5).collect::<Vec<_>>(),
            "postRateLimitStall": post_stall,
        });
        let n_spikes = c.spikes.len() as f64;

        // TRDD-YBJGIYI1: sharing a fingerprint only proves a shared transcript, not who wrote it —
        // a SESSION shares a fingerprint with its own earlier self just as readily as N forked
        // siblings do. `>=2` distinct session ids in the biggest family is the only thing that
        // tells "many agents forked one parent" apart from "one fat session rewrote its own
        // prefix repeatedly"; `biggest_fam_sessions == 0` (extraction failed on the body shape) is
        // treated the same as `== 1` — the honest fallback, never the flattering label.
        if n_spikes >= 3.0 && biggest_fam >= 3.0 && c.cold_spikes >= 2.0 && biggest_fam_sessions >= 2 {
            // Many simultaneous full writes of the SAME inherited transcript = a fork storm. CC
            // ≥2.1.229 staggers WORKFLOW same-prefix siblings, so on a current harness this points
            // at un-staggered spawns — parallel Agent-tool forks in one message, the stagger
            // disabled, or an older CC. The classification keys on OBSERVED writes either way, so
            // the harness change can only make storms rarer, never make this verdict wrong.
            findings.push(json!({
                "equivTokens": num(js_math_round(equiv)),
                "shareOfWindow": num(share),
                "evidence": evidence,
                "cause": "FORK_STORM",
                "confidence": "high",
                "verdict": format!(
                    "{} full-prefix cache writes ({} fully cold, largest {}) in {} — {} requests share ONE inherited transcript: a fan-out forked a fat parent into a cold cache{}.",
                    n_spikes, c.cold_spikes, fmt_k(largest), mins(c.to_ts - c.from_ts), biggest_fam,
                    if post_stall { ", right after a rate-limit stall (TTL-expired cache)" } else { "" }
                ),
            }));
            if post_stall {
                findings.push(json!({
                    "cause": "RATE_LIMIT_COLD_RESUME",
                    "equivTokens": num(js_math_round(equiv)),
                    "shareOfWindow": num(share),
                    "confidence": "high",
                    "verdict": format!(
                        "The fork storm at {} began ≤15min after a StopFailure (rate-limit turn death): the stall outlived the 5-min cache TTL, so every fork rebuilt the parent prefix from scratch. Do not resume fan-outs into a cold window.",
                        iso_from_ms(c.from_ts)
                    ),
                    "evidence": {
                        "clusterStart": iso_from_ms(c.from_ts),
                        // `.map(iso).slice(-5)` — the LAST five, not the first.
                        "stopFailures": stop_failures.iter().skip(stop_failures.len().saturating_sub(5))
                            .map(|t| Value::String(iso_from_ms(*t))).collect::<Vec<_>>(),
                    },
                }));
            }
        } else if n_spikes >= 3.0 && fams.len() >= 3 && biggest_fam <= 2.0 {
            findings.push(json!({
                "equivTokens": num(js_math_round(equiv)),
                "shareOfWindow": num(share),
                "evidence": evidence,
                "cause": "SUBAGENT_BOOT_TAX",
                "confidence": "medium",
                "verdict": format!(
                    "{} distinct agents each paid a {} boot write in {} ({} distinct transcripts) — a fresh-agent fan-out; every agent re-pays the CLAUDE.md/rules + tool-schema base.",
                    n_spikes, fmt_k(js_math_round(c.cc / n_spikes)), mins(c.to_ts - c.from_ts), fams.len()
                ),
            }));
        } else {
            findings.push(json!({
                "equivTokens": num(js_math_round(equiv)),
                "shareOfWindow": num(share),
                "evidence": evidence,
                "cause": "FAT_SESSION_REWRITES",
                "confidence": if n_spikes >= 2.0 { "medium" } else { "low" },
                "verdict": format!(
                    "{} full-prefix rewrite(s) totalling {} cache-write tokens around {}{} — a large session re-writing its whole prefix (compaction, model switch, or a >5-min idle gap).",
                    n_spikes, fmt_k(c.cc), iso_from_ms(c.from_ts),
                    if wss.is_empty() { String::new() } else { format!(" in {}", wss[0]) }
                ),
            }));
        }
    }
    findings
}

/// A burst of subagent-shaped calls on a model that prices above the rest of the window's traffic.
fn detect_premium_fanout(resps: &[RespRec], reqs: &[ReqRec], total_equiv: f64, now_ms: f64) -> Vec<Value> {
    let mut by_model: Vec<(String, Vec<&RespRec>)> = Vec::new();
    for r in resps {
        match by_model.iter_mut().find(|(m, _)| *m == r.model) {
            Some((_, v)) => v.push(r),
            None => by_model.push((r.model.clone(), vec![r])),
        }
    }
    let mut findings = Vec::new();
    for (model, calls) in &by_model {
        if calls.len() < 50 {
            continue;
        }
        let cc: f64 = calls.iter().map(|r| r.cc).sum();
        let cr: f64 = calls.iter().map(|r| r.cr).sum();
        let out_t: f64 = calls.iter().map(|r| r.out).sum();
        let equiv = equiv_of(cc, cr);
        if equiv < total_equiv * 0.15 {
            continue;
        }
        // Burst density: the largest count inside any 30-min span (calls are ts-ascending).
        let mut burst = 0i64;
        let mut j = 0usize;
        for i in 0..calls.len() {
            while calls[i].ts - calls[j].ts > 30.0 * 60_000.0 {
                j += 1;
            }
            burst = burst.max(i as i64 - j as i64 + 1);
        }
        if burst < 50 {
            continue;
        }
        let subagent_reqs: Vec<&ReqRec> =
            reqs_in(reqs, calls[0].ts, calls[calls.len() - 1].ts, 60_000.0)
                .into_iter()
                .filter(|r| r.model == *model)
                .collect();
        let no_ws = subagent_reqs.iter().filter(|r| r.workspace.is_empty()).count() as f64;
        if subagent_reqs.is_empty() || no_ws / (subagent_reqs.len() as f64) < 0.5 {
            continue;
        }
        let usd = calc_token_cost_usd(0.0, cr, cc, out_t, model, 0.0, None, now_ms);
        findings.push(json!({
            "cause": "PREMIUM_MODEL_FANOUT",
            "equivTokens": num(js_math_round(equiv)),
            "shareOfWindow": num(if total_equiv > 0.0 { equiv / total_equiv } else { 0.0 }),
            "confidence": "high",
            "verdict": format!(
                "{} calls on {model} (peak {burst} in 30min), {}% subagent-shaped — a fan-out ran on this model (est ${}). If {model} became the DEFAULT recently, fresh fan-out agents inherited it; pin cheaper models for fan-out work.",
                calls.len(),
                js_math_round(100.0 * no_ws / subagent_reqs.len() as f64),
                js_to_fixed_str(usd, 2)
            ),
            "evidence": {
                "model": model, "calls": num(calls.len() as f64), "peak30min": num(burst as f64),
                "cacheCreationTokens": num(cc), "cacheReadTokens": num(cr), "outputTokens": num(out_t),
                "estCostUsd": num(js_to_fixed_num(usd, 2)),
            },
        }));
    }
    findings
}

/// Workspaces with long-span, low-write, periodic traffic = sessions kept warm while nobody works.
fn detect_idle_keepwarm(reqs: &[ReqRec], resps: &[RespRec], total_equiv: f64, home: &str) -> Vec<Value> {
    let mut by_ws: Vec<(String, Vec<f64>)> = Vec::new();
    for r in reqs.iter().filter(|r| !r.workspace.is_empty()) {
        match by_ws.iter_mut().find(|(w, _)| *w == r.workspace) {
            Some((_, v)) => v.push(r.ts),
            None => by_ws.push((r.workspace.clone(), vec![r.ts])),
        }
    }
    let mut idle: Vec<(String, usize, f64, f64)> = Vec::new(); // ws, n, span, medianGapS
    for (ws, ts) in by_ws.iter_mut() {
        if ts.len() < 12 {
            continue;
        }
        ts.sort_by(|a, b| a.total_cmp(b));
        let span = ts[ts.len() - 1] - ts[0];
        if span < 2.0 * 3_600_000.0 {
            continue;
        }
        let mut gaps: Vec<f64> = ts.windows(2).map(|w| w[1] - w[0]).collect();
        gaps.sort_by(|a, b| a.total_cmp(b));
        let median = gaps[gaps.len() / 2] / 1000.0;
        if !(60.0..=900.0).contains(&median) {
            continue; // periodic keep-warm cadence, not active work
        }
        idle.push((ws.clone(), ts.len(), span, js_math_round(median)));
    }
    if idle.is_empty() {
        return vec![];
    }
    // The keep-warm bill is cache_read-dominated; attribute the window's low-write read share.
    let low_write_cr: f64 = resps.iter().filter(|r| r.cc < 5_000.0).map(|r| r.cr).sum();
    let equiv = low_write_cr * 0.1 * (idle.len() as f64 / (by_ws.len() as f64).max(1.0)).min(1.0);
    vec![json!({
        "cause": "IDLE_FLEET_KEEPWARM",
        "equivTokens": num(js_math_round(equiv)),
        "shareOfWindow": num(if total_equiv > 0.0 { equiv / total_equiv } else { 0.0 }),
        "confidence": if idle.len() >= 3 { "high" } else { "medium" },
        "verdict": format!(
            "{} background session(s) show periodic keep-warm traffic over 2h+ (median gap {}s): {}. Each fire re-reads that session's full prefix. Disarm/close sessions you are not using.",
            idle.len(), idle[0].3,
            idle.iter().take(4).map(|i| i.0.replacen(home, "~", 1)).collect::<Vec<_>>().join(", ")
        ),
        "evidence": {
            "workspaces": idle.iter().map(|i| json!({
                "workspace": i.0, "requests": num(i.1 as f64),
                "spanHours": num(js_to_fixed_num(i.2 / 3_600_000.0, 1)), "medianGapS": num(i.3),
            })).collect::<Vec<_>>(),
            "lowWriteCacheReadTokens": num(low_write_cr),
        },
    })]
}

fn detect_image_residency(reqs: &[ReqRec], total_equiv: f64) -> Vec<Value> {
    let with_img: Vec<&ReqRec> = reqs.iter().filter(|r| r.image_bytes > 200_000.0).collect();
    if with_img.len() < 3 {
        return vec![];
    }
    let mut by_fam: Vec<(String, Vec<&ReqRec>)> = Vec::new();
    for r in &with_img {
        match by_fam.iter_mut().find(|(f, _)| *f == r.fingerprint) {
            Some((_, v)) => v.push(r),
            None => by_fam.push((r.fingerprint.clone(), vec![r])),
        }
    }
    let mut findings = Vec::new();
    for (_, rs) in &by_fam {
        if rs.len() < 3 {
            continue;
        }
        let total_img: f64 = rs.iter().map(|r| r.image_bytes).sum();
        let tok = js_math_round(total_img / 4.0);
        findings.push(json!({
            "cause": "IMAGE_BLOB_RESIDENT",
            // Resident blobs mostly ride as cache reads once written.
            "equivTokens": num(js_math_round(tok * 0.1)),
            "shareOfWindow": num(if total_equiv > 0.0 { (tok * 0.1) / total_equiv } else { 0.0 }),
            "confidence": "medium",
            "verdict": format!(
                "{} requests of one conversation carry ~{} tokens of base64 image data EACH ({} cumulative) — images pasted once ride forward every turn. Analyze images in a subagent or compact them away.",
                rs.len(), fmt_k(js_math_round(rs[0].image_bytes / 4.0)), fmt_k(tok)
            ),
            "evidence": {
                "requests": num(rs.len() as f64), "perRequestImageBytes": num(rs[0].image_bytes),
                "cumulativeImageTokens": num(tok),
            },
        }));
    }
    findings
}

// ── entry point ───────────────────────────────────────────────────────────────

/// investigateBurn — scan the corpus, detect the known burn patterns, rank them, and compose a
/// plain-language verdict WITH the numbers.
pub fn investigate_burn(opts: &InvestigateOptions, now_ms: f64) -> Value {
    let scan = scan_window(opts, now_ms);
    finish(scan, opts, now_ms)
}

/// The half that turns a completed scan into the full report. Split out so a caller that already
/// paid for a scan (burn_seismic) does not pay for it twice.
pub fn finish(scan: ScanOutcome, opts: &InvestigateOptions, now_ms: f64) -> Value {
    let ScanOutcome { resps, reqs, total_equiv, cc, cr, est_cost_usd, stop_failures, verdict_override, mut partial, .. } =
        scan;

    let mut findings = detect_storms_and_rewrites(&resps, &reqs, total_equiv, &stop_failures);
    findings.extend(detect_premium_fanout(&resps, &reqs, total_equiv, now_ms));
    findings.extend(detect_idle_keepwarm(&reqs, &resps, total_equiv, &opts.home));
    findings.extend(detect_image_residency(&reqs, total_equiv));
    // STABLE sort: ties keep the concatenation order above (storms, premium, idle, image), which is
    // the order the TS `.sort()` also preserves (spec-stable since ES2019).
    findings.sort_by(|a, b| b["equivTokens"].as_f64().unwrap().total_cmp(&a["equivTokens"].as_f64().unwrap()));

    let attributed_share: f64 = findings.iter().map(|f| f["shareOfWindow"].as_f64().unwrap()).sum();
    let top: Vec<&Value> = findings.iter().take(3).collect();
    let verdict = match verdict_override {
        // A blind scan and a response-less window are decided before any detector runs.
        Some(v) => v,
        None if top.is_empty() => format!(
            "No known burn pattern detected: {} input-equivalent tokens across {} calls look like ordinary traffic (largest single write {}).",
            fmt_k(js_math_round(total_equiv)),
            resps.len(),
            fmt_k(resps.iter().map(|r| r.cc).fold(0.0f64, f64::max))
        ),
        None => {
            let heads = top
                .iter()
                .enumerate()
                .map(|(i, f)| {
                    format!(
                        "{}. {} ({} equiv, {}%) — {}",
                        i + 1,
                        f["cause"].as_str().unwrap(),
                        fmt_k(f["equivTokens"].as_f64().unwrap()),
                        pct0(f["shareOfWindow"].as_f64().unwrap()),
                        f["verdict"].as_str().unwrap()
                    )
                })
                .collect::<Vec<_>>()
                .join(" ");
            format!(
                "Top culprit{}: {} Window total: {} input-equivalents ({} cache-write + {} cache-read), est ${}.{}",
                if top.len() > 1 { "s" } else { "" },
                heads,
                fmt_k(js_math_round(total_equiv)),
                fmt_k(cc),
                fmt_k(cr),
                js_to_fixed_str(est_cost_usd, 2),
                if attributed_share < 0.5 {
                    format!(
                        " NOTE: detectors attribute only {}% of the window — the remainder is unclassified ordinary traffic; drill with the other tools/SQL.",
                        pct0(attributed_share)
                    )
                } else {
                    String::new()
                }
            )
        }
    };

    let o = partial.as_object_mut().unwrap();
    o.insert("findings".into(), Value::Array(findings));
    o.insert("verdict".into(), Value::String(verdict));
    partial
}

/// attachCausingCalls — enrich each fan-out finding with the VERBATIM tool-call that spawned it,
/// the operator's actual question ("which call caused this?").
///
/// SEPARATE from `investigate_burn` on purpose: the transcript read is paid ONLY here, only for
/// real findings that anchor a workspace + a time, and never on a blind or empty scan. A finding
/// whose cause cannot be resolved records the honest reason — nothing is ever fabricated.
///
/// Mutates `inv` in place and appends the resolved calls to the top-line verdict so the digest
/// names them.
pub fn attach_causing_calls(inv: &mut Value, home: &str, projects_dirs: &[std::path::PathBuf]) {
    let mut appended: Option<String> = None;
    // Take the array OUT, mutate it, and put it BACK. Iterating a `mem::take`d temporary in place
    // would drop every mutation AND leave `inv["findings"]` empty — silently turning a report with
    // findings into one without any.
    let mut findings = inv["findings"].as_array_mut().map(std::mem::take).unwrap_or_default();
    for f in findings.iter_mut() {
        let at_ms = f["evidence"]["peakStartMs"].as_f64();
        let wss: Vec<String> = f["evidence"]["workspaces"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
            .unwrap_or_default();
        // Only fan-out findings anchor spawn calls (a workspace + a burst-start time). Keep-warm
        // and image-residency findings have no spawning call, so they carry none.
        let (Some(at_ms), Some(first)) = (at_ms, wss.first()) else { continue };
        // A `~`-abbreviated workspace has to be re-expanded: the transcript slug needs the
        // absolute path.
        let workspace =
            if let Some(rest) = first.strip_prefix('~') { format!("{home}{rest}") } else { first.clone() };
        // The WHOLE burst (fromTs → toTs), not just its start: a SUSTAINED burst is many spawns
        // over time, and reporting one nearest-timestamp call misattributes it.
        let to_ms = f["evidence"]["peakEndMs"].as_f64().unwrap_or(at_ms);
        let mid = js_math_round((at_ms + to_ms) / 2.0);
        let r = super::causing_tool_call::causing_tool_calls(&super::causing_tool_call::CausingCallsOptions {
            at_ms: mid,
            session_id: None,
            workspace: Some(&workspace),
            jsonl_path: None,
            window_ms: Some((15.0 * 60_000.0f64).max(to_ms - at_ms)),
            forward_slack_ms: None,
            tools: None,
            projects_dirs: projects_dirs.to_vec(),
        });
        let calls = r["calls"].as_array().cloned().unwrap_or_default();
        if calls.is_empty() {
            f["causingCallsUnavailable"] = r["reason"].clone();
        } else {
            let comp = super::causing_tool_call::composition(&calls);
            if appended.is_none() {
                appended = Some(format!(
                    " Causing calls ({}: {}): {}",
                    calls.len(),
                    comp,
                    calls
                        .iter()
                        .map(|c| format!(
                            "{}. {}{}{} @{}",
                            c["n"],
                            c["tool"].as_str().unwrap_or(""),
                            c["subagentType"].as_str().map(|s| format!("/{s}")).unwrap_or_default(),
                            c["model"].as_str().map(|s| format!("/{s}")).unwrap_or_default(),
                            c["iso"].as_str().unwrap_or("")
                        ))
                        .collect::<Vec<_>>()
                        .join("; ")
                ));
            }
            f["causingCalls"] = Value::Array(calls);
            f["causingCallsComposition"] = Value::String(comp);
        }
    }
    inv["findings"] = Value::Array(findings);
    if let Some(tail) = appended {
        let v = inv["verdict"].as_str().unwrap_or("").to_owned();
        inv["verdict"] = Value::String(v + &tail);
    }
}

#[cfg(test)]
mod fork_storm_discriminator_tests {
    //! TRDD-YBJGIYI1: FORK_STORM cannot be told from one fat session rewriting its own prefix
    //! unless the biggest fingerprint family is checked for distinct session ids, not just count.
    //! Mutation-verified: reverting the `biggest_fam_sessions >= 2` gate in
    //! `detect_storms_and_rewrites` makes case (b) below misclassify as FORK_STORM again.
    use super::*;

    fn synth(session_ids: &[Option<&str>]) -> (Vec<RespRec>, Vec<ReqRec>) {
        // 3 full-prefix spikes, 2 min apart (inside CLUSTER_MS), all fully cold (cr=0) — the
        // exact shape the FORK_STORM/FAT_SESSION_REWRITES branch splits on.
        let resps: Vec<RespRec> = (0..3)
            .map(|i| RespRec { ts: i as f64 * 120_000.0, model: "claude-opus-5".into(), cc: 300_000.0, cr: 0.0, out: 100.0, inp: 4.0 })
            .collect();
        // 3 requests > SPIKE_CC*2 bytes, ONE shared fingerprint (the "inherited transcript"),
        // each carrying the caller-supplied session id (or none, simulating extraction failure).
        let reqs: Vec<ReqRec> = session_ids
            .iter()
            .enumerate()
            .map(|(i, sid)| ReqRec {
                ts: i as f64 * 120_000.0,
                size: 250_000.0,
                model: "claude-opus-5".into(),
                workspace: String::new(),
                fingerprint: "FP-SHARED".into(),
                image_bytes: 0.0,
                session_id: sid.map(str::to_owned),
            })
            .collect();
        (resps, reqs)
    }

    fn cause_of(session_ids: &[Option<&str>]) -> String {
        let (resps, reqs) = synth(session_ids);
        let findings = detect_storms_and_rewrites(&resps, &reqs, 10_000_000.0, &[]);
        findings[0]["cause"].as_str().unwrap().to_owned()
    }

    #[test]
    fn two_distinct_sessions_sharing_a_fingerprint_is_a_real_fork_storm() {
        assert_eq!(cause_of(&[Some("sess-A"), Some("sess-A"), Some("sess-B")]), "FORK_STORM");
    }

    #[test]
    fn one_session_repeating_a_fingerprint_is_a_fat_session_not_a_storm() {
        assert_eq!(cause_of(&[Some("sess-A"), Some("sess-A"), Some("sess-A")]), "FAT_SESSION_REWRITES");
    }

    #[test]
    fn unextractable_session_ids_fall_to_the_honest_label_not_the_flattering_one() {
        assert_eq!(cause_of(&[None, None, None]), "FAT_SESSION_REWRITES");
    }
}
