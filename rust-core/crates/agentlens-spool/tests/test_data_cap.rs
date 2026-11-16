//! Proof that this test binary runs under the 4 GB test-data cap (scripts/test-data-cap.sh via the
//! `.cargo/config.toml` runner). Does not prove the cap TRIPS above 4 GB, only that the run is covered.

#[test]
fn cargo_test_runs_inside_a_capped_run_dir_with_temp_dir_redirected_into_it() {
    let cap = std::env::var("AGENTLENS_TEST_CAP_DIR")
        .expect("AGENTLENS_TEST_CAP_DIR is not set: this run is not under the cap");
    assert!(cap.contains("/tests_dev/tmp/run-"), "cap dir is not a tests_dev/tmp/run-* dir: {cap}");
    let real = std::fs::canonicalize(&cap).expect("cap dir must exist");
    let tmp = std::fs::canonicalize(std::env::temp_dir()).expect("temp_dir must exist");
    assert!(tmp.starts_with(&real), "temp_dir {tmp:?} escapes the cap dir {real:?}");
}
