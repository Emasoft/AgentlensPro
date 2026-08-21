//! Cross-engine parity for forensicsIndex SLICE A (TRDD-DMWOBWFH P4x.2p) — the pure half. Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-forensicsindex-expected.mjs
//!
//! Every case's INPUT is carried in the fixture beside its output, so the two engines are handed
//! byte-identical bodies rather than two hand-transcribed copies that can drift apart silently.

use agentlens_core::forensics_index as fi;
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/forensicsindex-expected.json");
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
            assert_eq!(ga.len(), ea.len(), "{label}: length\n  got={got}\n  exp={exp}");
            for (i, (g, e)) in ga.iter().zip(ea).enumerate() {
                same(g, e, &format!("{label}[{i}]"));
            }
        }
        _ => assert_eq!(got, exp, "{label}"),
    }
}

#[test]
fn classify_effort_matches() {
    let o = oracle();
    for case in o["effort"].as_array().unwrap() {
        let input = &case["input"];
        // The fixture spells NaN as a STRING because JSON has no NaN literal — and NaN is exactly
        // the input worth carrying: JS's `!budgetTokens` catches it while `NaN <= 0` does not.
        let arg = if input == "NaN" { Some(f64::NAN) } else { input.as_f64() };
        assert_eq!(fi::classify_effort(arg), case["out"].as_str().unwrap(), "classifyEffort({input})");
    }
    // Not reachable from JSON, so asserted directly: an infinite budget is NOT falsy in JS, so it
    // takes the top branch rather than collapsing to `none` the way NaN does.
    assert_eq!(fi::classify_effort(Some(f64::INFINITY)), "high");
    assert_eq!(fi::classify_effort(Some(f64::NEG_INFINITY)), "none");
}

#[test]
fn compute_frontmatter_fp_matches() {
    let o = oracle();
    let mut hashes: Vec<&str> = Vec::new();
    for (name, body) in o["fpCases"].as_object().unwrap() {
        let got = fi::compute_frontmatter_fp(body);
        let exp = o["fp"][name].as_str();
        assert_eq!(got.as_deref(), exp, "computeFrontmatterFp({name}) body={body}");
        if let Some(h) = exp {
            assert_eq!(h.len(), 40, "{name}: sha1 hex is 40 chars, got {h}");
            // `system_blocks_with_empty` is the ONE case that must COLLIDE with another — a
            // text-less block is skipped, so it is the same prefix as `system_blocks`. It is
            // therefore excluded from the distinctness set and asserted as equal below.
            if name != "system_blocks_with_empty" {
                hashes.push(h);
            }
        }
    }
    assert_eq!(
        o["fp"]["system_blocks_with_empty"], o["fp"]["system_blocks"],
        "a text-less system block must not change the fingerprint"
    );
    // Every OTHER pair must differ — including the reordered-tools pair, which is what a port that
    // sorted for tidiness would collapse. Without this the whole table could be one constant and
    // every equality assertion above would still pass.
    let mut uniq: Vec<&str> = hashes.clone();
    uniq.sort_unstable();
    uniq.dedup();
    assert_eq!(uniq.len(), hashes.len(), "distinct prefixes collided: {hashes:?}");
}

#[test]
fn extract_injections_matches() {
    let o = oracle();
    for (name, body) in o["injectionCases"].as_object().unwrap() {
        let got = Value::Array(fi::extract_injections(body).iter().map(fi::InjectionRow::to_value).collect());
        same(&got, &o["injections"][name], &format!("extractInjections({name})"));
    }
}

#[test]
fn derive_content_tags_matches() {
    let o = oracle();
    for (name, comp) in o["tagCases"].as_object().unwrap() {
        let got = Value::Array(fi::derive_content_tags(comp));
        same(&got, &o["tags"][name], &format!("deriveContentTags({name})"));
    }
}
