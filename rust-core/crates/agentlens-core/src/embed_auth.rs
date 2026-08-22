// TRDD-DMWOBWFH slice B4 — Rust port of src/embedAuth.ts (TRDD-1ZH1D5EG, AgentlensPro#4 spec
// B1-B5). Ports `resolveViewerRole` and `signViewerAssertion` only — `ensureEmbedKey` reads its
// TS behaviour through `atomicWriteFileSync` (src/serverRuntime.ts), which is not yet part of
// this workspace's file-I/O surface, so it is left for a follow-up slice.
//
// CRATES NEEDED (add to Cargo.toml — not done here, coordinator wires it):
//   sha2 = "0.10"      (already in the workspace lock via agentlens-store; add as a direct dep)
//   hmac = "0.12"      (RustCrypto HMAC, pairs with the sha2/sha1 already vendored)
//   base64 = "0.22"    (already in the lock transitively at both 0.22.1 and 0.23.1; pin "0.22")
// NO `rand`: the worker's draft pulled it in for the reference signer's nonce. That signer's only
// callers are tests, so the nonce is a PARAMETER instead (see sign_viewer_assertion) and this
// crate takes no new dependency for a test-only helper.
// serde_json is already a dependency of agentlens-core with `preserve_order`, which is what lets
// the hand-built payload object serialize in the exact field order the TS `JSON.stringify`
// produces ({"v":...,"role":...,"iat":...,"exp":...,"nonce":...}) — load-bearing for the pinned
// cross-repo test vector, even though the verifier itself never depends on field order (the HMAC
// covers the base64url STRING, not a re-serialization).
//
// Wire format (pinned by src/test/embedAuth.test.ts, including the #4 §B4 cross-repo vector):
//   X-Agentlens-Viewer: <b64url(payload)>.<b64url(HMAC-SHA256(b64url(payload), key))>
//   payload = {"v":1,"role":"maestro"|"user","iat":<unix_ms>,"exp":<unix_ms>,"nonce":"<hex>"}
// The HMAC is over the ASCII bytes of the base64url-encoded payload STRING, never the raw JSON.
//
// Verdicts (decision table #4 §B5, fail-CLOSED everywhere):
//   header absent                                  -> Standalone (full access, unchanged)
//   valid sig + v:1 + unexpired + role "maestro"    -> Maestro
//   valid sig + v:1 + unexpired + role "user"       -> Restricted
//   anything else present (bad sig/expired/         -> Invalid (403 the whole request, NEVER a
//     malformed/unknown v/unknown role)               downgrade to standalone)
//   header present but key is None (embed feature   -> Invalid (can't verify => 403, never a
//     disabled: key file unusable at boot)             downgrade)

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use serde_json::{Map, Value};
use sha2::Sha256;
use std::path::Path;

type HmacSha256 = Hmac<Sha256>;

/// ensureEmbedKey (embedAuth.ts:59) — read, or create on first boot, the shared HMAC key at
/// `<data_dir>/embed-key`: 32 random bytes as 64 lowercase hex chars, one line, mode 0600.
/// ai-maestro reads the SAME file as the same user — that file IS the key exchange (#4 §B1).
///
/// FAIL-FAST, NEVER FAIL-QUIET. Both refusals are the point of the function:
/// - a corrupt existing file is an Err, NOT a regenerate. Silently minting a new key would
///   desync the consumer's copy, and every assertion it signs would quietly become invalid —
///   a total auth outage that looks like "the headers are all wrong" rather than like a bug here.
/// - a mode wider than 0600 is an Err. A world-readable shared secret is not a shared secret:
///   any local account could mint `maestro` assertions. Refusing forces the operator to
///   `chmod 600` or remove the file.
///
/// The Err IS the contract: the boot site treats it as FATAL and refuses to start (exit 78,
/// EX_CONFIG, which a supervisor treats as terminal) rather than run on with a corrupt or exposed
/// shared secret (TRDD-F1VX3M7C).
///
/// The mode check is POSIX-only, exactly as in the TS: on Windows the platform emulates st_mode
/// from the read-only flag, so a 0600-created file reads back as 0666 and the check would
/// spuriously refuse on every second boot. ACL-based protection is the platform's job there.
pub fn ensure_embed_key(data_dir: &Path) -> Result<Vec<u8>, String> {
    let file = data_dir.join("embed-key");
    if file.exists() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = std::fs::metadata(&file).map_err(|e| format!("[AgentLens] cannot stat embed-key at {}: {e}", file.display()))?;
            let mode = meta.permissions().mode() & 0o777;
            if mode & 0o077 != 0 {
                return Err(format!(
                    "[AgentLens] embed-key at {} has mode 0{mode:o} — wider than 0600; refusing to use a shared secret other accounts can read (chmod 600 it; see AgentlensPro#4)",
                    file.display()
                ));
            }
        }
        let raw = std::fs::read_to_string(&file)
            .map_err(|e| format!("[AgentLens] cannot read embed-key at {}: {e}", file.display()))?;
        let hex = raw.trim();
        // The TS gate is /^[0-9a-f]{64}$/ — LOWERCASE only. Accepting uppercase here would decode
        // to the same key but let a file the TS rejects boot the Rust server, so the two engines
        // would disagree about whether the same file is usable.
        if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(format!(
                "[AgentLens] corrupt embed-key at {} — expected 64 lowercase hex chars; refusing to regenerate (ai-maestro reads this file; see AgentlensPro#4)",
                file.display()
            ));
        }
        return Ok(decode_hex64(hex));
    }

    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("[AgentLens] cannot create data dir {}: {e}", data_dir.display()))?;
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).map_err(|e| format!("[AgentLens] no OS entropy for a new embed-key: {e}"))?;
    let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
    write_new_key_0600(&file, &format!("{hex}\n"))
        .map_err(|e| format!("[AgentLens] cannot write embed-key at {}: {e}", file.display()))?;
    Ok(key.to_vec())
}

/// 64 validated lowercase-hex chars → 32 bytes. Only ever called after the regex-equivalent gate
/// above, so the arithmetic cannot see a non-hex byte.
fn decode_hex64(hex: &str) -> Vec<u8> {
    fn nib(b: u8) -> u8 {
        if b.is_ascii_digit() { b - b'0' } else { b - b'a' + 10 }
    }
    hex.as_bytes().chunks(2).map(|p| (nib(p[0]) << 4) | nib(p[1])).collect()
}

/// Create the key file atomically AND at 0600 from the very first byte — temp + fsync + rename.
/// The mode is set at CREATION, never chmod'ed afterwards: a create-then-chmod leaves a window in
/// which the shared secret is world-readable, which is the exact condition `ensure_embed_key`
/// refuses to boot on. The temp file is removed on every failure path so a crashed write cannot
/// leave a readable partial key behind.
fn write_new_key_0600(file: &Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = file.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let res = (|| -> std::io::Result<()> {
        let mut f = opts.open(&tmp)?;
        f.write_all(contents.as_bytes())?;
        f.sync_all()
    })();
    if let Err(e) = res {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, file) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// The wire header name, lowercase as Node presents it. Mirrors `VIEWER_HEADER` in embedAuth.ts.
pub const VIEWER_HEADER: &str = "x-agentlens-viewer";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewerRole {
    Standalone,
    Maestro,
    Restricted,
    Invalid,
}

/// Constant-time compare that also rejects on length mismatch — mirrors Node's
/// `crypto.timingSafeEqual`, which THROWS on length mismatch (the TS caller checks length first
/// so a short/garbage signature can't crash the handler; we fold that check into this fn instead
/// so callers can't forget it). No crate added for this: XOR-accumulate over equal-length input,
/// bail before that loop on unequal length (the length itself is not secret — #4 doc).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Resolve the viewer role for one request. `header_value` is the raw header string (`None` when
/// absent). `key` is `None` when the embed feature is disabled (key file unusable at boot) — a
/// present header then resolves to `Invalid` (can't verify => 403, never a downgrade). Never
/// panics — every malformed-input path returns `Invalid`. Zero clock-skew tolerance on `exp`
/// (signer and verifier share one host clock, #4 Q6). `now_ms` is an explicit parameter so the
/// verifier is deterministic under test — never read the wall clock in here.
pub fn resolve_viewer_role(header_value: Option<&str>, key: Option<&[u8]>, now_ms: f64) -> ViewerRole {
    let header_value = match header_value {
        None => return ViewerRole::Standalone,
        Some(h) => h,
    };
    let key = match key {
        None => return ViewerRole::Invalid, // embed feature disabled: unverifiable header is untrusted
        Some(k) => k,
    };

    // `parts.length !== 2 || !parts[0] || !parts[1]` — split on '.', require exactly two
    // NON-EMPTY parts. Rust's `split('.')` never errors, so this is a plain length+emptiness
    // check, not a try/catch boundary (unlike the TS which wraps the whole body in one `try`).
    let parts: Vec<&str> = header_value.split('.').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return ViewerRole::Invalid;
    }
    let (payload_b64, sig_b64) = (parts[0], parts[1]);

    // HMAC-SHA256 over the ASCII bytes of the base64url payload STRING (never a re-serialization).
    let mut mac = match HmacSha256::new_from_slice(key) {
        Ok(m) => m,
        Err(_) => return ViewerRole::Invalid, // HMAC accepts any key length; this branch is unreachable in practice
    };
    mac.update(payload_b64.as_bytes());
    let expected = mac.finalize().into_bytes();

    let given = match URL_SAFE_NO_PAD.decode(sig_b64) {
        Ok(b) => b,
        Err(_) => return ViewerRole::Invalid, // malformed base64 signature
    };
    if !constant_time_eq(&given, &expected) {
        return ViewerRole::Invalid;
    }

    let payload_bytes = match URL_SAFE_NO_PAD.decode(payload_b64) {
        Ok(b) => b,
        Err(_) => return ViewerRole::Invalid, // malformed base64 payload
    };
    let payload_str = match std::str::from_utf8(&payload_bytes) {
        Ok(s) => s,
        Err(_) => return ViewerRole::Invalid, // not valid UTF-8 -> not valid JSON either
    };
    let payload: Value = match serde_json::from_str(payload_str) {
        Ok(v) => v,
        Err(_) => return ViewerRole::Invalid, // malformed JSON
    };

    // JSON.parse accepts non-objects (null, 42, "x", []) — guard before any field access so a
    // crafted scalar payload yields Invalid deterministically (WYC4KB50 #11 in the TS).
    let obj: &Map<String, Value> = match payload.as_object() {
        Some(o) => o,
        None => return ViewerRole::Invalid,
    };

    // `p.v !== 1` — reject any version that is not the JSON number 1 (unknown version, wrong
    // type, or absent). serde_json's `as_i64` fails on non-integers (e.g. the "1" string case in
    // the TS test matrix), which is exactly the strict `!==` behaviour we need.
    match obj.get("v").and_then(Value::as_i64) {
        Some(1) => {}
        _ => return ViewerRole::Invalid,
    }

    let exp = match obj.get("exp").and_then(Value::as_f64) {
        Some(e) => e,
        None => return ViewerRole::Invalid, // missing or non-number exp
    };
    if now_ms > exp {
        return ViewerRole::Invalid; // expired (zero skew tolerance)
    }

    match obj.get("role").and_then(Value::as_str) {
        Some("maestro") => ViewerRole::Maestro,
        Some("user") => ViewerRole::Restricted,
        _ => ViewerRole::Invalid, // unknown/missing role is a spec violation, not a viewer
    }
}

/// Reference signer — the shape ai-maestro's proxy implements, kept alongside the verifier so the
/// contract's two halves live in one place. `now_ms`/`ttl_ms` are explicit for determinism.
///
/// The NONCE IS A PARAMETER, where the TS generates it internally with `crypto.randomBytes(8)`.
/// Deliberate, and it is the same reasoning that makes the clock a parameter here: this signer's
/// only callers are TESTS (`src/test/embedAuth.test.ts`, `src/test/cliContract.aimaestro.test.ts`
/// — the server VERIFIES, ai-maestro's proxy signs), so generating randomness inside it would buy
/// nothing and cost a new `rand` dependency on a production crate that does not otherwise need
/// one. The nonce is not a security parameter of the VERIFIER: it is replay-distinguishing data
/// the HMAC merely covers, and nothing in `resolve_viewer_role` reads it. A caller that ever does
/// need a real proxy-side signer must pass real entropy — that is its job, not this function's.
pub fn sign_viewer_assertion(role: &str, key: &[u8], now_ms: f64, ttl_ms: f64, nonce: &str) -> String {
    // preserve_order (workspace-wide serde_json feature) keeps this in the same field order as
    // the TS object literal — load-bearing for the byte-for-byte cross-repo test vector.
    let mut payload = Map::new();
    payload.insert("v".to_string(), Value::from(1));
    payload.insert("role".to_string(), Value::from(role));
    // JS timestamps are integral milliseconds in practice; write them as JSON integers (not
    // floats with a trailing ".0") so the payload text matches what `JSON.stringify` on the TS
    // side would produce for the same values.
    payload.insert("iat".to_string(), Value::from(now_ms as i64));
    payload.insert("exp".to_string(), Value::from((now_ms + ttl_ms) as i64));
    payload.insert("nonce".to_string(), Value::from(nonce));

    let payload_json = Value::Object(payload).to_string();
    let payload_b64 = URL_SAFE_NO_PAD.encode(payload_json.as_bytes());

    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(payload_b64.as_bytes());
    let sig_b64 = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());

    format!("{}.{}", payload_b64, sig_b64)
}
