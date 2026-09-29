//! TRDD-9VX3WTGU Phase 0 — the byte-level live instrument (`rss_guard::mi_live_bytes`).
//!
//! IMPORTANT LIMITATION read before trusting a green run: the global allocator is set in the
//! `alcore` BINARY (`src/bin/alcore.rs`, "belongs in the binary, never in a library crate"),
//! so test binaries here use the SYSTEM allocator, not mimalloc. `mi_live_bytes` walks
//! mimalloc's subprocess heap list — in a non-mimalloc process, `mi_subproc_current()` still
//! resolves (mimalloc's statics exist; the library is linked) but the walk covers only what
//! mimalloc itself allocated internally, near-zero bytes. `None` is therefore a legitimate
//! outcome here and the test is TOLERANT of it; in the real server (alcore) the walk covers
//! every Rust allocation. What is asserted unconditionally is the invariant the composition
//! line depends on: WHEN Some, `live <= committed_current` from the same stats source
//! (allocated blocks cannot exceed what mimalloc has committed).

use agentlens_core::rss_guard::{mi_live_bytes, mimalloc_info};

#[test]
fn live_bytes_is_some_and_le_committed_when_walk_works() {
    let live = mi_live_bytes();
    let committed = mimalloc_info().committed_current_bytes;
    match live {
        Some(l) => {
            assert!(
                l <= committed,
                "live {l} bytes must be <= committed {committed} bytes — allocated blocks cannot exceed committed pages"
            );
        }
        None => {
            // Acceptable ONLY because this test binary does not use mimalloc as its global
            // allocator (the harness limitation in the header). If the alcore binary ever
            // reported None there, that would be a real failure — covered by the composition
            // line printing `? MB`, which the 24h attribution gate watches.
            eprintln!(
                "alcore test: mi_live_bytes returned None (no mimalloc subprocess in this process, expected for test binaries)"
            );
        }
    }
}

#[test]
fn live_bytes_is_repeatable() {
    // Two calls back to back: the walk must not error nondeterministically. Byte values may
    // drift (concurrent frees), but both calls agree on Some-ness — a walk that works works.
    let a = mi_live_bytes().is_some();
    let b = mi_live_bytes().is_some();
    assert_eq!(a, b, "Some-ness must be stable across consecutive calls");
}
