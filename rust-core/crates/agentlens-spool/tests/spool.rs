//! Integration tests of agentlens-spool: they drive the real `alspool` binary. Payloads are
//! synthetic. Every test that holds a lock itself (to make the child block) uses `fs2`, the same
//! kernel flock the binary takes.

use fs2::FileExt;
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SP: &str = "sp";
/// How long a child that must be blocked on a lock is given to (wrongly) finish.
const BLOCKED_FOR: Duration = Duration::from_millis(400);

// ---------------------------------------------------------------- helpers

fn scratch(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("alspool").join(name);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).unwrap();
    }
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn now_ns() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
}

fn current(dir: &Path, spool: &str) -> PathBuf {
    dir.join("inbox").join(spool).join("current.ndjson")
}

fn ready_files(dir: &Path, spool: &str) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir.join("ready").join(spool)) else { return Vec::new() };
    let mut v: Vec<PathBuf> = rd.map(|e| e.unwrap().path()).collect();
    v.sort();
    v
}

fn spawn_append(dir: &Path, spool: &str, stdin: &[u8]) -> Child {
    let mut child = Command::new(env!("CARGO_BIN_EXE_alspool"))
        .args(["append", "--ingest-dir"])
        .arg(dir)
        .args(["--spool", spool])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stdin).unwrap(); // dropped: EOF
    child
}

fn append(dir: &Path, spool: &str, stdin: &[u8]) -> Output {
    spawn_append(dir, spool, stdin).wait_with_output().unwrap()
}

fn spawn_seal(dir: &Path, spool: Option<&str>) -> Child {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_alspool"));
    cmd.args(["seal", "--ingest-dir"]).arg(dir);
    if let Some(s) = spool {
        cmd.args(["--spool", s]);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap()
}

fn seal(dir: &Path, spool: Option<&str>) -> Output {
    spawn_seal(dir, spool).wait_with_output().unwrap()
}

fn ok(out: &Output) {
    assert!(out.status.success(), "exit {:?}: {}", out.status.code(), String::from_utf8_lossy(&out.stderr));
}

/// Take the exclusive lock the binary will contend for, on a (possibly new) current.ndjson.
fn hold_lock(dir: &Path, spool: &str) -> File {
    std::fs::create_dir_all(current(dir, spool).parent().unwrap()).unwrap();
    let f = OpenOptions::new().append(true).create(true).open(current(dir, spool)).unwrap();
    f.lock_exclusive().unwrap();
    f
}

fn assert_blocked(child: &mut Child, what: &str) {
    std::thread::sleep(BLOCKED_FOR);
    assert!(child.try_wait().unwrap().is_none(), "{what} finished although the lock was held");
}

fn lines_of(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path).unwrap().lines().map(str::to_owned).collect()
}

// ---------------------------------------------------------------- append

/// 1. append writes exactly one line `{"ts_ns":N,"payload":<stdin verbatim>}`; trailing whitespace is dropped, nothing re-serialised.
#[test]
fn s01_append_writes_one_exact_line() {
    let dir = scratch("s01");
    let payload = r#"{"a": 1,  "b":[1, 2], "s":"x\ty"}"#;
    let before = now_ns();
    ok(&append(&dir, SP, format!("{payload}\n\r\n \t").as_bytes()));
    let after = now_ns();
    ok(&append(&dir, SP, payload.as_bytes()));
    let text = std::fs::read_to_string(current(&dir, SP)).unwrap();
    assert!(text.ends_with('\n'));
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 2);
    let mut last = 0u128;
    for line in &lines {
        let (ts, rest) = line.strip_prefix("{\"ts_ns\":").unwrap().split_once(",\"payload\":").unwrap();
        assert_eq!(rest, format!("{payload}}}"), "payload verbatim, then the closing brace of the line");
        let ts: u128 = ts.parse().unwrap();
        assert!(ts >= last, "ts_ns non-decreasing in file order");
        last = ts;
    }
    let first: u128 = lines[0].strip_prefix("{\"ts_ns\":").unwrap().split_once(',').unwrap().0.parse().unwrap();
    assert!((before..=after).contains(&first), "ts_ns {first} outside [{before}, {after}]");
}

/// 2. Every input that is not ONE JSON object on ONE line, or a bad spool name, is rejected with a non-zero exit, a message, and nothing written.
#[test]
fn s02_append_rejects_bad_input_and_writes_nothing() {
    let bad: [(&str, &[u8]); 13] = [
        ("raw newline", b"{\"a\":\n1}"),
        ("raw carriage return", b"{\"a\":\r1}"),
        ("invalid utf-8", b"{\"a\":\"\xff\"}"),
        ("truncated json", b"{\"a\":"),
        ("array", b"[1,2]"),
        ("bare string", b"\"x\""),
        ("number", b"12"),
        ("null", b"null"),
        ("empty stdin", b""),
        ("only whitespace", b" \n\t "),
        ("leading whitespace", b" {\"a\":1}"),
        ("two objects", b"{\"a\":1}{\"b\":2}"),
        ("trailing garbage", b"{\"a\":1} x"),
    ];
    for (i, (what, stdin)) in bad.iter().enumerate() {
        let dir = scratch(&format!("s02-{i}"));
        let out = append(&dir, SP, stdin);
        assert!(!out.status.success(), "{what} was accepted");
        assert!(!out.stderr.is_empty(), "{what}: no message on stderr");
        assert!(!dir.join("inbox").exists(), "{what}: something was written");
    }
    for spool in ["a/b", "", "x-y", "..", "a b"] {
        let dir = scratch("s02-spool");
        let out = append(&dir, spool, b"{\"a\":1}");
        assert!(!out.status.success(), "spool {spool:?} was accepted");
        assert!(!dir.join("inbox").exists(), "spool {spool:?}: something was written");
    }
}

/// 3. append blocks while another process holds the exclusive lock, then writes (the flock exists).
#[test]
fn s03_append_waits_for_the_exclusive_lock() {
    let dir = scratch("s03");
    let held = hold_lock(&dir, SP);
    let mut child = spawn_append(&dir, SP, b"{\"a\":1}");
    assert_blocked(&mut child, "append");
    assert_eq!(std::fs::metadata(current(&dir, SP)).unwrap().len(), 0);
    FileExt::unlock(&held).unwrap();
    ok(&child.wait_with_output().unwrap());
    assert_eq!(lines_of(&current(&dir, SP)).len(), 1);
}

/// 4. A file sealed while append waited for the lock is not written to: append reopens and writes the new current.ndjson (the inode re-check).
#[test]
fn s04_append_reopens_when_the_file_was_sealed_while_it_waited() {
    let dir = scratch("s04");
    let held = hold_lock(&dir, SP);
    let mut child = spawn_append(&dir, SP, b"{\"a\":1}");
    assert_blocked(&mut child, "append");
    let sealed = dir.join("ready").join(SP).join("x.ndjson");
    std::fs::create_dir_all(sealed.parent().unwrap()).unwrap();
    std::fs::rename(current(&dir, SP), &sealed).unwrap(); // what a sealer does under the lock
    drop(held);
    ok(&child.wait_with_output().unwrap());
    assert_eq!(std::fs::metadata(&sealed).unwrap().len(), 0, "the sealed file must stay untouched");
    assert_eq!(lines_of(&current(&dir, SP)).len(), 1, "the line went to a fresh current.ndjson");
}

// ---------------------------------------------------------------- seal

/// 5. seal moves a non-empty current.ndjson to ready/<spool>/<ts_ns>-<pid>.ndjson untouched; an absent or empty one is a no-op; --spool limits it.
#[test]
fn s05_seal_moves_current_to_ready() {
    let dir = scratch("s05");
    assert!(seal(&dir, None).status.success(), "no inbox at all is nothing to seal");
    ok(&append(&dir, SP, b"{\"n\":1}"));
    ok(&append(&dir, SP, b"{\"n\":2}"));
    ok(&append(&dir, "sq", b"{\"n\":3}"));
    let before = std::fs::read_to_string(current(&dir, SP)).unwrap();
    let out = seal(&dir, None);
    ok(&out);
    assert_eq!(String::from_utf8_lossy(&out.stdout).lines().count(), 2, "one ready file per spool");
    let ready = ready_files(&dir, SP);
    assert_eq!(ready.len(), 1);
    let name = ready[0].file_name().unwrap().to_str().unwrap();
    let (ts, rest) = name.split_once('-').unwrap();
    assert!(ts.parse::<u128>().is_ok() && rest.strip_suffix(".ndjson").unwrap().parse::<u32>().is_ok(), "{name}");
    assert_eq!(std::fs::read_to_string(&ready[0]).unwrap(), before);
    assert!(!current(&dir, SP).exists() && !current(&dir, "sq").exists());
    // Nothing current: no-op, no new file.
    let out = seal(&dir, None);
    ok(&out);
    assert!(out.stdout.is_empty());
    assert_eq!(ready_files(&dir, SP).len(), 1);
    // An empty current.ndjson is a no-op and stays where it is.
    drop(hold_lock(&dir, SP));
    ok(&seal(&dir, Some(SP)));
    assert_eq!(ready_files(&dir, SP).len(), 1);
    assert!(current(&dir, SP).exists());
    // --spool seals only that spool.
    ok(&append(&dir, SP, b"{\"n\":4}"));
    ok(&append(&dir, "sq", b"{\"n\":5}"));
    ok(&seal(&dir, Some(SP)));
    assert!(!current(&dir, SP).exists() && current(&dir, "sq").exists());
    assert_eq!((ready_files(&dir, SP).len(), ready_files(&dir, "sq").len()), (2, 1));
}

/// 6. An unknown entry in inbox/ is an error (dot entries are ignored); sealing an absent spool is a no-op.
#[test]
fn s06_seal_unknown_inbox_entry() {
    let dir = scratch("s06");
    ok(&append(&dir, SP, b"{\"a\":1}"));
    std::fs::write(dir.join("inbox").join(".DS_Store"), "x").unwrap();
    ok(&seal(&dir, None));
    assert_eq!(ready_files(&dir, SP).len(), 1);
    ok(&seal(&dir, Some("nothing_here")));
    std::fs::create_dir_all(dir.join("inbox").join("bad-name")).unwrap();
    let out = seal(&dir, None);
    assert!(!out.status.success() && String::from_utf8_lossy(&out.stderr).contains("bad-name"));
}

/// 7. seal blocks while another process holds the exclusive lock, then seals (the flock exists).
#[test]
fn s07_seal_waits_for_the_exclusive_lock() {
    let dir = scratch("s07");
    let mut held = hold_lock(&dir, SP);
    held.write_all(b"{\"ts_ns\":1,\"payload\":{}}\n").unwrap();
    let mut child = spawn_seal(&dir, Some(SP));
    assert_blocked(&mut child, "seal");
    assert!(ready_files(&dir, SP).is_empty());
    FileExt::unlock(&held).unwrap();
    ok(&child.wait_with_output().unwrap());
    assert_eq!(ready_files(&dir, SP).len(), 1);
}

/// 8. A seal that finds, after getting the lock, the path absent or naming another file (another seal won) does nothing and exits 0.
#[test]
fn s08_seal_that_lost_the_race_does_nothing() {
    for replaced in [false, true] {
        let dir = scratch(&format!("s08-{replaced}"));
        let mut held = hold_lock(&dir, SP);
        held.write_all(b"{\"ts_ns\":1,\"payload\":{}}\n").unwrap();
        let mut child = spawn_seal(&dir, Some(SP));
        assert_blocked(&mut child, "seal");
        std::fs::rename(current(&dir, SP), dir.join("elsewhere")).unwrap(); // the winner's rename
        if replaced {
            std::fs::write(current(&dir, SP), "{\"ts_ns\":2,\"payload\":{}}\n").unwrap(); // an appender's new file
        }
        drop(held);
        let out = child.wait_with_output().unwrap();
        ok(&out);
        assert!(out.stdout.is_empty(), "the losing seal sealed something");
        assert!(ready_files(&dir, SP).is_empty());
        assert_eq!(current(&dir, SP).exists(), replaced, "the new current.ndjson must be left alone");
    }
}

/// 9. Several seals racing for the same file: exactly one wins, no file is lost or duplicated, all exit 0.
#[test]
fn s09_racing_seals_never_lose_or_duplicate_a_file() {
    let dir = scratch("s09");
    for round in 0..20 {
        std::fs::create_dir_all(current(&dir, SP).parent().unwrap()).unwrap();
        std::fs::write(current(&dir, SP), format!("round {round}\n")).unwrap();
        let children: Vec<Child> = (0..6).map(|_| spawn_seal(&dir, Some(SP))).collect();
        for c in children {
            ok(&c.wait_with_output().unwrap());
        }
        assert_eq!(ready_files(&dir, SP).len(), round + 1, "round {round}");
        assert!(!current(&dir, SP).exists());
    }
    let contents: BTreeSet<String> = ready_files(&dir, SP).iter().map(|p| std::fs::read_to_string(p).unwrap()).collect();
    assert_eq!(contents, (0..20).map(|r| format!("round {r}\n")).collect::<BTreeSet<_>>());
}

// ---------------------------------------------------------------- concurrency

/// 10. 22 processes x 50 appends of ~8 KiB while a loop seals: every (proc, seq) is in the sealed files exactly once, intact, and ts_ns never decreases within a file.
#[test]
fn s10_concurrent_appends_with_sealing_lose_nothing() {
    const PROCS: usize = 22;
    const PER_PROC: usize = 50;
    let dir = scratch("s10");
    let stop = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let sealer = scope.spawn(|| {
            while !stop.load(Ordering::Relaxed) {
                ok(&seal(&dir, Some(SP)));
            }
        });
        let writers: Vec<_> = (0..PROCS)
            .map(|p| {
                let dir = &dir;
                scope.spawn(move || {
                    for s in 0..PER_PROC {
                        let payload = serde_json::json!({"proc": p, "seq": s, "pad": "x".repeat(8192 + (p + s) % 64)});
                        ok(&append(dir, SP, payload.to_string().as_bytes()));
                    }
                })
            })
            .collect();
        for w in writers {
            w.join().unwrap();
        }
        stop.store(true, Ordering::Relaxed);
        sealer.join().unwrap();
    });
    ok(&seal(&dir, Some(SP)));
    assert!(!current(&dir, SP).exists());
    let mut seen: Vec<(u64, u64, usize)> = Vec::new();
    let files = ready_files(&dir, SP);
    for file in &files {
        let mut last_ts = 0u64;
        for line in lines_of(file) {
            let v: Value = serde_json::from_str(&line).unwrap_or_else(|e| panic!("{}: unparsable line: {e}", file.display()));
            let ts = v["ts_ns"].as_u64().unwrap();
            assert!(ts >= last_ts, "{}: ts_ns went backwards", file.display());
            last_ts = ts;
            let p = &v["payload"];
            seen.push((p["proc"].as_u64().unwrap(), p["seq"].as_u64().unwrap(), p["pad"].as_str().unwrap().len()));
        }
    }
    seen.sort_unstable();
    let expected: Vec<(u64, u64, usize)> = (0..PROCS).flat_map(|p| (0..PER_PROC).map(move |s| (p as u64, s as u64, 8192 + (p + s) % 64))).collect();
    assert_eq!(seen, expected, "lost, duplicated or damaged lines");
    println!("s10: {} sealed files", files.len());
}
