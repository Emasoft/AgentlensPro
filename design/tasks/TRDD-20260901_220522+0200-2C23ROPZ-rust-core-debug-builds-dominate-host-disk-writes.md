---
trdd-id: 2C23ROPZ
title: rust-core debug builds are the host's dominant disk writer — bound the dev profile
column: todo
created: 2026-09-01T22:05:22+0200
updated: 2026-09-01T22:05:22+0200
current-owner: agentlenspro-15
task-type: infra
external-refs: [https://github.com/Emasoft/AgentlensPro/issues/18]
---

# rust-core `target/` debug builds wrote +30.8 GB in 3 days (issue #18)

GitHub issue #18 (2026-08-25) measured `rust-core/target/` debug artifacts as the host's dominant
disk writer: +30.8 GB in 3 days. `rust-core/Cargo.toml` today carries only a `[profile.release]`
section — the dev profile is stock (full DWARF debuginfo, incremental on, no split-debuginfo), so
every `cargo test`/`cargo clippy --all-targets` on the ~200-file workspace rewrites large debug
objects. This session alone ran cargo build/clippy/test cycles a dozen times.

Candidate bounds (measure before adopting — write amplification, not build time, is the metric;
see the `ssd-write-economics` memory page):
- `[profile.dev] debug = "line-tables-only"` (or `debug = 1`) — keeps backtraces, drops most DWARF.
- `[profile.dev.package."*"] debug = false` — no debuginfo for dependencies (DuckDB is the bulk).
- `split-debuginfo = "unpacked"` on macOS — stops relinking debuginfo into every binary.
- Keep `incremental = true` (it REDUCES rewrites for source-local edits); revisit only if measured.

Acceptance: a before/after of bytes written by one `cargo test -p agentlens-core --lib` cycle
(e.g. `iostat`/`fs_usage` or `du -s target` deltas), recorded here; test/clippy gates unchanged;
CI cache keys unaffected (Swatinem/rust-cache keys on lockfile + rustc, not on profile).
