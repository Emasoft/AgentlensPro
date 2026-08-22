//! all_accounts SLICE B5 — the account-roster reads behind `get_account_status(all: true)`
//! (TRDD-DMWOBWFH). Self-contained: fixtures are built inline (an NDJSON timeline + a small usage
//! archive directory) rather than committed, because their only load-bearing content is a handful
//! of numbers this file also asserts on directly.
//!
//! FALSIFICATION NOTE: the dispatching task forbids running `cargo build/test/check/clippy` in this
//! turn (a build lock is held by the coordinator), so the "break it, confirm red, revert" step
//! could not be executed here. That step is deferred to whoever next runs the suite under the lock.

use std::path::{Path, PathBuf};

use agentlens_core::all_accounts::{
    classify_window, list_account_roster, list_all_accounts, list_observed_account_usage,
    usage_refresh_capability, ListAllAccountsInput, WindowBound, WindowFreshness,
};
use agentlens_core::subscription_usage::UsagePaths;
use serde_json::json;

/// PID-and-tag-scoped temp dir — cargo runs tests as parallel threads in one process, so a
/// PID-only path would let sibling tests race on the same fixture directory.
fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("al-allacct-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn write_timeline(dir: &Path, lines: &[String]) -> PathBuf {
    let p = dir.join("account-state.ndjson");
    std::fs::write(&p, lines.join("\n") + "\n").unwrap();
    p
}

const TTL_MS: f64 = 600_000.0;

// -------------------------------------------------------------------------------------------
// classify_window — every branch.
// -------------------------------------------------------------------------------------------

#[test]
/// A reading with no reset since, taken inside the TTL, is 'fresh'/'exact' and keeps its percent.
fn classify_window_fresh_inside_ttl() {
    let now = 1_000_000.0;
    let w = classify_window(Some(42.0), Some("2026-01-01T00:00:00Z"), now - 1_000.0, None, now, false);
    assert_eq!(w.freshness, WindowFreshness::Fresh);
    assert_eq!(w.bound, WindowBound::Exact);
    assert_eq!(w.percent, Some(42.0));
    assert!(w.reason.is_none());
}

#[test]
/// A reading with no reset since, taken outside the TTL, is 'aged'/'lower' — utilization only
/// grows, so the old percent is still a safe LOWER bound.
fn classify_window_aged_outside_ttl() {
    let now = 1_000_000.0;
    let w = classify_window(Some(10.0), Some("2026-01-01T00:00:00Z"), now - TTL_MS - 1.0, None, now, false);
    assert_eq!(w.freshness, WindowFreshness::Aged);
    assert_eq!(w.bound, WindowBound::Lower);
    assert_eq!(w.percent, Some(10.0));
    assert!(w.reason.as_deref().unwrap().contains("LOWER bound"));
}

#[test]
/// Reset happened, and this machine left the account AT OR BEFORE the reset instant: the new
/// window is knowably empty — INFERRED 0%, 'rolled'/'inferred'.
fn classify_window_rolled_when_left_before_reset() {
    let reset_ms = 500_000.0;
    let now = reset_ms + 10_000.0; // reset already passed
    let w = classify_window(Some(91.0), Some(&iso(reset_ms)), 100.0, Some(reset_ms - 5_000.0), now, false);
    assert_eq!(w.freshness, WindowFreshness::Rolled);
    assert_eq!(w.bound, WindowBound::Inferred);
    assert_eq!(w.percent, Some(0.0));
    assert!(w.resets_at.is_none());
}

#[test]
/// Reset happened, this machine is STILL on the account (leftAt is None): the old number is void
/// and nothing can be inferred — 'stale'/'unknown'.
fn classify_window_stale_when_still_live() {
    let reset_ms = 500_000.0;
    let now = reset_ms + 10_000.0;
    let w = classify_window(Some(80.0), Some(&iso(reset_ms)), 100.0, None, now, false);
    assert_eq!(w.freshness, WindowFreshness::Stale);
    assert_eq!(w.bound, WindowBound::Unknown);
    assert_eq!(w.percent, None);
    assert!(w.reason.as_deref().unwrap().contains("still the one this machine is on"));
}

#[test]
/// Reset happened, left AFTER the reset (activity in the new window cannot be excluded): 'stale'.
fn classify_window_stale_when_left_after_reset() {
    let reset_ms = 500_000.0;
    let now = reset_ms + 10_000.0;
    let w = classify_window(Some(80.0), Some(&iso(reset_ms)), 100.0, Some(reset_ms + 1_000.0), now, false);
    assert_eq!(w.freshness, WindowFreshness::Stale);
    assert!(w.reason.as_deref().unwrap().contains("activity in it cannot be excluded"));
}

#[test]
/// `label_suspect` DISABLES the rolled inference even when leftAt would otherwise qualify — the
/// precondition (this machine's own claimed identity) is unfounded, so "left before reset" cannot
/// be trusted either.
fn classify_window_label_suspect_disables_rolled() {
    let reset_ms = 500_000.0;
    let now = reset_ms + 10_000.0;
    let w = classify_window(Some(91.0), Some(&iso(reset_ms)), 100.0, Some(reset_ms - 5_000.0), now, true);
    assert_eq!(w.freshness, WindowFreshness::Stale);
    assert!(w.reason.as_deref().unwrap().contains("does not match the one"));
}

#[test]
/// No percent at all in the reading: 'unreadable'/'unknown', never a guessed number.
fn classify_window_unreadable_absent_percent() {
    let w = classify_window(None, None, 0.0, None, 1_000.0, false);
    assert_eq!(w.freshness, WindowFreshness::Unreadable);
    assert_eq!(w.bound, WindowBound::Unknown);
    assert_eq!(w.percent, None);
}

fn iso(ms: f64) -> String {
    let secs = (ms / 1000.0) as i64;
    let dt = std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs.max(0) as u64);
    let datetime: chrono_like::Fmt = chrono_like::Fmt(dt);
    datetime.to_iso()
}

/// A tiny hand-rolled ISO formatter — this crate has no chrono dependency, and pulling one in for
/// a test-only timestamp would be exactly the kind of unrequested dependency the ladder forbids.
mod chrono_like {
    pub struct Fmt(pub std::time::SystemTime);
    impl Fmt {
        pub fn to_iso(&self) -> String {
            let dur = self.0.duration_since(std::time::UNIX_EPOCH).unwrap();
            let days = dur.as_secs() / 86_400;
            let rem = dur.as_secs() % 86_400;
            let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
            // Civil-from-days (Howard Hinnant's algorithm) — good enough for a monotonically
            // increasing test fixture clock, no leap-second handling needed.
            let z = days as i64 + 719_468;
            let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
            let doe = (z - era * 146_097) as u64;
            let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
            let y = yoe as i64 + era * 400;
            let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            let mp = (5 * doy + 2) / 153;
            let d = doy - (153 * mp + 2) / 5 + 1;
            let mth = if mp < 10 { mp + 3 } else { mp - 9 };
            let y = if mth <= 2 { y + 1 } else { y };
            format!("{y:04}-{mth:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
        }
    }
}

// -------------------------------------------------------------------------------------------
// list_account_roster — including the malformed-entry REFUSAL path.
// -------------------------------------------------------------------------------------------

#[test]
/// Two accounts in the timeline: latest-active-first, leftAt computed from the NEXT record that
/// names a different account, firstSeen kept from the earliest record for that key.
fn roster_basic_two_accounts() {
    let dir = tmp("roster-basic");
    let lines = vec![
        json!({"ts": 1000.0, "accountId": "aaaaaaaa", "email": "a@x", "plan": "Pro", "mode": "m1", "authRegime": "subscription"}).to_string(),
        json!({"ts": 2000.0, "accountId": "aaaaaaaa", "email": "a@x", "plan": "Pro", "mode": "m1", "authRegime": "subscription"}).to_string(),
        json!({"ts": 3000.0, "accountId": "bbbb2222", "email": "b@x", "plan": "Max", "mode": "m2", "authRegime": "usage-credits"}).to_string(),
    ];
    let path = write_timeline(&dir, &lines);
    let roster = list_account_roster(&path);
    assert_eq!(roster.len(), 2);
    // bbbb2222 is last-active -> sorts first.
    assert_eq!(roster[0].account_id.as_deref(), Some("bbbb2222"));
    assert_eq!(roster[0].left_at, None); // still the last account in the timeline
    assert_eq!(roster[1].account_id.as_deref(), Some("aaaaaaaa"));
    assert_eq!(roster[1].first_seen, 1000.0);
    assert_eq!(roster[1].last_state_change, 2000.0);
    assert_eq!(roster[1].left_at, Some(3000.0)); // left when bbbb2222's record appeared
}

#[test]
/// REFUSAL: a torn JSON line and a record naming neither accountId nor email are both skipped —
/// never guessed at, never turned into a plausible-looking account.
fn roster_skips_malformed_and_unkeyed_records() {
    let dir = tmp("roster-refusal");
    let lines = vec![
        "{not json".to_owned(),
        json!({"ts": 1000.0, "accountId": null, "email": null, "plan": "Pro", "mode": "m", "authRegime": "subscription"}).to_string(),
        json!({"ts": 2000.0, "accountId": "cccc3333", "email": null, "plan": "Pro", "mode": "m", "authRegime": "subscription"}).to_string(),
    ];
    let path = write_timeline(&dir, &lines);
    let roster = list_account_roster(&path);
    assert_eq!(roster.len(), 1);
    assert_eq!(roster[0].account_id.as_deref(), Some("cccc3333"));
}

// -------------------------------------------------------------------------------------------
// list_observed_account_usage — archive dir scan, newest-first, malformed skipped.
// -------------------------------------------------------------------------------------------

fn usage_record(fetched_at: f64, uuid: &str) -> serde_json::Value {
    json!({
        "fetchedAt": fetched_at, "ageSeconds": 0, "stale": false,
        "accountFp": null, "accountUuid": uuid, "accountLabel": "e@x", "accountTier": null,
        "localClaimedLabel": null, "accountLabelSuspect": false, "accountVerified": "yes",
        "reason": "fresh", "limits": [], "fiveHourPercent": 5.0, "sevenDayPercent": 6.0,
        "usageCreditsEnabled": false, "spendPercent": null, "note": ""
    })
}

#[test]
fn observed_usage_newest_first_and_skips_malformed() {
    let dir = tmp("usage-basic");
    let paths = UsagePaths::under(&dir);
    std::fs::create_dir_all(&paths.account_dir).unwrap();
    let older = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    let newer = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    std::fs::write(
        paths.account_dir.join(format!("{older}.json")),
        usage_record(1_000.0, older).to_string(),
    )
    .unwrap();
    std::fs::write(
        paths.account_dir.join(format!("{newer}.json")),
        usage_record(2_000.0, newer).to_string(),
    )
    .unwrap();
    // A file that is not uuid-shaped and a torn one — both must be skipped, not error the scan.
    std::fs::write(paths.account_dir.join("not-a-uuid.json"), "{}").unwrap();
    std::fs::write(paths.account_dir.join(format!("{older}.json.tmp-9999")), "{not json").unwrap();

    let out = list_observed_account_usage(&paths);
    assert_eq!(out.len(), 2);
    assert_eq!(out[0]["accountUuid"], newer);
    assert_eq!(out[1]["accountUuid"], older);
}

#[test]
/// usage_refresh_capability: a present credentials file means "can refresh", no keychain needed.
fn refresh_capability_credentials_file_present() {
    let dir = tmp("refresh-cap");
    let home = dir.join("home");
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    std::fs::write(home.join(".claude/.credentials.json"), "{}").unwrap();
    let (can, reason) =
        usage_refresh_capability(None, &home, &dir, &std::collections::HashMap::new(), true);
    assert!(can);
    assert!(reason.is_none());
}

#[test]
/// usage_refresh_capability: no credentials file, non-darwin -> cannot refresh, reason names the
/// path it looked for.
fn refresh_capability_no_credentials_non_darwin() {
    let dir = tmp("refresh-cap-nd");
    let home = dir.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let (can, reason) =
        usage_refresh_capability(None, &home, &dir, &std::collections::HashMap::new(), false);
    assert!(!can);
    assert!(reason.unwrap().contains(".credentials.json"));
}

// -------------------------------------------------------------------------------------------
// list_all_accounts — the join, including the "never observed" branch and freshness folding.
// -------------------------------------------------------------------------------------------

#[test]
fn all_accounts_join_never_observed_account_is_unreadable() {
    let dir = tmp("join-unobserved");
    let lines = vec![json!({
        "ts": 1000.0, "accountId": "ffff4444", "email": "f@x", "plan": "Pro", "mode": "m",
        "authRegime": "subscription"
    })
    .to_string()];
    let timeline = write_timeline(&dir, &lines);
    let usage_paths = UsagePaths::under(&dir); // no archive dir created -> no readings at all

    let answer = list_all_accounts(ListAllAccountsInput {
        now: 5_000.0,
        live_account_id: None,
        timeline_path: &timeline,
        usage_paths: &usage_paths,
        refresh_capability: (true, None),
    });

    assert_eq!(answer.accounts.len(), 1);
    let row = &answer.accounts[0];
    assert_eq!(row.freshness, WindowFreshness::Unreadable);
    assert!(row.observed_at.is_none());
    assert_eq!(row.five_hour.percent, None);
    assert!(!answer.blind);
    assert!(answer.archive.maintained);
}

#[test]
/// An account WITH a reading: five_hour comes from the 'session' limit bucket, freshness folds to
/// the worse of the two account-wide windows (aged beats fresh), and isLive is set from the
/// injected live_account_id.
fn all_accounts_join_observed_account_folds_freshness() {
    let dir = tmp("join-observed");
    let uuid = "11112222-3333-4444-5555-666677778888";
    let lines = vec![json!({
        "ts": 1000.0, "accountId": uuid, "email": "g@x", "plan": "Max", "mode": "m",
        "authRegime": "subscription"
    })
    .to_string()];
    let timeline = write_timeline(&dir, &lines);
    let usage_paths = UsagePaths::under(&dir);
    std::fs::create_dir_all(&usage_paths.account_dir).unwrap();

    let now = 10_000_000.0;
    let fetched_at = now - TTL_MS - 1.0; // outside TTL -> 'aged' on a no-reset window
    let rec = json!({
        "fetchedAt": fetched_at, "ageSeconds": 0, "stale": false,
        "accountFp": null, "accountUuid": uuid, "accountLabel": "g@x", "accountTier": null,
        "localClaimedLabel": null, "accountLabelSuspect": false, "accountVerified": "yes",
        "reason": "fresh",
        "limits": [
            {"kind": "session", "group": "session", "percent": 20.0, "severity": "normal",
             "resetsAt": null, "isActive": true, "scopeLabel": null, "resetsInSeconds": null},
            {"kind": "weekly_all", "group": "weekly", "percent": 30.0, "severity": "normal",
             "resetsAt": null, "isActive": true, "scopeLabel": null, "resetsInSeconds": null},
            {"kind": "weekly_scoped", "group": "weekly", "percent": 15.0, "severity": "normal",
             "resetsAt": null, "isActive": true, "scopeLabel": "Opus", "resetsInSeconds": null}
        ],
        "fiveHourPercent": 20.0, "sevenDayPercent": 30.0,
        "usageCreditsEnabled": true, "spendPercent": null, "note": ""
    });
    std::fs::write(usage_paths.account_dir.join(format!("{uuid}.json")), rec.to_string()).unwrap();

    let answer = list_all_accounts(ListAllAccountsInput {
        now,
        live_account_id: Some(uuid),
        timeline_path: &timeline,
        usage_paths: &usage_paths,
        refresh_capability: (false, Some("no creds".to_owned())),
    });

    assert_eq!(answer.accounts.len(), 1);
    let row = &answer.accounts[0];
    assert!(row.is_live);
    assert_eq!(row.left_at, None); // live now, so leftAt is suppressed even if the timeline had one
    assert_eq!(row.five_hour.percent, Some(20.0));
    assert_eq!(row.five_hour.freshness, WindowFreshness::Aged);
    assert_eq!(row.seven_day.freshness, WindowFreshness::Aged);
    assert_eq!(row.freshness, WindowFreshness::Aged); // both windows agree
    assert_eq!(row.model_windows.len(), 1);
    assert_eq!(row.model_windows[0].model, "Opus");
    assert_eq!(row.scoped_weekly.len(), 1);
    assert!(!answer.archive.maintained);
    assert_eq!(answer.archive.reason.as_deref(), Some("no creds"));
}

#[test]
fn all_accounts_blind_when_roster_empty() {
    let dir = tmp("join-blind");
    let timeline = write_timeline(&dir, &[]);
    let usage_paths = UsagePaths::under(&dir);
    let answer = list_all_accounts(ListAllAccountsInput {
        now: 1.0,
        live_account_id: None,
        timeline_path: &timeline,
        usage_paths: &usage_paths,
        refresh_capability: (true, None),
    });
    assert!(answer.blind);
    assert!(answer.accounts.is_empty());
}
