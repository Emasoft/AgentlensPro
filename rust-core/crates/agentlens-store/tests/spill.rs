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
    assert_eq!(rows[0]["m"], "1.8 GiB"); // TRANSCRIPT_MEMORY_LIMIT = 2GB
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
