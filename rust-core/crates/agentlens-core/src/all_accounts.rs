//! Port of src/allAccounts.ts (issue #8 / TRDD-1UTH3B3V) — the account-roster reads that back
//! `get_account_status(all: true)`. Ported under TRDD-DMWOBWFH slice B5.
//!
//! SCOPE: `listAllAccounts` + `classifyWindow` + the two roster/archive reads it joins
//! (`listAccountRoster`, `listObservedAccountUsage`) + `usageRefreshCapability`. NOT ported:
//! `selectAccountsWithHeadroom` (the `--model` rotator query) — it is not on the path to
//! `get_account_status(all: true)`, which this slice targets; port it separately if/when needed.
//!
//! TWO DEPENDENCIES ARE NOT YET THEIR OWN RUST FUNCTIONS, so this file self-contains local ports
//! rather than editing the modules that will eventually own them (out of this slice's scope):
//!   - `listAccountRoster`/`AccountRosterEntry` (src/accountStateTimeline.ts) — that file's own doc
//!     comment says "NOT PORTED YET". Built here on top of the already-ported, public
//!     `account_state_timeline::read_timeline`.
//!   - `listObservedAccountUsage`/`usageRefreshCapability` (src/subscriptionUsage.ts) — the
//!     directory-scan/legacy-adoption orchestration is new here; it is built entirely on the
//!     already-ported primitives (`read_cache`, `normalize_cache_record`, `archive_account_usage`,
//!     `keychain_read_allowed`, `UsagePaths`) so there is exactly one copy of each of THOSE rules.
//!
//! `SubscriptionUsage`/`UsageLimit` are deliberately NOT given typed Rust structs here:
//! subscription_usage.rs's own convention is `serde_json::Value` end to end (its module doc says
//! so), and introducing a second typed representation of the same wire shape is exactly the kind
//! of duplicate-source-of-truth this codebase's CLAUDE.md forbids. Every read below is a `Value`
//! field access, mirroring `normalize()`'s own key names.
//!
//! CLOCK DISCIPLINE: every function that needs "now" takes it as an explicit `f64` millisecond
//! parameter — never `SystemTime::now()` inside. `classifyWindow`'s whole job is a deterministic
//! function of a supplied clock, and a hidden clock read would make it untestable and, worse,
//! would make two calls in the same request disagree if a real clock ticked between them.

use std::collections::HashMap;
use std::path::Path;

use serde_json::{Map, Value};

use crate::account_state_timeline::read_timeline;
use crate::subscription_usage::{
    archive_account_usage, keychain_read_allowed, normalize_cache_record, read_cache, UsagePaths,
    TTL_MS,
};
use crate::summarize::helpers::parse_iso_ms;

// ---------------------------------------------------------------------------------------------
// Small Value helpers — no unwrap on parsed/untrusted data anywhere in this file.
// ---------------------------------------------------------------------------------------------

/// A finite JSON number, or None for anything else (absent key, null, NaN, a string, ±Infinity —
/// serde_json never represents ±Infinity anyway, so this is really "present numeric or not").
fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|n| n.is_finite())
}

/// A non-empty-or-not JSON string, verbatim (an empty string IS a value, distinct from absent).
fn opt_str(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::to_owned)
}

fn num_or_null(v: Option<f64>) -> Value {
    v.and_then(serde_json::Number::from_f64)
        .map_or(Value::Null, Value::Number)
}

fn str_or_null(v: &Option<String>) -> Value {
    v.clone().map_or(Value::Null, Value::String)
}

fn bool_or_null(v: Option<bool>) -> Value {
    v.map_or(Value::Null, Value::Bool)
}

// ---------------------------------------------------------------------------------------------
// WindowFreshness / WindowBound — the classification vocabulary.
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowFreshness {
    Fresh,
    Aged,
    Rolled,
    Stale,
    Unreadable,
}

impl WindowFreshness {
    pub fn as_str(self) -> &'static str {
        match self {
            WindowFreshness::Fresh => "fresh",
            WindowFreshness::Aged => "aged",
            WindowFreshness::Rolled => "rolled",
            WindowFreshness::Stale => "stale",
            WindowFreshness::Unreadable => "unreadable",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowBound {
    Exact,
    Lower,
    Inferred,
    Unknown,
}

impl WindowBound {
    pub fn as_str(self) -> &'static str {
        match self {
            WindowBound::Exact => "exact",
            WindowBound::Lower => "lower",
            WindowBound::Inferred => "inferred",
            WindowBound::Unknown => "unknown",
        }
    }
}

/// `const BOUND: Record<WindowFreshness, WindowBound>` — the ONE place the two vocabularies meet.
fn bound_for(f: WindowFreshness) -> WindowBound {
    match f {
        WindowFreshness::Fresh => WindowBound::Exact,
        WindowFreshness::Aged => WindowBound::Lower,
        WindowFreshness::Rolled => WindowBound::Inferred,
        WindowFreshness::Stale | WindowFreshness::Unreadable => WindowBound::Unknown,
    }
}

/// `const SEVERITY: Record<WindowFreshness, number>` — worst-wins rank for folding two window
/// verdicts into one account verdict.
fn severity_for(f: WindowFreshness) -> u8 {
    match f {
        WindowFreshness::Fresh => 0,
        WindowFreshness::Aged => 1,
        WindowFreshness::Rolled => 2,
        WindowFreshness::Stale => 3,
        WindowFreshness::Unreadable => 4,
    }
}

#[derive(Debug, Clone)]
pub struct AccountWindow {
    pub percent: Option<f64>,
    pub resets_at: Option<String>,
    pub freshness: WindowFreshness,
    pub bound: WindowBound,
    pub reason: Option<String>,
}

impl AccountWindow {
    /// Key order matches the TS object literal: percent, resetsAt, freshness, bound, reason.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("percent".into(), num_or_null(self.percent));
        m.insert("resetsAt".into(), str_or_null(&self.resets_at));
        m.insert("freshness".into(), Value::String(self.freshness.as_str().to_owned()));
        m.insert("bound".into(), Value::String(self.bound.as_str().to_owned()));
        m.insert("reason".into(), str_or_null(&self.reason));
        Value::Object(m)
    }
}

/// `mkWindow` — the one constructor, so `bound` can never be forgotten at a call site.
fn mk_window(
    percent: Option<f64>,
    resets_at: Option<String>,
    freshness: WindowFreshness,
    reason: Option<String>,
) -> AccountWindow {
    AccountWindow { percent, resets_at, freshness, bound: bound_for(freshness), reason }
}

fn unreadable(reason: &str) -> AccountWindow {
    mk_window(None, None, WindowFreshness::Unreadable, Some(reason.to_owned()))
}

/// Port of `classifyWindow`. `leftAt` is the whole game — see the TS doc comment for the full
/// rationale; the short version: an account left BEFORE its window reset is knowably idle in that
/// new window (`rolled`, ~0%, INFERRED); an account still live after the reset is NOT (`stale`,
/// unknown). `label_suspect` disables the `rolled` inference because `left_at` itself is derived
/// from the timeline's accountId claim, and a mismatched label means that claim is unfounded.
pub fn classify_window(
    percent: Option<f64>,
    resets_at: Option<&str>,
    fetched_at: f64,
    left_at: Option<f64>,
    now: f64,
    label_suspect: bool,
) -> AccountWindow {
    let Some(percent) = percent else {
        return unreadable("this window was absent from the reading");
    };
    let reset_ms = resets_at.and_then(parse_iso_ms);
    let has_reset = matches!(reset_ms, Some(r) if r.is_finite() && r <= now);

    if !has_reset {
        if now - fetched_at < TTL_MS {
            return mk_window(Some(percent), resets_at.map(str::to_owned), WindowFreshness::Fresh, None);
        }
        return mk_window(
            Some(percent),
            resets_at.map(str::to_owned),
            WindowFreshness::Aged,
            Some(
                "read outside the cache TTL, but this window has not reset since — utilization only \
                 grows, so treat it as a LOWER bound"
                    .to_owned(),
            ),
        );
    }

    // The window reset, so the number describes a window that no longer exists. Compare against the
    // RESET INSTANT, not the reading — an account left at/before the reset had no local traffic in
    // the new window at all.
    let reset_ms = reset_ms.expect("has_reset implies Some(finite)");
    if let Some(l) = left_at {
        if l <= reset_ms && !label_suspect {
            return mk_window(
                Some(0.0),
                None,
                WindowFreshness::Rolled,
                Some(
                    "INFERRED, not measured: the window has reset since this reading, and this machine \
                     was already off the account when the new window began — so no local activity can \
                     have filled it. Breaks if the account is used from another host."
                        .to_owned(),
                ),
            );
        }
    }
    let reason = if label_suspect {
        "the window reset after this reading, and the reading's own account does not match the one \
         ~/.claude.json claims — so \"this machine left the account\" cannot be established and the \
         window may be filling under a credential the config does not name"
            .to_owned()
    } else if left_at.is_none() {
        "the window has reset since this reading and the account is still the one this machine is on \
         — the old number is void and the new window has not been read"
            .to_owned()
    } else {
        "the window has reset since this reading, but this machine was still on the account after the \
         new window began — activity in it cannot be excluded"
            .to_owned()
    };
    mk_window(None, None, WindowFreshness::Stale, Some(reason))
}

/// `l.kind === 'weekly_scoped' && l.scopeLabel !== null`, verbatim, one per model bucket.
#[derive(Debug, Clone)]
pub struct ModelWindow {
    pub model: String,
    pub window: AccountWindow,
}

impl ModelWindow {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("model".into(), Value::String(self.model.clone()));
        if let Value::Object(w) = self.window.to_json() {
            for (k, v) in w {
                m.insert(k, v);
            }
        }
        Value::Object(m)
    }
}

// ---------------------------------------------------------------------------------------------
// Local port of listAccountRoster (src/accountStateTimeline.ts) — see module doc: that file does
// not have it yet, so it lives here, built on the already-ported `read_timeline`.
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct AccountRosterEntry {
    pub account_id: Option<String>,
    pub email: Option<String>,
    pub plan: String,
    pub mode: String,
    pub auth_regime: String,
    pub first_seen: f64,
    pub last_state_change: f64,
    pub left_at: Option<f64>,
}

fn roster_key(r: &Value) -> Option<String> {
    let k = opt_str(r.get("accountId")).or_else(|| opt_str(r.get("email"))).unwrap_or_default();
    if k.is_empty() {
        None
    } else {
        Some(k)
    }
}

/// Every account in the timeline, most-recently-active first. Latest-wins for descriptive fields
/// (a plan upgrade must not be reported from the oldest record).
pub fn list_account_roster(timeline_path: &Path) -> Vec<AccountRosterEntry> {
    let records = read_timeline(timeline_path);
    let mut by: HashMap<String, AccountRosterEntry> = HashMap::new();
    for i in 0..records.len() {
        let r = &records[i];
        let Some(key) = roster_key(r) else { continue };
        // The end of THIS record's live run: the ts of the next record naming a DIFFERENT account.
        let mut left_at: Option<f64> = None;
        for jr in records.iter().skip(i + 1) {
            let jkey = opt_str(jr.get("accountId")).or_else(|| opt_str(jr.get("email"))).unwrap_or_default();
            if jkey != key {
                left_at = num(jr.get("ts"));
                break;
            }
        }
        let ts = num(r.get("ts")).unwrap_or(f64::NAN);
        let first_seen = by.get(&key).map_or(ts, |p| p.first_seen);
        by.insert(
            key,
            AccountRosterEntry {
                account_id: opt_str(r.get("accountId")),
                email: opt_str(r.get("email")),
                plan: opt_str(r.get("plan")).unwrap_or_default(),
                mode: opt_str(r.get("mode")).unwrap_or_default(),
                auth_regime: opt_str(r.get("authRegime")).unwrap_or_default(),
                first_seen,
                last_state_change: ts,
                left_at,
            },
        );
    }
    let mut out: Vec<AccountRosterEntry> = by.into_values().collect();
    out.sort_by(|a, b| {
        b.last_state_change.partial_cmp(&a.last_state_change).unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

// ---------------------------------------------------------------------------------------------
// Local port of listObservedAccountUsage + usageRefreshCapability (src/subscriptionUsage.ts).
// Built entirely on the already-ported primitives so there is exactly one copy of each rule.
// ---------------------------------------------------------------------------------------------

/// `UUID_SHAPE` — refused rather than sanitized: anything not shaped like a uuid is not an
/// identity we can file under.
fn is_uuid_shape(s: &str) -> bool {
    let groups = [8, 4, 4, 4, 12];
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == groups.len()
        && parts.iter().zip(groups).all(|(p, n)| p.len() == n && p.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Every account this machine has ever fetched a reading for, newest-first. Adopts the legacy
/// single-file cache on the way past (only when strictly newer than what is already filed), then
/// scans the per-account archive directory.
pub fn list_observed_account_usage(paths: &UsagePaths) -> Vec<Value> {
    if let Some(legacy) = read_cache(&paths.cache) {
        if let Some(uuid) = legacy.get("accountUuid").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            if is_uuid_shape(uuid) {
                let dest = paths.account_dir.join(format!("{uuid}.json"));
                let existing = std::fs::read_to_string(&dest)
                    .ok()
                    .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                    .and_then(|v| normalize_cache_record(Some(&v)));
                let legacy_fetched = num(legacy.get("fetchedAt")).unwrap_or(f64::NEG_INFINITY);
                let stale = existing.as_ref().is_none_or(|e| {
                    let e_fetched = num(e.get("fetchedAt")).unwrap_or(f64::INFINITY);
                    legacy_fetched > e_fetched
                });
                if stale {
                    archive_account_usage(Some(&legacy), &paths.account_dir);
                }
            }
        }
    }
    let Ok(entries) = std::fs::read_dir(&paths.account_dir) else { return Vec::new() };
    let mut out: Vec<Value> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(stem) = name.strip_suffix(".json") else { continue }; // skips any .tmp-<pid>
        if !is_uuid_shape(stem) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
        let Ok(parsed) = serde_json::from_str::<Value>(&text) else { continue };
        if let Some(rec) = normalize_cache_record(Some(&parsed)) {
            out.push(rec);
        }
    }
    out.sort_by(|a, b| {
        let fa = num(a.get("fetchedAt")).unwrap_or(f64::NEG_INFINITY);
        let fb = num(b.get("fetchedAt")).unwrap_or(f64::NEG_INFINITY);
        fb.partial_cmp(&fa).unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

/// Port of `usageRefreshCapability` — answered WITHOUT reading a credential, so an aged archive can
/// be told apart from an archive that can never refresh again.
pub fn usage_refresh_capability(
    config_dir: Option<&Path>,
    home: &Path,
    data_dir: &Path,
    vars: &HashMap<String, String>,
    is_darwin: bool,
) -> (bool, Option<String>) {
    let base = config_dir.map_or_else(|| home.join(".claude"), Path::to_path_buf);
    let creds = base.join(".credentials.json");
    if creds.exists() {
        return (true, None);
    }
    if !is_darwin {
        return (false, Some(format!("no credentials file at {}", creds.display())));
    }
    if keychain_read_allowed(data_dir, vars) {
        return (true, None);
    }
    (
        false,
        Some(
            "the credential is in the macOS keychain and reading it is opt-in — the archive will not \
             refresh until `agentlenspro config set readKeychainUsage on` (or \
             AGENTLENS_READ_KEYCHAIN_USAGE=1)"
                .to_owned(),
        ),
    )
}

// ---------------------------------------------------------------------------------------------
// listAllAccounts — the join.
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct AccountStatusRow {
    pub account_id: Option<String>,
    pub email: Option<String>,
    pub is_live: bool,
    pub plan: String,
    pub mode: String,
    pub auth_regime: String,
    pub observed_at: Option<f64>,
    pub stale_seconds: Option<f64>,
    pub left_at: Option<f64>,
    pub five_hour: AccountWindow,
    pub seven_day: AccountWindow,
    pub scoped_weekly: Vec<Value>,
    pub model_windows: Vec<ModelWindow>,
    pub usage_credits_enabled: Option<bool>,
    pub freshness: WindowFreshness,
    pub account_label_suspect: bool,
}

impl AccountStatusRow {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("accountId".into(), str_or_null(&self.account_id));
        m.insert("email".into(), str_or_null(&self.email));
        m.insert("isLive".into(), Value::Bool(self.is_live));
        m.insert("plan".into(), Value::String(self.plan.clone()));
        m.insert("mode".into(), Value::String(self.mode.clone()));
        m.insert("authRegime".into(), Value::String(self.auth_regime.clone()));
        m.insert("observedAt".into(), num_or_null(self.observed_at));
        m.insert("staleSeconds".into(), num_or_null(self.stale_seconds));
        m.insert("leftAt".into(), num_or_null(self.left_at));
        m.insert("fiveHour".into(), self.five_hour.to_json());
        m.insert("sevenDay".into(), self.seven_day.to_json());
        m.insert("scopedWeekly".into(), Value::Array(self.scoped_weekly.clone()));
        m.insert(
            "modelWindows".into(),
            Value::Array(self.model_windows.iter().map(ModelWindow::to_json).collect()),
        );
        m.insert("usageCreditsEnabled".into(), bool_or_null(self.usage_credits_enabled));
        m.insert("freshness".into(), Value::String(self.freshness.as_str().to_owned()));
        m.insert("accountLabelSuspect".into(), Value::Bool(self.account_label_suspect));
        Value::Object(m)
    }
}

#[derive(Debug, Clone)]
pub struct ArchiveStatus {
    pub maintained: bool,
    pub reason: Option<String>,
    pub last_observed_at: Option<f64>,
}

impl ArchiveStatus {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("maintained".into(), Value::Bool(self.maintained));
        m.insert("reason".into(), str_or_null(&self.reason));
        m.insert("lastObservedAt".into(), num_or_null(self.last_observed_at));
        Value::Object(m)
    }
}

#[derive(Debug, Clone)]
pub struct AllAccountsAnswer {
    pub accounts: Vec<AccountStatusRow>,
    pub live_account_id: Option<String>,
    pub blind: bool,
    pub archive: ArchiveStatus,
    pub note: String,
}

impl AllAccountsAnswer {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert(
            "accounts".into(),
            Value::Array(self.accounts.iter().map(AccountStatusRow::to_json).collect()),
        );
        m.insert("liveAccountId".into(), str_or_null(&self.live_account_id));
        m.insert("blind".into(), Value::Bool(self.blind));
        m.insert("archive".into(), self.archive.to_json());
        m.insert("note".into(), Value::String(self.note.clone()));
        Value::Object(m)
    }
}

fn pick_limit<'a>(u: &'a Value, kind: &str) -> Option<&'a Value> {
    u.get("limits")?
        .as_array()?
        .iter()
        .find(|l| l.get("kind").and_then(Value::as_str) == Some(kind))
}

/// Inputs to `list_all_accounts`, grouped so the call site cannot transpose two `&Path`s or two
/// `Option<&str>`s by argument position.
pub struct ListAllAccountsInput<'a> {
    pub now: f64,
    pub live_account_id: Option<&'a str>,
    pub timeline_path: &'a Path,
    pub usage_paths: &'a UsagePaths,
    /// `usageRefreshCapability()`'s result — computed by the caller (it needs env/home/platform,
    /// which are orthogonal to "join the roster with the archive").
    pub refresh_capability: (bool, Option<String>),
}

/// Port of `listAllAccounts` — join the roster (who exists) with the per-account usage archive
/// (their last true numbers).
pub fn list_all_accounts(input: ListAllAccountsInput) -> AllAccountsAnswer {
    let roster = list_account_roster(input.timeline_path);
    let mut usage_by_uuid: HashMap<String, Value> = HashMap::new();
    for u in list_observed_account_usage(input.usage_paths) {
        // list_observed_account_usage is newest-first, so the first record for a uuid is freshest.
        if let Some(uuid) = u.get("accountUuid").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            usage_by_uuid.entry(uuid.to_owned()).or_insert(u);
        }
    }
    let live_account_id = input.live_account_id.map(str::to_owned);

    let accounts: Vec<AccountStatusRow> = roster
        .into_iter()
        .map(|r| {
            let is_live = r.account_id.is_some() && r.account_id.as_deref() == live_account_id.as_deref();
            // An account live RIGHT NOW has not been left, whatever the timeline's last record says.
            let left_at = if is_live { None } else { r.left_at };
            let u = r.account_id.as_ref().and_then(|id| usage_by_uuid.get(id));

            let Some(u) = u else {
                let reason = "no usage reading has ever been captured for this account — NOT the \
                    same as an empty or a full window";
                return AccountStatusRow {
                    account_id: r.account_id,
                    email: r.email,
                    is_live,
                    plan: r.plan,
                    mode: r.mode,
                    auth_regime: r.auth_regime,
                    observed_at: None,
                    stale_seconds: None,
                    left_at,
                    five_hour: unreadable(reason),
                    seven_day: unreadable(reason),
                    scoped_weekly: Vec::new(),
                    model_windows: Vec::new(),
                    usage_credits_enabled: None,
                    freshness: WindowFreshness::Unreadable,
                    account_label_suspect: false,
                };
            };

            let label_suspect = u.get("accountLabelSuspect") == Some(&Value::Bool(true));
            let fetched_at = num(u.get("fetchedAt")).unwrap_or(0.0);

            let session = pick_limit(u, "session");
            let five_hour_percent =
                session.map_or_else(|| num(u.get("fiveHourPercent")), |s| num(s.get("percent")));
            let five_hour_resets = session.and_then(|s| opt_str(s.get("resetsAt")));
            let five_hour = classify_window(
                five_hour_percent, five_hour_resets.as_deref(), fetched_at, left_at, input.now,
                label_suspect,
            );

            let weekly = pick_limit(u, "weekly_all");
            let seven_day_percent =
                weekly.map_or_else(|| num(u.get("sevenDayPercent")), |w| num(w.get("percent")));
            let seven_day_resets = weekly.and_then(|w| opt_str(w.get("resetsAt")));
            let seven_day = classify_window(
                seven_day_percent, seven_day_resets.as_deref(), fetched_at, left_at, input.now,
                label_suspect,
            );

            let empty_limits: Vec<Value> = Vec::new();
            let limits = u.get("limits").and_then(Value::as_array).unwrap_or(&empty_limits);
            let scoped_weekly: Vec<Value> = limits
                .iter()
                .filter(|l| l.get("kind").and_then(Value::as_str) == Some("weekly_scoped"))
                .cloned()
                .collect();
            let model_windows: Vec<ModelWindow> = limits
                .iter()
                .filter(|l| {
                    l.get("kind").and_then(Value::as_str) == Some("weekly_scoped")
                        && l.get("scopeLabel").is_some_and(|v| !v.is_null())
                })
                .map(|l| {
                    let model = l.get("scopeLabel").and_then(Value::as_str).unwrap_or_default().to_owned();
                    let percent = num(l.get("percent"));
                    let resets_at = opt_str(l.get("resetsAt"));
                    let window = classify_window(
                        percent, resets_at.as_deref(), fetched_at, left_at, input.now, label_suspect,
                    );
                    ModelWindow { model, window }
                })
                .collect();

            let email = r.email.or_else(|| opt_str(u.get("accountLabel")));
            let stale_seconds = ((input.now - fetched_at) / 1000.0).round().max(0.0);
            let usage_credits_enabled = u.get("usageCreditsEnabled").and_then(Value::as_bool);
            let freshness = if severity_for(five_hour.freshness) >= severity_for(seven_day.freshness) {
                five_hour.freshness
            } else {
                seven_day.freshness
            };

            AccountStatusRow {
                account_id: r.account_id,
                email,
                is_live,
                plan: r.plan,
                mode: r.mode,
                auth_regime: r.auth_regime,
                observed_at: Some(fetched_at),
                stale_seconds: Some(stale_seconds),
                left_at,
                five_hour,
                seven_day,
                scoped_weekly,
                model_windows,
                usage_credits_enabled,
                freshness,
                account_label_suspect: label_suspect,
            }
        })
        .collect();

    let last_observed_at = accounts
        .iter()
        .filter_map(|a| a.observed_at)
        .fold(None, |acc: Option<f64>, x| Some(acc.map_or(x, |a| a.max(x))));
    let blind = accounts.is_empty();

    AllAccountsAnswer {
        accounts,
        live_account_id,
        blind,
        archive: ArchiveStatus {
            maintained: input.refresh_capability.0,
            reason: input.refresh_capability.1,
            last_observed_at,
        },
        note: "Every row is what was OBSERVED while that account was live — no credential is read to \
            produce it. A `rolled` window is INFERRED from its resetsAt plus this machine having been \
            off the account; check `leftAt` before acting on it."
            .to_owned(),
    }
}
