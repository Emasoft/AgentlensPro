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
    // temp_dir(), not env!("CARGO_TARGET_TMPDIR"): that path is baked in at COMPILE time, so it escapes the
    // TMPDIR redirect of scripts/test-data-cap.sh and its 4 GB cap; temp_dir() follows the run dir.
    let dir = std::env::temp_dir().join("alspool").join(name);
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
    spawn_append_with(dir, spool, stdin, &[])
}

/// `alspool append` with extra command-line arguments (e.g. `--seal-bytes N`) after the two required flags.
fn spawn_append_with(dir: &Path, spool: &str, stdin: &[u8], extra: &[&str]) -> Child {
    let mut child = Command::new(env!("CARGO_BIN_EXE_alspool"))
        .args(["append", "--ingest-dir"])
        .arg(dir)
        .args(["--spool", spool])
        .args(extra)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // WHY (TRDD-JCUXA6Z4): a child may exit before it reads stdin (a usage error exits 64 while
    // parsing arguments), and then this write fails with BrokenPipe. The test's exit-code assertion
    // decides the outcome; any other write error is still a test failure.
    if let Err(e) = child.stdin.take().unwrap().write_all(stdin) {
        assert_eq!(e.kind(), std::io::ErrorKind::BrokenPipe, "stdin write: {e}");
    } // the handle is dropped here: EOF
    child
}

fn append(dir: &Path, spool: &str, stdin: &[u8]) -> Output {
    spawn_append(dir, spool, stdin).wait_with_output().unwrap()
}

fn append_with(dir: &Path, spool: &str, stdin: &[u8], extra: &[&str]) -> Output {
    spawn_append_with(dir, spool, stdin, extra).wait_with_output().unwrap()
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
    let bad: [(&str, &[u8]); 12] = [
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

// ---------------------------------------------------------------- payload rules and the size bound

/// 11. Leading and trailing ASCII whitespace around the object is dropped, whitespace inside it is kept verbatim, non-ASCII whitespace is not whitespace.
#[test]
fn s11_append_trims_ascii_whitespace_at_both_ends() {
    let dir = scratch("s11");
    let payload = r#"{"a": 1,  "b":" x "}"#;
    for wrapped in [format!(" {payload}"), format!("\n\r\t {payload}\n"), format!("\x0c{payload}\x0c"), format!("  {payload}  ")] {
        ok(&append(&dir, SP, wrapped.as_bytes()));
    }
    let lines = lines_of(&current(&dir, SP));
    assert_eq!(lines.len(), 4);
    for line in &lines {
        assert!(line.ends_with(&format!(",\"payload\":{payload}}}")), "payload verbatim, nothing of the whitespace kept: {line}");
    }
    let nbsp = scratch("s11-nbsp");
    let out = append(&nbsp, SP, format!("\u{a0}{payload}").as_bytes());
    assert!(!out.status.success() && !nbsp.join("inbox").exists(), "a no-break space is not ASCII whitespace");
}

/// 12. A payload whose spool line would exceed the loader's 64 MiB maximum object size is rejected, naming the limit, with nothing written; the largest one that fits is accepted and its line is within the limit.
#[test]
fn s12_append_rejects_a_payload_too_large_for_the_loader() {
    use agentlens_spool::{LINE_OVERHEAD_MAX, MAX_LINE_BYTES};
    assert_eq!(MAX_LINE_BYTES, 67_108_864, "the loader's maximum_object_size (agentlens-digest MAX_OBJECT_BYTES)");
    // `{"p":"xxx"}` is 8 bytes plus the pad: an object of exactly `len` bytes.
    let object = |len: usize| format!("{{\"p\":\"{}\"}}", "x".repeat(len - 8));
    for (name, len) in [("limit", MAX_LINE_BYTES), ("one over", MAX_LINE_BYTES - LINE_OVERHEAD_MAX + 1)] {
        let dir = scratch(&format!("s12-{name}"));
        let out = append(&dir, SP, object(len).as_bytes());
        assert!(!out.status.success(), "{name}: accepted");
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(err.contains("67108864") && err.contains(&len.to_string()), "{name}: {err}");
        assert!(!dir.join("inbox").exists(), "{name}: something was written");
        std::fs::remove_dir_all(&dir).unwrap();
    }
    let dir = scratch("s12-fits");
    // A threshold that is never reached: the 64 MiB line stays in current.ndjson (the default would seal it away).
    ok(&append_with(&dir, SP, object(MAX_LINE_BYTES - LINE_OVERHEAD_MAX).as_bytes(), &["--seal-bytes", &u64::MAX.to_string()]));
    let size = std::fs::metadata(current(&dir, SP)).unwrap().len() as usize;
    assert!(size <= MAX_LINE_BYTES, "the line is {size} bytes");
    std::fs::remove_dir_all(&dir).unwrap(); // 64 MiB of scratch
}

/// The `seq` of every line, ready files (oldest first) then current.ndjson: the order of the appends.
fn seqs_in_order(dir: &Path) -> Vec<u64> {
    let mut files = ready_files(dir, SP);
    if current(dir, SP).exists() {
        files.push(current(dir, SP));
    }
    files.iter().flat_map(|f| lines_of(f)).map(|l| serde_json::from_str::<Value>(&l).unwrap()["payload"]["seq"].as_u64().unwrap()).collect()
}

/// Largest line (newline included) of the files.
fn longest_line(files: &[PathBuf]) -> u64 {
    files.iter().flat_map(|f| lines_of(f)).map(|l| l.len() as u64 + 1).max().unwrap()
}

/// 13. With --seal-bytes N the appender seals by itself once the file holds >= N bytes: every ready file is >= N and at most N + one line, the remainder is < N, and every line is in exactly one file, in order.
#[test]
fn s13_append_seals_by_itself_past_the_threshold() {
    const N: u64 = 100_000;
    let dir = scratch("s13");
    for seq in 0..25 {
        let payload = serde_json::json!({"seq": seq, "pad": "x".repeat(30_000)}).to_string();
        ok(&append_with(&dir, SP, payload.as_bytes(), &["--seal-bytes", &N.to_string()]));
    }
    let ready = ready_files(&dir, SP);
    assert_eq!(ready.len(), 6, "25 lines of ~30 KB: a seal after every 4th");
    let longest = longest_line(&ready);
    for f in &ready {
        let size = std::fs::metadata(f).unwrap().len();
        assert!((N..=N + longest).contains(&size), "{}: {size} bytes outside [{N}, {}]", f.display(), N + longest);
    }
    assert!(std::fs::metadata(current(&dir, SP)).unwrap().len() < N, "the remainder is under the threshold");
    assert_eq!(seqs_in_order(&dir), (0..25).collect::<Vec<u64>>());
}

/// 14. Without --seal-bytes the default of 4 MiB applies.
#[test]
fn s14_the_default_threshold_is_4_mib() {
    assert_eq!(agentlens_spool::DEFAULT_SEAL_BYTES, 4_194_304);
    let dir = scratch("s14");
    for seq in 0..5 {
        ok(&append(&dir, SP, serde_json::json!({"seq": seq, "pad": "x".repeat(1_048_576)}).to_string().as_bytes()));
    }
    let ready = ready_files(&dir, SP);
    assert_eq!(ready.len(), 1, "3 lines are under 4 MiB, the 4th reaches it");
    assert_eq!(lines_of(&ready[0]).len(), 4);
    assert_eq!(lines_of(&current(&dir, SP)).len(), 1);
}

/// 15. 22 processes x 30 appends of ~8 KiB with --seal-bytes 65536 and NO sealer: every (proc, seq) is in exactly one file, intact, every ready file is >= N and at most N + one line, the remainder is < N.
#[test]
fn s15_concurrent_self_sealing_appends_lose_nothing_and_bound_the_files() {
    const PROCS: usize = 22;
    const PER_PROC: usize = 30;
    const N: u64 = 65_536;
    let dir = scratch("s15");
    std::thread::scope(|scope| {
        let writers: Vec<_> = (0..PROCS)
            .map(|p| {
                let dir = &dir;
                scope.spawn(move || {
                    for s in 0..PER_PROC {
                        let payload = serde_json::json!({"proc": p, "seq": s, "pad": "x".repeat(8192 + (p + s) % 64)});
                        ok(&append_with(dir, SP, payload.to_string().as_bytes(), &["--seal-bytes", &N.to_string()]));
                    }
                })
            })
            .collect();
        for w in writers {
            w.join().unwrap();
        }
    });
    let ready = ready_files(&dir, SP);
    assert!(ready.len() >= 8, "{} ready files", ready.len());
    let longest = longest_line(&ready);
    let mut seen: Vec<(u64, u64, usize)> = Vec::new();
    for f in &ready {
        let size = std::fs::metadata(f).unwrap().len();
        assert!((N..=N + longest).contains(&size), "{}: {size} bytes outside [{N}, {}]", f.display(), N + longest);
    }
    for f in ready.iter().chain(std::iter::once(&current(&dir, SP)).filter(|p| p.exists())) {
        for line in lines_of(f) {
            let p = &serde_json::from_str::<Value>(&line).unwrap()["payload"];
            seen.push((p["proc"].as_u64().unwrap(), p["seq"].as_u64().unwrap(), p["pad"].as_str().unwrap().len()));
        }
    }
    assert!(std::fs::metadata(current(&dir, SP)).map_or(0, |m| m.len()) < N, "the remainder is under the threshold");
    seen.sort_unstable();
    let expected: Vec<(u64, u64, usize)> = (0..PROCS).flat_map(|p| (0..PER_PROC).map(move |s| (p as u64, s as u64, 8192 + (p + s) % 64))).collect();
    assert_eq!(seen, expected, "lost, duplicated or damaged lines");
}

/// 16. A seal that fails AFTER the write exits 2 with the line kept (a retry would duplicate it) and the next append seals; a malformed --seal-bytes is a usage error that writes nothing.
#[test]
fn s16_a_failed_seal_after_the_write_exits_2_and_keeps_the_line() {
    let dir = scratch("s16");
    std::fs::create_dir_all(dir.join("ready")).unwrap();
    std::fs::write(dir.join("ready").join(SP), "a file where the ready directory must go").unwrap();
    let out = append_with(&dir, SP, br#"{"seq":1}"#, &["--seal-bytes", "1"]);
    assert_eq!(out.status.code(), Some(2), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(String::from_utf8_lossy(&out.stderr).contains("do not retry"));
    assert_eq!(lines_of(&current(&dir, SP)).len(), 1, "the line is there");
    std::fs::remove_file(dir.join("ready").join(SP)).unwrap();
    ok(&append_with(&dir, SP, br#"{"seq":2}"#, &["--seal-bytes", "1"]));
    assert_eq!(seqs_in_order(&dir), [1, 2]);
    assert_eq!(ready_files(&dir, SP).len(), 1, "both lines sealed together");
    assert!(!current(&dir, SP).exists());
    let bad = scratch("s16-usage");
    let out = append_with(&bad, SP, br#"{"seq":1}"#, &["--seal-bytes", "lots"]);
    assert_eq!(out.status.code(), Some(64));
    assert!(!bad.join("inbox").exists());
    // TRDD-JCUXA6Z4: 1 MiB of stdin is more than a pipe buffer, so the write is still blocked when
    // alspool exits 64 on the usage error, and the helper's BrokenPipe branch runs on every run.
    let big = vec![b'x'; 1 << 20];
    let out = append_with(&bad, SP, &big, &["--seal-bytes", "lots"]);
    assert_eq!(out.status.code(), Some(64), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(!bad.join("inbox").exists());
}


/// 17. `append_many` writes every payload verbatim as its own line in order, under one lock hold, with non-decreasing `ts_ns`; a one-element call equals `append`.
#[test]
fn s17_append_many_writes_every_payload_as_its_own_line_in_order() {
    let dir = scratch("s17");
    let payloads: Vec<String> = (0..50).map(|i| format!(r#"{{"seq": {i},  "big":18446744073709551616, "d":0.123456789012345678901234567890}}"#)).collect();
    let refs: Vec<&[u8]> = payloads.iter().map(|p| p.as_bytes()).collect();
    let before = now_ns();
    assert_eq!(agentlens_spool::append_many(&dir, SP, &refs, agentlens_spool::DEFAULT_SEAL_BYTES).unwrap(), agentlens_spool::Appended::Written);
    let after = now_ns();
    let lines = lines_of(&current(&dir, SP));
    assert_eq!(lines.len(), 50);
    let mut last = 0u128;
    for (line, payload) in lines.iter().zip(&payloads) {
        let (ts, rest) = line.strip_prefix("{\"ts_ns\":").unwrap().split_once(",\"payload\":").unwrap();
        assert_eq!(rest, format!("{payload}}}"), "payload verbatim");
        let ts: u128 = ts.parse().unwrap();
        assert!(ts >= last && (before..=after).contains(&ts), "ts_ns {ts} not non-decreasing inside [{before}, {after}]");
        last = ts;
    }
    agentlens_spool::append_many(&dir, SP, &[br#"{"seq":50}"#], agentlens_spool::DEFAULT_SEAL_BYTES).unwrap();
    ok(&append(&dir, SP, br#"{"seq":51}"#));
    let all = lines_of(&current(&dir, SP));
    assert_eq!(all.len(), 52);
    assert!(all[50].ends_with(r#""payload":{"seq":50}}"#) && all[51].ends_with(r#""payload":{"seq":51}}"#));
}

/// 18. One invalid payload in a batch (or an empty batch) is an `Err` that writes nothing, not even the directory; the single-payload message is the bare one.
#[test]
fn s18_append_many_validates_everything_before_writing_anything() {
    let dir = scratch("s18");
    let err = agentlens_spool::append_many(&dir, SP, &[br#"{"a":1}"#, b"[1]", br#"{"a":3}"#], 1).unwrap_err();
    assert!(err.starts_with("payload 1: "), "{err}");
    assert!(!dir.join("inbox").exists(), "something was written");
    assert!(agentlens_spool::append_many(&dir, SP, &[], 1).is_err());
    let single = agentlens_spool::append_many(&dir, SP, &[b"[1]"], 1).unwrap_err();
    assert!(single.starts_with("payload must be one JSON object"), "a lone payload keeps the bare `alspool append` message: {single}");
    assert!(!dir.join("inbox").exists());
}

/// 19. A batch that takes the file past `seal_bytes` seals it once, whole: no line is lost, split or duplicated.
#[test]
fn s19_append_many_seals_once_after_the_batch() {
    let dir = scratch("s19");
    let payloads: Vec<String> = (0..10).map(|i| format!(r#"{{"seq":{i},"pad":"{}"}}"#, "x".repeat(1000))).collect();
    let refs: Vec<&[u8]> = payloads.iter().map(|p| p.as_bytes()).collect();
    let got = agentlens_spool::append_many(&dir, SP, &refs, 4000).unwrap();
    assert!(matches!(got, agentlens_spool::Appended::Sealed(_)), "{got:?}");
    let ready = ready_files(&dir, SP);
    assert_eq!(ready.len(), 1);
    assert_eq!(lines_of(&ready[0]).len(), 10);
    assert!(!current(&dir, SP).exists());
}
