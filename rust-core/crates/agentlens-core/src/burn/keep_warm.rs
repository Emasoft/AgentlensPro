//! Port of src/shared/keepWarm.ts (P6 + TRDD-VY1IUVUM) — the per-session cache keep-warm
//! measurement over `claude_code.api_request` timeline entries, classified against the
//! session's TtlRegime, with THE MEASURED FALSIFIER: a cache hit AFTER the assumed expiry
//! contradicts the assumption, flips ttlSource to 'measured' and snaps the effective TTL to
//! the 1-hour tier (only two tiers exist), or to the observed gap itself past 1h.
//!
//! Honest absence: a timeline with NO parseable api_request entries returns None — never
//! zeros presented as measurements. The report is emitted as a `Value` mirroring the TS
//! object literal (the P4d design law: no typed-struct mirror of the wire shape).

use serde_json::{Map, Value};

use super::cache_ttl::{TtlRegime, TTL_1H_MS};
use crate::summarize::helpers;

/// Warm-hit signature for the falsifier: a big prefix READ with only a small (normal
/// incremental suffix) write. The 1k floor keeps trivial prefixes from "proving" anything;
/// the /4 share bound mirrors BodiesActivityTracker.sessionWarmSince so "warm" means the same
/// thing in the falsifier and in the cold-resume disarm.
pub fn is_warm_hit(cache_read: f64, cache_create: f64) -> bool {
    cache_read >= 1_000.0 && cache_create * 4.0 < cache_read
}

/// computeKeepWarm — measure a session's cache keep-warm behaviour from its timeline against
/// its TTL regime. None when the timeline carries no api_request entry with a parseable
/// timestamp. Classification per consecutive pair, against the EFFECTIVE TTL:
/// gap < TTL → warm; gap ≥ TTL with cacheCreate > cacheRead → cold (+wasted writes);
/// gap ≥ TTL without the re-write signature → NEITHER bucket (no observed penalty). The first
/// request follows no gap — the unavoidable session warm-up, excluded by construction.
pub fn compute_keep_warm(timeline: &[Value], regime: &TtlRegime) -> Option<Value> {
    // Only api_request entries carry the exact per-call timestamps + cache buckets this needs.
    // Unparseable timestamps are DROPPED, not defaulted — a fabricated ts would fabricate a gap.
    let mut requests: Vec<(f64, f64, f64)> = Vec::new();
    for e in timeline {
        if e.get("type").and_then(Value::as_str) != Some("api_request") {
            continue;
        }
        let ts_str = e.get("timestamp").and_then(Value::as_str).unwrap_or("");
        let Some(ts) = helpers::parse_iso_ms(ts_str) else { continue };
        let bucket = |k: &str| e.get(k).and_then(Value::as_f64).unwrap_or(0.0); // `?? 0`
        requests.push((ts, bucket("cacheReadTokens"), bucket("cacheCreateTokens")));
    }
    if requests.is_empty() {
        return None;
    }
    // Merged/reparsed sessions can interleave — sort so a spurious negative "gap" can never
    // mis-classify a turn (ts values are finite: the parse filter above dropped NaN).
    requests.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    // Falsifier pass BEFORE classification, so the contradiction corrects the buckets too.
    let mut measured_warm_gap_ms = 0.0f64;
    for i in 1..requests.len() {
        let gap = requests[i].0 - requests[i - 1].0;
        if gap >= regime.ttl_ms && is_warm_hit(requests[i].1, requests[i].2) && gap > measured_warm_gap_ms {
            measured_warm_gap_ms = gap;
        }
    }
    let contradicted = measured_warm_gap_ms > 0.0;
    // Survival past the assumed tier proves the 1-hour tier (only two tiers exist); a >1h
    // survival is off-matrix — classify against the observation itself.
    let effective_ttl_ms = if contradicted { TTL_1H_MS.max(measured_warm_gap_ms + 1.0) } else { regime.ttl_ms };

    let mut warm_turns = 0.0f64;
    let mut cold_turns = 0.0f64;
    let mut wasted_write_tokens = 0.0f64;
    let mut worst_gap_ms = 0.0f64;
    for i in 1..requests.len() {
        let gap = requests[i].0 - requests[i - 1].0;
        if gap > worst_gap_ms {
            worst_gap_ms = gap;
        }
        if gap < effective_ttl_ms {
            warm_turns += 1.0;
        } else if requests[i].2 > requests[i].1 {
            // The TTL expired AND this call re-wrote more prefix than it read — the cold signature.
            cold_turns += 1.0;
            wasted_write_tokens += requests[i].2;
        }
    }
    // `Math.round(ms / 60_000 * 10) / 10` — JS half-up equals f64::round for non-negative gaps.
    let to_min = |ms: f64| (ms / 60_000.0 * 10.0).round() / 10.0;
    let effective_min = (effective_ttl_ms / 60_000.0).round();
    let mut m = Map::new();
    m.insert("warmTurns".into(), helpers::num(warm_turns));
    m.insert("coldTurns".into(), helpers::num(cold_turns));
    m.insert("wastedWriteTokens".into(), helpers::num(wasted_write_tokens));
    m.insert("worstGapMin".into(), helpers::num(to_min(worst_gap_ms)));
    m.insert("ttlAssumedMin".into(), helpers::num(effective_min));
    m.insert("ttlSource".into(), if contradicted { "measured".into() } else { regime.ttl_source.into() });
    m.insert("ttlContradicted".into(), Value::Bool(contradicted));
    m.insert("measuredWarmGapMin".into(), if contradicted { helpers::num(to_min(measured_warm_gap_ms)) } else { Value::Null });
    m.insert(
        "ttlBasis".into(),
        if contradicted {
            format!(
                "assumed {}-min TTL ({}) CONTRADICTED: a cache hit landed {}min after the last call — the entry survived, so the measured floor ({}min tier) was preferred",
                helpers::fmt_js_num(regime.ttl_assumed_min),
                regime.ttl_source,
                helpers::fmt_js_num(to_min(measured_warm_gap_ms)),
                helpers::fmt_js_num(effective_min)
            )
            .into()
        } else {
            regime.ttl_basis.clone().into()
        },
    );
    Some(Value::Object(m))
}
