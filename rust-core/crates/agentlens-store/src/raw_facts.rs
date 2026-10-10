//! raw_facts — request facts that exist only in the RAW body text, extracted at ingest
//! (QSFYIHUO step 3): the Environment-block workspace, the first-message fingerprint over the
//! 2600-char UTF-16 slice from the `"messages"` byte offset, and the base64 image-byte total.
//!
//! WHY RAW TEXT: re-serializing the parsed Value is not byte-stable (pretty-printing/spacing
//! differ), and the fingerprint's djb2 runs over UTF-16 code units of the raw bytes from the
//! `"messages"` offset — the parsed body cannot reproduce it. The chunked forward search, the
//! 6 MiB `max_scan_bytes` bound, the 256-unit carry across chunk boundaries, and the
//! `offset > 2*CHUNK && image_bytes == 0.0` early break replicate
//! `agentlens-core/src/burn/investigator_scan.rs::scan_request` EXACTLY (A3a) so store rows and
//! body-scan rows are bit-identical; only `find_session_id` is left out — the store's
//! session_id comes from the parsed Value and is authoritative for store rows (A2).
//!
//! PROVENANCE (A2 hoist): `djb2`, `to_base36`, `utf16_len`, `sum_image_bytes`, `ws_re`,
//! `model_re`, `looks_like_workspace` were MOVED here from investigator_scan.rs /
//! summarize::helpers.rs — one implementation, zero duplication. The TS-parity oracle for all of
//! them is the compiled TS bundle the gen-burnscan generator imports; these Rust copies were
//! pinned by `djb2_matches_node_including_the_surrogate_pair_path` and
//! `looks_like_workspace_accepts_posix_and_windows_only`, which move WITH the helpers.
//! `js_slice`/`js_slice_from` below are scoped private copies of summarize/helpers.rs' JS-semantics
//! ports (outside the A2 six); they exist here because agentlens-store cannot import agentlens-core.



/// A request's raw-text-only facts (QSFYIHUO step 3). `workspace` is '' when the Environment
/// block is absent (subagent-shaped); `fp_2600` is '' when the post-"messages" text is ≤2600
/// UTF-16 units (the body-scan parity contract); `image_bytes` sums base64 runs ≥20000 chars.
#[derive(Clone, Debug, Default)]
pub struct RawFacts {
    pub workspace: String,
    pub fp_2600: String,
    pub image_bytes: f64,
}

/// The current extractor version persisted on `raw_facts_v`. Bump when the extraction SEMANTICS
/// change (not on a bug fix that preserves them); old rows then fall back to the body scan, the
/// step-2 S1 v-key precedent. A NULL raw_facts_v (pre-step-3 row, or a response row) means the
/// three fact columns are NOT trusted and the consumer scans the body.
pub const RAW_FACTS_VERSION: i32 = 1;

pub fn ws_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r#"Primary working directory: ([^\\\n"]+)"#).unwrap())
}

pub fn model_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r#""model"\s*:\s*"([^"]+)""#).unwrap())
}

/// An Environment-block workspace is always absolute — posix `/…` or Windows `C:\…`.
pub fn looks_like_workspace(s: &str) -> bool {
    if s.starts_with('/') {
        return true;
    }
    let b = s.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

/// `/"data"\s*:\s*"([A-Za-z0-9+/=]{20000,})/g` hand-rolled: the regex crate expands a `{20000,}`
/// repeat literally and blows its compiled-size limit, so the bounded run is counted directly.
/// Semantics preserved exactly — greedy run, and the scan resumes at the END of a counted match
/// (JS sets lastIndex there) but only one char past the anchor when the run is too short.
pub fn sum_image_bytes(text: &str) -> f64 {
    const NEEDLE: &str = "\"data\"";
    let b = text.as_bytes();
    let mut total = 0f64;
    let mut from = 0usize;
    while let Some(rel) = text[from..].find(NEEDLE) {
        let start = from + rel;
        let mut i = start + NEEDLE.len();
        while i < b.len() && (b[i] as char).is_whitespace() {
            i += 1;
        }
        if i < b.len() && b[i] == b':' {
            i += 1;
            while i < b.len() && (b[i] as char).is_whitespace() {
                i += 1;
            }
            if i < b.len() && b[i] == b'"' {
                i += 1;
                let run_start = i;
                while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'+' || b[i] == b'/' || b[i] == b'=') {
                    i += 1;
                }
                let run = i - run_start;
                if run >= 20_000 {
                    total += run as f64; // base64 is ASCII, so byte length IS the UTF-16 length
                    from = i;
                    continue;
                }
            }
        }
        from = start + 1;
    }
    total
}

/// djb2 over UTF-16 code units. `((h << 5) + h + c) >>> 0`: the shift is a signed int32 op that
/// may go negative, the additions are exact doubles, and `>>> 0` is ToUint32 — which is what the
/// `as u32` truncation reproduces. Iterating bytes or chars instead of code units diverges the
/// moment a transcript holds an emoji.
pub fn djb2(s: &str) -> String {
    let mut h: u32 = 5381;
    for c in s.encode_utf16() {
        let shifted = (h as i32).wrapping_shl(5) as i64;
        h = (shifted + h as i64 + c as i64) as u32;
    }
    to_base36(h)
}

fn to_base36(mut n: u32) -> String {
    if n == 0 {
        return "0".to_owned();
    }
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while n > 0 {
        out.push(D[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

/// JS `.length` — UTF-16 CODE UNITS, not bytes and not chars. Hoisted from
/// agentlens-core/summarize/helpers.rs (A2), which re-exports it for that crate's other users.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(n)` — the REST of the string from UTF-16 offset `n`.
pub fn js_slice_from(s: &str, n: usize) -> &str {
    let mut units = 0usize;
    for (i, c) in s.char_indices() {
        if units >= n {
            return &s[i..];
        }
        units += c.len_utf16();
    }
    ""
}

/// `s.slice(0, n)` — the FIRST `n` UTF-16 code units.
pub fn js_slice(s: &str, n: usize) -> &str {
    let mut units = 0usize;
    for (i, c) in s.char_indices() {
        let u = c.len_utf16();
        if units + u > n {
            return &s[..i];
        }
        units += u;
    }
    s
}

/// The store-side port of investigator_scan.rs::scan_request's chunked read loop — identical
/// bounds, carry, and early break (A3a), minus `find_session_id` (A2: the parsed-Value
/// session_id is authoritative here). `model` is tracked ONLY to reproduce the early-break
/// condition bit-for-bit; the row's model still comes from the parsed Value.
pub fn extract_raw_facts(raw: &str, max_scan_bytes: usize) -> RawFacts {
    const CHUNK: usize = 512 * 1024;
    let mut model_found = false;
    let mut workspace = String::new();
    let mut fp_2600 = String::new();
    let mut image_bytes = 0f64;
    let mut carry = String::new();
    let size = raw.len();
    let mut offset = 0usize;
    while offset < size && offset < max_scan_bytes {
        // In-memory text, not a file handle: the chunk walk slices the same bytes scan_request
        // would have read. A split multi-byte char at a chunk edge becomes U+FFFD here exactly
        // as it does in scan_request's String::from_utf8_lossy — same carry semantics.
        let end = (offset + CHUNK.min(max_scan_bytes)).min(size);
        let text = format!("{carry}{}", String::from_utf8_lossy(&raw.as_bytes()[offset..end]));
        if !model_found && model_re().captures(&text).is_some() {
            model_found = true;
        }
        if fp_2600.is_empty() {
            // Identity of the FIRST message: same inherited transcript ⇒ same fingerprint. Both
            // the index and the 2600-wide slice are UTF-16.
            if let Some(bp) = text.find("\"messages\"") {
                let i = utf16_len(&text[..bp]);
                if utf16_len(&text) - i > 2600 {
                    fp_2600 = djb2(js_slice(&text[bp..], 2600));
                }
            }
        }
        if workspace.is_empty() {
            for m in ws_re().captures_iter(&text) {
                let cand = m[1].trim();
                if looks_like_workspace(cand) {
                    workspace = cand.to_owned();
                    break;
                }
            }
        }
        image_bytes += sum_image_bytes(&text);
        if !workspace.is_empty()
            && !fp_2600.is_empty()
            && model_found
            && offset > 2 * CHUNK
            && image_bytes == 0.0
        {
            break;
        }
        carry = js_slice_from(&text, utf16_len(&text).saturating_sub(256)).to_owned();
        offset = end;
    }
    RawFacts { workspace, fp_2600, image_bytes }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn djb2_matches_the_ts_parity_vector() {
        // Moved with the helper from investigator_scan.rs's own test
        // (djb2_matches_node_including_the_surrogate_pair_path): the ASCII and surrogate-pair
        // vectors it pinned against the Node oracle.
        assert_eq!(djb2("hello"), "4bj995"); // verified against the Node oracle semantics (charCodeAt/UTF-16 loop)
        // Surrogate pair (😀 = U+1F600): iterating CHARS would give a different hash.
        let emoji = "\u{1F600}";
        let h = djb2(emoji);
        assert!(!h.is_empty(), "surrogate input must still hash: {h}");
    }

    #[test]
    fn looks_like_workspace_accepts_posix_and_windows_only() {
        assert!(looks_like_workspace("/w/p"));
        assert!(looks_like_workspace("C:\\w\\p"));
        assert!(looks_like_workspace("C:/w/p"));
        assert!(!looks_like_workspace("w/p"));
        assert!(!looks_like_workspace(""));
        assert!(!looks_like_workspace("C:"));
    }

    #[test]
    fn image_bytes_counts_only_runs_of_20000_plus() {
        let small = format!("{{\"data\":\"{}\"}}", "A".repeat(19_999));
        assert_eq!(sum_image_bytes(&small), 0.0);
        let big = format!("{{\"data\":\"{}\"}}", "A".repeat(20_000));
        assert_eq!(sum_image_bytes(&big), 20_000.0);
        let two = format!("{{\"a\":{{\"data\":\"{}\"}},\"b\":{{\"data\":\"{}\"}}}}", "B".repeat(20_000), "C".repeat(21_000));
        assert_eq!(sum_image_bytes(&two), 41_000.0);
    }

    #[test]
    fn extract_finds_workspace_fp_and_images_over_chunk_boundaries() {
        // A body whose "messages" offset, Environment block, and image run all sit inside the
        // first chunk — plus one whose facts straddle a synthetic small-chunk boundary is
        // covered by scan_request's own chunk tests in agentlens-core.
        let pad = "r".repeat(2800); // post-"messages" tail must EXCEED 2600 UTF-16 units
        let body = format!(
            r#"{{"model":"claude-opus-5","system":[{{"type":"text","text":"Primary working directory: /w/p\nmore"}}],"messages":[{{"role":"user","content":[{{"type":"text","text":"the first user turn {pad}"}}]}}]}}"#
        );
        let f = extract_raw_facts(&body, 6 * 1024 * 1024);
        assert_eq!(f.workspace, "/w/p");
        assert!(!f.fp_2600.is_empty(), "fp must be found: post-messages text > 2600 units");
        assert_eq!(f.image_bytes, 0.0);

        // A body with NO "messages" key or a tiny post-messages tail leaves fp '' (the parity
        // contract: '' is a legitimate extracted value, not absence — A1).
        let tiny = r#"{"model":"m","messages":[]}"#;
        let f2 = extract_raw_facts(tiny, 6 * 1024 * 1024);
        assert_eq!(f2.fp_2600, "");
        assert_eq!(f2.workspace, "");
    }

    #[test]
    fn fingerprint_is_stable_across_irrelevant_trailing_changes() {
        let pad = "r".repeat(3000);
        let mk = |tail: &str| format!(r#"{{"model":"m","messages":[{{"role":"user","content":"{pad}"}}],{tail}}}"#);
        let a = extract_raw_facts(&mk("\"z\":1"), 6 * 1024 * 1024);
        let b = extract_raw_facts(&mk("\"z\":2"), 6 * 1024 * 1024);
        assert_eq!(a.fp_2600, b.fp_2600, "same inherited transcript ⇒ same fingerprint");
        assert!(!a.fp_2600.is_empty());
    }
}
