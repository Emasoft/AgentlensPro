//! Cross-engine parity for subscriptionUsage SLICE B (TRDD-DMWOBWFH P4x.2n) — `loadToken` and the
//! `getSubscriptionUsage` decision ladder. Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-subusageb-expected.mjs
//!
//! The ORDER of the ladder is the contract, so the assertions are deliberately not just "the same
//! reading came back": each case also pins the SIDE EFFECTS (which files exist afterwards, whether
//! the lock was released, how many requests were attempted). A port that served the right number
//! from the wrong branch — a cache hit where the TS refetches, a fetch where the TS is in cooldown —
//! produces an identical `usage` and is caught only by the call count and the files on disk.
//!
//! No network and no keychain: both credential shapes are files, and every case that would reach
//! the keychain is pinned to the `opt_in_required` branch that returns before shelling out.

use std::cell::Cell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use agentlens_core::subscription_usage::{self as su, HttpResponse, TokenIdentity};
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/subusageb-expected.json");
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

fn read_json(p: &Path) -> Value {
    std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null)
}

fn write_json(p: &Path, v: &Value) {
    std::fs::write(p, serde_json::to_string(v).unwrap()).unwrap();
}

/// One HTTP leg of the stubbed plan. A missing leg is the transport THROWING, not a 5xx — the two
/// take different paths through the TS (`catch` vs `!res.ok`) and both must land on `http_error`.
fn leg(plan: &Value, which: &str) -> Option<HttpResponse> {
    let r = plan.get(which)?;
    if r.is_null() {
        return None;
    }
    let headers: HashMap<String, String> = r
        .get("headers")
        .and_then(Value::as_object)
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned())).collect())
        .unwrap_or_default();
    Some(HttpResponse {
        status: r["status"].as_u64().unwrap_or(0) as u16,
        headers,
        body: r.get("body").map_or_else(String::new, ToString::to_string),
    })
}

#[test]
fn get_subscription_usage_ladder_matches() {
    let o = oracle();
    let now = o["now"].as_f64().unwrap();
    let is_darwin = o["platform"] == "darwin";
    let access = o["access"].as_str().unwrap();
    let uuid = o["uuid"].as_str().unwrap();
    let ok_plan = serde_json::json!({
        "usage": {"status": 200, "body": o["usageBody"]},
        "profile": {"status": 200, "body": o["profileBody"]},
    });

    let root = std::env::temp_dir().join(format!("agentlens-subusageb-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);

    for (name, case) in o["cases"].as_object().unwrap() {
        let seed = &case["seed"];
        let data = root.join(name).join("data");
        let cfg = root.join(name).join("claude");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&cfg).unwrap();
        let paths = su::UsagePaths::under(&data);

        if !seed["credentials"].is_null() {
            write_json(&cfg.join(".credentials.json"), &seed["credentials"]);
        }
        if !seed["cache"].is_null() {
            write_json(&paths.cache, &seed["cache"]);
        }
        if !seed["cooldown"].is_null() {
            write_json(&paths.cooldown, &seed["cooldown"]);
        }
        if !seed["lock"].is_null() {
            std::fs::write(&paths.lock, seed["lock"].to_string()).unwrap();
            // The staleness test is `now - mtime > 2 * HTTP_TIMEOUT_MS`, and `now` here is the
            // oracle's fixed instant — not the wall clock — so the seeded mtime has to be placed
            // relative to IT. Leaving the file at its real creation time would make the age
            // negative and silently turn every stale-lock case into a contended one.
            let at = now - seed["lockAgeMs"].as_f64().unwrap_or(0.0);
            let f = std::fs::File::options().write(true).open(&paths.lock).unwrap();
            f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(at as u64)).unwrap();
        }

        let loaded = su::load_token(Some(&cfg), &cfg, false, false, is_darwin);
        if !seed["credentials"].is_null() {
            // Pin the fingerprint itself: it is the cache-validity key, so a port that hashed the
            // access token instead would pass every ladder assertion until the hourly rotation and
            // then miss the cache forever.
            assert_eq!(loaded.fp.as_deref(), o["fp"].as_str(), "{name}: fingerprint");
        }

        let plan = if seed["plan"] == "ok" { ok_plan.clone() } else { seed["plan"].clone() };
        let usage_calls = Cell::new(0usize);
        let ident_calls = Cell::new(0usize);
        let fetch_usage = |tok: &str| -> Result<HttpResponse, String> {
            usage_calls.set(usage_calls.get() + 1);
            assert_eq!(tok, access, "{name}: usage fetched with the wrong token");
            leg(&plan, "usage").ok_or_else(|| "network down".to_owned())
        };
        let fetch_identity = |tok: &str| -> Option<TokenIdentity> {
            ident_calls.set(ident_calls.get() + 1);
            assert_eq!(tok, access, "{name}: identity fetched with the wrong token");
            su::parse_token_identity(&leg(&plan, "profile")?)
        };

        let got = su::get_subscription_usage(
            &paths,
            &loaded,
            now,
            seed["force"].as_bool().unwrap_or(false),
            None,
            &fetch_usage,
            &fetch_identity,
        );

        same(&got.unwrap_or(Value::Null), &case["usage"], &format!("{name}.usage"));
        same(&read_json(&paths.cache), &case["cache"], &format!("{name}.cache"));
        same(&read_json(&paths.cooldown), &case["cooldown"], &format!("{name}.cooldown"));
        same(&read_json(&paths.account_dir.join(format!("{uuid}.json"))), &case["archived"], &format!("{name}.archived"));
        assert_eq!(paths.lock.exists(), case["lockRemains"], "{name}: lock left behind");

        let want: Vec<&str> = case["calls"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        let want_ident = want.iter().filter(|u| u.contains("/profile")).count();
        assert_eq!(ident_calls.get(), want_ident, "{name}: identity requests");
        assert_eq!(usage_calls.get(), want.len() - want_ident, "{name}: usage requests");
    }
    let _ = std::fs::remove_dir_all(&root);
}

/// `loadToken`'s own branches, independent of the ladder: the file shape it accepts, and what it
/// reports when there is nothing to load. Every case here returns BEFORE the keychain call.
#[test]
fn load_token_branches() {
    let o = oracle();
    let is_darwin = o["platform"] == "darwin";
    let root = std::env::temp_dir().join(format!("agentlens-loadtoken-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let dir = |n: &str, body: Option<&str>| -> PathBuf {
        let d = root.join(n);
        std::fs::create_dir_all(&d).unwrap();
        if let Some(b) = body {
            std::fs::write(d.join(".credentials.json"), b).unwrap();
        }
        d
    };

    let nested = dir("nested", Some(r#"{"claudeAiOauth":{"accessToken":"a","refreshToken":"r"}}"#));
    let t = su::load_token(Some(&nested), &nested, false, false, is_darwin);
    assert_eq!(t.token.as_deref(), Some("a"));
    assert_eq!(t.reason, None);

    // A BARE record (no claudeAiOauth wrapper) is accepted from the FILE — only the keychain branch
    // requires the wrapper.
    let bare = dir("bare", Some(r#"{"accessToken":"a2","refreshToken":"r2","expiresAt":123}"#));
    let t = su::load_token(Some(&bare), &bare, false, false, is_darwin);
    assert_eq!(t.token.as_deref(), Some("a2"));
    assert_eq!(t.expires_at, Some(123.0));

    // Present but unusable: parse failure, and a record with no access token. Both fall THROUGH to
    // the same place a missing file does, rather than being reported as a loaded-but-empty token.
    for (n, body) in [("garbage", "{not json"), ("empty", r#"{"claudeAiOauth":{}}"#)] {
        let d = dir(n, Some(body));
        let t = su::load_token(Some(&d), &d, false, false, is_darwin);
        assert_eq!(t.token, None, "{n}");
        assert_eq!(t.reason, Some(if is_darwin { "opt_in_required" } else { "no_token" }), "{n}");
    }

    // No file at all. On darwin the keychain is the next step and consent gates it; elsewhere there
    // is nowhere else to look.
    let none = dir("none", None);
    let t = su::load_token(Some(&none), &none, false, false, is_darwin);
    assert_eq!(t.reason, Some(if is_darwin { "opt_in_required" } else { "no_token" }));
    assert!(t.fp.is_none());

    let _ = std::fs::remove_dir_all(&root);
}
