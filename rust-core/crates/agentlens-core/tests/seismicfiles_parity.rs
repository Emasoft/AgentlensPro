//! Cross-engine parity for `resolveSeismicFiles` (TRDD-DMWOBWFH P4x.2s). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-seismicfiles-expected.mjs
//!
//! The comparison is ORDER-SENSITIVE, and that is the point: the result is sorted most-recent-first
//! precisely so a capped set keeps the LIVE sessions, so a port that returned the right SET in
//! directory order would truncate to an arbitrary slice of it and still look correct.

use std::path::PathBuf;

use agentlens_core::burn_seismic as bs;
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/seismicfiles-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

#[test]
fn resolve_seismic_files_matches() {
    let o = oracle();
    let tree = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/seismicfiles");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as f64;
    let oracle_now = o["now"].as_f64().unwrap();

    // Re-stamp with the SAME offsets the generator used, relative to THIS run's now. git does not
    // preserve mtimes, so without this the checkout time decides both the selection and the order.
    for (rel, hours) in o["offsets"].as_object().unwrap() {
        let p = tree.join(rel);
        let at = now - hours.as_f64().unwrap() * 3_600_000.0;
        let f = std::fs::File::options().write(true).open(&p).unwrap_or_else(|e| panic!("{rel}: {e}"));
        f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(at as u64)).unwrap();
    }

    let dirs = vec![tree.join("base1"), tree.join("base2")];
    let token = tree.to_string_lossy().into_owned();

    for (name, case) in o["cases"].as_object().unwrap() {
        let c = &case["opts"];
        let scope = match c["scope"].as_str().unwrap() {
            "fleet" => bs::SeismicScope::Fleet,
            "workspace" => bs::SeismicScope::Workspace,
            _ => bs::SeismicScope::Session,
        };
        // The generator's `sinceMs` is an offset from ITS now; rebase it onto this run's now so the
        // window covers the same files that were just re-stamped.
        let since_ms = now - (oracle_now - c["sinceMs"].as_f64().unwrap());
        let opts = bs::ResolveSeismicOptions {
            scope,
            workspace: c["workspace"].as_str(),
            session_id: c["sessionId"].as_str(),
            since_ms,
            include_subagents: c["includeSubagents"].as_bool().unwrap_or(false),
            max_files: c["maxFiles"].as_f64(),
            projects_dirs: dirs.clone(),
        };
        let got: Vec<String> = bs::resolve_seismic_files(&opts)
            .iter()
            .map(|p| p.to_string_lossy().replace(&token, "<FIXTURES>"))
            .collect();
        let exp: Vec<String> =
            case["out"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect();
        assert_eq!(got, exp, "{name}");
    }
}

/// The two SQL text builders. They are pure string composition, so they are pinned directly rather
/// than through a query: what matters is that the projection, the error mode and the torn-line
/// probe's column all survive the port verbatim.
#[test]
fn sql_text_is_verbatim() {
    let files = vec![PathBuf::from("/a/b.jsonl"), PathBuf::from("/it's/odd.jsonl")];
    let spec = bs::transcript_read_spec(&files);
    // The quote in a path is DOUBLED, not escaped with a backslash — DuckDB's rule, and the reason
    // this goes through one helper instead of being inlined at each call site.
    assert!(spec.contains("'/it''s/odd.jsonl'"), "{spec}");
    assert!(spec.contains("format='newline_delimited'"), "{spec}");
    assert!(spec.contains("columns={timestamp:'VARCHAR', type:'VARCHAR', message:'JSON'}"), "{spec}");
    assert!(spec.contains("ignore_errors=true"), "{spec}");
    // `filename=true` is what lets a multi-file scan attribute a row back to its session; without it
    // every per-session number in the report would be un-derivable.
    assert!(spec.contains("filename=true"), "{spec}");
    assert!(spec.contains("maximum_object_size=268435456"), "{spec}");

    // `type`, never `timestamp`: measured over 482,993 real records, `timestamp` is absent from
    // 16.9% of them by design, so keying the torn-line probe on it would report a sixth of a healthy
    // machine's records as unparseable.
    assert_eq!(
        bs::torn_line_sql("t", "type"),
        "SELECT count(*) AS total, count(type) AS withCol FROM t"
    );
}
