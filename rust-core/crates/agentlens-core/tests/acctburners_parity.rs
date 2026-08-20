//! Cross-engine parity for `get_account_burners` (TRDD-DMWOBWFH P4x.2d). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-acctburners-expected.mjs

use agentlens_core::account_burners::{
    build_account_burners_report, events_for_account_in_window, fmt_tok, read_account_segments, resolve_target_account,
    resolve_window_capacity, resolve_window_until, segments_from_records, weighted, AccountBurnersOpts, AccountSegment,
    ResolvedAccount,
};
use agentlens_core::burn::monitor::ObservedAccountCapacity;
use indexmap::IndexMap;
use serde_json::{json, Map, Value};

fn fixtures() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn oracle() -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join("acctburners-expected.json")).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract `assert_eq!` cannot see (`preserve_order` makes `Value::Object` an
/// IndexMap whose `PartialEq` ignores order). It matters here because the row shapes come from a
/// REST SPREAD (`const { attr: _attr, ...row } = r`), which keeps every surviving key in its
/// declaration position — an appended field would compare equal by value and still be wrong.
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

fn opt_str(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned)
}

fn seg_from(v: &Value) -> AccountSegment {
    AccountSegment {
        account_id: v["accountId"].as_str().unwrap_or("").to_owned(),
        email: opt_str(v, "email"),
        plan: opt_str(v, "plan"),
        start_ms: v["startMs"].as_f64().unwrap_or(0.0),
        end_ms: v.get("endMs").and_then(Value::as_f64),
    }
}

fn seg_value(s: &AccountSegment) -> Value {
    let mut m = Map::new();
    m.insert("accountId".into(), Value::String(s.account_id.clone()));
    m.insert("email".into(), s.email.clone().map(Value::from).unwrap_or(Value::Null));
    m.insert("plan".into(), s.plan.clone().map(Value::from).unwrap_or(Value::Null));
    m.insert("startMs".into(), json!(s.start_ms as i64));
    m.insert("endMs".into(), s.end_ms.map(|e| json!(e as i64)).unwrap_or(Value::Null));
    Value::Object(m)
}

fn segs(v: &Value) -> Vec<AccountSegment> {
    v.as_array().map(|a| a.iter().map(seg_from).collect()).unwrap_or_default()
}

fn target_from(v: &Value) -> ResolvedAccount {
    ResolvedAccount {
        account_id: v["accountId"].as_str().unwrap_or("").to_owned(),
        email: opt_str(v, "email"),
        plan: opt_str(v, "plan"),
        segments: segs(&v["segments"]),
        last_active_ms: v["lastActiveMs"].as_f64().unwrap_or(0.0),
        is_current: v["isCurrent"].as_bool().unwrap_or(false),
    }
}

fn target_value(t: &ResolvedAccount) -> Value {
    let mut m = Map::new();
    m.insert("accountId".into(), Value::String(t.account_id.clone()));
    m.insert("email".into(), t.email.clone().map(Value::from).unwrap_or(Value::Null));
    m.insert("plan".into(), t.plan.clone().map(Value::from).unwrap_or(Value::Null));
    m.insert("segments".into(), Value::Array(t.segments.iter().map(seg_value).collect()));
    m.insert("lastActiveMs".into(), json!(t.last_active_ms as i64));
    m.insert("isCurrent".into(), Value::Bool(t.is_current));
    Value::Object(m)
}

fn observed_from(v: &Value) -> IndexMap<String, ObservedAccountCapacity> {
    let mut m = IndexMap::new();
    for (k, c) in v.as_object().map(|o| o.iter().collect::<Vec<_>>()).unwrap_or_default() {
        m.insert(
            k.clone(),
            ObservedAccountCapacity {
                window5h_tokens: c.get("window5hTokens").and_then(Value::as_f64),
                window7d_tokens: c.get("window7dTokens").and_then(Value::as_f64),
                window5h_cost_usd: c.get("window5hCostUsd").and_then(Value::as_f64),
                window7d_cost_usd: c.get("window7dCostUsd").and_then(Value::as_f64),
                observed_at: opt_str(c, "observedAt"),
            },
        );
    }
    m
}

const HOME: &str = "/h/user";

fn report(o: &Value, observed_key: &str, target_key: &str, all_segments: &Value, until_ms: f64, limit: f64) -> Value {
    let events = o["events"].as_array().cloned().unwrap_or_default();
    let cards = o["cards"].as_array().cloned().unwrap_or_default();
    let target = target_from(&o["targets"][target_key]);
    let observed = observed_from(&o[observed_key]);
    let all = segs(all_segments);
    build_account_burners_report(&AccountBurnersOpts {
        events: &events,
        target: &target,
        all_segments: &all,
        cards: &cards,
        until_ms,
        now_ms: o["nowMs"].as_f64().unwrap(),
        limit,
        observed: &observed,
        home: HOME,
    })
}

#[test]
fn segments_from_records_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, v) in o["segmentCases"].as_object().unwrap() {
        let records = v["records"].as_array().cloned().unwrap_or_default();
        let got = Value::Array(segments_from_records(&records).iter().map(seg_value).collect());
        same(&got, &v["out"], case);
    }
}

#[test]
fn read_account_segments_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let got = Value::Array(read_account_segments(&fixtures().join("acct-burners-timeline.ndjson")).iter().map(seg_value).collect());
    same(&got, &o["readSegments"], "readSegments");
    let missing = read_account_segments(&fixtures().join("does-not-exist.ndjson"));
    assert!(missing.is_empty(), "an absent file is an empty timeline, not a crash");
}

#[test]
fn resolve_target_account_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let segments = segs(&o["readSegments"]);
    let now = o["nowMs"].as_f64().unwrap();
    for (spec, exp) in o["targets"].as_object().unwrap() {
        let got = resolve_target_account(&segments, spec, now).as_ref().map_or(Value::Null, target_value);
        same(&got, exp, spec);
    }
}

#[test]
fn resolve_window_until_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let segments = segs(&o["readSegments"]);
    let now = o["nowMs"].as_f64().unwrap();
    let current = resolve_target_account(&segments, "current", now).unwrap();
    for (interval, exp) in o["intervals"].as_object().unwrap() {
        let (until, err) = resolve_window_until(interval, &current, now);
        let mut m = Map::new();
        m.insert("untilMs".into(), json!(until as i64));
        // The TS literal omits `error` entirely when the interval parsed — a `?? null` port would
        // add a key the caller's `if (intervalError)` guard then treats as an error object.
        if let Some(e) = err {
            m.insert("error".into(), Value::String(e));
        }
        same(&Value::Object(m), exp, interval);
    }
}

#[test]
fn weighted_and_fmt_tok_reproduce_the_ts_oracle_exactly() {
    let o = oracle();
    let events = o["events"].as_array().cloned().unwrap_or_default();
    let got: Vec<f64> = events.iter().map(weighted).collect();
    let exp: Vec<f64> = o["weights"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    assert_eq!(got, exp);
    for pair in o["fmtTok"].as_array().unwrap() {
        let n = pair[0].as_f64().unwrap();
        assert_eq!(fmt_tok(n), pair[1].as_str().unwrap(), "fmtTok({n})");
    }
}

#[test]
fn resolve_window_capacity_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let now = o["nowMs"].as_f64().unwrap();
    let segments = segs(&o["readSegments"]);
    let current = resolve_target_account(&segments, "current", now).unwrap();
    same(&resolve_window_capacity(&observed_from(&o["observedOwn"]), &current, &segments, "5h").to_value(), &o["capacityOwn"], "own");
    same(
        &resolve_window_capacity(&observed_from(&o["observedProxy"]), &current, &segs(&o["proxySegments"]), "5h").to_value(),
        &o["capacityProxy"],
        "proxy",
    );
    same(&resolve_window_capacity(&IndexMap::new(), &current, &segments, "7d").to_value(), &o["capacityNone"], "none");
}

#[test]
fn build_account_burners_report_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let now = o["nowMs"].as_f64().unwrap();
    same(&report(&o, "observedOwn", "current", &o["readSegments"], now, 15.0), &o["reportOwn"], "reportOwn");
    same(&report(&o, "observedProxy", "current", &o["proxySegments"], now, 15.0), &o["reportProxy"], "reportProxy");
    same(&report(&o, "nothing", "current", &o["readSegments"], now, 15.0), &o["reportNoCapacity"], "reportNoCapacity");
    same(&report(&o, "observedTokensOnly", "current", &o["readSegments"], now, 15.0), &o["reportTokensOnlyCapacity"], "reportTokensOnly");
    same(&report(&o, "observedOwn", "previous", &o["readSegments"], now, 15.0), &o["reportPrevious"], "reportPrevious");
    same(&report(&o, "observedOwn", "current", &o["readSegments"], now, 1.0), &o["reportLimitOne"], "reportLimitOne");
    let early = 1754035200000.0 - 100.0 * 3_600_000.0;
    same(&report(&o, "observedOwn", "current", &o["readSegments"], early, 15.0), &o["reportEmptyWindow"], "reportEmptyWindow");
}

/// The "Known: …" list an unmatched account spec is answered with. `${s.email ?? '?'}` is NULLISH,
/// so an EMPTY email renders as empty parens rather than "?" — and the fixture's newest segment has
/// exactly that, so a truthy-guard port would print "?" for an account it can actually name.
///
/// PARITY GAP, stated: this expression lives INLINE in mcpServer.ts's dispatch rather than in an
/// exported function, so the oracle side is a transcription of that line, not a call into it.
#[test]
fn the_known_accounts_list_renders_a_blank_email_as_blank() {
    let o = oracle();
    let segments = segs(&o["readSegments"]);
    assert_eq!(
        agentlens_core::account_burners::known_accounts(&segments),
        o["knownAccounts"].as_str().unwrap()
    );
    // Deduped on the RENDERED string, so the same account with two different emails appears twice.
    assert_eq!(o["knownAccounts"].as_str().unwrap().matches("aaaaaaaa").count(), 2, "{}", o["knownAccounts"]);
}

/// A NULL accountId CLOSES the open segment and opens nothing. Consumption during an unresolved
/// stretch is attributable to NOBODY — without this the gap is silently charged to the last known
/// account, which is precisely the misattribution this tool exists to avoid.
#[test]
fn an_unresolved_record_closes_the_segment_and_attributes_to_nobody() {
    let o = oracle();
    let segments = read_account_segments(&fixtures().join("acct-burners-timeline.ndjson"));
    assert_eq!(segments.len(), 3, "{segments:?}");
    assert!(segments[1].end_ms.is_some(), "the null record closed bbbb's segment");
    // The gap between segments[1].endMs and segments[2].startMs belongs to no account.
    let gap_start = segments[1].end_ms.unwrap();
    assert!(gap_start < segments[2].start_ms, "there IS a hole: {segments:?}");
    let now = o["nowMs"].as_f64().unwrap();
    let events = o["events"].as_array().cloned().unwrap_or_default();
    for spec in ["current", "previous"] {
        let t = resolve_target_account(&segments, spec, now).unwrap();
        let hit = events_for_account_in_window(&events, &t, 0.0, now, now);
        assert!(
            hit.iter().all(|e| {
                let ts = e["ts"].as_f64().unwrap();
                ts < gap_start || ts >= segments[2].start_ms || ts < segments[1].start_ms
            }),
            "{spec}: an event inside the unresolved stretch was attributed"
        );
    }
}

/// The email/plan pick is `.filter(Boolean).pop()` — the last TRUTHY value. The fixture's newest
/// segment carries an EMPTY email, and a `.last()` port would report the account as having no
/// email at all while the timeline plainly knows it.
#[test]
fn a_later_blank_email_does_not_erase_the_known_one() {
    let o = oracle();
    let segments = segs(&o["readSegments"]);
    assert_eq!(segments.last().unwrap().email.as_deref(), Some(""), "the fixture's last segment IS blank");
    let now = o["nowMs"].as_f64().unwrap();
    let current = resolve_target_account(&segments, "current", now).unwrap();
    assert_eq!(current.email.as_deref(), Some("one@example.test"));
}

/// `previous` skips EVERY segment of the current account, not just the immediately preceding one —
/// a timeline that re-recorded the current account (a plan change, a re-login) must still resolve to
/// the account the user actually rotated away from.
#[test]
fn previous_skips_every_segment_of_the_current_account() {
    let o = oracle();
    let segments = segs(&o["readSegments"]);
    let now = o["nowMs"].as_f64().unwrap();
    let prev = resolve_target_account(&segments, "previous", now).unwrap();
    assert!(prev.account_id.starts_with("bbbbbbbb"), "{prev:?}");
    // aaaa holds BOTH the first and the last segment, so a naive "the segment before the last one"
    // would answer aaaa — its own account.
    assert_eq!(segments[0].account_id, segments[2].account_id);
}

/// `resolveWindowUntil` parses the RAW interval and NAMES an unparseable one. Falling back to `now`
/// silently would answer a question about a different window than the caller asked for.
#[test]
fn an_unparseable_interval_is_named_not_silently_defaulted() {
    let o = oracle();
    let segments = segs(&o["readSegments"]);
    let now = o["nowMs"].as_f64().unwrap();
    let current = resolve_target_account(&segments, "current", now).unwrap();
    let (until, err) = resolve_window_until("not-a-date", &current, now);
    assert_eq!(until, current.last_active_ms, "it still returns a usable window");
    assert!(err.unwrap().contains("Unparseable interval 'not-a-date'"));
    assert_eq!(resolve_window_until("  LAST  ", &current, now).1, None, "the selector IS trimmed and lowercased");
}

/// The same-plan proxy is picked DETERMINISTICALLY — newest `observedAt`, then the larger cap — so
/// the answer never depends on which key the observed table happened to be built with first. And it
/// is LABELLED as a proxy, so a fill% derived from another account's calibration never reads as
/// this account's own measurement.
#[test]
fn the_same_plan_proxy_is_deterministic_and_labelled() {
    let o = oracle();
    let now = o["nowMs"].as_f64().unwrap();
    let segments = segs(&o["readSegments"]);
    let current = resolve_target_account(&segments, "current", now).unwrap();
    let proxy_segs = segs(&o["proxySegments"]);
    let observed = observed_from(&o["observedProxy"]);
    let cap = resolve_window_capacity(&observed, &current, &proxy_segs, "5h");
    assert_eq!(cap.source, Some("same-plan-proxy"));
    assert!(cap.proxy_account_id.as_deref().unwrap().starts_with("cccccccc"), "the NEWEST observedAt wins: {cap:?}");
    // Reversing the table's insertion order must not change the answer.
    let mut reversed: IndexMap<String, ObservedAccountCapacity> = IndexMap::new();
    for (k, v) in observed.iter().rev() {
        reversed.insert(k.clone(), v.clone());
    }
    assert_eq!(resolve_window_capacity(&reversed, &current, &proxy_segs, "5h").proxy_account_id, cap.proxy_account_id);
}

/// fill% is COST-based FIRST — Anthropic meters the windows by cost, and a raw-token fill is
/// inflated by the ~96% cache-read volume. Token fill is the FALLBACK, used only when no cost cap is
/// calibrated; with neither, the fill is null and `mostLikelyExhausted` says "undetermined" rather
/// than picking a window on no evidence.
#[test]
fn fill_prefers_cost_falls_back_to_tokens_and_otherwise_says_undetermined() {
    let o = oracle();
    let now = o["nowMs"].as_f64().unwrap();
    let cost = report(&o, "observedOwn", "current", &o["readSegments"], now, 15.0);
    let tokens = report(&o, "observedTokensOnly", "current", &o["readSegments"], now, 15.0);
    let none = report(&o, "nothing", "current", &o["readSegments"], now, 15.0);

    let f = |r: &Value, w: &str| r[w]["fillPct"].as_f64();
    assert!(f(&cost, "fiveHour").is_some() && f(&tokens, "fiveHour").is_some());
    assert_ne!(f(&cost, "fiveHour"), f(&tokens, "fiveHour"), "cost fill and token fill are different numbers");
    assert_eq!(f(&none, "fiveHour"), None, "no capacity ⇒ undetermined, never invented");
    assert_eq!(none["mostLikelyExhausted"], "undetermined");
    assert!(none["exhaustionReason"].as_str().unwrap().contains("No calibrated capacity"), "{}", none["exhaustionReason"]);
    assert_eq!(cost["mostLikelyExhausted"], "5h");
}

/// `limit` truncates BOTH tables while `totalProjects`/`totalBurners` keep the honest full counts —
/// a truncated table that also reported a truncated total would read as "this is everything".
#[test]
fn the_limit_truncates_the_tables_but_not_the_counts() {
    let o = oracle();
    let now = o["nowMs"].as_f64().unwrap();
    let full = report(&o, "observedOwn", "current", &o["readSegments"], now, 15.0);
    let one = report(&o, "observedOwn", "current", &o["readSegments"], now, 1.0);
    assert_eq!(one["fiveHour"]["projects"].as_array().unwrap().len(), 1);
    assert_eq!(one["fiveHour"]["burners"].as_array().unwrap().len(), 1);
    assert_eq!(one["fiveHour"]["totalProjects"], full["fiveHour"]["totalProjects"]);
    assert_eq!(one["fiveHour"]["totalBurners"], full["fiveHour"]["totalBurners"]);
    assert!(full["fiveHour"]["totalBurners"].as_f64().unwrap() > 1.0, "the fixture has something to truncate");
}

/// A window with no attributable events says so in the VERDICT and points at coverage, instead of
/// rendering an empty table that reads as "nothing burned this account".
#[test]
fn an_empty_window_explains_itself() {
    let o = oracle();
    let early = 1754035200000.0 - 100.0 * 3_600_000.0;
    let got = report(&o, "observedOwn", "current", &o["readSegments"], early, 15.0);
    assert_eq!(got["fiveHour"]["totalBurners"], 0);
    assert_eq!(got["sevenDay"]["totalBurners"], 0);
    assert!(got["verdict"].as_str().unwrap().contains("No consumption events attribute to"), "{}", got["verdict"]);
    assert!(got["verdict"].as_str().unwrap().contains("see coverage"), "{}", got["verdict"]);
}

/// The rendered `text` is a wire surface too: a padStart drift misaligns every column and is
/// invisible to a field-by-field comparison, so the whole block is compared verbatim. It also pins
/// the HOME abbreviation (`~/Code/alpha`) and the `(unattributed)` row for events with no workspace
/// on either the event or a card.
#[test]
fn the_rendered_table_is_byte_identical() {
    let o = oracle();
    let now = o["nowMs"].as_f64().unwrap();
    let got = report(&o, "observedOwn", "current", &o["readSegments"], now, 15.0);
    assert_eq!(got["text"], o["reportOwn"]["text"]);
    let text = got["text"].as_str().unwrap();
    assert!(text.contains("~/Code/alpha"), "a workspace under HOME is abbreviated: {text}");
    assert!(text.contains("(unattributed)"), "an event with no workspace still gets a row: {text}");
    assert!(text.contains("◀ MOST LIKELY EXHAUSTED"), "the exhausted window is marked in the table: {text}");
}
