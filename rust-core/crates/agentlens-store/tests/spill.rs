//! Phase B (TRDD-9VX3WTGU / TRDD-DKBGT7MQ): every server DuckDB connection declares a small
//! memory limit AND a real spill directory, so an over-limit query is latency + disk, not a kill.

use agentlens_store::duckdb::Connection;
use agentlens_store::transcript_sql::DuckSession;
use agentlens_store::{open_store, spill_sql};

fn scratch(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("al-spill-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

/// A sort whose working set (~3M x 64-byte keys) far exceeds a 64MB limit.
const BIG_SORT: &str = "SELECT max(rn) FROM (SELECT row_number() OVER (ORDER BY h) rn FROM \
    (SELECT md5(i::VARCHAR) || md5((i+1)::VARCHAR) h FROM range(3000000) t(i)))";

/// `open_store` declares the 512MiB limit it is given and `<store>/tmp` as the spill dir.
#[test]
fn open_store_declares_its_limit_and_store_tmp() {
    let dir = scratch("store");
    let store = open_store(&dir, agentlens_store::SERVER_MEMORY_LIMIT, 2).expect("open");
    let lim: String = store.con.query_row("SELECT current_setting('memory_limit')", [], |r| r.get(0)).unwrap();
    let tmp: String = store.con.query_row("SELECT current_setting('temp_directory')", [], |r| r.get(0)).unwrap();
    assert_eq!(lim, "512.0 MiB");
    assert_eq!(tmp, dir.join("tmp").to_string_lossy());
    assert!(dir.join("tmp").is_dir());
    let _ = std::fs::remove_dir_all(&dir);
}

/// `DuckSession` (burn-seismic and transcript SQL share `open_spilling`) declares 512MiB + its tmp dir.
#[test]
fn duck_session_declares_512mib_and_the_given_tmp() {
    let tmp = scratch("session").join("tmp");
    let s = DuckSession::open_in_memory(&tmp).expect("open");
    let rows = s.query("SELECT current_setting('memory_limit') AS m, current_setting('temp_directory') AS t").unwrap();
    assert_eq!(rows[0]["m"], "953.6 MiB"); // TRANSCRIPT_MEMORY_LIMIT = 1GB
    assert_eq!(rows[0]["t"], tmp.to_string_lossy().as_ref());
    assert!(tmp.is_dir());
    let _ = std::fs::remove_dir_all(tmp.parent().unwrap());
}

/// Over a tiny limit a big sort SUCCEEDS with a spill dir (and the dir is empty once the
/// connection drops), while the same sort with spilling disabled FAILS — the control that proves
/// the spill dir, not a roomy limit, is what makes it pass.
#[test]
fn an_over_limit_sort_spills_and_leaves_no_tmp_file_behind() {
    let tmp = scratch("sort").join("tmp");
    {
        let con = Connection::open_in_memory().unwrap();
        let spill = spill_sql(&tmp).unwrap();
        con.execute_batch(&format!("SET memory_limit='64MB'; SET threads=2; {spill}")).unwrap();
        let n: i64 = con.query_row(BIG_SORT, [], |r| r.get(0)).expect("the spilling sort must succeed");
        assert_eq!(n, 3_000_000);
    }
    let left: Vec<_> = std::fs::read_dir(&tmp).unwrap().flatten().collect();
    assert!(left.is_empty(), "spill files must be gone after the connection drops: {left:?}");

    let control = Connection::open_in_memory().unwrap();
    control.execute_batch("SET memory_limit='64MB'; SET threads=2; SET temp_directory='';").unwrap();
    assert!(control.query_row(BIG_SORT, [], |r| r.get::<_, i64>(0)).is_err(), "no spill dir => the same sort must fail");
    let _ = std::fs::remove_dir_all(tmp.parent().unwrap());
}

/// Two concurrent `DuckSession`s serialize: the process-wide heavy-query slot admits one at a time.
#[test]
fn concurrent_heavy_sessions_serialize() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static LIVE: AtomicUsize = AtomicUsize::new(0);
    static MAX_LIVE: AtomicUsize = AtomicUsize::new(0);
    let base = scratch("serialize");
    let handles: Vec<_> = (0..2)
        .map(|i| {
            let tmp = base.join(format!("tmp{i}"));
            std::thread::spawn(move || {
                let _s = DuckSession::open_in_memory(&tmp).expect("open");
                let now = LIVE.fetch_add(1, Ordering::SeqCst) + 1;
                MAX_LIVE.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(300));
                LIVE.fetch_sub(1, Ordering::SeqCst);
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    assert_eq!(MAX_LIVE.load(Ordering::SeqCst), 1, "two heavy sessions overlapped");
    let _ = std::fs::remove_dir_all(&base);
}

/// A panic while holding the heavy slot must not wedge it: the next acquire recovers the poisoned lock.
#[test]
fn a_panic_while_holding_the_heavy_slot_does_not_wedge_it() {
    use agentlens_store::transcript_sql::acquire_heavy_within;
    let t = std::thread::spawn(|| {
        let _g = acquire_heavy_within(std::time::Duration::from_secs(5)).expect("first acquire");
        panic!("deliberate panic while holding the heavy slot");
    });
    assert!(t.join().is_err());
    // Bound (not discarded): the guard is held to the end of the test, as the recovery check intends.
    let _held = acquire_heavy_within(std::time::Duration::from_secs(5)).expect("slot must be recoverable after a poisoning panic");
}

/// A chore facing a steady stream of short heavy queries skips at most CHORE_MAX_SKIPS ticks, then runs.
#[test]
fn a_chore_is_not_starved_by_a_stream_of_heavy_queries() {
    use agentlens_store::transcript_sql::{acquire_heavy_for_chore, acquire_heavy_within, CHORE_MAX_SKIPS};
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    let stop = Arc::new(AtomicBool::new(false));
    let s2 = stop.clone();
    let holder = std::thread::spawn(move || {
        while !s2.load(Ordering::SeqCst) {
            if let Ok(g) = acquire_heavy_within(Duration::from_secs(5)) {
                std::thread::sleep(Duration::from_millis(1300)); // longer than the 1s chore wait
                drop(g);
            }
            std::thread::sleep(Duration::from_millis(30));
        }
    });
    std::thread::sleep(Duration::from_millis(100));
    let skips = AtomicU32::new(0);
    let mut ran_on = None;
    for tick in 1..=(CHORE_MAX_SKIPS + 1) {
        if acquire_heavy_for_chore("test chore", &skips).is_some() {
            ran_on = Some(tick);
            break;
        }
    }
    stop.store(true, Ordering::SeqCst);
    holder.join().unwrap();
    let t = ran_on.expect("the chore must run within CHORE_MAX_SKIPS + 1 ticks");
    assert!(t <= CHORE_MAX_SKIPS + 1);
    assert_eq!(skips.load(Ordering::SeqCst), 0, "a successful acquire resets the skip counter");
}

/// A holder that re-acquires with ZERO gap cannot starve a chore in its forced wait: ordinary
/// acquirers yield, so the chore gets the slot within about one holder cycle.
#[test]
fn a_forced_chore_wins_against_a_zero_gap_holder() {
    use agentlens_store::transcript_sql::{acquire_heavy_for_chore, acquire_heavy_within, CHORE_MAX_SKIPS};
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    let stop = Arc::new(AtomicBool::new(false));
    let s2 = stop.clone();
    let holder = std::thread::spawn(move || {
        while !s2.load(Ordering::SeqCst) {
            if let Ok(g) = acquire_heavy_within(Duration::from_secs(10)) {
                std::thread::sleep(Duration::from_millis(300));
                drop(g); // immediately loops to re-acquire: no gap
            }
        }
    });
    std::thread::sleep(Duration::from_millis(100));
    let skips = AtomicU32::new(CHORE_MAX_SKIPS); // already at the bound => forced wait
    let t0 = Instant::now();
    let got = acquire_heavy_for_chore("zero-gap test chore", &skips);
    let waited = t0.elapsed();
    stop.store(true, Ordering::SeqCst);
    drop(got);
    holder.join().unwrap();
    assert!(waited < Duration::from_secs(2), "forced chore must get the next free slot, waited {waited:?}");
}
