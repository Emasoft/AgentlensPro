// TRDD-DMWOBWFH slice B4 — parity tests for embed_auth.rs against src/test/embedAuth.test.ts
// (TRDD-1ZH1D5EG / AgentlensPro#4 §B5). Every case in the TS suite that exercises
// resolveViewerRole / signViewerAssertion is mirrored here, plus ensureEmbedKey at the bottom.
//
// No identities: the only "account-shaped" strings below are the 2-char fake ids the task asked
// for (none needed here — the contract has no account ids, only roles/keys/nonces).

use agentlens_core::embed_auth::{resolve_viewer_role, sign_viewer_assertion, ViewerRole};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use serde_json::json;
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

const NOW: f64 = 1_800_000_000_000.0;

fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Hand-rolled signer independent of `sign_viewer_assertion`, mirroring the TS test file's own
/// `signValue` — pins the WIRE FORMAT rather than testing the reference signer against itself.
fn sign_value(value: &serde_json::Value, key: &[u8]) -> String {
    let p = b64url(value.to_string().as_bytes());
    let mut mac = HmacSha256::new_from_slice(key).unwrap();
    mac.update(p.as_bytes());
    let sig = b64url(&mac.finalize().into_bytes());
    format!("{p}.{sig}")
}

#[test]
fn no_header_at_all_is_standalone() {
    assert_eq!(resolve_viewer_role(None, Some(b"key"), NOW), ViewerRole::Standalone);
}

#[test]
fn valid_unexpired_maestro_assertion_is_maestro() {
    let key = b"a-shared-secret-key-32-bytes!!!!";
    let h = sign_value(&json!({"v":1,"role":"maestro","iat":NOW-1000.0,"exp":NOW+60_000.0,"nonce":"n1"}), key);
    assert_eq!(resolve_viewer_role(Some(&h), Some(key), NOW), ViewerRole::Maestro);
}

#[test]
fn valid_unexpired_user_assertion_is_restricted() {
    let key = b"a-shared-secret-key-32-bytes!!!!";
    let h = sign_value(&json!({"v":1,"role":"user","iat":NOW-1000.0,"exp":NOW+60_000.0,"nonce":"n2"}), key);
    assert_eq!(resolve_viewer_role(Some(&h), Some(key), NOW), ViewerRole::Restricted);
}

/// The AgentlensPro#4 §B4 cross-repo test vector, copied verbatim from
/// src/test/embedAuth.test.ts — if this ever fails, the two implementations diverged.
#[test]
fn cross_repo_test_vector_verifies_byte_for_byte() {
    let vector_key = b"key".to_vec(); // hex "6b6579" decodes to ASCII "key" — no hex crate needed for 3 bytes
    let vector = "eyJ2IjoxLCJyb2xlIjoidXNlciIsImlhdCI6MTc1MjcyMDAwMDAwMCwiZXhwIjoxNzUyNzIwMDYwMDAwLCJub25jZSI6IjAxMjM0NTY3ODlhYmNkZWYifQ.aj_Q93wQFqYwSQZgXU-KbWCMTbJH8K6mvEBdfouklpo";
    // Inside the validity window -> role user -> restricted.
    assert_eq!(
        resolve_viewer_role(Some(vector), Some(&vector_key), 1_752_720_030_000.0),
        ViewerRole::Restricted
    );
    // Past exp the SAME vector is invalid (zero skew tolerance).
    assert_eq!(
        resolve_viewer_role(Some(vector), Some(&vector_key), 1_752_720_060_001.0),
        ViewerRole::Invalid
    );
}

#[test]
fn expired_maestro_assertion_is_invalid() {
    let key = b"key-key-key-key-key-key-key-key";
    let h = sign_value(&json!({"v":1,"role":"maestro","iat":NOW-120_000.0,"exp":NOW-1.0,"nonce":"n3"}), key);
    assert_eq!(resolve_viewer_role(Some(&h), Some(key), NOW), ViewerRole::Invalid);
}

#[test]
fn tampered_payload_signature_mismatch_is_invalid_never_maestro() {
    let key = b"key-key-key-key-key-key-key-key";
    let good = sign_value(&json!({"v":1,"role":"user","iat":NOW,"exp":NOW+60_000.0,"nonce":"n4"}), key);
    let sig = good.split('.').nth(1).unwrap();
    let forged = b64url(
        json!({"v":1,"role":"maestro","iat":NOW,"exp":NOW+60_000.0,"nonce":"n4"})
            .to_string()
            .as_bytes(),
    );
    let h = format!("{forged}.{sig}");
    assert_eq!(resolve_viewer_role(Some(&h), Some(key), NOW), ViewerRole::Invalid);
}

#[test]
fn assertion_signed_with_different_key_is_invalid() {
    let key = b"key-key-key-key-key-key-key-key";
    let other_key = b"another-different-key-not-key32";
    let h = sign_value(&json!({"v":1,"role":"maestro","iat":NOW,"exp":NOW+60_000.0,"nonce":"n5"}), other_key);
    assert_eq!(resolve_viewer_role(Some(&h), Some(key), NOW), ViewerRole::Invalid);
}

#[test]
fn unknown_contract_version_is_invalid() {
    let key = b"key-key-key-key-key-key-key-key";
    for v in [json!(0), json!(2), json!("1")] {
        let h = sign_value(&json!({"v":v,"role":"maestro","iat":NOW,"exp":NOW+60_000.0,"nonce":"n6"}), key);
        assert_eq!(resolve_viewer_role(Some(&h), Some(key), NOW), ViewerRole::Invalid, "v={v:?}");
    }
}

/// TS test's `v: undefined` case: `JSON.stringify` DROPS a key whose value is `undefined`, so it
/// is really "the `v` field is absent" — mirrored here as an omitted map key, not a JSON null.
#[test]
fn missing_version_field_is_invalid() {
    let key = b"key-key-key-key-key-key-key-key";
    let h = sign_value(&json!({"role":"maestro","iat":NOW,"exp":NOW+60_000.0,"nonce":"n6b"}), key);
    assert_eq!(resolve_viewer_role(Some(&h), Some(key), NOW), ViewerRole::Invalid);
}

#[test]
fn unknown_role_is_invalid() {
    let key = b"key-key-key-key-key-key-key-key";
    for role in ["MAESTRO", "admin", "Maestro", "maestro-delegate", ""] {
        let h = sign_value(&json!({"v":1,"role":role,"iat":NOW,"exp":NOW+60_000.0,"nonce":"n7"}), key);
        assert_eq!(resolve_viewer_role(Some(&h), Some(key), NOW), ViewerRole::Invalid, "role={role}");
    }
}

#[test]
fn malformed_headers_never_panic_and_never_grant() {
    let key = b"key-key-key-key-key-key-key-key";
    let p = b64url(json!({"v":1,"role":"maestro","iat":NOW,"exp":NOW+60_000.0}).to_string().as_bytes());
    let x = b64url(b"x");
    let cases = vec![
        String::new(),
        "nodot".to_string(),
        format!("{p}."),
        ".sig".to_string(),
        format!("{p}.AAAA"),
        format!("not-json.{x}"),
        format!("{p}.{p}.{p}"),
    ];
    for h in cases {
        assert_eq!(resolve_viewer_role(Some(&h), Some(key), NOW), ViewerRole::Invalid, "header={h:?}");
    }
}

#[test]
fn missing_exp_or_role_is_invalid() {
    let key = b"key-key-key-key-key-key-key-key";
    let no_exp = sign_value(&json!({"v":1,"role":"maestro","iat":NOW,"nonce":"n8"}), key);
    let no_role = sign_value(&json!({"v":1,"iat":NOW,"exp":NOW+60_000.0,"nonce":"n9"}), key);
    assert_eq!(resolve_viewer_role(Some(&no_exp), Some(key), NOW), ViewerRole::Invalid);
    assert_eq!(resolve_viewer_role(Some(&no_role), Some(key), NOW), ViewerRole::Invalid);
}

#[test]
fn validly_signed_non_object_payload_is_invalid() {
    let key = b"key-key-key-key-key-key-key-key";
    for v in [json!(null), json!(42), json!("maestro"), json!([1, 2])] {
        let h = sign_value(&v, key);
        assert_eq!(resolve_viewer_role(Some(&h), Some(key), NOW), ViewerRole::Invalid, "payload={v:?}");
    }
}

#[test]
fn comma_joined_duplicated_header_is_invalid() {
    let key = b"key-key-key-key-key-key-key-key";
    let a = sign_value(&json!({"v":1,"role":"maestro","iat":NOW,"exp":NOW+60_000.0,"nonce":"ca"}), key);
    let b = sign_value(&json!({"v":1,"role":"user","iat":NOW,"exp":NOW+60_000.0,"nonce":"cb"}), key);
    assert_eq!(resolve_viewer_role(Some(&format!("{a}, {b}")), Some(key), NOW), ViewerRole::Invalid);
    assert_eq!(resolve_viewer_role(Some("a, b"), Some(key), NOW), ViewerRole::Invalid);
}

#[test]
fn null_key_present_header_is_invalid_absent_header_still_standalone() {
    let key = b"key-key-key-key-key-key-key-key";
    let h = sign_value(&json!({"v":1,"role":"maestro","iat":NOW,"exp":NOW+60_000.0,"nonce":"nd"}), key);
    assert_eq!(resolve_viewer_role(Some(&h), None, NOW), ViewerRole::Invalid);
    assert_eq!(resolve_viewer_role(None, None, NOW), ViewerRole::Standalone);
}

/// Length-mismatched signature: a signature shorter/longer than the expected HMAC digest must
/// resolve to Invalid without panicking — proves `constant_time_eq` bails on length before
/// touching Node's timingSafeEqual-throws behaviour equivalent.
#[test]
fn length_mismatched_signature_is_invalid_never_panics() {
    let key = b"key-key-key-key-key-key-key-key";
    let p = b64url(json!({"v":1,"role":"maestro","iat":NOW,"exp":NOW+60_000.0,"nonce":"nl"}).to_string().as_bytes());
    let short_sig = b64url(b"short");
    let h = format!("{p}.{short_sig}");
    assert_eq!(resolve_viewer_role(Some(&h), Some(key), NOW), ViewerRole::Invalid);
}

#[test]
fn sign_viewer_assertion_round_trips_through_the_verifier() {
    let key = b"key-key-key-key-key-key-key-key";
    // Fixed nonce: the signer takes it as a parameter (it is test-only — see its doc comment),
    // which also makes this round-trip byte-reproducible instead of merely probabilistic.
    let maestro_h = sign_viewer_assertion("maestro", key, NOW, 60_000.0, "aaaaaaaaaaaaaaaa");
    let user_h = sign_viewer_assertion("user", key, NOW, 60_000.0, "bbbb2222bbbb2222");
    assert_eq!(resolve_viewer_role(Some(&maestro_h), Some(key), NOW), ViewerRole::Maestro);
    assert_eq!(resolve_viewer_role(Some(&user_h), Some(key), NOW), ViewerRole::Restricted);
}

// ---------------------------------------------------------------------------------------------
// ensureEmbedKey (embedAuth.ts:59) — the loader. Its two REFUSALS are the whole point of it, so
// they get the same weight as the happy path. PID-and-tag-scoped temp dirs: cargo runs these as
// parallel threads in ONE process, so a PID-only path would let siblings delete each other's
// fixtures (same convention as tests/forensicsindexer_parity.rs:36).
// ---------------------------------------------------------------------------------------------

fn key_dir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("al-embed-key-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn first_boot_creates_a_32_byte_key_at_0600_and_reads_back_identically() {
    let dir = key_dir("create");
    let key = agentlens_core::embed_auth::ensure_embed_key(&dir).expect("first boot creates a key");
    assert_eq!(key.len(), 32, "32 random bytes");

    let file = dir.join("embed-key");
    let text = std::fs::read_to_string(&file).unwrap();
    assert_eq!(text.trim().len(), 64, "64 hex chars, one line");
    assert!(text.ends_with('\n'), "trailing newline, as the TS writes");
    assert!(text.trim().bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "lowercase hex");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "created at 0600 from the first byte — never a world-readable window");
    }

    // A second call must READ the existing key, never mint a new one: ai-maestro holds a copy,
    // so a regenerate is a silent, total auth outage.
    let again = agentlens_core::embed_auth::ensure_embed_key(&dir).expect("second boot reads it back");
    assert_eq!(again, key, "the key is stable across boots");

    // And it is a real key the verifier accepts end-to-end.
    let h = sign_viewer_assertion("maestro", &key, NOW, 60_000.0, "aaaaaaaaaaaaaaaa");
    assert_eq!(resolve_viewer_role(Some(&h), Some(&key), NOW), ViewerRole::Maestro);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_corrupt_key_file_is_refused_and_never_regenerated() {
    // Regenerating would desync ai-maestro's copy and quietly invalidate every assertion it
    // signs — an outage that looks like "the headers are all wrong", not like a bug here.
    let dir = key_dir("corrupt");
    let file = dir.join("embed-key");
    std::fs::write(&file, "not-a-key\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    let err = agentlens_core::embed_auth::ensure_embed_key(&dir).expect_err("corrupt must refuse");
    assert!(err.contains("corrupt embed-key"), "names the problem: {err}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "not-a-key\n", "the file is left EXACTLY as found");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn uppercase_hex_is_refused_even_though_it_would_decode() {
    // The TS gate is /^[0-9a-f]{64}$/ — lowercase only. Accepting uppercase here would boot the
    // Rust server on a file the TS engine rejects, so the two would disagree about whether the
    // same key file is usable. Deliberate strictness, not an oversight.
    let dir = key_dir("uppercase");
    std::fs::write(dir.join("embed-key"), format!("{}\n", "A".repeat(64))).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.join("embed-key"), std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    let err = agentlens_core::embed_auth::ensure_embed_key(&dir).expect_err("uppercase must refuse");
    assert!(err.contains("corrupt embed-key"), "{err}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn a_mode_wider_than_0600_is_refused_because_any_local_account_could_mint_maestro() {
    use std::os::unix::fs::PermissionsExt;
    let dir = key_dir("widemode");
    let file = dir.join("embed-key");
    std::fs::write(&file, format!("{}\n", "ab".repeat(32))).unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();

    let err = agentlens_core::embed_auth::ensure_embed_key(&dir).expect_err("0644 must refuse");
    assert!(err.contains("wider than 0600"), "names the problem: {err}");
    // Refuse, do not "helpfully" chmod: the operator must know the secret was exposed.
    let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o644, "left as found — silently tightening it would hide the exposure");

    let _ = std::fs::remove_dir_all(&dir);
}

/// Invalid must be STRICTER than restricted/standalone: a deliberately broken header (bad
/// version) must never fall back to full/partial access — proves the fail-closed invariant
/// end-to-end rather than per-branch.
#[test]
fn invalid_is_never_a_downgrade_to_standalone_or_restricted() {
    let key = b"key-key-key-key-key-key-key-key";
    let broken = sign_value(&json!({"v":99,"role":"maestro","iat":NOW,"exp":NOW+60_000.0,"nonce":"bad"}), key);
    let verdict = resolve_viewer_role(Some(&broken), Some(key), NOW);
    assert_ne!(verdict, ViewerRole::Standalone);
    assert_ne!(verdict, ViewerRole::Maestro);
    assert_ne!(verdict, ViewerRole::Restricted);
    assert_eq!(verdict, ViewerRole::Invalid);
}
