//! Cross-engine parity for subscriptionUsage SLICE A (TRDD-DMWOBWFH P4x.2m). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-subusage-expected.mjs
//!
//! Pure + disk-local only: no network, no keychain. `armCooldown` is the one case that touches a
//! file, and the generator pointed AGENTLENS_DATA_DIR at a fixture dir before importing so it
//! never wrote into a real store; this test writes its cooldown seeds into a temp dir of its own.

use std::collections::HashMap;

use agentlens_core::subscription_usage as su;
use agentlens_core::summarize::helpers::num;
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/subusage-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

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

fn now(o: &Value) -> f64 {
    o["now"].as_f64().unwrap()
}

#[test]
fn window_pct_matches() {
    let o = oracle();
    for (name, exp) in o["windowPct"].as_object().unwrap() {
        let input = window_input(name);
        // `num`, not `Value::from(f64)`: JS prints an integral double as `17`, and a bare f64 would
        // serialize as `17.0` and fail against every whole-number percentage in the oracle.
        let got = su::window_pct(input.as_ref()).map_or(Value::Null, num);
        assert_eq!(&got, exp, "windowPct({name})");
    }
}

fn window_input(name: &str) -> Option<Value> {
    match name {
        "utilization" => Some(serde_json::json!({"utilization": 42.5})),
        "used_percentage_fallback" => Some(serde_json::json!({"used_percentage": 17})),
        "both_present" => Some(serde_json::json!({"utilization": 1, "used_percentage": 99})),
        "zero_is_a_real_number" => Some(serde_json::json!({"utilization": 0})),
        "string_number_is_not_a_number" => Some(serde_json::json!({"utilization": "42"})),
        "empty" => Some(serde_json::json!({})),
        "null_window" => None,
        other => panic!("unknown windowPct case {other}"),
    }
}

#[test]
fn resets_at_matches_every_shape() {
    let o = oracle();
    for (name, exp) in o["resetsAt"].as_object().unwrap() {
        let raw = resets_input(name);
        let got = su::normalize_resets_at(raw.as_ref()).map_or(Value::Null, Value::String);
        assert_eq!(&got, exp, "normalizeResetsAt({name})");
    }
}

fn resets_input(name: &str) -> Option<Value> {
    match name {
        "epoch_seconds" => Some(Value::from(1787270400_i64)),
        "epoch_millis" => Some(Value::from(1787270400000_i64)),
        "numeric_string_seconds" => Some(Value::from("1787270400")),
        "decimal_string" => Some(Value::from("1787270400.5")),
        "iso_string_kept_verbatim" => Some(Value::from("2026-08-19T04:00:00Z")),
        "iso_with_offset" => Some(Value::from("2026-08-19T06:00:00+0200")),
        "garbage_string" => Some(Value::from("not a date")),
        "empty_string" => Some(Value::from("")),
        "whitespace_string" => Some(Value::from("   ")),
        "null_value" => Some(Value::Null),
        "boolean_value" => Some(Value::Bool(true)),
        "boundary_just_below_1e12" => Some(Value::from(999999999999_i64)),
        "boundary_at_1e12" => Some(Value::from(1000000000000_i64)),
        other => panic!("unknown resetsAt case {other}"),
    }
}

#[test]
fn normalize_matches() {
    let o = oracle();
    let n = now(&o);
    let body = body_fixture();
    let ident = su::TokenIdentity {
        email: Some("owner@example.com".to_owned()),
        account_uuid: Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".to_owned()),
        tier: Some("max_20x".to_owned()),
    };
    let empty = serde_json::json!({});
    let mut credits_non_boolean = body.clone();
    credits_non_boolean["extra_usage"] = serde_json::json!({"is_enabled": "yes"});
    for (name, exp) in o["normalize"].as_object().unwrap() {
        let got = match name.as_str() {
            "full" => su::normalize(&body, n - 30_000.0, "ok", n, Some("fp-1234"), Some(&ident), Some("owner@example.com")),
            "suspect_label" => su::normalize(&body, n - 30_000.0, "ok", n, Some("fp-1234"), Some(&ident), Some("second@example.com")),
            "no_fingerprint" => su::normalize(&body, n - 30_000.0, "ok", n, None, Some(&ident), None),
            "no_identity" => su::normalize(&body, n - 30_000.0, "ok", n, Some("fp-1234"), None, Some("owner@example.com")),
            "stale_at_write" => su::normalize(&body, n - 40.0 * 60_000.0, "ok", n, Some("fp-1234"), Some(&ident), None),
            "empty_body" => su::normalize(&empty, n, "fresh", n, None, None, None),
            "credits_non_boolean" => su::normalize(&credits_non_boolean, n, "ok", n, None, None, None),
            other => panic!("unknown normalize case {other}"),
        };
        same(&got, exp, &format!("normalize({name})"));
    }
}

fn body_fixture() -> Value {
    serde_json::json!({
        "five_hour": { "utilization": 61 },
        "seven_day": { "used_percentage": 12.5 },
        "limits": [
            { "kind": "session", "group": "session", "percent": 61, "severity": "normal", "resets_at": "2099-01-01T00:00:00.000Z", "is_active": true },
            { "resets_at": 1787270400_i64, "is_active": false },
            { "kind": "weekly_scoped", "group": "weekly", "percent": 3, "severity": "critical", "resets_at": "2000-01-01T00:00:00.000Z",
              "is_active": true, "scope": { "model": { "display_name": "claude-opus-5" }, "surface": "api" } },
            { "kind": "weekly_all", "group": "weekly", "percent": 0, "resets_at": "garbage", "is_active": 1, "scope": { "model": null } }
        ],
        "extra_usage": { "is_enabled": true },
        "spend": { "percent": 4.25 }
    })
}

#[test]
fn stale_predicates_match() {
    let o = oracle();
    let n = now(&o);
    let base = &o["normalize"]["full"];
    for (name, exp) in o["stale"].as_object().unwrap() {
        let mut rec = base.clone();
        let (age_ms, resets): (f64, Value) = match name.as_str() {
            "fresh" => (1000.0, serde_json::json!([{ "resetsAt": "2099-01-01T00:00:00.000Z" }])),
            "too_old" => (31.0 * 60_000.0, serde_json::json!([{ "resetsAt": "2099-01-01T00:00:00.000Z" }])),
            "window_reset" => (1000.0, serde_json::json!([{ "resetsAt": "2000-01-01T00:00:00.000Z" }])),
            "null_resets_at" => (1000.0, serde_json::json!([{ "resetsAt": null }])),
            "unparseable_resets_at" => (1000.0, serde_json::json!([{ "resetsAt": "nonsense" }])),
            "no_limits" => (1000.0, serde_json::json!([])),
            "exactly_at_ttl_x3" => (30.0 * 60_000.0, serde_json::json!([{ "resetsAt": "2099-01-01T00:00:00.000Z" }])),
            other => panic!("unknown stale case {other}"),
        };
        rec["fetchedAt"] = Value::from(n - age_ms);
        rec["limits"] = resets;
        let got = serde_json::json!({
            "stale": su::derive_stale(&rec, n),
            "reason": su::stale_reason(&rec, n).map_or(Value::Null, |s| Value::String(s.to_owned())),
        });
        same(&got, exp, &format!("staleReason({name})"));
    }
}

#[test]
fn arm_cooldown_matches() {
    let o = oracle();
    let n = now(&o);
    let dir = std::env::temp_dir().join(format!("agentlens-subusage-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("subscription-usage-cooldown.json");
    for (name, exp) in o["arm"].as_object().unwrap() {
        // The SEED is read from the oracle so the two engines start from the same cooldown state.
        match &exp["seed"] {
            Value::Null => {
                let _ = std::fs::remove_file(&file);
            }
            seed => std::fs::write(&file, serde_json::to_string(seed).unwrap()).unwrap(),
        }
        let retry_after = match name.as_str() {
            "retry_after_floored" => Some(30.0),
            "retry_after_honored" => Some(200.0),
            "retry_after_zero" => Some(0.0),
            _ => None,
        };
        let delay = su::arm_cooldown(retry_after, n, &file);
        let written: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        let got = serde_json::json!({ "delay": num(delay), "file": written, "seed": exp["seed"].clone() });
        same(&got, exp, &format!("armCooldown({name})"));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn retry_after_matches() {
    let o = oracle();
    let n = now(&o);
    for (name, exp) in o["retryAfter"].as_object().unwrap() {
        let headers = retry_headers(name, n);
        let got = su::retry_after_seconds(headers.as_ref(), n).map_or(Value::Null, num);
        assert_eq!(&got, exp, "retryAfterSeconds({name})");
    }
}

fn retry_headers(name: &str, now: f64) -> Option<HashMap<String, String>> {
    let http_date = |ms: f64| {
        // `Date.prototype.toUTCString()` — RFC 7231 IMF-fixdate.
        let secs = (ms / 1000.0) as i64;
        chrono::DateTime::from_timestamp(secs, 0).unwrap().format("%a, %d %b %Y %H:%M:%S GMT").to_string()
    };
    let iso = |ms: f64| agentlens_core::summarize::helpers::iso_from_ms(ms);
    let one = |k: &str, v: String| Some(HashMap::from([(k.to_owned(), v)]));
    match name {
        "numeric" => one("retry-after", "120".to_owned()),
        "http_date" => one("retry-after", http_date(now + 90_000.0)),
        "http_date_past" => one("retry-after", http_date(now - 90_000.0)),
        "unified_epoch" => one("anthropic-ratelimit-unified-reset", format!("{}", (now / 1000.0).floor() as i64 + 300)),
        "unified_epoch_past" => one("anthropic-ratelimit-unified-reset", format!("{}", (now / 1000.0).floor() as i64 - 300)),
        "iso_reset" => one("anthropic-ratelimit-requests-reset", iso(now + 45_000.0)),
        "precedence" => Some(HashMap::from([
            ("retry-after".to_owned(), "7".to_owned()),
            ("anthropic-ratelimit-unified-reset".to_owned(), format!("{}", (now / 1000.0).floor() as i64 + 900)),
        ])),
        "case_insensitive" => one("Retry-After", "11".to_owned()),
        "garbage" => one("retry-after", "soon".to_owned()),
        "none" => Some(HashMap::new()),
        "null_headers" => None,
        other => panic!("unknown retryAfter case {other}"),
    }
}

#[test]
fn usage_bar_matches() {
    let o = oracle();
    for (name, exp) in o["bar"].as_object().unwrap() {
        let got = if name == "20_cells" { su::usage_bar(37.0, 20) } else { su::usage_bar(name.parse().unwrap(), 10) };
        assert_eq!(&Value::String(got), exp, "usageBar({name})");
    }
}

#[test]
fn format_matches() {
    let o = oracle();
    let n = now(&o);
    let base = &o["fmtInputs"]["base"];
    let lim = &o["fmtInputs"]["lim"];
    let relim = |over: Value| {
        let mut l = lim.clone();
        for (k, v) in over.as_object().unwrap() {
            l[k] = v.clone();
        }
        l
    };
    for (name, exp) in o["format"].as_object().unwrap() {
        let mut rec = base.clone();
        match name.as_str() {
            "null_usage" => {
                assert_eq!(su::format_subscription_usage(None, n), exp.as_str().unwrap(), "format({name})");
                continue;
            }
            "live_verified" => {}
            "live_unverified" => rec["accountVerified"] = Value::from("unknown"),
            "another_account" => rec["accountVerified"] = Value::from("no"),
            "suspect_label" => {
                rec["accountLabelSuspect"] = Value::Bool(true);
                rec["localClaimedLabel"] = Value::from("second@example.com");
            }
            "stale_all_rolled" => {
                rec["stale"] = Value::Bool(true);
                rec["ageSeconds"] = Value::from(8525 * 60);
                rec["reason"] = Value::from("cooldown");
                rec["limits"] = Value::Array(vec![
                    relim(serde_json::json!({"resetsAt": "2000-01-01T00:00:00.000Z"})),
                    relim(serde_json::json!({"kind": "weekly_all", "resetsAt": "2000-01-01T00:00:00.000Z"})),
                ]);
            }
            "stale_some_rolled" => {
                rec["stale"] = Value::Bool(true);
                rec["ageSeconds"] = Value::from(300);
                rec["reason"] = Value::from("429");
                rec["limits"] = Value::Array(vec![
                    relim(serde_json::json!({"resetsAt": "2000-01-01T00:00:00.000Z"})),
                    relim(serde_json::json!({"kind": "weekly_all", "resetsAt": "2099-01-01T00:00:00.000Z"})),
                ]);
            }
            "credits_disabled" => rec["usageCreditsEnabled"] = Value::Bool(false),
            "credits_unknown" => rec["usageCreditsEnabled"] = Value::Null,
            "unresolved_account" => {
                rec["accountLabel"] = Value::Null;
                rec["accountUuid"] = Value::Null;
            }
            "uuid_only" => rec["accountLabel"] = Value::Null,
            "age_seconds" | "age_minutes" | "age_hours" | "age_days" => {
                rec["stale"] = Value::Bool(true);
                rec["limits"] = Value::Array(Vec::new());
                rec["ageSeconds"] = Value::from(match name.as_str() {
                    "age_seconds" => 45,
                    "age_minutes" => 600,
                    "age_hours" => 3 * 3600 + 120,
                    _ => 6 * 86400,
                });
            }
            other => panic!("unknown format case {other}"),
        }
        assert_eq!(su::format_subscription_usage(Some(&rec), n), exp.as_str().unwrap(), "format({name})");
    }
}
