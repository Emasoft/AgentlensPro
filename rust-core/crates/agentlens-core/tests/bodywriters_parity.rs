//! Cross-engine parity for `get_body_writers` (TRDD-DMWOBWFH P4x.2d). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-bodywriters-expected.mjs
//!
//! MTIME ORACLE: every recent/active decision reads a file's mtime and git does not preserve them,
//! so the generator stamps a fixed table and publishes it; this test re-stamps from that table.

use agentlens_core::body_writers::{
    build_body_writers_report, scan_live_body_writers, BodyWritersOpts, FileRef, LiveBodiesScan, LiveSessionAgg, ResponsesAgg,
    StoreSession, StoreWriterTotals,
};
use serde_json::{Map, Value};

fn fixtures() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn oracle() -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join("bodywriters-expected.json")).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract `assert_eq!` cannot see (`preserve_order` makes `Value::Object` an
/// IndexMap whose `PartialEq` ignores order).
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

fn repin(o: &Value) -> std::path::PathBuf {
    let dir = fixtures().join("bodies-dir");
    for (name, ms) in o["mtimes"].as_object().unwrap() {
        let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(ms.as_f64().unwrap() as u64);
        let f = std::fs::OpenOptions::new().append(true).open(dir.join(name)).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
    }
    dir
}

const HOME: &str = "/h/user";

/// The oracle REDACTS the absolute fixture path to `<FIXTURES>/` — `dir` echoes whatever the caller
/// passed, and a committed fixture carrying a real home path both fails `check-identities` and pins
/// one machine's layout into the suite. Apply the same substitution to the Rust side.
fn strip(v: &Value) -> Value {
    let prefix = format!("{}/", fixtures().to_string_lossy());
    serde_json::from_str(&v.to_string().replace(&prefix, "<FIXTURES>/")).unwrap()
}

fn live_value(l: &LiveBodiesScan) -> Value {
    let files = |fs: &[FileRef]| {
        Value::Array(
            fs.iter()
                .map(|f| {
                    let mut m = Map::new();
                    m.insert("name".into(), Value::String(f.name.clone()));
                    m.insert("bytes".into(), Value::from(f.bytes as i64));
                    Value::Object(m)
                })
                .collect(),
        )
    };
    let mut sessions = Vec::new();
    for s in &l.sessions {
        let mut m = Map::new();
        m.insert("sessionId".into(), s.session_id.clone().map(Value::from).unwrap_or(Value::Null));
        m.insert("files".into(), files(&s.files));
        m.insert("bytes".into(), Value::from(s.bytes as i64));
        m.insert("recentFiles".into(), Value::from(s.recent_files as i64));
        m.insert("recentBytes".into(), Value::from(s.recent_bytes as i64));
        m.insert("firstMs".into(), Value::from(s.first_ms as i64));
        m.insert("lastMs".into(), Value::from(s.last_ms as i64));
        m.insert("model".into(), s.model.clone().map(Value::from).unwrap_or(Value::Null));
        sessions.push(Value::Object(m));
    }
    let mut r = Map::new();
    r.insert("files".into(), files(&l.responses.files));
    r.insert("bytes".into(), Value::from(l.responses.bytes as i64));
    r.insert("recentBytes".into(), Value::from(l.responses.recent_bytes as i64));
    r.insert("lastMs".into(), Value::from(l.responses.last_ms as i64));
    let mut m = Map::new();
    m.insert("available".into(), Value::Bool(l.available));
    m.insert("dir".into(), Value::String(l.dir.clone()));
    m.insert("scannedFiles".into(), Value::from(l.scanned_files as i64));
    m.insert("sessions".into(), Value::Array(sessions));
    m.insert("responses".into(), Value::Object(r));
    Value::Object(m)
}

/// Rebuild a scan from the oracle so the report cases are driven by the SAME live figures the TS
/// saw, independent of whether the directory walk itself is under test in this case.
fn live_from(v: &Value) -> LiveBodiesScan {
    let files = |x: &Value| -> Vec<FileRef> {
        x.as_array()
            .map(|a| a.iter().map(|f| FileRef { name: f["name"].as_str().unwrap_or("").to_owned(), bytes: f["bytes"].as_f64().unwrap_or(0.0) }).collect())
            .unwrap_or_default()
    };
    LiveBodiesScan {
        available: v["available"].as_bool().unwrap_or(false),
        dir: v["dir"].as_str().unwrap_or("").to_owned(),
        scanned_files: v["scannedFiles"].as_f64().unwrap_or(0.0),
        sessions: v["sessions"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|s| LiveSessionAgg {
                        session_id: s["sessionId"].as_str().map(str::to_owned),
                        files: files(&s["files"]),
                        bytes: s["bytes"].as_f64().unwrap_or(0.0),
                        recent_files: s["recentFiles"].as_f64().unwrap_or(0.0),
                        recent_bytes: s["recentBytes"].as_f64().unwrap_or(0.0),
                        first_ms: s["firstMs"].as_f64().unwrap_or(0.0),
                        last_ms: s["lastMs"].as_f64().unwrap_or(0.0),
                        model: s["model"].as_str().map(str::to_owned),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        responses: ResponsesAgg {
            files: files(&v["responses"]["files"]),
            bytes: v["responses"]["bytes"].as_f64().unwrap_or(0.0),
            recent_bytes: v["responses"]["recentBytes"].as_f64().unwrap_or(0.0),
            last_ms: v["responses"]["lastMs"].as_f64().unwrap_or(0.0),
        },
    }
}

fn store_from(v: &Value) -> StoreWriterTotals {
    StoreWriterTotals {
        sessions: v["sessions"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|s| StoreSession {
                        session_id: s["sessionId"].as_str().map(str::to_owned),
                        files: s["files"].as_f64().unwrap_or(0.0),
                        bytes: s["bytes"].as_f64().unwrap_or(0.0),
                        last_ms: s["lastMs"].as_f64().unwrap_or(0.0),
                        model: s["model"].as_str().map(str::to_owned),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        response_files: v["responses"]["files"].as_f64().unwrap_or(0.0),
        response_bytes: v["responses"]["bytes"].as_f64().unwrap_or(0.0),
        recent_src_names: v["recentSrcNames"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default(),
    }
}

struct Case<'a> {
    live: &'a Value,
    store: Option<&'a Value>,
    cards: &'a Value,
    limit: f64,
}

fn run(o: &Value, c: Case<'_>) -> Value {
    let live = live_from(c.live);
    let store = c.store.map(store_from);
    let cards = c.cards.as_array().cloned().unwrap_or_default();
    build_body_writers_report(&BodyWritersOpts {
        live: &live,
        store: store.as_ref(),
        cards: &cards,
        now_ms: o["nowMs"].as_f64().unwrap(),
        window_ms: o["windowMs"].as_f64().unwrap(),
        active_ms: o["activeMs"].as_f64().unwrap(),
        limit: c.limit,
        home: HOME,
    })
}

#[test]
fn scan_live_body_writers_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let dir = repin(&o);
    let got = scan_live_body_writers(&dir, o["nowMs"].as_f64().unwrap(), o["windowMs"].as_f64().unwrap());
    same(&strip(&live_value(&got)), &o["live"], "live");

    let missing = scan_live_body_writers(&fixtures().join("no-such-bodies-dir"), o["nowMs"].as_f64().unwrap(), o["windowMs"].as_f64().unwrap());
    assert!(!missing.available, "an absent dir reports available:false, never throws");
    assert_eq!(missing.scanned_files, 0.0);
    assert!(missing.sessions.is_empty());
}

#[test]
fn build_body_writers_report_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let cases: [(&str, Option<&str>, &str, f64, &str); 7] = [
        ("reportNoStore", None, "live", 20.0, "cards"),
        ("reportStoreNoOverlap", Some("storeNoOverlap"), "live", 20.0, "cards"),
        ("reportStoreOverlap", Some("storeOverlap"), "live", 20.0, "cards"),
        ("reportLimitOne", None, "live", 1.0, "cards"),
        ("reportNoDir", None, "liveMissingDir", 20.0, "cards"),
        ("reportNoDirWithStore", Some("storeNoOverlap"), "liveMissingDir", 20.0, "cards"),
        ("reportNoCards", None, "live", 20.0, "__empty"),
    ];
    let empty = Value::Array(Vec::new());
    for (case, store_key, live_key, limit, cards_key) in cases {
        let cards = if cards_key == "__empty" { &empty } else { &o[cards_key] };
        let got = run(&o, Case { live: &o[live_key], store: store_key.map(|k| &o[k]), cards, limit });
        // Already redacted on both sides — the live scan is rebuilt FROM the oracle here, so its
        // `dir` is the placeholder and passes through unchanged.
        same(&got, &o[case], case);
    }
}

/// `active` and `recent` are DIFFERENT windows, and conflating them loses the row a user acts on:
/// r3 wrote 20 minutes ago — inside the 30m rate window (so it still shows a rate) but outside the
/// 10m active window, which is precisely "this one already stopped, do not restart it".
#[test]
fn recent_and_active_are_different_windows() {
    let o = oracle();
    let got = run(&o, Case { live: &o["live"], store: None, cards: &o["cards"], limit: 20.0 });
    let w = got["writers"].as_array().unwrap();
    let bbbb = w.iter().find(|r| r["sessionId"].as_str().unwrap_or("").starts_with("bbbb")).unwrap();
    assert_eq!(bbbb["active"], false, "20m ago is outside the 10m active window");
    assert_eq!(bbbb["recentFiles"], 1, "…but inside the 30m rate window: {bbbb}");
    assert!(bbbb["rateMBmin"].as_f64().unwrap() > 0.0, "so it still reports a rate");

    let aaaa = w.iter().find(|r| r["sessionId"].as_str().unwrap_or("").starts_with("aaaa")).unwrap();
    assert_eq!(aaaa["active"], true, "2m ago is inside both");
    assert_eq!(aaaa["liveFiles"], 2, "both of its files count toward live totals");
    assert_eq!(aaaa["recentFiles"], 1, "only the recent one counts toward the rate");
}

/// A request with no session marker is its OWN bucket (sessionId null) and — by the TRUTHY
/// `sessionId ? cardBy.get(...)` guard — never inherits a card's workspace. Folding it into a real
/// session would attribute bytes to a terminal the user would then restart for nothing.
#[test]
fn an_unattributed_request_is_its_own_bucket_with_no_card() {
    let o = oracle();
    let got = run(&o, Case { live: &o["live"], store: None, cards: &o["cards"], limit: 20.0 });
    let un = got["writers"].as_array().unwrap().iter().find(|r| r["sessionId"].is_null()).unwrap();
    assert_eq!(un["workspace"], Value::Null, "{un}");
    assert_eq!(un["source"], Value::Null);
    assert_eq!(un["model"], "claude-haiku-4-5", "the model still comes off the body itself");
    assert!(got["text"].as_str().unwrap().contains("unattributed"), "{}", got["text"]);
}

/// The store merge is an EXACT union: a live file the store ALREADY ingested must not add to
/// totalBytes. `storeOverlap` and `storeNoOverlap` differ only in `recentSrcNames`, so the
/// difference in the total is exactly r1's size — the double count the subtraction prevents.
#[test]
fn an_already_ingested_live_file_is_not_counted_twice() {
    let o = oracle();
    let no_overlap = run(&o, Case { live: &o["live"], store: Some(&o["storeNoOverlap"]), cards: &o["cards"], limit: 20.0 });
    let overlap = run(&o, Case { live: &o["live"], store: Some(&o["storeOverlap"]), cards: &o["cards"], limit: 20.0 });
    let total = |r: &Value| {
        r["writers"].as_array().unwrap().iter().find(|w| w["sessionId"].as_str().unwrap_or("").starts_with("aaaa")).unwrap()["totalBytes"]
            .as_f64()
            .unwrap()
    };
    let r1_bytes = o["live"]["sessions"].as_array().unwrap()[0]["files"].as_array().unwrap()[0]["bytes"].as_f64().unwrap();
    assert_eq!(total(&no_overlap) - total(&overlap), r1_bytes, "exactly the ingested file's bytes, not a fraction or a double");
    // Same rule for the response aggregate.
    assert_eq!(
        no_overlap["responses"]["totalBytes"].as_f64().unwrap() - overlap["responses"]["totalBytes"].as_f64().unwrap(),
        o["live"]["responses"]["files"].as_array().unwrap()[0]["bytes"].as_f64().unwrap()
    );
}

/// With NO store the note SAYS "STORE UNAVAILABLE" and the live bytes are the whole total. This is
/// the branch the Rust route takes today (the durable store is not held by the Rust server), so the
/// degradation is visible in the payload rather than silently changing the numbers.
#[test]
fn without_a_store_the_note_says_so_and_live_bytes_are_the_total() {
    let o = oracle();
    let got = run(&o, Case { live: &o["live"], store: None, cards: &o["cards"], limit: 20.0 });
    assert!(got["note"].as_str().unwrap().starts_with("STORE UNAVAILABLE"), "{}", got["note"]);
    for w in got["writers"].as_array().unwrap() {
        assert_eq!(w["storeFiles"], 0);
        assert_eq!(w["storeBytes"], 0);
        assert_eq!(w["totalBytes"], w["liveBytes"], "{w}");
    }
    let with_store = run(&o, Case { live: &o["live"], store: Some(&o["storeNoOverlap"]), cards: &o["cards"], limit: 20.0 });
    assert!(with_store["note"].as_str().unwrap().starts_with("totals = ingested store history"), "{}", with_store["note"]);
}

/// `available` is `live.available || store !== null` — a missing bodies dir with a real store is
/// still an ANSWERABLE question, because the ingested history exists whether or not the dir does.
#[test]
fn availability_is_the_union_of_the_dir_and_the_store() {
    let o = oracle();
    let no_dir = run(&o, Case { live: &o["liveMissingDir"], store: None, cards: &o["cards"], limit: 20.0 });
    assert_eq!(no_dir["available"], false);
    assert_eq!(no_dir["totalWriters"], 0);
    let no_dir_store = run(&o, Case { live: &o["liveMissingDir"], store: Some(&o["storeNoOverlap"]), cards: &o["cards"], limit: 20.0 });
    assert_eq!(no_dir_store["available"], true, "the store's history is still real");
    assert_eq!(no_dir_store["totalWriters"], 2);
}

/// `limit` truncates the table while `totalWriters` keeps the honest count — a truncated table that
/// also reported a truncated total would read as "this is everything".
#[test]
fn the_limit_truncates_the_table_but_not_the_count() {
    let o = oracle();
    let one = run(&o, Case { live: &o["live"], store: None, cards: &o["cards"], limit: 1.0 });
    assert_eq!(one["writers"].as_array().unwrap().len(), 1);
    assert_eq!(one["totalWriters"], 3);
    assert!(one["text"].as_str().unwrap().contains("(3 writer(s), showing 1)"), "{}", one["text"]);
}

/// A file that is neither `.request.json` nor `.response.json` is not even counted in
/// `scannedFiles` — the fixture ships an `ignore.txt` to prove the filter runs before the stat.
#[test]
fn a_non_body_file_is_not_scanned() {
    let o = oracle();
    let dir = repin(&o);
    let got = scan_live_body_writers(&dir, o["nowMs"].as_f64().unwrap(), o["windowMs"].as_f64().unwrap());
    assert!(dir.join("ignore.txt").exists(), "the fixture must actually contain the decoy");
    assert_eq!(got.scanned_files, 6.0, "4 requests + 2 responses, and NOT ignore.txt");
}
