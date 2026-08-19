//! Port of the span summarizer (TRDD-DMWOBWFH P4d) — src/spanSummarizer.ts + src/summarizers/*.
//! The wire shape (shared/summarizerTypes.ts) is FROZEN; parity is proven per module by unit
//! pins and end-to-end by the cross-engine harness.

pub mod helpers;
pub mod buckets;
pub mod retention;
pub mod copilot;
pub mod claude;
pub mod codex;
pub mod loop_detector;
