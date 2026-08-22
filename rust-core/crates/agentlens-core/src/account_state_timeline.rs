//! Port of the shared helpers in src/accountStateTimeline.ts (TRDD-YQZ9P8IL, ported under
//! TRDD-DMWOBWFH P4x.2c) — the human PLAN name, the human billing MODE, and the raw auth regime.
//!
//! They live in their own module for the same reason they do in TS: `get_account_status` and the
//! account-state sampler must produce the SAME plan and mode strings, and the way to guarantee that
//! is one implementation, not two that agree today.
//!
//! `resolve_state_at` and `build_account_state_record` are both ported below; only
//! `get_account_state_at` (the tool wrapper around them) is not.

use std::io::Write as _;
use std::path::PathBuf;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::burn::account_info::AccountInfo;
use crate::burn::cache_ttl::{classify_ttl_regime, SessionTtlKind, TtlContext};
use crate::summarize::helpers;

/// `default_claude_max_5x` → "5". Hoisted: compiling a Regex inside a per-call function is the
/// clippy `regex_creation_in_loops` shape and pointless work on a hot path.
fn tier_multiplier_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(\d+)x\b").unwrap())
}

/// The human plan name from planType + the rate-limit tier's multiplier.
///
/// The DEFAULT arm is not a catch-all "unknown": an unrecognised `planType` is echoed VERBATIM with
/// the multiplier, because a plan name this code has not heard of is still the truth about the
/// account, and replacing it with "unknown" would hide a real answer behind a placeholder.
pub fn describe_plan(plan_type: Option<&str>, rate_limit_tier: Option<&str>) -> String {
    let tier = rate_limit_tier.unwrap_or("").to_lowercase();
    let mult = tier_multiplier_re().captures(&tier).map(|c| c[1].to_owned());
    // ` 5x`, not ` 5` — the `x` belongs to the SUFFIX in the TS, so `Max` + suffix is "Max 5x".
    let suffix = mult.as_ref().map_or(String::new(), |m| format!(" {m}x"));
    match plan_type.unwrap_or("").to_lowercase().as_str() {
        "max" => format!("Max{suffix}"),
        "pro" => "Pro".to_owned(),
        "team" => "Team".to_owned(),
        "enterprise" => "Enterprise".to_owned(),
        "free" => "Free".to_owned(),
        _ => match plan_type.filter(|p| !p.is_empty()) {
            // TS truthiness: an EMPTY planType is falsy and falls to the multiplier branch.
            Some(p) => format!("{p}{suffix}"),
            None => mult.map_or_else(|| "unknown".to_owned(), |m| format!("Max {m}x")),
        },
    }
}

/// The billing MODE in human words from the resolved auth regime.
pub fn describe_account_mode(auth_regime: Option<&str>) -> &'static str {
    match auth_regime {
        Some("subscription") => "subscription (within plan)",
        Some("usage-credits") => "subscription drawing usage credits (over plan limit)",
        Some("api-key") => "API key (pay-per-token)",
        _ => "unresolved",
    }
}

/// The raw auth regime from ttlCtx (preferred) or a coarse billingType read.
///
/// The SUBSTRING match is load-bearing: the real value is `stripe_subscription`, and an equality
/// check against "subscription" misreads a paying subscriber as an api-key account — which flips
/// the whole cache-TTL model (1h tier vs 5m) and every cost number derived from it.
/// A null billingType yields null, never a guess.
pub fn resolve_auth_regime_label(account: Option<&AccountInfo>, ttl_ctx: Option<&TtlContext>) -> Option<String> {
    // `ttlCtx?.auth ?? …` — the TS TtlContext always carries an `auth`, so a present ctx always
    // wins, including its 'unknown'.
    if let Some(ctx) = ttl_ctx {
        return Some(ctx.auth.as_str().to_owned());
    }
    let billing = account?.billing_type.as_deref().filter(|b| !b.is_empty())?;
    Some(if billing.to_lowercase().contains("subscription") { "subscription" } else { "api-key" }.to_owned())
}

/// `AGENTLENS_ACCOUNT_STATE_LOG || dataPath('account-state.ndjson')` — a FALSY-or, so an empty
/// override falls through to the data dir rather than resolving to the empty path.
pub fn account_state_timeline_path(data_dir: &std::path::Path) -> std::path::PathBuf {
    match std::env::var("AGENTLENS_ACCOUNT_STATE_LOG") {
        Ok(v) if !v.is_empty() => std::path::PathBuf::from(v),
        _ => data_dir.join("account-state.ndjson"),
    }
}

/// The NDJSON state timeline, oldest first. A missing or unreadable file is an EMPTY timeline, never
/// an error: "we have never observed an account" is a real answer, and throwing here would turn a
/// first run into a failure. A torn line is skipped individually — one bad record must not discard
/// the history around it — and a record without a numeric `ts` is dropped because the binary search
/// below is only sound on an ordered, dated list.
pub fn read_timeline(path: &std::path::Path) -> Vec<serde_json::Value> {
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    text.split('\n')
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter(|r| r.get("ts").and_then(serde_json::Value::as_f64).is_some())
        .collect()
}

/// The newest record at or BEFORE `ts` — the account state in force at that moment.
///
/// Binary search over the append-ordered timeline: `records[mid].ts <= ts` moves the answer forward,
/// so the result is the LAST record that does not postdate the query. `None` means the timeline does
/// not reach back that far, which the caller must report as a gap rather than as "no account".
pub fn resolve_state_at(ts: f64, path: &std::path::Path) -> Option<serde_json::Value> {
    let records = read_timeline(path);
    let t = |r: &serde_json::Value| r.get("ts").and_then(serde_json::Value::as_f64).unwrap_or(f64::NAN);
    let (mut lo, mut hi, mut ans) = (0i64, records.len() as i64 - 1, -1i64);
    while lo <= hi {
        let mid = (lo + hi) >> 1;
        if t(&records[mid as usize]) <= ts {
            ans = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    (ans >= 0).then(|| records[ans as usize].clone())
}

/// Build the current state record — key order `ts, accountId, email, mode, plan, authRegime,
/// ttlMinutes, ttlSource` matches the TS wire shape exactly (the parity fixtures compare by key,
/// but keeping order identical makes a raw diff readable too). `now_ms` is injected, never read
/// from a clock here, so callers (and tests) control the timestamp.
pub fn build_account_state_record(account: Option<&AccountInfo>, ttl_ctx: Option<&TtlContext>, now_ms: f64) -> Map<String, Value> {
    let auth_regime = resolve_auth_regime_label(account, ttl_ctx);
    // Always Main: get_account_status is a main-conversation tool, never subagent/fork — passing
    // the subagent kind here would silently halve every TTL reported.
    let ttl_regime = classify_ttl_regime(Some(SessionTtlKind::Main), ttl_ctx);
    let mut m = Map::new();
    m.insert("ts".into(), helpers::num(now_ms));
    m.insert("accountId".into(), account.and_then(|a| a.account_uuid.clone()).map_or(Value::Null, Value::from));
    // `email ?? label` — label is a plain String (always present on a real account), so a `None`
    // email falls to it even when label is empty; but a present EMPTY-STRING email is kept as-is
    // (`??`, not `||`) rather than replaced by the label.
    m.insert(
        "email".into(),
        account.map_or(Value::Null, |a| Value::from(a.email.clone().unwrap_or_else(|| a.label.clone()))),
    );
    m.insert("mode".into(), Value::from(describe_account_mode(auth_regime.as_deref())));
    // The planType is deliberately IGNORED when source == "none" — an account synthesized as a
    // placeholder has no real plan to report, however plausible its planType field looks.
    m.insert(
        "plan".into(),
        Value::from(match account {
            Some(a) if a.source != "none" => describe_plan(a.plan_type.as_deref(), a.rate_limit_tier.as_deref()),
            _ => "unknown".to_owned(),
        }),
    );
    m.insert("authRegime".into(), Value::from(auth_regime.unwrap_or_else(|| "unknown".to_owned())));
    m.insert("ttlMinutes".into(), helpers::num(ttl_regime.ttl_assumed_min));
    m.insert("ttlSource".into(), Value::from(ttl_regime.ttl_source));
    m
}

/// The discrete change-detection key. `email` and `ttlSource` are deliberately EXCLUDED — email
/// changes independently of the billing state, and including ttlSource would write a record every
/// time it flips assumed<->measured, turning a few-writes/hour timeline into a firehose. A missing
/// accountId collapses to the literal sentinel "∅" (a documented, intentional collision with any
/// record that literally carries that string). `\x01` can't appear in any of these fields, unlike
/// a comma.
fn discrete_key(r: &Map<String, Value>) -> String {
    let account_id = match r.get("accountId") {
        Some(Value::String(s)) => s.clone(),
        _ => "∅".to_owned(),
    };
    let s = |k: &str| r.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    let ttl_minutes = r.get("ttlMinutes").and_then(Value::as_f64).map_or_else(String::new, |n| helpers::num(n).to_string());
    [account_id, s("mode"), s("plan"), s("authRegime"), ttl_minutes].join("\u{1}")
}

/// The change-detected, buffered, fsync-on-flush timeline writer — no auto timer here (alcore's
/// own chore drives `flush()` on its schedule, same split as every other chore in this crate).
pub struct AccountStateTimeline {
    file_path: PathBuf,
    buffer: Vec<Map<String, Value>>,
    buffered_bytes: usize,
    last_key: Option<String>,
}

impl AccountStateTimeline {
    const FLUSH_MAX_RECORDS: usize = 32;
    const FLUSH_MAX_BYTES: usize = 16 * 1024;

    /// Seeds `last_key` from the LAST line of the file, so a restart into an unchanged state does
    /// not re-log it. Any failure (absent file, unreadable, torn tail) seeds `None` rather than
    /// erroring — a fresh timeline is a legitimate starting state, not a fault.
    pub fn open(file_path: PathBuf) -> Self {
        let last_key = std::fs::read_to_string(&file_path).ok().and_then(|text| {
            text.split('\n')
                .rfind(|l| !l.trim().is_empty())
                .and_then(|line| serde_json::from_str::<Map<String, Value>>(line).ok())
                .map(|r| discrete_key(&r))
        });
        Self { file_path, buffer: Vec::new(), buffered_bytes: 0, last_key }
    }

    /// Enqueue `state` iff its discrete key differs from the last enqueued one. Returns true when a
    /// change was recorded. Auto-flushes once either bound is hit.
    pub fn record(&mut self, state: Map<String, Value>) -> bool {
        let key = discrete_key(&state);
        if Some(&key) == self.last_key.as_ref() {
            return false;
        }
        self.last_key = Some(key);
        self.buffered_bytes += serde_json::to_string(&state).map_or(0, |s| s.len() + 1);
        self.buffer.push(state);
        if self.buffer.len() >= Self::FLUSH_MAX_RECORDS || self.buffered_bytes >= Self::FLUSH_MAX_BYTES {
            self.flush();
        }
        true
    }

    /// Append the buffered batch as NDJSON and fsync ONCE per batch — never per record, which is
    /// the SSD killer this design exists to avoid. A write failure re-buffers the batch IN FRONT of
    /// anything enqueued meanwhile (order preserved) and never panics — losing it would be silent
    /// data loss, and the buffer stays bounded in practice because discrete changes are rare.
    pub fn flush(&mut self) {
        if self.buffer.is_empty() {
            return;
        }
        let batch = std::mem::take(&mut self.buffer);
        self.buffered_bytes = 0;
        let mut lines = String::new();
        for r in &batch {
            if let Ok(s) = serde_json::to_string(r) {
                lines.push_str(&s);
                lines.push('\n');
            }
        }
        let result = (|| -> std::io::Result<()> {
            if let Some(dir) = self.file_path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&self.file_path)?;
            f.write_all(lines.as_bytes())?;
            f.sync_all()
        })();
        if result.is_err() {
            self.buffered_bytes = lines.len();
            let mut restored = batch;
            restored.append(&mut self.buffer);
            self.buffer = restored;
        }
    }

    /// Records currently buffered (unflushed) — test seam.
    pub fn buffered(&self) -> usize {
        self.buffer.len()
    }
}
