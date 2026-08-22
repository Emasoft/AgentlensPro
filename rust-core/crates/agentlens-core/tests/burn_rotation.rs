//! The burn tick's account-ROTATION edge (TRDD-DMWOBWFH C3 / A7-residual, porting
//! server.ts:1656). Rate limits are per account and the usage endpoint only ever answers for the
//! credential currently installed, so the only chance to capture account B's windows is while B is
//! the live one. The edge detector is what finds that moment.
//!
//! `run_burn_tick` itself is a `loop`+`await` in the binary's runtime and cannot be driven from an
//! integration test, so what is gated here is the ONE decision inside it that a future edit could
//! quietly reverse: the seed. Everything else on that path (`!=`, then a network fetch) is either
//! trivial or unmockable — and this project does not mock a service to claim it tested it.

use agentlens_core::CoreState;

fn tmp(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("al-burnrot-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// A fresh runtime has seen NO account, so the very first tick registers as a rotation edge and
/// captures the live account's windows once. Seeding this with the current account at construction
/// would look tidier and would silently cost every server start its one free capture — the account
/// live at boot would then stay `unreadable` until it happened to rotate.
#[test]
fn a_fresh_runtime_has_seen_no_account_so_the_first_tick_is_an_edge() {
    let st = CoreState::open(&tmp("boot"));
    assert_eq!(
        st.burn.last_seen_account_uuid, None,
        "the first tick must count as a rotation edge — do NOT seed this from the current account"
    );
}
