//! Port of the burn subsystem (TRDD-DMWOBWFH P4r) — the smoke detector behind freeze rows
//! 12 (/api/burn-risk), 13 (/api/agent-gate) and 24 (/api/burn-status).
//!
//! P4r.1: the pure leaf dependencies every burn consumer types against —
//! `cache_ttl` (src/shared/cacheTtl.ts — THE one place the prompt-cache TTL numbers live) and
//! `keep_warm` (src/shared/keepWarm.ts — the per-session cache-gap measurement with the
//! measured falsifier). Later slices: the monitor (computeBurnStatus), the guard
//! (checkBurnRisk), the gate (agentGate), and their server plumbing.

pub mod cache_ttl;
pub mod keep_warm;
pub mod monitor;
