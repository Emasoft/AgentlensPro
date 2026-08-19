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

fn list_dir_cached(dir: &Path) -> Vec<String> {
    let mut c = LISTING.lock().expect("listing cache");
    let Ok(m) = std::fs::metadata(dir) else {
        c.map.shift_remove(dir);
        return Vec::new();
    };
    let mtime = node_mtime_ms(&m);
    let hit = c.map.get(dir).filter(|(cached_mtime, _)| *cached_mtime == mtime).map(|(_, names)| names.clone());
    if let Some(names) = hit {
        c.hits += 1;
        return names;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        c.map.shift_remove(dir);
        return Vec::new();
    };
    let names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    c.readdirs += 1;
    if c.map.len() >= LISTING_CACHE_MAX {
        c.map.clear();
    }
    c.map.insert(dir.to_path_buf(), (mtime, names.clone()));
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
