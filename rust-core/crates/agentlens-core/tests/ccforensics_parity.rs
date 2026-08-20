//! Cross-engine parity for the cache-creation SCAN half (TRDD-DMWOBWFH P4x.2d). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-ccforensics-expected.mjs
//!
//! MTIME ORACLE: the window filter and the recency ordering both read mtimes, and git does not
//! preserve them — the generator stamps a fixed table and publishes it; this test re-stamps from it.
//!
//! Every absolute path in the oracle is REDACTED to `<BODIES>` / `<MISSING>`, so this test applies
//! the same substitution to the Rust output before comparing. A fixture carrying a real path would
//! both fail `check-identities` and pin one machine's layout into the suite.

use std::path::PathBuf;

use agentlens_core::cache_creation_forensics::{
    bounded_recent, list_by_suffix, read_json_bounded, scan_cache_creation_events, DirEntry, ScanOptions,
};
use serde_json::{Map, Value};

fn fixtures() -> PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn oracle() -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join("ccforensics-expected.json")).unwrap()).unwrap()
}

fn bodies() -> PathBuf {
    fixtures().join("forensics-bodies")
}

fn missing_dir() -> PathBuf {
    fixtures().join("no-such-forensics-dir")
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract `assert_eq!` cannot see (`preserve_order` makes `Value::Object` an
/// IndexMap whose `PartialEq` ignores order). It is load-bearing here because FIVE event fields are
/// optional — `model`, `responseId`, `requestRef`, `sessionId`, `accountUuid` — and a `?? null` port
/// would emit five keys the TS never does, in the right places, with the right values.
fn same(got: &Value, exp: &Value, label: &str) {
    assert_eq!(keys(got), keys(exp), "{label}: key set/ORDER differs\n  got={got}\n  exp={exp}");
    match exp {
        Value::Object(o) => {
            for (k, ev) in o {
                same(&got[k], ev, &format!("{label}.{k}"));
            }
        }
        Value::Array(ea) => {
            let ga = got.as_array().cloned().unwrap_or_default();
            assert_eq!(ga.len(), ea.len(), "{label}: length\n  got={got}");
            for (i, (g, e)) in ga.iter().zip(ea).enumerate() {
                same(g, e, &format!("{label}[{i}]"));
            }
        }
        _ => assert_eq!(got, exp, "{label}"),
    }
}

/// Apply the generator's own redaction to the Rust side so the two are comparable.
fn strip(v: &Value) -> Value {
    let s = v.to_string().replace(&bodies().to_string_lossy().into_owned(), "<BODIES>").replace(
        &missing_dir().to_string_lossy().into_owned(),
        "<MISSING>",
    );
    serde_json::from_str(&s).unwrap()
}

fn repin(o: &Value) {
    let dir = bodies();
    for (name, ms) in o["mtimes"].as_object().unwrap() {
        let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(ms.as_f64().unwrap() as u64);
        let f = std::fs::OpenOptions::new().append(true).open(dir.join(name)).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
    }
}

fn rel(entries: &[DirEntry]) -> Value {
    Value::Array(
        entries
            .iter()
            .map(|e| {
                let mut m = Map::new();
                m.insert("name".into(), Value::String(e.name.clone()));
                m.insert("mtimeMs".into(), Value::from(e.mtime_ms as i64));
                Value::Object(m)
            })
            .collect(),
    )
}

fn bounded_value(entries: &[DirEntry], window_hours: Option<f64>, cap: usize, now: f64) -> Value {
    let (slice, matched) = bounded_recent(entries, window_hours, cap, now);
    let mut m = Map::new();
    m.insert("slice".into(), rel(&slice));
    m.insert("matched".into(), Value::from(matched as i64));
    Value::Object(m)
}

fn scan_value(o: &Value, opts: &ScanOptions, dir: &std::path::Path) -> Value {
    let (events, coverage) = scan_cache_creation_events(dir, opts, o["nowMs"].as_f64().unwrap());
    let mut m = Map::new();
    m.insert("events".into(), Value::Array(events.iter().map(|e| e.to_value()).collect()));
    m.insert("coverage".into(), coverage.to_value());
    strip(&Value::Object(m))
}

#[test]
fn list_by_suffix_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    repin(&o);
    // The oracle stores `slice` order for boundedRecent but the raw list is order-independent here
    // (the Rust walk is sorted, Node's is not) — so compare as SETS keyed by name.
    let cmp = |got: &[DirEntry], exp: &Value, label: &str| {
        let mut g = rel(got).as_array().unwrap().clone();
        let mut e = exp.as_array().unwrap().clone();
        let key = |v: &Value| v["name"].as_str().unwrap_or("").to_owned();
        g.sort_by_key(key);
        e.sort_by_key(key);
        same(&Value::Array(g), &Value::Array(e), label);
    };
    cmp(&list_by_suffix(&bodies(), ".response.json"), &o["listResponses"], "listResponses");
    cmp(&list_by_suffix(&bodies(), ".request.json"), &o["listRequests"], "listRequests");
    assert!(list_by_suffix(&missing_dir(), ".response.json").is_empty(), "a missing dir is empty, not fatal");
}

#[test]
fn bounded_recent_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    repin(&o);
    let now = o["nowMs"].as_f64().unwrap();
    let responses = list_by_suffix(&bodies(), ".response.json");
    same(&bounded_value(&responses, None, 100, now), &o["boundedAll"], "boundedAll");
    same(&bounded_value(&responses, None, 3, now), &o["boundedCapped"], "boundedCapped");
    same(&bounded_value(&responses, Some(6.0), 100, now), &o["boundedWindowed"], "boundedWindowed");
    same(&bounded_value(&responses, Some(0.0), 100, now), &o["boundedZeroWindow"], "boundedZeroWindow");
}

/// Every failure mode of `readJsonBounded` is the SAME `null`: missing, oversized, unparseable. To a
/// bounded scan they ARE the same outcome — this file contributes nothing and the scan continues —
/// and distinguishing them would only invite a caller to branch on a difference that carries no
/// information.
#[test]
fn read_json_bounded_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let ok = read_json_bounded(&bodies().join("s2.response.json"), 1_000_000).unwrap();
    same(&ok, &o["readOk"], "readOk");
    assert!(read_json_bounded(&bodies().join("s2.response.json"), 10).is_none(), "over maxBytes");
    assert!(read_json_bounded(&bodies().join("s7.response.json"), 1_000_000).is_none(), "malformed JSON");
    assert!(read_json_bounded(&bodies().join("does-not-exist.json"), 1_000_000).is_none(), "absent");
    for k in ["readTooBig", "readMalformed", "readMissing"] {
        assert!(o[k].is_null(), "{k} is null in the TS too");
    }
}

#[test]
fn scan_cache_creation_events_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    repin(&o);
    let d = bodies();
    let cases: [(&str, ScanOptions); 5] = [
        ("scanDefault", ScanOptions::default()),
        ("scanWithZeros", ScanOptions { include_zero_cache_create: true, ..ScanOptions::default() }),
        ("scanWindowed", ScanOptions { window_hours: Some(6.0), ..ScanOptions::default() }),
        ("scanCapped", ScanOptions { scan_cap: Some(2), ..ScanOptions::default() }),
        ("scanCappedWithZeros", ScanOptions { scan_cap: Some(2), include_zero_cache_create: true, ..ScanOptions::default() }),
    ];
    for (case, opts) in cases {
        same(&scan_value(&o, &opts, &d), &o[case], case);
    }
    same(&scan_value(&o, &ScanOptions::default(), &missing_dir()), &o["scanMissingDir"], "scanMissingDir");
}

/// The REQUEST's model wins over the response's. s1's request says claude-opus-5 while its response
/// says claude-opus-4-8 — the request is what was actually billed, and a response can carry a
/// resolved alias the pricing table does not know. It is the only fixture that can tell the two
/// precedence orders apart, and the two models have DIFFERENT rates so the cost moves with it.
#[test]
fn the_requests_model_wins_over_the_responses() {
    let o = oracle();
    repin(&o);
    let (events, _) = scan_cache_creation_events(&bodies(), &ScanOptions::default(), o["nowMs"].as_f64().unwrap());
    let s1 = events.iter().find(|e| e.response_id.as_deref() == Some("msg_resp0001")).unwrap();
    assert_eq!(s1.model.as_deref(), Some("claude-opus-5"), "not the response's claude-opus-4-8");
    assert!(s1.cost_usd > 0.0);
    // s3 has NO top-level model, so the third fallback (`message.model`) is the only route to one.
    let s3 = events.iter().find(|e| e.response_id.as_deref() == Some("msg_resp0003")).unwrap();
    assert_eq!(s3.model.as_deref(), Some("claude-sonnet-5"));
}

/// An UNKNOWN model is priced at ZERO, never at a guessed rate — and the `model` key is DROPPED
/// entirely rather than emitted as null, so a consumer can tell "unpriced" from "free".
#[test]
fn a_modelless_response_is_unpriced_and_drops_the_key() {
    let o = oracle();
    repin(&o);
    let (events, _) = scan_cache_creation_events(&bodies(), &ScanOptions::default(), o["nowMs"].as_f64().unwrap());
    let s4 = events.iter().find(|e| e.response_id.as_deref() == Some("msg_resp0004")).unwrap();
    assert_eq!(s4.model, None);
    assert_eq!(s4.cost_usd, 0.0);
    assert!(s4.cache_create_tokens > 0.0, "it DID write cache — the tokens are known, the price is not");
    let v = s4.to_value();
    assert!(!keys(&v).contains(&"model"), "{v}");
}

/// ATTRIBUTION and IDENTITY are separate facts. s5's request (q3) carries a `user_id` that is not
/// valid JSON: the join still succeeded, so `attributed` is true and `requestRef` points at the
/// file, while `sessionId`/`accountUuid` are DROPPED. Collapsing the two would either lose a real
/// link or invent a session id from an unparseable field.
#[test]
fn a_link_with_an_unparseable_user_id_is_attributed_without_an_identity() {
    let o = oracle();
    repin(&o);
    let opts = ScanOptions { include_zero_cache_create: true, ..ScanOptions::default() };
    let (events, _) = scan_cache_creation_events(&bodies(), &opts, o["nowMs"].as_f64().unwrap());
    let s5 = events.iter().find(|e| e.response_id.as_deref() == Some("msg_resp0005")).unwrap();
    assert!(s5.attributed, "the previous_message_id join DID match");
    assert!(s5.request_ref.is_some());
    assert_eq!(s5.session_id, None, "…but the user_id was not JSON");
    assert_eq!(s5.account_uuid, None);
    let v = s5.to_value();
    assert!(!keys(&v).contains(&"sessionId") && !keys(&v).contains(&"accountUuid"), "{v}");
}

/// A ZERO cache_creation is EXCLUDED by default and INCLUDED under `includeZeroCacheCreate` — the
/// per-call event log needs the warm turns, because a ledger that hides them cannot show that the
/// turn before a cold write was warm, which is exactly the comparison that tells a TTL expiry apart
/// from a prefix break. A response with NO `usage` at all is excluded under BOTH.
#[test]
fn zero_cache_creation_is_opt_in_but_a_usageless_response_is_never_included() {
    let o = oracle();
    repin(&o);
    let now = o["nowMs"].as_f64().unwrap();
    let (def, _) = scan_cache_creation_events(&bodies(), &ScanOptions::default(), now);
    let with = scan_cache_creation_events(&bodies(), &ScanOptions { include_zero_cache_create: true, ..ScanOptions::default() }, now).0;
    let has = |v: &[agentlens_core::cache_creation_forensics::CacheCreationEvent], id: &str| {
        v.iter().any(|e| e.response_id.as_deref() == Some(id))
    };
    assert!(!has(&def, "msg_resp0005") && has(&with, "msg_resp0005"), "the zero-write turn is opt-in");
    assert!(!has(&def, "msg_resp0006") && !has(&with, "msg_resp0006"), "no usage object ⇒ never an event");
    assert_eq!(with.len(), def.len() + 1, "exactly one extra event, not a different scan");
}

/// The two coverage branches say DIFFERENT things and both are load-bearing: a capped scan reports
/// `complete:false` with a SAMPLE note naming what it did not read, while a MISSING directory
/// reports `complete:true` — there was nothing to sample, so calling it incomplete would send the
/// caller retrying for coverage that cannot exist.
#[test]
fn a_capped_scan_is_a_sample_but_a_missing_dir_is_complete() {
    let o = oracle();
    repin(&o);
    let now = o["nowMs"].as_f64().unwrap();
    let (_, capped) = scan_cache_creation_events(&bodies(), &ScanOptions { scan_cap: Some(2), ..ScanOptions::default() }, now);
    assert!(!capped.complete);
    assert!(capped.note.starts_with("SAMPLE: 2 most-recent of 8"), "{}", capped.note);
    assert_eq!(capped.response_files_total, 8, "the total on disk is still reported honestly");

    let (_, missing) = scan_cache_creation_events(&missing_dir(), &ScanOptions::default(), now);
    assert!(missing.complete, "nothing to sample is not a partial view");
    assert!(!missing.dir_exists);
    assert!(missing.note.contains("OTEL_LOG_RAW_API_BODIES"), "it names the remedy: {}", missing.note);
}

/// The request index is capped by the CONSTANT `REQUEST_INDEX_CAP`, not by `scan_cap` — a caller
/// lowering the response cap must not shrink the index the join depends on, or the same responses
/// would come back unattributed just because fewer of them were asked for.
#[test]
fn lowering_the_response_cap_does_not_shrink_the_request_index() {
    let o = oracle();
    repin(&o);
    let now = o["nowMs"].as_f64().unwrap();
    let (_, full) = scan_cache_creation_events(&bodies(), &ScanOptions::default(), now);
    let (_, capped) = scan_cache_creation_events(&bodies(), &ScanOptions { scan_cap: Some(2), ..ScanOptions::default() }, now);
    assert_eq!(capped.request_files_indexed, full.request_files_indexed, "same index, fewer responses");
    assert_eq!(capped.response_files_scanned, 2);
}

/// A missing `cache_creation` sub-object means the tier split is 0/0, NOT unknown. The 5m/1h split
/// is what tells a TTL expiry apart from a real prefix break, so a response that carries no split
/// must read as "no split" — s2 is that case, s1 is the populated one.
#[test]
fn an_absent_tier_split_reads_as_zero_not_unknown() {
    let o = oracle();
    repin(&o);
    let (events, _) = scan_cache_creation_events(&bodies(), &ScanOptions::default(), o["nowMs"].as_f64().unwrap());
    let s2 = events.iter().find(|e| e.response_id.as_deref() == Some("msg_resp0002")).unwrap();
    assert_eq!((s2.cache_creation_5m_tokens, s2.cache_creation_1h_tokens), (0.0, 0.0));
    assert!(s2.cache_create_tokens > 0.0, "it wrote 9,000 tokens with no tier recorded");
    let s1 = events.iter().find(|e| e.response_id.as_deref() == Some("msg_resp0001")).unwrap();
    assert_eq!((s1.cache_creation_5m_tokens, s1.cache_creation_1h_tokens), (2000.0, 30000.0));
    // Both keys are ALWAYS present, so a consumer never has to distinguish absent from zero.
    for e in [s1, s2] {
        let v = e.to_value();
        assert!(keys(&v).contains(&"cacheCreation5mTokens") && keys(&v).contains(&"cacheCreation1hTokens"), "{v}");
    }
}
