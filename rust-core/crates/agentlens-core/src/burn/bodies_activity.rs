//! Port of src/bodiesActivity.ts (TRDD-GOD0108C) — the realtime INCREMENTAL watch over the raw
//! OTEL bodies dir. Response bodies land the instant calls complete and carry Anthropic's EXACT
//! usage (cache_creation/cache_read) + model — the only realtime feed that can see the
//! "invalidating most of the cache EVERY turn" pattern (CACHE_THRASH).
//!
//! Incremental BY CONSTRUCTION, not heuristically: bodies are WRITE-ONCE (the collector never
//! rewrites a body file), so a name seen once can never become "new" again — readdir + stat ONLY
//! unseen names is exact. First poll pays one seeded pass; every later poll is O(new files).
//!
//! Every error path is fail-open: worst case the report says quiet.

use indexmap::IndexMap;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::{CoreState, LockTimed};

use crate::summarize::helpers::{find_session_id, js_slice, js_to_fixed_num, num};

const RESPONSE_PARSE_CAP: u64 = 5 * 1024 * 1024;
const HUGE_REQUEST_BYTES: u64 = 1_000_000;
/// A 100k-token cache write ≈ a ~400KB request, so fat-but-not-huge requests still get their
/// sender extracted — that is what lets thrash suspects be named.
const ATTRIB_REQUEST_BYTES: u64 = 400_000;
const LARGE_RING_WINDOW_MS: f64 = 10.0 * 60_000.0;
const RESPONSE_RING_WINDOW_MS: f64 = 15.0 * 60_000.0;
const SEED_LOOKBACK_MS: f64 = 15.0 * 60_000.0;

fn is_premium(model: &str) -> bool {
    let m = model.to_lowercase();
    m.contains("opus") || m.contains("fable") || m.contains("mythos")
}

/// fmtFatSenders — top-`cap` senders + "+N more". `senders` are the Value shape below.
pub fn fmt_fat_senders(senders: &[Value], cap: usize) -> String {
    if senders.is_empty() {
        return "no fat-request sender attributable".to_owned();
    }
    let parts: Vec<String> = senders
        .iter()
        .take(cap)
        .map(|s| {
            let who = match s.get("session").and_then(Value::as_str) {
                Some(sid) => format!("session {}…", js_slice(sid, 8)),
                None => "unattributed sender(s)".to_owned(),
            };
            let model = s.get("model").and_then(Value::as_str).map(|m| format!("{m}, ")).unwrap_or_default();
            let count = s.get("count").and_then(Value::as_f64).unwrap_or(0.0);
            let bytes = s.get("bytes").and_then(Value::as_f64).unwrap_or(0.0);
            format!("{who} ({model}{count} fat request{} ~{:.1}MB)", if count == 1.0 { "" } else { "s" }, js_to_fixed_num(bytes / 1e6, 1))
        })
        .collect();
    let more = if senders.len() > cap { format!("; +{} more", senders.len() - cap) } else { String::new() };
    parts.join("; ") + &more
}

#[derive(Clone, Debug)]
struct LargeRequestEntry {
    t: f64,
    bytes: u64,
    huge: bool,
    session_id: Option<String>,
    model: Option<String>,
}

#[derive(Clone, Debug)]
struct ResponseEntry {
    t: f64,
    model: Option<String>,
    cc: f64,
    cr: f64,
    id: Option<String>,
    /// TRDD-DIZ289UQ: `usage.cache_creation.ephemeral_1h_input_tokens`; `None` when the response
    /// carries no `cache_creation` object (older Claude Code builds — the legacy count-only rule
    /// applies there).
    tier_1h: Option<f64>,
    /// `diagnostics.cache_miss_reason.type` — the API's own label for the miss.
    miss_reason: Option<String>,
}

/// TRDD-DIZ289UQ — bodiesActivity.ts `extractMissDiagnostics`: `(tier1h, missReason)`. What tells
/// a subagent's BOOT write apart from a caller re-writing its own prefix — measured over 205 big
/// writes in the store (2026-09-05): every main-conversation rewrite sat on the 1h tier, every
/// worker boot on the 5m tier with NO reason. The reason alone is not enough: 16 of 21 reason-less
/// opus writes were 1h-tier main-turn rewrites the API did not label (review-fork finding).
/// ponytail: on a usage-credits account main turns are 5m too — thread the gate's ttl_context in
/// if that case is ever measured.
pub fn extract_miss_diagnostics(j: &Value) -> (Option<f64>, Option<String>) {
    let Some(cand) = [Some(j), j.get("response"), j.get("body")]
        .into_iter()
        .flatten()
        .find(|x| x.get("usage").is_some_and(Value::is_object))
    else {
        return (None, None);
    };
    // A `cache_creation` object IS tiered accounting: on all 205 big writes in the store the two
    // tier keys summed to the write (never both zero), so an absent 1h key under a present object
    // is a real 0, not "unknown". Only a missing object is unknown.
    // An object with NEITHER tier key is unknown, not "0 on the 1h tier": treating it as tiered
    // would turn every reason-less big write into a boot and disarm the detector on that build.
    let tier_1h = cand
        .pointer("/usage/cache_creation")
        .filter(|c| c.is_object() && (c.get("ephemeral_5m_input_tokens").is_some() || c.get("ephemeral_1h_input_tokens").is_some()))
        .map(|c| c.get("ephemeral_1h_input_tokens").and_then(Value::as_f64).filter(|v| v.is_finite()).unwrap_or(0.0));
    (tier_1h, cand.pointer("/diagnostics/cache_miss_reason/type").and_then(Value::as_str).map(str::to_owned))
}

/// extractRequestAttribution — the bounded 6KB read on a fat request body: `"model"` in the
/// first 2KB, `metadata.user_id` (an ESCAPED JSON string carrying session_id) and
/// `diagnostics.previous_message_id` in the last 4KB. `Primary working directory` sits ~92% in
/// and is deliberately NOT sought — workspace resolution is the hook-event ring's job.
pub fn extract_request_attribution(file_path: &Path, size: u64) -> (Option<String>, Option<String>, Option<String>) {
    let read = || -> std::io::Result<(String, String)> {
        use std::io::{Read, Seek, SeekFrom};
        let mut f = std::fs::File::open(file_path)?;
        let head_len = size.min(2048) as usize;
        let mut head = vec![0u8; head_len];
        let n = f.read(&mut head)?;
        head.truncate(n);
        let tail_len = size.min(4096);
        let mut tail = vec![0u8; tail_len as usize];
        f.seek(SeekFrom::Start(size - tail_len))?;
        let n = f.read(&mut tail)?;
        tail.truncate(n);
        Ok((String::from_utf8_lossy(&head).into_owned(), String::from_utf8_lossy(&tail).into_owned()))
    };
    // Unreadable → unattributed, never fatal.
    let Ok((head, tail)) = read() else { return (None, None, None) };
    // `/"model"\s*:\s*"([^"]+)"/` on the head.
    let model = find_json_string(&head, "\"model\"");
    // `/\\?"session_id\\?":\\?"([0-9a-fA-F-]{8,36})/` — accept the escaped and plain forms.
    let session_id = find_session_id(&tail);
    // `/"previous_message_id"\s*:\s*"(msg_[A-Za-z0-9]+)"/`
    let previous_message_id = find_json_string(&tail, "\"previous_message_id\"")
        .filter(|v| v.starts_with("msg_") && v[4..].chars().all(|c| c.is_ascii_alphanumeric()) && v.len() > 4);
    (session_id, model, previous_message_id)
}

/// `"<key>"\s*:\s*"([^"]+)"` — the first match's capture, or None (the regexes are simple
/// enough that a hand scanner beats pulling in a regex engine, and it cannot backtrack).
fn find_json_string(hay: &str, quoted_key: &str) -> Option<String> {
    let mut from = 0usize;
    while let Some(i) = hay[from..].find(quoted_key) {
        let mut p = from + i + quoted_key.len();
        let b = hay.as_bytes();
        while p < b.len() && (b[p] as char).is_whitespace() {
            p += 1;
        }
        if p >= b.len() || b[p] != b':' {
            from = from + i + quoted_key.len();
            continue;
        }
        p += 1;
        while p < b.len() && (b[p] as char).is_whitespace() {
            p += 1;
        }
        if p >= b.len() || b[p] != b'"' {
            from = from + i + quoted_key.len();
            continue;
        }
        p += 1;
        let start = p;
        while p < b.len() && b[p] != b'"' {
            p += 1;
        }
        // `[^"]+` needs at least one char; an empty value is not a match.
        if p > start && p <= b.len() {
            return Some(hay[start..p].to_owned());
        }
        from = from + i + quoted_key.len();
    }
    None
}

/// extractResponseUsage — tolerant: the usage object may sit at the root, under `response`, or
/// under `body`; a non-finite/absent bucket reads 0. None when no `usage` object is found.
pub fn extract_response_usage(j: &Value) -> Option<(Option<String>, f64, f64, Option<String>)> {
    if !j.is_object() {
        return None;
    }
    let cand = [Some(j), j.get("response"), j.get("body")]
        .into_iter()
        .flatten()
        .find(|x| x.is_object() && x.get("usage").is_some_and(Value::is_object))?;
    let usage = cand.get("usage")?;
    let n = |k: &str| usage.get(k).and_then(Value::as_f64).filter(|v| v.is_finite()).unwrap_or(0.0);
    Some((
        cand.get("model").and_then(Value::as_str).map(str::to_owned),
        n("cache_creation_input_tokens"),
        n("cache_read_input_tokens"),
        cand.get("id").and_then(Value::as_str).map(str::to_owned),
    ))
}

pub struct BodiesActivityOptions {
    pub thrash_min_cc: f64,
    pub thrash_max_read_share: f64,
    pub thrash_min_count: f64,
    pub thrash_window_ms: f64,
}

impl Default for BodiesActivityOptions {
    fn default() -> Self {
        // The TS clamps: max(1_000, …), min(0.9, max(0, …)), max(2, …), max(60_000, …).
        BodiesActivityOptions { thrash_min_cc: 100_000.0, thrash_max_read_share: 0.25, thrash_min_count: 3.0, thrash_window_ms: 300_000.0 }
    }
}

impl BodiesActivityOptions {
    fn clamped(self) -> Self {
        BodiesActivityOptions {
            thrash_min_cc: self.thrash_min_cc.max(1_000.0),
            thrash_max_read_share: self.thrash_max_read_share.clamp(0.0, 0.9),
            thrash_min_count: self.thrash_min_count.max(2.0),
            thrash_window_ms: self.thrash_window_ms.max(60_000.0),
        }
    }
}

/// What one directory scan found. Produced by `BodiesPoller::scan` (read-only), consumed by
/// `BodiesActivity::merge` and then `BodiesPoller::commit`.
#[derive(Default)]
struct BodiesDelta {
    /// False when the dir could not be listed — poll then does nothing at all (fail-open).
    listed: bool,
    /// Every listed name not yet in `seen` (request/response or not, stat ok or not): today's
    /// poll inserts all of them into `seen`, so commit must too.
    new_names: Vec<String>,
    /// The whole live listing — drives the `seen` drift rebuild in commit.
    listing: Vec<String>,
    large_requests: Vec<LargeRequestEntry>,
    responses: Vec<ResponseEntry>,
    msg_session: Vec<(String, (String, f64))>,
}

/// The filesystem half: knows which names were already consumed. `scan` never mutates it.
struct BodiesPoller {
    dir: PathBuf,
    seen: HashSet<String>,
    seeded: bool,
}

/// The state half: the rings the report reads. Fed only by `merge`.
struct BodiesActivity {
    dir: PathBuf,
    opts: BodiesActivityOptions,
    large_requests: Vec<LargeRequestEntry>,
    responses: Vec<ResponseEntry>,
    /// The previous_message_id chain: a request from session S carrying previous_message_id=m
    /// proves response m belongs to S — the only realtime response→session attribution the
    /// bodies afford (response bodies carry no metadata; request/response FILES share no
    /// basename). Attribution therefore lags by exactly one call, as in TS.
    msg_session: IndexMap<String, (String, f64)>,
}

pub struct BodiesActivityTracker {
    poller: Arc<Mutex<BodiesPoller>>,
    activity: BodiesActivity,
    /// True while a background scan owns the poller; the burn tick reads it to avoid piling up
    /// spawns, and `bodiesScan.inProgress` reports it.
    in_flight: Arc<AtomicBool>,
    /// Merge time of the last applied scan (state-side, so a reader never locks the poller).
    last_merge_ms: Option<f64>,
    /// State-side copy of `BodiesPoller::seeded`, set at merge time for the same reason.
    seeded: bool,
}

impl BodiesActivityTracker {
    pub fn new(dir: PathBuf, opts: BodiesActivityOptions) -> BodiesActivityTracker {
        BodiesActivityTracker {
            poller: Arc::new(Mutex::new(BodiesPoller { dir: dir.clone(), seen: HashSet::new(), seeded: false })),
            activity: BodiesActivity { dir, opts: opts.clamped(), large_requests: Vec::new(), responses: Vec::new(), msg_session: IndexMap::new() },
            in_flight: Arc::new(AtomicBool::new(false)),
            last_merge_ms: None,
            seeded: false,
        }
    }

    /// One incremental pass, inline (scan, merge, commit). A missing dir returns silently —
    /// report() says available:false.
    ///
    /// Test-only inline scan. Never call while holding the state lock (it takes the poller: reverse lock order, deadlocks against a background scan). Production uses run_bodies_scan.
    #[doc(hidden)]
    pub fn poll(&mut self, now: f64) {
        let mut poller = self.poller.lock().unwrap_or_else(|p| p.into_inner());
        let mut d = poller.scan(now);
        if !d.listed {
            return;
        }
        // WHY this order: names enter `seen` only AFTER the merge succeeded, so a delta that is
        // scanned but never merged is simply re-read by the next scan instead of being lost.
        self.activity.merge(&mut d, now);
        self.last_merge_ms = Some(now);
        self.seeded = true;
        poller.commit(d);
    }

    pub fn session_warm_since(&self, session: &str, since_ms: f64, warm_read_floor: f64) -> bool {
        self.activity.session_warm_since(session, since_ms, warm_read_floor)
    }

    /// The BodiesActivityReport wire shape.
    pub fn report(&mut self, now: f64) -> Value {
        self.activity.report(now)
    }

    /// The `bodiesScan` block of `/api/burn-risk`: the scan runs in the background, so the
    /// report says how fresh it is instead of polling.
    pub fn scan_status(&self, now: f64) -> Value {
        let mut m = Map::new();
        m.insert("seeded".into(), Value::Bool(self.seeded));
        m.insert("inProgress".into(), Value::Bool(self.in_flight.load(Ordering::Acquire)));
        m.insert("lastMergeAgeMs".into(), self.last_merge_ms.map_or(Value::Null, |t| num(now - t)));
        Value::Object(m)
    }

    /// The flag the burn tick checks (under its state lock) before starting a background scan.
    pub fn in_flight_handle(&self) -> Arc<AtomicBool> {
        self.in_flight.clone()
    }
}

/// Clears `in_flight` on every exit path of a background scan, including a panic.
struct ClearInFlight(Arc<AtomicBool>);

impl Drop for ClearInFlight {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// One background scan of the bodies folder with NO state lock held during the filesystem work
/// (the first pass after boot held it for 534-588 s). The burn tick starts this in a blocking
/// task and never awaits it.
pub fn run_bodies_scan(state: &Arc<Mutex<CoreState>>) {
    let scan_now = crate::now_ms() as f64;
    run_bodies_scan_with(state, scan_now, || crate::now_ms() as f64, &mut || {});
}

/// `run_bodies_scan` with injectable clocks and a hook `on_entry` called once per unseen name
/// inside the scan (tests park the scan there).
///
/// Lock order: poller, then state. Nothing that holds the state lock touches the poller.
///
/// `merge_now` is read AFTER the scan on purpose: the rings are pruned against merge time (the
/// wall clock when the findings land, as the old inline poll did after its scan), while the seed
/// floor uses scan time, the moment the directory was listed. A slow first pass must not age
/// its own findings out against a clock taken before it started.
///
/// A scan that never returns (a wedged volume) leaves in_flight true and the rings stale; bodiesScan.inProgress=true with a growing lastMergeAgeMs is how that shows.
pub fn run_bodies_scan_with(state: &Arc<Mutex<CoreState>>, scan_now: f64, merge_now: impl FnOnce() -> f64, on_entry: &mut dyn FnMut()) {
    let (poller, in_flight) = {
        let st = state.lock_timed();
        (st.burn.bodies.poller.clone(), st.burn.bodies.in_flight.clone())
    };
    if in_flight.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
        return;
    }
    let _clear = ClearInFlight(in_flight);
    // A panic inside a previous scan poisons this mutex; that is safe to ignore because `scan`
    // is `&self` and `seen` changes only in `commit`, so a poisoned poller is still consistent.
    let mut poller = poller.lock().unwrap_or_else(|p| p.into_inner());
    // TRDD-2HRA270Y: opens the burn bodies scan window (list + parse of the unseen body names), taken
    // after the poller lock is held and before the scan reads the directory.
    static BURN_SCAN_START: std::sync::Once = std::sync::Once::new();
    BURN_SCAN_START.call_once(|| crate::rss_guard::log_boot_phase("burn_scan_start", None));
    let t0 = std::time::Instant::now();
    let mut d = poller.scan_with(scan_now, on_entry);
    if !d.listed {
        return;
    }
    let scan_ms = t0.elapsed().as_millis();
    let new_names = d.new_names.len();
    let t1 = std::time::Instant::now();
    let merged_at = merge_now();
    {
        let mut st = state.lock_timed();
        st.burn.bodies.activity.merge(&mut d, merged_at);
        st.burn.bodies.last_merge_ms = Some(merged_at);
        st.burn.bodies.seeded = true;
    }
    let merge_ms = t1.elapsed().as_millis();
    // Names enter `seen` only after the merge landed, so a scan that dies before it is re-read.
    poller.commit(d);
    if scan_ms >= 1000 {
        eprintln!("{} alcore: burn bodies scan {scan_ms} ms, merge {merge_ms} ms, new {new_names}", crate::log_ts());
    }
    // TRDD-2HRA270Y: taken after the scan, merge and commit, whether or not the line above printed (it
    // prints only at >= 1000 ms); with `burn_scan_start` it splits the one burn bodies scan window. NOT reached on the
    // `!d.listed` early return above (the scan listed nothing), so a later scan can pair this reading with an earlier
    // `burn_scan_start`: a `burn_scan_start` with no `burn_scan_done` after it means that scan returned early.
    static BURN_SCAN_DONE: std::sync::Once = std::sync::Once::new();
    BURN_SCAN_DONE.call_once(|| crate::rss_guard::log_boot_phase("burn_scan_done", None));
}

impl BodiesPoller {
    /// Read-only pass over the dir: lists, stats and parses every unseen name. `&self` on
    /// purpose — marking names seen is `commit`'s job, after the merge.
    fn scan(&self, scan_now: f64) -> BodiesDelta {
        self.scan_with(scan_now, &mut || {})
    }

    /// `scan`, calling `on_entry` once per unseen name before it is read.
    fn scan_with(&self, scan_now: f64, on_entry: &mut dyn FnMut()) -> BodiesDelta {
        let mut d = BodiesDelta::default();
        let Ok(rd) = std::fs::read_dir(&self.dir) else { return d };
        d.listed = true;
        let names: Vec<String> = rd.flatten().filter_map(|e| e.file_name().to_str().map(str::to_owned)).collect();
        let seed_floor = if self.seeded { 0.0 } else { scan_now - SEED_LOOKBACK_MS };
        for name in &names {
            if self.seen.contains(name) {
                continue;
            }
            on_entry();
            d.new_names.push(name.clone());
            let is_req = name.ends_with(".request.json");
            let is_resp = name.ends_with(".response.json");
            if !is_req && !is_resp {
                continue;
            }
            let path = self.dir.join(name);
            let Ok(md) = std::fs::metadata(&path) else { continue }; // raced with the archiver
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0.0, |d| d.as_secs() as f64 * 1000.0 + d.subsec_nanos() as f64 / 1e6);
            if mtime < seed_floor {
                continue; // pre-boot history beyond the seed window
            }
            let size = md.len();
            if is_req {
                if size >= ATTRIB_REQUEST_BYTES {
                    let (session_id, model, previous_message_id) = extract_request_attribution(&path, size);
                    d.large_requests.push(LargeRequestEntry { t: mtime, bytes: size, huge: size > HUGE_REQUEST_BYTES, session_id: session_id.clone(), model });
                    if let (Some(sid), Some(pm)) = (session_id, previous_message_id) {
                        d.msg_session.push((pm, (sid, mtime)));
                    }
                }
                continue;
            }
            if size > RESPONSE_PARSE_CAP {
                continue;
            }
            // Truncated mid-write or not JSON — skip.
            if let Some(body) = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
                if let Some((model, cc, cr, id)) = extract_response_usage(&body) {
                    let (tier_1h, miss_reason) = extract_miss_diagnostics(&body);
                    d.responses.push(ResponseEntry { t: mtime, model, cc, cr, id, tier_1h, miss_reason });
                }
            }
        }
        d.listing = names;
        d
    }

    /// Mark the delta's names consumed. Call only after the delta was merged.
    fn commit(&mut self, d: BodiesDelta) {
        self.seen.extend(d.new_names);
        self.seeded = true;
        // The hourly archiver removes old files; rebuild `seen` from the live listing when it
        // drifts well past the dir's contents so memory stays bounded.
        if self.seen.len() > d.listing.len() * 2 + 512 {
            self.seen = d.listing.into_iter().collect();
        }
    }
}

impl BodiesActivity {
    /// Apply a scan's findings in scan order, then age the rings out against `merge_now`.
    fn merge(&mut self, d: &mut BodiesDelta, merge_now: f64) {
        self.large_requests.extend(std::mem::take(&mut d.large_requests));
        self.responses.extend(std::mem::take(&mut d.responses));
        for (pm, v) in std::mem::take(&mut d.msg_session) {
            self.msg_session.insert(pm, v);
        }
        self.prune(merge_now);
    }

    fn prune(&mut self, now: f64) {
        // Unconditional filter: entries arrive in readdir order, NOT mtime order, so a
        // "check the head, skip the pass" shortcut could strand old entries forever.
        let l_floor = now - LARGE_RING_WINDOW_MS;
        let r_floor = now - RESPONSE_RING_WINDOW_MS;
        self.large_requests.retain(|e| e.t >= l_floor);
        self.responses.retain(|e| e.t >= r_floor);
        self.msg_session.retain(|_, v| v.1 >= r_floor);
    }

    fn session_of(&self, e: &ResponseEntry) -> Option<&str> {
        e.id.as_ref().and_then(|id| self.msg_session.get(id)).map(|(s, _)| s.as_str())
    }

    /// sessionWarmSince — the cold-resume disarm evidence: did `session` complete a WARM request
    /// after `since_ms`? Warm = a big cache_read with a small cache_creation share, i.e. proof
    /// the prompt cache survived, so holding the deny longer only blocks legitimate work.
    pub fn session_warm_since(&self, session: &str, since_ms: f64, warm_read_floor: f64) -> bool {
        self.responses
            .iter()
            .any(|e| e.t > since_ms && e.cr >= warm_read_floor && e.cc < e.cr * 0.25 && self.session_of(e) == Some(session))
    }

    /// Aggregate fat-request entries by sending session, heaviest first.
    fn senders(entries: &[&LargeRequestEntry]) -> Vec<Value> {
        let mut by: IndexMap<String, (Option<String>, Option<String>, f64, f64)> = IndexMap::new();
        for e in entries {
            let key = e.session_id.clone().unwrap_or_else(|| "(unattributed)".to_owned());
            let slot = by.entry(key).or_insert((e.session_id.clone(), e.model.clone(), 0.0, 0.0));
            slot.2 += 1.0;
            slot.3 += e.bytes as f64;
            if slot.1.is_none() {
                slot.1.clone_from(&e.model);
            }
        }
        let mut out: Vec<(Option<String>, Option<String>, f64, f64)> = by.into_values().collect();
        out.sort_by(|a, b| b.3.partial_cmp(&a.3).unwrap_or(std::cmp::Ordering::Equal));
        out.into_iter()
            .map(|(session, model, count, bytes)| {
                let mut m = Map::new();
                m.insert("session".into(), session.map_or(Value::Null, Value::from));
                m.insert("model".into(), model.map_or(Value::Null, Value::from));
                m.insert("count".into(), num(count));
                m.insert("bytes".into(), num(bytes));
                Value::Object(m)
            })
            .collect()
    }

    /// The BodiesActivityReport wire shape.
    pub fn report(&mut self, now: f64) -> Value {
        let available = std::fs::metadata(&self.dir).is_ok();
        self.prune(now);

        let huge90: Vec<&LargeRequestEntry> = self.large_requests.iter().filter(|e| e.huge && now - e.t <= 90_000.0).collect();
        let huge_count = huge90.len() as f64;
        let huge_bytes: f64 = huge90.iter().map(|e| e.bytes as f64).sum();

        let all_misses: Vec<&ResponseEntry> = self
            .responses
            .iter()
            .filter(|e| {
                if now - e.t > self.opts.thrash_window_ms {
                    return false;
                }
                let denom = e.cc + e.cr;
                e.cc > self.opts.thrash_min_cc && denom > 0.0 && e.cr / denom < self.opts.thrash_max_read_share
            })
            .collect();
        // TRDD-DIZ289UQ: ONE rule — a big 5m-tier write is a SUBAGENT's own prefix (its boot, or
        // its own turn-2 rewrite: the `cc_prev_req` prefix break the API labels `system_changed`),
        // never the caller's; on a subscription the caller's turns are 1h-tier (see
        // `extract_miss_diagnostics` for the measurement). 2026-09-04: five sonnet workers booting
        // under their parent's session id tripped "the same session re-wrote its prefix 5×" and
        // the gate blamed the launches; the real thrash that day was opus 1h-tier main-turn writes
        // the API labelled `previous_message_not_found`. A 5m write leaves `misses` entirely, so
        // `count`, `topSource` and `missReasons` all describe the same population; a 1h-tier or
        // legacy (untiered) write always counts.
        let is_subagent_write = |e: &ResponseEntry| e.tier_1h == Some(0.0);
        let (subagent_writes, misses): (Vec<&ResponseEntry>, Vec<&ResponseEntry>) =
            all_misses.into_iter().partition(|e| is_subagent_write(e));
        let subagent_cc: f64 = subagent_writes.iter().map(|e| e.cc).sum();
        let mut by_model: IndexMap<&str, f64> = IndexMap::new();
        let mut rebilled = 0.0;
        for m in &misses {
            rebilled += m.cc;
            if let Some(model) = m.model.as_deref().filter(|s| !s.is_empty()) {
                *by_model.entry(model).or_insert(0.0) += 1.0;
            }
        }
        // `[...entries].sort((a,b) => b[1]-a[1])[0]?.[0]` — first-seen wins ties (stable sort).
        let mut ranked: Vec<(&str, f64)> = by_model.into_iter().collect();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let top_model: Option<String> = ranked.first().map(|(m, _)| (*m).to_owned());

        // Per-SOURCE attribution: thrash = the SAME session re-writing its prefix
        // ≥ thrash_min_count times; N distinct sessions' single cold-start writes are a fan-out
        // paying its one-time cost, not thrash.
        let mut by_source: IndexMap<Option<String>, (f64, f64)> = IndexMap::new();
        for m in &misses {
            let sid = self.session_of(m).map(str::to_owned);
            let g = by_source.entry(sid).or_insert((0.0, 0.0));
            g.0 += 1.0;
            g.1 += m.cc;
        }
        let mut top_source: Option<(String, f64, f64)> = None;
        let (mut unattributed_count, mut unattributed_cc) = (0.0, 0.0);
        let (mut cold_start_sessions, mut cold_start_rebilled) = (0.0, 0.0);
        for (sid, g) in &by_source {
            let Some(sid) = sid else {
                // The unattributed pool CANNOT flip `active` (TRDD-THRGX41P): attribution fails
                // for most requests in the field, so it is usually N distinct one-time boots,
                // not one mutating caller. Surfaced separately instead of feeding the deny.
                unattributed_count = g.0;
                unattributed_cc = g.1;
                continue;
            };
            if top_source.as_ref().is_none_or(|t| g.0 > t.1) {
                top_source = Some((sid.clone(), g.0, g.1));
            }
            if g.0 < self.opts.thrash_min_count {
                cold_start_sessions += 1.0;
                cold_start_rebilled += g.1;
            }
        }
        let thrash_active = top_source.as_ref().is_some_and(|t| t.1 >= self.opts.thrash_min_count);
        let window_large: Vec<&LargeRequestEntry> = self.large_requests.iter().filter(|e| now - e.t <= self.opts.thrash_window_ms).collect();
        // Exact culprit narrowing: name the thrashing session's OWN fat requests, so an innocent
        // fat parent is not blamed.
        let culprit_large: Vec<&LargeRequestEntry> = match (&top_source, thrash_active) {
            (Some(t), true) => window_large.iter().copied().filter(|e| e.session_id.as_deref() == Some(t.0.as_str())).collect(),
            _ => window_large.clone(),
        };
        let suspects: Vec<Value> = Self::senders(if culprit_large.is_empty() { &window_large } else { &culprit_large })
            .into_iter()
            // A sender on a DIFFERENT model cannot be the prefix-mutating caller; unknown-model
            // senders STAY (honest uncertainty is not a mismatch).
            .filter(|s| {
                let sm = s.get("model").and_then(Value::as_str);
                top_model.is_none() || sm.is_none() || sm == top_model.as_deref()
            })
            .collect();

        let recent: Vec<&ResponseEntry> = self.responses.iter().filter(|e| now - e.t <= 300_000.0).collect();
        let premium_count = recent.iter().filter(|e| e.model.as_deref().is_some_and(is_premium)).count() as f64;
        // Newest by mtime, not by array position — entries arrive in readdir order.
        let newest = recent.iter().fold(None::<&&ResponseEntry>, |a, e| match a {
            None => Some(e),
            Some(cur) if e.t > cur.t => Some(e),
            keep => keep,
        });

        let mut huge_obj = Map::new();
        huge_obj.insert("count".into(), num(huge_count));
        huge_obj.insert("bytes".into(), num(huge_bytes));
        huge_obj.insert("senders".into(), Value::Array(Self::senders(&huge90)));

        let mut thrash = Map::new();
        thrash.insert("active".into(), Value::Bool(thrash_active));
        thrash.insert("count".into(), num(misses.len() as f64));
        thrash.insert("rebilledTokens".into(), num(rebilled));
        thrash.insert("model".into(), top_model.clone().map_or(Value::Null, Value::from));
        thrash.insert("windowMs".into(), num(self.opts.thrash_window_ms));
        thrash.insert("suspects".into(), Value::Array(suspects));
        thrash.insert(
            "topSource".into(),
            match &top_source {
                Some((session, count, cc)) => {
                    let mut m = Map::new();
                    m.insert("session".into(), session.clone().into());
                    m.insert("count".into(), num(*count));
                    m.insert("rebilledTokens".into(), num(*cc));
                    Value::Object(m)
                }
                None => Value::Null,
            },
        );
        let mut un = Map::new();
        un.insert("count".into(), num(unattributed_count));
        un.insert("rebilledTokens".into(), num(unattributed_cc));
        thrash.insert("unattributed".into(), Value::Object(un));
        // TRDD-DIZ289UQ: counted over `misses` AFTER the tier partition — on a tiered wire a fresh
        // agent's 5m boot lands in `subagentWrites`, so this counts only untiered (older CC)
        // bodies plus 1h-tier callers below the repeat threshold. Mirrors the TS doc comment.
        thrash.insert("coldStartSessions".into(), num(cold_start_sessions));
        thrash.insert("coldStartRebilledTokens".into(), num(cold_start_rebilled));
        let mut subagent_obj = Map::new();
        subagent_obj.insert("count".into(), num(subagent_writes.len() as f64));
        subagent_obj.insert("rebilledTokens".into(), num(subagent_cc));
        thrash.insert("subagentWrites".into(), Value::Object(subagent_obj));
        // The API's own reasons for the top source's misses — what the warning names as the cause.
        let mut reasons: IndexMap<String, f64> = IndexMap::new();
        for m in &misses {
            // A legacy body (no tier data at all) is "no data", not a cause — it counts toward
            // `active` but says nothing here; the clause is prefixed "API cache_miss_reason".
            if m.tier_1h.is_none() {
                continue;
            }
            if top_source.as_ref().is_none_or(|t| self.session_of(m) == Some(t.0.as_str())) {
                // A 1h-tier rewrite the API did not label still counts — say so, rather than
                // print no reason at all in exactly the case the histogram exists for.
                *reasons.entry(m.miss_reason.clone().unwrap_or_else(|| "unlabelled".to_owned())).or_insert(0.0) += 1.0;
            }
        }
        thrash.insert("missReasons".into(), Value::Object(reasons.into_iter().map(|(k, v)| (k, num(v))).collect()));

        let mut premium = Map::new();
        premium.insert("share".into(), num(if recent.is_empty() { 0.0 } else { premium_count / recent.len() as f64 }));
        premium.insert("sampled".into(), num(recent.len() as f64));
        premium.insert("lastModel".into(), newest.and_then(|e| e.model.clone()).map_or(Value::Null, Value::from));

        let mut out = Map::new();
        out.insert("available".into(), Value::Bool(available));
        out.insert("hugeRequests90s".into(), Value::Object(huge_obj));
        out.insert("thrash".into(), Value::Object(thrash));
        out.insert("premium".into(), Value::Object(premium));
        Value::Object(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    const SID: &str = "11111111-aaaa-bbbb-cccc-000000000001";

    fn temp_dir(tag: &str) -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!("bodies-activity-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn now_ms() -> f64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as f64
    }

    /// A fat request: model in the first 2KB, session id + previous message id in the last 4KB.
    fn write_request(dir: &Path, name: &str, prev: &str) {
        let body = format!(
            "{{\"model\":\"claude-opus-5\",\"pad\":\"{}\",\"metadata\":{{\"user_id\":\"{{\\\"session_id\\\":\\\"{SID}\\\"}}\"}},\"diagnostics\":{{\"previous_message_id\":\"{prev}\"}}}}",
            "x".repeat(ATTRIB_REQUEST_BYTES as usize + 100)
        );
        std::fs::write(dir.join(name), body).unwrap();
    }

    fn write_response(dir: &Path, name: &str, id: &str, cc: u64, cr: u64) {
        let body = serde_json::json!({
            "id": id, "model": "claude-opus-5",
            "usage": { "cache_creation_input_tokens": cc, "cache_read_input_tokens": cr,
                       "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": cc } },
            "diagnostics": { "cache_miss_reason": { "type": "previous_message_not_found" } }
        });
        std::fs::write(dir.join(name), body.to_string()).unwrap();
    }

    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn seed_first_batch(dir: &Path) {
        write_request(dir, "r1.request.json", "msg_w"); // its response lands in poll 2
        write_request(dir, "r2.request.json", "msg_a");
        write_response(dir, "a.response.json", "msg_a", 150_000, 100);
        std::fs::write(dir.join("notes.txt"), "noise").unwrap();
        std::fs::write(dir.join("small.request.json"), "{}").unwrap();
    }

    /// Prune is judged at merge time, not scan time: a delta scanned 11 minutes before its merge drops its large request but keeps its response.
    #[test]
    fn merge_time_not_scan_time_decides_prune() {
        let dir = temp_dir("c");
        let _guard = TempDir(dir.clone());
        seed_first_batch(&dir);
        let t1 = now_ms();
        let t2 = t1 + 11.0 * 60_000.0; // past the 10-min large ring, inside the 15-min response ring
        let mut new = BodiesActivityTracker::new(dir.clone(), BodiesActivityOptions::default());
        let mut d = new.poller.lock().unwrap().scan(t1);
        new.activity.merge(&mut d, t2);
        new.poller.lock().unwrap().commit(d);
        assert!(new.activity.large_requests.is_empty(), "pruned against merge time");
        assert_eq!(new.activity.responses.len(), 1);
    }

    /// A scanned but never merged or committed delta leaves its names unseen, so the next scan re-reads the same files.
    #[test]
    fn unmerged_delta_is_rescanned() {
        let dir = temp_dir("d");
        let _guard = TempDir(dir.clone());
        write_response(&dir, "a.response.json", "msg_a", 150_000, 100);
        let t = now_ms();
        let p = BodiesPoller { dir: dir.clone(), seen: HashSet::new(), seeded: false };
        drop(p.scan(t)); // scanned, never merged or committed
        assert!(p.seen.is_empty(), "scan must not mark names seen");
        let again = p.scan(t);
        assert_eq!(again.new_names, vec!["a.response.json".to_owned()]);
        assert_eq!(again.responses.len(), 1);
    }

    /// A missing dir consumes no seed pass, the seed window skips a 20-minute-old response, and a later poll never resurrects a seen file.
    #[test]
    fn seed_window_and_missing_dir_and_no_resurrection() {
        let base = temp_dir("e");
        let _guard = TempDir(base.clone());
        let dir = base.join("later");
        let mut new = BodiesActivityTracker::new(dir.clone(), BodiesActivityOptions::default());

        // (a) the dir does not exist yet: nothing is listed, so the seed pass must not be spent
        let t0 = now_ms();
        new.poll(t0);
        assert!(!new.poller.lock().unwrap().seeded, "a missing dir must not consume the seed pass");

        // (b) the dir appears with one fresh and one 20-minute-old response
        std::fs::create_dir_all(&dir).unwrap();
        write_response(&dir, "fresh1.response.json", "msg_f1", 150_000, 100);
        write_response(&dir, "old.response.json", "msg_old", 150_000, 100);
        let stale = std::time::SystemTime::now() - std::time::Duration::from_secs(1200);
        std::fs::File::options().write(true).open(dir.join("old.response.json")).unwrap().set_modified(stale).unwrap();
        // The floor is asserted at the delta: SEED_LOOKBACK_MS equals the response ring window, so prune hides it in the rings; the floor only saves first-pass parse work.
        let tf = now_ms();
        let unseeded = BodiesPoller { dir: dir.clone(), seen: HashSet::new(), seeded: false }.scan(tf);
        let ids: Vec<_> = unseeded.responses.iter().map(|r| r.id.as_deref()).collect();
        assert!(ids.contains(&Some("msg_f1")) && !ids.contains(&Some("msg_old")), "unseeded scan must skip the old response, got {ids:?}");
        let seeded = BodiesPoller { dir: dir.clone(), seen: HashSet::new(), seeded: true }.scan(tf);
        let ids: Vec<_> = seeded.responses.iter().map(|r| r.id.as_deref()).collect();
        assert!(ids.contains(&Some("msg_old")), "seeded scan must not apply the floor, got {ids:?}");
        let t1 = now_ms();
        new.poll(t1);
        assert!(new.poller.lock().unwrap().seeded);
        assert_eq!(new.activity.responses.len(), 1, "only the fresh response is inside the seed window");
        assert!(new.activity.responses.iter().all(|r| r.id.as_deref() != Some("msg_old")), "old response must be skipped by the seed floor");

        // (c) a later poll must not resurrect the old file: it is already in `seen`
        write_response(&dir, "fresh2.response.json", "msg_f2", 150_000, 100);
        let t2 = now_ms();
        new.poll(t2);
        assert_eq!(new.activity.responses.len(), 2);
        assert!(new.activity.responses.iter().all(|r| r.id.as_deref() != Some("msg_old")), "old response stays absent once seen");
    }

    /// A request seen in one scan and its response seen in a LATER scan are joined by the persisted previous_message_id chain: report() names the request's session, model and sizes in topSource, suspects and missReasons.
    #[test]
    fn response_in_later_scan_is_attributed_to_earlier_request() {
        let dir = temp_dir("f");
        let _guard = TempDir(dir.clone());
        write_request(&dir, "q.request.json", "msg_x");
        let bytes = std::fs::metadata(dir.join("q.request.json")).unwrap().len();
        let mut new = BodiesActivityTracker::new(dir.clone(), BodiesActivityOptions::default());

        new.poll(now_ms()); // scan 1: only the request exists
        assert_eq!(new.activity.large_requests.len(), 1);
        assert!(new.activity.responses.is_empty());

        write_response(&dir, "p.response.json", "msg_x", 150_000, 100);
        new.poll(now_ms()); // scan 2: only the response is new
        assert_eq!(new.activity.large_requests.len(), 1);
        assert_eq!(new.activity.responses.len(), 1);

        let report = new.report(now_ms() + 1000.0);
        let expected = serde_json::json!({
            "available": true,
            "hugeRequests90s": { "count": 0, "bytes": 0, "senders": [] },
            "thrash": {
                "active": false, "count": 1, "rebilledTokens": 150_000, "model": "claude-opus-5", "windowMs": 300_000,
                "suspects": [ { "session": SID, "model": "claude-opus-5", "count": 1, "bytes": bytes } ],
                "topSource": { "session": SID, "count": 1, "rebilledTokens": 150_000 },
                "unattributed": { "count": 0, "rebilledTokens": 0 },
                "coldStartSessions": 1, "coldStartRebilledTokens": 150_000,
                "subagentWrites": { "count": 0, "rebilledTokens": 0 },
                "missReasons": { "previous_message_not_found": 1 }
            },
            "premium": { "share": 1, "sampled": 1, "lastModel": "claude-opus-5" }
        });
        assert_eq!(report, expected);
    }
}
