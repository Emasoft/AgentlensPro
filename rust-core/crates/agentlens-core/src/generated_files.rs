//! src/generatedFiles.ts — output-file / scratch-subfolder tracking (TRDD-ZS1GDXVY), the fs half
//! (the PATH harvest lives in the parser: `ParsedTranscript.gen_files`). Claude Code writes
//! per-session artifacts under an OS-temp `claude-<uid>/<project-slug>/<sessionUuid>/` tree;
//! this resolves the harvested referenced paths (stat → a ref, `missing:true` when gone) and
//! indexes the session's scratch tree (BOUNDED breadth-first, 500 files, never reads content)
//! onto the card: correlated refs attach to their timeline entry (`generatedFiles`), the rest +
//! the scratch discoveries land in `card.generatedFiles` (absent when empty),
//! `generatedFilesTruncated` only when the cap was hit. Byte-only leaves use the coarse
//! `ceil(bytes/4)` estimator.
//!
//! Directory listings are cached by the directory's OWN mtime (TRDD-X2E6OSWK): POSIX bumps it on
//! every entry create/remove/rename, so a new tree/slug/session dir is still found on the next
//! call — the LISTING is cached, never the answer; file sizes are statted fresh. The cache is a
//! process-wide singleton (as the TS module state), bounded, cleared whole on overflow.

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use indexmap::IndexMap;
use serde_json::{json, Map, Value};

pub const SCRATCH_INDEX_MAX_FILES: usize = 500;
const LISTING_CACHE_MAX: usize = 5000;

#[derive(Default)]
struct ListingCache {
    map: IndexMap<PathBuf, (f64, Vec<String>)>,
    readdirs: u64,
    hits: u64,
}

static LISTING: LazyLock<Mutex<ListingCache>> = LazyLock::new(|| Mutex::new(ListingCache::default()));

// SHARDING WAS TRIED HERE AND IS DELIBERATELY NOT PRESENT (TRDD-HFV4AIT7).
//
// 64 path-hashed shards were implemented and measured. The measurement was WORTHLESS, so the
// change was reverted: two consecutive identical runs of the same binary produced 28.4 s and
// 103.0 s, because a live alcore server had been restarted and was boot-scanning the same ~8.78 GB
// corpus. Every timing taken in that window — including the ones that looked like an improvement —
// was competing with it.
//
// So sharding is not rejected on merit; it is UNPROVEN, and unproven complexity does not get to
// stay. Re-measure on a QUIESCED machine (no server running, no other scan) before reintroducing
// it, and keep the cap in mind: `LISTING_CACHE_MAX` is a whole-cache budget, so applying it per
// shard silently raises the ceiling 64x (5,000 -> 320,000 cached listings).

/// isClaudeScratchPath — the `claude-<x>` prefix must sit directly under a recognised temp
/// root (/tmp, /private/tmp, or a macOS /var/folders/.../T), so an unrelated directory
/// literally named "claude-foo" is NOT mistaken for scratch.
pub fn is_claude_scratch_path(p: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r"(?:^|/)(?:private/tmp|tmp|var/folders/[^/]+/[^/]+/[A-Za-z])/claude-[^/]+/").expect("static regex")
    });
    !p.is_empty() && re.is_match(p)
}

/// readScratchFile (row 31) — one generated/output file's content for the on-demand "expand"
/// leaf. SECURITY (path-traversal containment): the regex above only asserts the RAW string
/// CONTAINS a scratch segment, so `/tmp/claude-x/../../etc/passwd` matches yet resolves
/// outside — and the UI is browser-reachable, so a raw-string check would let any website read
/// arbitrary local files. Hence realpath containment: canonicalize (symlinks + `..` resolved)
/// and re-check the regex on THAT; all stat/read then use the canonical path, never the
/// caller-supplied string. Content is capped (200KB default) with an explicit truncated flag;
/// absence is `{exists:false}`, never a silent null.
pub fn read_scratch_file(p: &str, max_bytes: usize) -> Value {
    use serde_json::json;
    if !is_claude_scratch_path(p) {
        return json!({ "exists": false, "error": "path not under a Claude scratch tree" });
    }
    let Ok(real) = std::fs::canonicalize(p) else { return json!({ "exists": false }) };
    if !is_claude_scratch_path(&real.to_string_lossy()) {
        return json!({ "exists": false, "error": "path not under a Claude scratch tree" });
    }
    let Ok(st) = std::fs::metadata(&real) else { return json!({ "exists": false }) };
    if !st.is_file() {
        return json!({ "exists": false, "error": "not a file" });
    }
    let Ok(buf) = std::fs::read(&real) else { return json!({ "exists": false }) };
    let mtime_ms = st
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    json!({
        "exists": true,
        "sizeBytes": st.len(),
        // Math.round(st.mtimeMs) — the JS away-from-zero round on the float ms.
        "mtimeMs": crate::summarize::helpers::num(crate::summarize::helpers::js_math_round(mtime_ms)),
        "truncated": buf.len() > max_bytes,
        // buf.subarray(0, max).toString('utf8') — a cap landing mid-UTF-8-char yields the
        // replacement char in both engines (lossy either way).
        "content": String::from_utf8_lossy(&buf[..buf.len().min(max_bytes)]),
    })
}

/// `{readdirs, hits, cached}` — /api/debug/log-scan-stats scratchListing; `readdirs` must stay
/// ~flat while a session is appended to (that is the meter the cache is judged on).
pub fn scratch_listing_stats() -> (u64, u64, usize) {
    let c = LISTING.lock().expect("listing cache");
    (c.readdirs, c.hits, c.map.len())
}

pub fn clear_scratch_listing_cache() {
    LISTING.lock().expect("listing cache").map.clear();
}

/// estimateTokensFromBytes — ceil(bytes / 4), 0 for 0.
pub fn estimate_tokens_from_bytes(bytes: u64) -> u64 {
    bytes.div_ceil(4)
}

fn node_mtime_ms(m: &std::fs::Metadata) -> f64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs() as f64 * 1000.0 + d.subsec_nanos() as f64 / 1e6)
}

/// NEVER HOLD `LISTING` ACROSS A SYSCALL (TRDD-HFV4AIT7).
///
/// This function used to take the global lock ONCE at the top and keep it for the whole body —
/// across `fs::metadata`, across `fs::read_dir`, and across the full directory iteration. `LISTING`
/// is process-global, so every parallel scan worker queued behind one mutex while its holder did
/// directory I/O. That is a lock convoy, and it is why the cold scan reached only **3.09 CPU cores
/// / 25.9 s** while `allogscan` over the same corpus reached **8.02 cores at 1,439 MB/s**, and why
/// `RAYON_NUM_THREADS=4` measured FASTER than the default 14 — more threads meant a longer queue,
/// not more work done. Profile: 64,827 `__psynch_mutexwait` samples top-of-stack.
///
/// The lock now covers only the map operations. Two threads that miss on the same directory may
/// both `read_dir` it; that race is BENIGN and deliberately accepted — they compute identical
/// listings, the second insert overwrites an equal value, and the alternative (holding the lock
/// while one of them does I/O) is the bug being fixed. Duplicated work on a cache miss is far
/// cheaper than serialising every worker.
fn list_dir_cached(dir: &Path) -> Vec<String> {
    // stat OUTSIDE the lock.
    let Ok(m) = std::fs::metadata(dir) else {
        LISTING.lock().expect("listing cache").map.shift_remove(dir);
        return Vec::new();
    };
    let mtime = node_mtime_ms(&m);

    // Cache probe: lock held for one map lookup and a clone, nothing else.
    {
        let mut c = LISTING.lock().expect("listing cache");
        if let Some(names) = c.map.get(dir).filter(|(cached_mtime, _)| *cached_mtime == mtime).map(|(_, names)| names.clone()) {
            c.hits += 1;
            return names;
        }
    }

    // read_dir + iteration OUTSIDE the lock — this is the expensive part, and the whole point.
    let Ok(rd) = std::fs::read_dir(dir) else {
        LISTING.lock().expect("listing cache").map.shift_remove(dir);
        return Vec::new();
    };
    let names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();

    // Publish: lock held for the insert only.
    {
        let mut c = LISTING.lock().expect("listing cache");
        c.readdirs += 1;
        if c.map.len() >= LISTING_CACHE_MAX {
            c.map.clear();
        }
        c.map.insert(dir.to_path_buf(), (mtime, names.clone()));
    }
    names
}

fn file_ref(path: &str, size: u64, mtime_ms: f64, origin: &str) -> Value {
    json!({ "path": path, "sizeBytes": size, "mtimeMs": mtime_ms.round() as i64, "tokenEstimate": estimate_tokens_from_bytes(size), "origin": origin })
}

fn missing_ref(path: &str, origin: &str) -> Value {
    json!({ "path": path, "sizeBytes": 0, "mtimeMs": 0, "tokenEstimate": 0, "origin": origin, "missing": true })
}

/// resolveGeneratedFile — a `missing:true` ref for an absent REFERENCED path (the leaf still shows
/// the call named an output), None for an absent scratch path or a non-file.
pub fn resolve_generated_file(path: &str, origin: &str) -> Option<Value> {
    let Ok(m) = std::fs::metadata(path) else {
        return (origin == "referenced").then(|| missing_ref(path, origin));
    };
    if !m.is_file() {
        return None;
    }
    Some(file_ref(path, m.len(), node_mtime_ms(&m), origin))
}

/// defaultTmpRoots — os.tmpdir(), /tmp, /private/tmp, realpath-deduped (macOS's /tmp →
/// /private/tmp symlink must not be walked twice), absent roots dropped.
pub fn default_tmp_roots() -> Vec<PathBuf> {
    let mut seen: Vec<PathBuf> = Vec::new();
    for r in [std::env::temp_dir(), PathBuf::from("/tmp"), PathBuf::from("/private/tmp")] {
        if let Ok(real) = std::fs::canonicalize(&r) {
            if !seen.contains(&real) {
                seen.push(real);
            }
        }
    }
    seen
}

/// findSessionScratchDirs — {root}/claude-*/<slug>/<sessionUuid>; the existence check is a real
/// stat every call (one syscall; the one thing never served from a cache).
fn find_session_scratch_dirs(session_uuid: &str, roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for root in roots {
        for uid in list_dir_cached(root) {
            if !uid.starts_with("claude-") {
                continue;
            }
            let uid_path = root.join(&uid);
            for slug in list_dir_cached(&uid_path) {
                let candidate = uid_path.join(&slug).join(session_uuid);
                if std::fs::metadata(&candidate).is_ok_and(|m| m.is_dir()) {
                    dirs.push(candidate);
                }
            }
        }
    }
    dirs
}

/// indexScratchTree — BOUNDED breadth-first walk; `truncated` the moment the cap is hit.
pub fn index_scratch_tree(session_uuid: &str, tmp_roots: Option<&[PathBuf]>, max_files: usize) -> (Vec<Value>, bool) {
    if session_uuid.is_empty() {
        return (Vec::new(), false);
    }
    let default_roots;
    let roots: &[PathBuf] = match tmp_roots {
        Some(r) => r,
        None => {
            default_roots = default_tmp_roots();
            &default_roots
        }
    };
    let mut queue: std::collections::VecDeque<PathBuf> = find_session_scratch_dirs(session_uuid, roots).into();
    let mut files = Vec::new();
    let mut truncated = false;
    'walk: while let Some(dir) = queue.pop_front() {
        for name in list_dir_cached(&dir) {
            let full = dir.join(&name);
            let Ok(m) = std::fs::metadata(&full) else { continue };
            if m.is_dir() {
                queue.push_back(full);
                continue;
            }
            if !m.is_file() {
                continue;
            }
            if files.len() >= max_files {
                truncated = true;
                break 'walk;
            }
            files.push(file_ref(&full.to_string_lossy(), m.len(), node_mtime_ms(&m), "scratch"));
        }
    }
    (files, truncated)
}

/// attachGeneratedFiles — onto a Value card: per-span refs on the matching timeline entries,
/// uncorrelated + scratch at card level (referenced wins a path collision), `generatedFiles`
/// absent when empty, `generatedFilesTruncated` only when true. Idempotent.
pub fn attach_generated_files(card: &mut Map<String, Value>, harvested: &[(String, Option<String>)], tmp_roots: Option<&[PathBuf]>, max_files: usize) {
    let mut by_span: IndexMap<&str, Vec<Value>> = IndexMap::new();
    let mut card_level: Vec<Value> = Vec::new();
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for (p, span) in harvested {
        let r = resolve_generated_file(p, "referenced").unwrap_or_else(|| missing_ref(p, "referenced"));
        seen.insert(p.as_str());
        match span.as_deref().filter(|s| !s.is_empty()) {
            Some(s) => by_span.entry(s).or_default().push(r),
            None => card_level.push(r),
        }
    }
    if let Some(timeline) = card.get_mut("timeline").and_then(Value::as_array_mut) {
        for entry in timeline.iter_mut().filter_map(Value::as_object_mut) {
            let span = entry.get("spanId").and_then(Value::as_str).unwrap_or("");
            if let Some(refs) = by_span.get(span).filter(|r| !r.is_empty()) {
                entry.insert("generatedFiles".into(), Value::Array(refs.clone()));
            }
        }
    }
    let session_id = card.get("sessionId").and_then(Value::as_str).unwrap_or("").to_owned();
    let (files, truncated) = index_scratch_tree(&session_id, tmp_roots, max_files);
    let mut scratch: Vec<Value> = Vec::new();
    for f in files {
        let p = f.get("path").and_then(Value::as_str).unwrap_or("").to_owned();
        if seen.contains(p.as_str()) {
            continue;
        }
        scratch.push(f);
        // The TS adds to `seen` as it goes; duplicate scratch paths cannot occur (one walk).
    }
    card_level.extend(scratch);
    if card_level.is_empty() {
        card.shift_remove("generatedFiles");
    } else {
        card.insert("generatedFiles".into(), Value::Array(card_level));
    }
    if truncated {
        card.insert("generatedFilesTruncated".into(), Value::Bool(true));
    } else {
        card.shift_remove("generatedFilesTruncated");
    }
}
