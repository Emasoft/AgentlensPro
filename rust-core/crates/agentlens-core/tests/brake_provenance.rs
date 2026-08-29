//! TRDD-Q8ZW00CI: the NO_REVIVE boot WARN must not accuse a starter that honoured the brake.
//!
//! `agentlenspro server start` is the ONE documented command that lifts the brake — it spawns with
//! the override and clears the flag once the server answers. The original WARN was
//! provenance-blind, so that operator was told "the starter above did not honour it. Clear the
//! brake with `agentlenspro server start`" — accusing the wrong party and advising the command that
//! had just run.
//!
//! MUTATION CHECK: make `brake_lift_is_sanctioned` return `false` unconditionally and
//! `the_two_documented_overrides_are_sanctioned` MUST fail; make it return `true` unconditionally
//! and `every_other_starter_still_earns_the_warn` MUST fail. A predicate needs both directions
//! pinned — one alone is satisfied by a constant.

use agentlens_core::brake_lift_is_sanctioned;

#[test]
fn the_two_documented_overrides_are_sanctioned() {
    assert!(brake_lift_is_sanctioned("server start"));
    assert!(brake_lift_is_sanctioned("server restart"));
    // The CLI stamps the value into an env var (serverControl.ts:218), and env round-trips are a
    // classic source of stray whitespace; trimming is part of the contract, not incidental.
    assert!(brake_lift_is_sanctioned("  server start  "));
}

#[test]
fn every_other_starter_still_earns_the_warn() {
    // These are the cases the WARN exists for — a spawner that bypassed the CLI gate entirely.
    for starter in ["supervisor", "hook", "dashboard", "", "unknown", "server", "start", "server stop"] {
        assert!(!brake_lift_is_sanctioned(starter), "{starter:?} must NOT be treated as a sanctioned brake lift");
    }
}
