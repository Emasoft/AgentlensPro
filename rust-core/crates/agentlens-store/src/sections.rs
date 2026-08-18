//! Byte-exact sectioning of a raw API body — port of `src/store/sections.ts`.
//!
//! WHY BYTE OFFSETS AND NOT parse→re-serialize: reconstruction must be BYTE-IDENTICAL to the
//! source, and a re-serialization round trip only *happens* to be byte-exact. We slice the
//! ORIGINAL text and concatenate it back — identity by construction, not by luck. Rust scans
//! BYTES (all structural JSON characters are ASCII, so multibyte UTF-8 can never collide),
//! which is naturally byte-exact where the TS scanner had to be careful with UTF-16 indices.

use sha2::{Digest, Sha256};

/// A span smaller than this stays inline as literal glue (a content-addressed row costs more
/// than it saves on a 20-byte scalar). Same constant as the TS sectioner.
pub const MIN_BLOB_BYTES: usize = 128;

#[derive(Debug, Clone, PartialEq)]
pub enum Part {
    Lit { text: String },
    Blob { sha: String, n: u64, path: String, idx: i64 },
}

pub struct Sectioned {
    pub parts: Vec<Part>,
    /// sha256 → exact span text. Keyed by content — the map IS the dedup.
    pub blobs: std::collections::HashMap<String, String>,
    /// Blob insertion order (the TS Map preserves it; HashMap does not) — the appender writes
    /// blobs in this order so cross-engine part files stay comparable.
    pub blob_order: Vec<String>,
}

pub fn sha256_hex(text: &str) -> String {
    let mut h = Sha256::new();
    h.update(text.as_bytes());
    let out = h.finalize();
    let mut s = String::with_capacity(64);
    for b in out {
        use std::fmt::Write;
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn ws(s: &[u8], mut i: usize) -> usize {
    while i < s.len() && matches!(s[i], b' ' | b'\n' | b'\r' | b'\t') {
        i += 1;
    }
    i
}

/// Index just past the JSON value starting at `i`. Same minimal scanner as the TS original:
/// escape pairs consume as ONE unit; strings are opaque to brace counting.
pub fn scan_value(s: &[u8], mut i: usize) -> Result<usize, String> {
    i = ws(s, i);
    let Some(&c) = s.get(i) else { return Err(format!("unexpected end of body at {i}")) };
    if c == b'"' {
        i += 1;
        while i < s.len() {
            match s[i] {
                b'\\' => i += 2, // an escape pair is ONE unit — never look at its second byte
                b'"' => return Ok(i + 1),
                _ => i += 1,
            }
        }
        return Err("unterminated string in JSON body".into());
    }
    if c == b'{' || c == b'[' {
        let (open, close) = if c == b'{' { (b'{', b'}') } else { (b'[', b']') };
        let mut depth = 0usize;
        while i < s.len() {
            let ch = s[i];
            if ch == b'"' {
                i = scan_value(s, i)?;
                continue;
            }
            if ch == open {
                depth += 1;
            } else if ch == close {
                depth -= 1;
                if depth == 0 {
                    return Ok(i + 1);
                }
            }
            i += 1;
        }
        return Err("unterminated object/array in JSON body".into());
    }
    let start = i;
    while i < s.len() && !matches!(s[i], b',' | b'}' | b']' | b' ' | b'\n' | b'\r' | b'\t') {
        i += 1;
    }
    if i == start {
        return Err(format!("unexpected character {:?} at {i}", c as char));
    }
    Ok(i)
}

fn emit(out: &mut Sectioned, span: &str, path: &str, idx: i64) {
    let n = span.len();
    if n < MIN_BLOB_BYTES {
        out.parts.push(Part::Lit { text: span.to_owned() });
        return;
    }
    let sha = sha256_hex(span);
    if !out.blobs.contains_key(&sha) {
        out.blob_order.push(sha.clone());
    }
    out.blobs.insert(sha.clone(), span.to_owned());
    out.parts.push(Part::Blob { sha, n: n as u64, path: path.to_owned(), idx });
}

/// Split a raw body into parts — top-level keys become sections, a top-level array splits
/// element-wise, and EVERY non-value byte (punctuation, whitespace) survives as literal glue.
pub fn sectionize(raw: &str) -> Result<Sectioned, String> {
    let s = raw.as_bytes();
    let mut out = Sectioned { parts: Vec::new(), blobs: std::collections::HashMap::new(), blob_order: Vec::new() };
    let mut i = ws(s, 0);
    if s.get(i) != Some(&b'{') {
        emit(&mut out, raw, "$", -1);
        return Ok(out);
    }
    let mut lit = i; // start of the pending literal run
    i += 1; // past '{'
    loop {
        i = ws(s, i);
        match s.get(i) {
            Some(b'}') => {
                out.parts.push(Part::Lit { text: raw[lit..].to_owned() });
                break;
            }
            Some(b',') => {
                i += 1;
                continue;
            }
            None => return Err("unterminated top-level object".into()),
            _ => {}
        }
        let key_end = scan_value(s, i)?;
        let key: String = serde_json::from_str(&raw[i..key_end]).map_err(|e| format!("bad key: {e}"))?;
        let mut j = ws(s, key_end);
        if s.get(j) != Some(&b':') {
            return Err(format!("expected ':' after key {key}"));
        }
        j = ws(s, j + 1);

        if s.get(j) == Some(&b'[') {
            out.parts.push(Part::Lit { text: raw[lit..j + 1].to_owned() });
            let mut k = j + 1;
            let mut glue = k;
            let mut elem: i64 = 0;
            loop {
                let p = ws(s, k);
                match s.get(p) {
                    Some(b']') => {
                        k = p + 1;
                        break;
                    }
                    Some(b',') => {
                        k = p + 1;
                        continue;
                    }
                    None => return Err("unterminated array".into()),
                    _ => {}
                }
                let end = scan_value(s, p)?;
                out.parts.push(Part::Lit { text: raw[glue..p].to_owned() });
                emit(&mut out, &raw[p..end], &key, elem);
                elem += 1;
                glue = end;
                k = end;
            }
            lit = glue; // from the end of the last element (trailing ws + ']') onward
            i = k;
            continue;
        }

        let end = scan_value(s, j)?;
        out.parts.push(Part::Lit { text: raw[lit..j].to_owned() });
        emit(&mut out, &raw[j..end], &key, -1);
        lit = end;
        i = end;
    }
    Ok(out)
}

/// Rebuild the exact source text. A missing blob is an ERROR, never a silent gap.
pub fn reassemble(parts: &[Part], get_blob: impl Fn(&str) -> Option<String>) -> Result<String, String> {
    let mut out = String::new();
    for p in parts {
        match p {
            Part::Lit { text } => out.push_str(text),
            Part::Blob { sha, n, path, idx } => {
                let span = get_blob(sha).ok_or_else(|| format!("missing blob {sha} ({path}[{idx}], {n} bytes)"))?;
                out.push_str(&span);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sectionize_round_trips_byte_identically() {
        let big = "x".repeat(200);
        let raw = format!(
            "{{\"model\":\"claude-opus-5\",\"messages\":[{{\"role\":\"user\",\"content\":\"{big}\"}} , {{\"role\":\"assistant\",\"content\":\"{big}zzz\"}}],\"max_tokens\":5}}"
        );
        let sec = sectionize(&raw).expect("sectionize");
        let back = reassemble(&sec.parts, |sha| sec.blobs.get(sha).cloned()).expect("reassemble");
        assert_eq!(back, raw, "byte identity by construction");
        assert!(sec.blobs.len() >= 2, "both big elements content-address");
    }

    #[test]
    fn escapes_and_nested_braces_inside_strings_do_not_desync() {
        let pad = "p".repeat(150);
        let raw = format!(
            "{{\"a\":\"quote \\\" brace {{ bracket [ backslash \\\\ end {pad}\",\"b\":[1,2,3]}}"
        );
        let sec = sectionize(&raw).expect("sectionize");
        let back = reassemble(&sec.parts, |sha| sec.blobs.get(sha).cloned()).expect("reassemble");
        assert_eq!(back, raw);
    }

    #[test]
    fn non_object_body_stores_whole() {
        let raw = "[1,2,3]";
        let sec = sectionize(raw).expect("sectionize");
        let back = reassemble(&sec.parts, |sha| sec.blobs.get(sha).cloned()).expect("reassemble");
        assert_eq!(back, raw);
    }
}
