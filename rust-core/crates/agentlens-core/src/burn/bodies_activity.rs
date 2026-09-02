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

pub struct BodiesActivityTracker {
    dir: PathBuf,
    opts: BodiesActivityOptions,
    seen: HashSet<String>,
    seeded: bool,
    large_requests: Vec<LargeRequestEntry>,
    responses: Vec<ResponseEntry>,
    /// The previous_message_id chain: a request from session S carrying previous_message_id=m
    /// proves response m belongs to S — the only realtime response→session attribution the
    /// bodies afford (response bodies carry no metadata; request/response FILES share no
    /// basename). Attribution therefore lags by exactly one call, as in TS.
    msg_session: IndexMap<String, (String, f64)>,
}

impl BodiesActivityTracker {
    pub fn new(dir: PathBuf, opts: BodiesActivityOptions) -> BodiesActivityTracker {
        BodiesActivityTracker {
            dir,
            opts: opts.clamped(),
            seen: HashSet::new(),
            seeded: false,
            large_requests: Vec::new(),
            responses: Vec::new(),
            msg_session: IndexMap::new(),
        }
    }

    /// One incremental pass. A missing dir returns silently — report() says available:false.
    pub fn poll(&mut self, now: f64) {
        let Ok(rd) = std::fs::read_dir(&self.dir) else { return };
        let names: Vec<String> = rd.flatten().filter_map(|e| e.file_name().to_str().map(str::to_owned)).collect();
        let seed_floor = if self.seeded { 0.0 } else { now - SEED_LOOKBACK_MS };
        for name in &names {
            if self.seen.contains(name) {
                continue;
            }
            self.seen.insert(name.clone());
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
                    self.large_requests.push(LargeRequestEntry { t: mtime, bytes: size, huge: size > HUGE_REQUEST_BYTES, session_id: session_id.clone(), model });
                    if let (Some(sid), Some(pm)) = (session_id, previous_message_id) {
                        self.msg_session.insert(pm, (sid, mtime));
                    }
                }
                continue;
            }
            if size > RESPONSE_PARSE_CAP {
                continue;
            }
            // Truncated mid-write or not JSON — skip.
            if let Some((model, cc, cr, id)) = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).as_ref().and_then(extract_response_usage) {
                self.responses.push(ResponseEntry { t: mtime, model, cc, cr, id });
            }
        }
        self.seeded = true;
        self.prune(now);
        // The hourly archiver removes old files; rebuild `seen` from the live listing when it
        // drifts well past the dir's contents so memory stays bounded.
        if self.seen.len() > names.len() * 2 + 512 {
            self.seen = names.into_iter().collect();
        }
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

        let misses: Vec<&ResponseEntry> = self
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
        thrash.insert("coldStartSessions".into(), num(cold_start_sessions));
        thrash.insert("coldStartRebilledTokens".into(), num(cold_start_rebilled));

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
