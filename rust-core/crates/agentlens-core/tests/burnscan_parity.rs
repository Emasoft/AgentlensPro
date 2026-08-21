//! Cross-engine parity for burnInvestigator SLICE 1 — the corpus SCAN half (TRDD-DMWOBWFH P4x.2e).
//! Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-burnscan-expected.mjs
//!
//! MTIME ORACLE: the window filter, byHour, firstIso/lastIso and every coverage count are functions
//! of the fixture's mtime table, which git does not preserve — the generator stamps it and
//! publishes it; this test re-stamps from it.
//!
//! The oracle stores the FULL investigateBurn output. This slice owns `window`/`coverage`/`totals`/
//! `attribution` plus the two verdict branches the scan decides alone (blind, and no-responses);
//! `findings` and the detector verdicts arrive with slice 2 and are NOT compared here.
//!
//! `os.homedir()` was stubbed to the fixtures dir in the generator, so `home` is passed to match.
//! Absolute dirs are REDACTED identically on both sides before comparing.

use std::path::PathBuf;

use agentlens_core::burn::investigator_scan::{scan_window, BodiesScope, InvestigateOptions};
use serde_json::Value;

fn fixtures() -> PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn oracle() -> Value {
    let o: Value =
        serde_json::from_str(&std::fs::read_to_string(fixtures().join("burnscan-expected.json")).unwrap()).unwrap();
    for (rel, ms) in o["mtimes"].as_object().unwrap() {
        let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(ms.as_f64().unwrap() as u64);
        let p = fixtures().join(rel);
        let f = std::fs::OpenOptions::new().append(true).open(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
        f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
    }
    o
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract `assert_eq!` cannot see (`preserve_order` makes `Value::Object` an
/// IndexMap whose `PartialEq` ignores order), and `coverage.blind` is a key that EXISTS only when
/// the scan went blind — a port that emitted it as `null` would compare equal field by field.
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

fn strip(v: &Value) -> Value {
    let mut s = v.to_string();
    for (dir, tag) in [
        ("burnscan-bodies", "<BODIES>"),
        ("burnscan-noresp", "<NORESP>"),
        ("burnscan-cap", "<CAP>"),
        ("no-such-burnscan-dir", "<MISSING>"),
        ("burnscan-storm", "<STORM>"),
        ("burnscan-boot", "<BOOT>"),
        ("burnscan-premium", "<PREMIUM>"),
        ("burnscan-idle", "<IDLE>"),
        ("burnscan-image", "<IMAGE>"),
        ("burnscan-partial", "<PARTIAL>"),
    ] {
        s = s.replace(&fixtures().join(dir).to_string_lossy().into_owned(), tag);
    }
    serde_json::from_str(&s).unwrap()
}

/// The same existence check investigateBurn's `bodiesDir` override performs: a caller who points at
/// a path that isn't there must be told it isn't there, not handed an "empty window" verdict.
fn opts_for(dir: &str, until_ms: f64, window_hours: Option<f64>, max_files: Option<f64>) -> InvestigateOptions {
    let p = fixtures().join(dir);
    let ok = p.is_dir();
    InvestigateOptions {
        scope: BodiesScope {
            dirs: if ok { vec![p.to_string_lossy().into_owned()] } else { vec![] },
            missing: if ok { vec![] } else { vec![p.to_string_lossy().into_owned()] },
            capture_on: true,
        },
        hook_events_dir: fixtures().join("burnscan-hooks"),
        home: fixtures().to_string_lossy().into_owned(),
        window_hours,
        until_ms: Some(until_ms),
        max_files,
    }
}

struct Case {
    name: &'static str,
    dir: &'static str,
    hours: Option<f64>,
    max_files: Option<f64>,
}

const CASES: &[Case] = &[
    Case { name: "main", dir: "burnscan-bodies", hours: None, max_files: None },
    Case { name: "clampedHigh", dir: "burnscan-bodies", hours: Some(100.0), max_files: None },
    Case { name: "clampedLow", dir: "burnscan-bodies", hours: Some(0.01), max_files: None },
    Case { name: "noResponses", dir: "burnscan-noresp", hours: None, max_files: None },
    Case { name: "missingDir", dir: "no-such-burnscan-dir", hours: None, max_files: None },
    Case { name: "capHit", dir: "burnscan-cap", hours: None, max_files: Some(1.0) },
    // One corpus per detector — see the generator for why they cannot share a dir.
    Case { name: "storm", dir: "burnscan-storm", hours: None, max_files: None },
    Case { name: "boot", dir: "burnscan-boot", hours: None, max_files: None },
    Case { name: "premium", dir: "burnscan-premium", hours: None, max_files: None },
    Case { name: "idle", dir: "burnscan-idle", hours: None, max_files: None },
    Case { name: "image", dir: "burnscan-image", hours: None, max_files: None },
    Case { name: "partial", dir: "burnscan-partial", hours: None, max_files: None },
];

#[test]
fn scan_half_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let until = o["untilMs"].as_f64().unwrap();
    for c in CASES {
        let got = strip(&scan_window(&opts_for(c.dir, until, c.hours, c.max_files), until).partial);
        let exp = &o["cases"][c.name];
        for field in ["window", "coverage", "totals", "attribution"] {
            same(&got[field], &exp[field], &format!("{}.{field}", c.name));
        }
    }
}

/// The two verdict branches the SCAN decides alone. The rest of the verdict needs the detectors and
/// arrives with slice 2 — so `main` must produce NO override here, or slice 2 could never speak.
#[test]
fn blind_and_no_response_verdicts_are_decided_by_the_scan() {
    let o = oracle();
    let until = o["untilMs"].as_f64().unwrap();
    for c in CASES {
        let out = scan_window(&opts_for(c.dir, until, c.hours, c.max_files), until);
        let exp_verdict = o["cases"][c.name]["verdict"].as_str().unwrap();
        match c.name {
            // capHit belongs here too, and NOT because of the cap: its corpus is 101 REQUEST files
            // and zero responses, so it takes the same no-responses branch. Asserting it was the
            // detectors' to write was my error, not the port's — the TS agrees with the port.
            "clampedLow" | "missingDir" | "noResponses" | "capHit" => {
                let got = out.verdict_override.expect("scan-decided verdict");
                // Redaction is by dir name, and these verdicts carry only the shortWs'd `~/…` form.
                assert_eq!(got, exp_verdict, "{}", c.name);
            }
            _ => assert!(out.verdict_override.is_none(), "{}: verdict is the detectors' to write", c.name),
        }
    }
}

/// `blind` is a THREE-valued classification and conflating its members is what let this tool answer
/// "nothing burned here" during a measured 2.3M tok/min burn.
#[test]
fn blind_classification_separates_its_three_causes() {
    let o = oracle();
    let until = o["untilMs"].as_f64().unwrap();
    let blind_of = |c: &Case| scan_window(&opts_for(c.dir, until, c.hours, c.max_files), until).blind;
    assert_eq!(blind_of(&CASES[0]), None, "a corpus that was READ is never blind");
    assert_eq!(blind_of(&CASES[2]), Some("dirs-empty-in-window"));
    assert_eq!(blind_of(&CASES[4]), Some("no-bodies-dir"));

    // capture-off has NO oracle: investigateBurn's `bodiesDir` override hardcodes captureOn:true,
    // so the branch is unreachable through the TS public API. Pinned here against the source.
    let mut off = opts_for("burnscan-bodies", until, Some(0.01), None);
    off.scope.capture_on = false;
    let out = scan_window(&off, until);
    assert_eq!(out.blind, Some("capture-off"));
    assert!(out.verdict_override.unwrap().starts_with("BLIND — raw-body capture is OFF"));
}

/// Slice 2's detectors key on these; nothing else in the report exposes them, so a regression in
/// the fingerprint or the workspace scan would pass every comparison above.
#[test]
fn scanned_records_carry_the_identities_slice_2_needs() {
    let o = oracle();
    let until = o["untilMs"].as_f64().unwrap();
    let out = scan_window(&opts_for("burnscan-bodies", until, None, None), until);

    let by = |name: &str| {
        // q1/q2 are the only 08:3x /w/alpha pair; index by ts, which the mtime table fixes.
        let ts = match name {
            "q1" => "2026-08-20T08:30:00Z",
            "q2" => "2026-08-20T08:31:00Z",
            "q5" => "2026-08-20T09:14:00Z",
            "q8" => "2026-08-20T08:33:00Z",
            _ => "2026-08-20T08:32:00Z", // q6
        };
        let ms = agentlens_core::summarize::helpers::parse_iso_ms(ts).unwrap();
        out.reqs.iter().find(|r| r.ts == ms).unwrap_or_else(|| panic!("no req at {ts}"))
    };

    // Same inherited transcript ⇒ same fingerprint. The shared prefix is emoji, so a BYTE-indexed
    // slice(i, i+2600) takes a different substring and these stop matching.
    assert_eq!(by("q1").fingerprint, by("q2").fingerprint, "q1/q2 share a transcript");
    assert!(!by("q1").fingerprint.is_empty());
    // THE UTF-16 pin. q8 matches q1 through byte 2600 but diverges at unit 2000, so ONLY a
    // UTF-16-indexed slice(i, i+2600) tells them apart. A byte-indexed window hashes them equal
    // and merges two unrelated transcripts into one "shared transcript" family — the exact input
    // slice 2's fork-storm detector counts. Nothing else observes this: a fingerprint value never
    // reaches the report, and a byte cut can never SPLIT a shared prefix, only merge distinct ones.
    assert_ne!(by("q8").fingerprint, by("q1").fingerprint, "q8 diverges from q1 within 2600 UTF-16 units");
    // Fewer than 2600 UTF-16 units follow `"messages"` → no fingerprint at all.
    assert_eq!(by("q6").fingerprint, "", "q6 is too short to fingerprint");
    assert_eq!(by("q5").image_bytes, 20_005.0, "the base64 run at the 20k floor");
    assert_eq!(by("q6").image_bytes, 0.0);

    // The hook store feeds the rate-limit-stall correlation. readHookEvents is NEWEST-FIRST, and
    // that order reaches the wire through evidence.stopFailures — so it is asserted, not sorted.
    assert_eq!(
        out.stop_failures,
        vec![o["hookStopFailureMs2"].as_f64().unwrap(), o["hookStopFailureMs"].as_f64().unwrap()],
        "newest-first"
    );
}

// ── SLICE 2: the detectors and the final assembly ────────────────────────────

/// The WHOLE report, every case. This subsumes the scan-half comparison above; that one is kept
/// because it isolates a scan regression from a detector regression when both would redden here.
#[test]
fn full_report_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let until = o["untilMs"].as_f64().unwrap();
    for c in CASES {
        let opts = opts_for(c.dir, until, c.hours, c.max_files);
        let got = strip(&agentlens_core::burn::investigator::investigate_burn(&opts, until));
        same(&got, &o["cases"][c.name], c.name);
    }
}

/// Key ORDER is not uniform across findings, and that is the wire contract. A finding built by
/// spreading `base` leads with `equivTokens`; every other detector leads with `cause`. Normalizing
/// them would compare equal field-by-field under a looser check and be wrong on the wire.
#[test]
fn finding_key_order_differs_by_detector_and_is_preserved() {
    let o = oracle();
    let until = o["untilMs"].as_f64().unwrap();
    let causes_of = |name: &str, dir: &str| -> Vec<(String, Vec<String>)> {
        let c = CASES.iter().find(|c| c.name == name).unwrap();
        let r = agentlens_core::burn::investigator::investigate_burn(&opts_for(dir, until, c.hours, c.max_files), until);
        r["findings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| {
                (
                    f["cause"].as_str().unwrap().to_owned(),
                    f.as_object().unwrap().keys().cloned().collect::<Vec<_>>(),
                )
            })
            .collect()
    };
    let storm = causes_of("storm", "burnscan-storm");
    let spread = ["equivTokens", "shareOfWindow", "evidence", "cause", "confidence", "verdict"];
    let literal = ["cause", "equivTokens", "shareOfWindow", "confidence", "verdict", "evidence"];
    assert_eq!(storm.iter().find(|(c, _)| c == "FORK_STORM").unwrap().1, spread, "FORK_STORM spreads `base`");
    assert_eq!(
        storm.iter().find(|(c, _)| c == "RATE_LIMIT_COLD_RESUME").unwrap().1,
        literal,
        "RATE_LIMIT_COLD_RESUME is a literal"
    );
    assert_eq!(causes_of("image", "burnscan-image")[0].1, literal, "IMAGE_BLOB_RESIDENT is a literal");
    assert_eq!(causes_of("boot", "burnscan-boot")[0].1, spread, "SUBAGENT_BOOT_TAX spreads `base`");
}

/// NO SILENT GAPS: every BURN_CAUSE must be reachable by some fixture, or a detector could be
/// wholly broken and the suite would still be green. The thresholds are far enough apart that no
/// single corpus can satisfy them all, which is why there is one dir per detector.
#[test]
fn every_burn_cause_is_exercised_by_the_fixture_set() {
    let o = oracle();
    let until = o["untilMs"].as_f64().unwrap();
    let mut seen: Vec<String> = Vec::new();
    for c in CASES {
        let r = agentlens_core::burn::investigator::investigate_burn(&opts_for(c.dir, until, c.hours, c.max_files), until);
        for f in r["findings"].as_array().unwrap() {
            let cause = f["cause"].as_str().unwrap().to_owned();
            if !seen.contains(&cause) {
                seen.push(cause);
            }
        }
    }
    let missing: Vec<&str> = agentlens_core::burn::investigator::BURN_CAUSES
        .iter()
        .copied()
        .filter(|c| !seen.iter().any(|s| s == c))
        .collect();
    assert!(missing.is_empty(), "unexercised causes: {missing:?}");
}

/// The verdict's honesty clause: it must NAME the unattributed remainder rather than imply the
/// detectors explained the window. `main` attributes well under half, so the NOTE must be there;
/// `storm` attributes ~100%, so it must NOT be.
#[test]
fn the_verdict_admits_what_the_detectors_could_not_attribute() {
    let o = oracle();
    let until = o["untilMs"].as_f64().unwrap();
    let verdict = |name: &str, dir: &str| {
        let c = CASES.iter().find(|c| c.name == name).unwrap();
        agentlens_core::burn::investigator::investigate_burn(&opts_for(dir, until, c.hours, c.max_files), until)
            ["verdict"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    // MEASURED, not assumed: main attributes 74% and storm ~100%, so NEITHER carries the note —
    // asserting main did was my error. `partial` is built to land at 12.5%, between the 2%
    // reporting floor and the 50% honesty threshold, and is the ONLY corpus that reaches it.
    assert!(verdict("partial", "burnscan-partial").contains("detectors attribute only"), "12.5% ⇒ note");
    assert!(!verdict("main", "burnscan-bodies").contains("detectors attribute only"), "74% ⇒ no note");
    assert!(!verdict("storm", "burnscan-storm").contains("detectors attribute only"), "~100% ⇒ no note");
    // Singular vs plural is computed from the top-3 slice, not from the total.
    assert!(verdict("storm", "burnscan-storm").starts_with("Top culprits:"), "two findings ⇒ plural");
    assert!(verdict("image", "burnscan-image").starts_with("Top culprit:"), "one finding ⇒ singular");
}

/// attach_causing_calls must PRESERVE the findings it enriches. The obvious implementation —
/// iterating a `mem::take`d temporary — drops every mutation and leaves the array EMPTY, turning a
/// report with findings into one without any while every other test still passes.
#[test]
fn attach_causing_calls_preserves_findings_and_reports_honestly() {
    let o = oracle();
    let until = o["untilMs"].as_f64().unwrap();
    let c = CASES.iter().find(|c| c.name == "storm").unwrap();
    let opts = opts_for(c.dir, until, c.hours, c.max_files);
    let mut inv = agentlens_core::burn::investigator::investigate_burn(&opts, until);
    let before: Vec<String> =
        inv["findings"].as_array().unwrap().iter().map(|f| f["cause"].as_str().unwrap().to_owned()).collect();
    let verdict_before = inv["verdict"].as_str().unwrap().to_owned();

    // No transcript store is pointed at, so nothing can resolve — which is exactly the path that
    // must record an honest reason instead of fabricating a call.
    agentlens_core::burn::investigator::attach_causing_calls(&mut inv, &opts.home, &[]);

    let after: Vec<String> =
        inv["findings"].as_array().unwrap().iter().map(|f| f["cause"].as_str().unwrap().to_owned()).collect();
    assert_eq!(after, before, "findings survive enrichment");
    assert!(!after.is_empty(), "the storm corpus has findings to enrich");

    let storm = inv["findings"].as_array().unwrap().iter().find(|f| f["cause"] == "FORK_STORM").unwrap();
    assert!(storm["causingCalls"].is_null(), "nothing resolvable ⇒ no fabricated calls");
    assert!(storm["causingCallsUnavailable"].is_string(), "an unresolvable cause states WHY");
    // Only fan-out findings anchor a spawn call; a finding with no workspace must stay untouched.
    let rlcr = inv["findings"].as_array().unwrap().iter().find(|f| f["cause"] == "RATE_LIMIT_COLD_RESUME").unwrap();
    assert!(rlcr["causingCallsUnavailable"].is_null(), "no peakStartMs/workspaces ⇒ not even attempted");
    assert_eq!(inv["verdict"].as_str().unwrap(), verdict_before, "no calls resolved ⇒ verdict unchanged");
}
