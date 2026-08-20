//! Cross-engine parity for the WAD archive reader (TRDD-DMWOBWFH rows 14–15): the committed
//! fixture volumes were WRITTEN by the compiled TS bodyArchive.js (the one writer), and the
//! Rust reader must list, random-access and extract them byte-identically — the directory
//! listing, every extracted file's bytes, and the windowed filter all deep-equal the oracle.
//! After any TS change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-bodyarchive-expected.mjs

use agentlens_core::body_archive::{extract_archive, list_archive_entries};
use serde_json::Value;

fn fixtures() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

#[test]
fn wad_reader_reproduces_the_ts_writer_exactly() {
    let dir = fixtures();
    let arch = dir.join("bodyarchive-tree/otel-bodies-archive");
    let oracle: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("bodyarchive-expected.json")).unwrap()).unwrap();

    // The directory listing — every field, including the torn-tail line being skipped.
    let entries = list_archive_entries(&arch);
    let exp = oracle["entries"].as_array().unwrap();
    assert_eq!(entries.len(), exp.len(), "entry count");
    for (e, x) in entries.iter().zip(exp) {
        assert_eq!(e.name, x["name"].as_str().unwrap());
        assert_eq!(e.offset, x["offset"].as_u64().unwrap(), "{}", e.name);
        assert_eq!(e.compressed_length, x["compressedLength"].as_u64().unwrap(), "{}", e.name);
        assert_eq!(e.size, x["size"].as_u64().unwrap(), "{}", e.name);
        assert_eq!(e.mtime_ms, x["mtimeMs"].as_f64().unwrap(), "{}", e.name);
        assert_eq!(e.volume.file_name().unwrap().to_str().unwrap(), x["volume"].as_str().unwrap(), "{}", e.name);
    }

    // Full extract — counts, total bytes, and the exact bytes of every produced file.
    let dest = std::env::temp_dir().join(format!("al-bodyarchive-all-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dest);
    let (files, bytes) = extract_archive(&arch, &dest, |_| true).unwrap();
    assert_eq!(files, oracle["extractAll"]["files"].as_u64().unwrap());
    assert_eq!(bytes, oracle["extractAll"]["bytes"].as_u64().unwrap());
    for (name, content) in oracle["extractAll"]["contents"].as_object().unwrap() {
        let got = std::fs::read_to_string(dest.join(name)).unwrap();
        assert_eq!(&got, content.as_str().unwrap(), "{name}");
    }
    let _ = std::fs::remove_dir_all(&dest);

    // The windowed filter — the export route's `e.mtimeMs >= since && e.mtimeMs <= until`.
    let since = oracle["extractWindow"]["since"].as_f64().unwrap();
    let until = oracle["extractWindow"]["until"].as_f64().unwrap();
    let dest = std::env::temp_dir().join(format!("al-bodyarchive-win-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dest);
    let (files, bytes) = extract_archive(&arch, &dest, |e| e.mtime_ms >= since && e.mtime_ms <= until).unwrap();
    assert_eq!(files, oracle["extractWindow"]["files"].as_u64().unwrap());
    assert_eq!(bytes, oracle["extractWindow"]["bytes"].as_u64().unwrap());
    let mut names: Vec<String> = std::fs::read_dir(&dest)
        .unwrap()
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_owned))
        .collect();
    names.sort();
    let exp_names: Vec<&str> = oracle["extractWindow"]["names"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert_eq!(names, exp_names);
    let _ = std::fs::remove_dir_all(&dest);
}
