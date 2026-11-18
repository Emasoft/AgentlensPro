//! TRDD-YL3EWT6N item 10 — `alcore version` prints the build's package.json version and nothing else.
//!
//! The CLI's post-verb version check (src/cli/versionRestart.ts) runs this against the binary on disk and
//! compares stdout with the version the running server reports, so the contract is exact: stdout is the
//! version plus one newline, stderr is empty, exit 0. The branch runs before install_exit_on_panic and the
//! boot-phase log (both write stderr), which is what keeps stderr empty.

use std::process::Command;

#[test]
fn version_prints_the_package_json_version_and_nothing_else() {
    let pkg: serde_json::Value = serde_json::from_str(include_str!("../../../../package.json")).unwrap();
    let want = pkg["version"].as_str().expect("package.json carries a version");
    let out = Command::new(env!("CARGO_BIN_EXE_alcore")).arg("version").output().unwrap();
    assert_eq!(out.status.code(), Some(0), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(String::from_utf8_lossy(&out.stdout), format!("{want}\n"));
    assert!(out.stderr.is_empty(), "stderr must be empty, got: {}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn a_command_that_is_not_version_still_gets_usage() {
    // The control for the test above: with no `version` argument the binary does not print a version, it
    // exits 64 with the usage text — so the first test cannot pass merely because every invocation prints one.
    let out = Command::new(env!("CARGO_BIN_EXE_alcore")).arg("versions").output().unwrap();
    assert_eq!(out.status.code(), Some(64));
    assert!(String::from_utf8_lossy(&out.stderr).contains("alcore version"));
}
