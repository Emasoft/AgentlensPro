//! The core cap lives in agentlens-store (see `agentlens_store::cores` for why). This module keeps
//! the `crate::cores` and `agentlens_core::cores` paths that every alcore call site uses.

pub use agentlens_store::cores::{duckdb_threads, max_cores};
