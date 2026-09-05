---
trdd-id: 2C23ROPZ
title: rust-core debug builds are the host's dominant disk writer — bound the dev profile
column: ai_review
created: 2026-09-01T22:05:22+0200
updated: 2026-09-05T09:45:50+0200
current-owner: agentlenspro-15
task-type: infra
external-refs: [https://github.com/Emasoft/AgentlensPro/issues/18]
---

# rust-core `target/` debug builds wrote +30.8 GB in 3 days (issue #18)

## ⏵ AI-REVIEW VERDICT 2026-09-05 — APPROVE. Ready for `human_review`; the USER makes that move.

Acceptance is PROSE, not checkboxes; the reviewing agent extracted the claims and verified each.
Report: `reports/ai-review/20260905_091606+0200-2C23ROPZ.md`.

**OBSERVED BY THE ORCHESTRATOR:** the dev profile really is bound —
`rust-core/Cargo.toml:22-26` carries `[profile.dev] debug = "line-tables-only"` and
`[profile.dev.package."*"] debug = false`, i.e. minimal debuginfo for workspace crates and none at
all for dependencies. That is the artifact the fix consists of, read directly.

**REPORTED BY THE REVIEWING AGENT** (not re-checked here): `ci.yml`, the CHANGELOG entry, the
implementing commit, and the issue closure — plus a live re-run of `cargo test -p agentlens-core
--lib` at 52/52. **The "implementing commit is confirmed" item is the agent's, and unchecked by
me**: two cards over (TRDD-NDKKOABG) a commit's subject named one thing while its diff carried
sixteen more, so that class of claim needs a `git show --stat` before it counts as mine.

**The card's Acceptance has THREE clauses, and they land differently:**

- **(a) a before/after of bytes written, RECORDED HERE** — met. Note the clause asks for the
  measurement to be *recorded*, not *reproduced by a reviewer*; the Measurements section carries
  the method, a four-row table of raw byte counts, like-for-like artifact pairs, and an explicit
  statement of what the metric under- and over-counts. Checking that a recording exists and is
  honest about its own limits is the bar this clause sets, and it clears it.
- **(b) test/clippy gates unchanged** — CONFIRMED (lib tests 52/52 re-run by the agent; clippy
  rc 0 per the card).
- **(c) CI cache keys unaffected** — **THE CARD RECORDS ITS OWN ASSUMPTION AS FALSIFIED** and fixes
  it with `hashFiles('rust-core/Cargo.toml')` on both rust-cache steps. That the card says this,
  I verified by reading it. **The underlying technical fact — that `Swatinem/rust-cache` hashes
  every member manifest but never the virtual root — is the CARD'S check against the pinned
  action's source, not mine**; I never opened the action. An earlier version of this block stated
  it flat, with no provenance marker, in a paragraph whose whole organising principle is provenance
  markers. Note the fix is correct either way: keying on `rust-core/Cargo.toml` is right whether or
  not the original assumption was wrong. **That retraction is still the most useful thing on this
  card for a future reader** — an assumption checked against a pinned source and found half-wrong,
  recorded rather than quietly patched.

**Two DIFFERENT reasons a number here is unreproduced — an earlier version of this block flattened
them into one, and that flattening was the error:**

- **+30.8 GB in 3 days** — genuinely unreproducible: a disk-history observation over a window that
  has closed.
- **The touch-cycle table** (100,740,576 B → 93,755,108 B) — **reproducible in principle** by the
  method the card documents (`touch lib.rs` → `cargo test --lib --no-run` → scan by mtime). NOT
  reproduced, on cost grounds, with the machine under load. That is an engineering call, not an
  impossibility, and calling it "cannot be re-run" quietly promoted a decision into physics.

**What this verdict covers**: the SETTING is verified present by me; the gates are re-run; the
cache-key clause is met via a documented correction. **The SIZE OF THE EFFECT remains the card's
own claim** — checkable, unchecked.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-02

**Adopted:** `[profile.dev] debug = "line-tables-only"` + `[profile.dev.package."*"] debug = false`
in `rust-core/Cargo.toml`; `key: ${{ hashFiles('rust-core/Cargo.toml') }}` on BOTH rust-cache steps
in `ci.yml` (the virtual root manifest is never hashed by the action — read from the pinned
source — so without it CI would restore old-profile artifacts and rebuild deps on EVERY run until
the lockfile/rustc rotated the key); CHANGELOG line under 2.33.2 Changed. `split-debuginfo` left
alone: `unpacked` is already the macOS default for a debug-info profile.

**Measured (this machine, rustc 1.97, load 10–28, decimal units) — see `## Measurements`:**
- **Full rebuild, like-for-like per artifact:** DuckDB C++ out dir **3.10 GB → 0.47 GB**
  (`libduckdb.a` 1.57 GB → 0.25 GB), `libduckdb` rlib 5.7 → 3.3 MB, `agentlens-core` lib-test
  binary 39.4 → 34.0 MB. One full rebuild under the new profile writes **1,464 MB / 7,303 files**
  into this target — the script's scan at 07:13, taken BEFORE the touch cycle. A re-scan at 07:28
  bounded to the same cargo window gives deps 789.6 + build 523.7 + incremental 142.2 = 1,456 MB:
  the 8 MB gap is settle-window files the touch cycle then rewrote IN PLACE (the test binary, its
  `.d`, the fingerprints), which moved them out of the window. Two scans, two populations — the
  headline is the one to quote.
  The OLD full-rebuild total is NOT measurable from this target (it accumulates generations —
  below); the per-artifact pairs are the honest before/after.
- **Touch cycle (`touch lib.rs` → `cargo test --lib --no-run`), the NO-OP-EDIT FLOOR:** 100.7 →
  93.8 MB, 10 files, dominated by the incremental `dep-graph.bin` (42.9 → 41.3 MB) +
  `query-cache.bin` (18.4 → 18.4 MB) and the relinked test binary (39.4 → 34.0 MB). Zero `.o`
  rewritten — this cycle never touches deps, so it is structurally blind to the `package."*"`
  lever (adversarial review). Every figure here is DECIMAL (a first draft mixed MiB from an
  awk `/1048576` listing with MB — caught by review; the raw bytes are in `## Measurements`).
- **What the 92 GB actually is:** generation ACCUMULATION, not per-build volume — 2,997
  `agentlens-core` fingerprint generations and four ~3.1 GB `libduckdb-sys` build dirs. That is
  the shape of issue #18's +30.8 GB/3 days; the profile bounds each generation, a sweep bounds the
  count → [[TRDD-ZSX34J8F]] (a sibling lever, NOT an EHT: this card's post-conditions do not
  depend on it, so it must not gate `complete`).
- **`Closes #18` stays in `636cb99e`:** the issue's question ("add `[profile.dev]` limits?") is
  answered and measured; its headline symptom is the accumulation, named on the issue with the
  follow-up card so the auto-close on push does not bury it.
- Backtrace claim settled on this toolchain: `rustc -C debuginfo=line-tables-only` panic
  backtrace frame reads `at ./lt.rs:1:46`.

**Gate on the new profile — GREEN, read from the exit codes:** `cargo test -p agentlens-core
--lib` rc 0 (34 passed, 0 failed — the DuckDB-linked test binary built with `debug=false` deps
links and runs) and `cargo clippy --workspace --all-targets -- -D warnings` rc 0, 0 warnings,
12m37s at load ~20 (a check build of every target: proves the profile breaks no compilation, not
that every dep links — the lib-test run is what proved that). The full workspace `cargo test` is
left to CI's `rust` job on the push (it does not complete locally under this load — 1B98LCVR).

**NEXT ACTION:** none — in `ai_review`. Ships with 2.33.2; #18 auto-closes on the push.

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
*(Superseded — that assumption was checked against the pinned action's source and is only half
true: the key hashes every MEMBER manifest, Cargo.lock and toolchain files, never the virtual root;
so the profile edit would NOT rotate the key, which is worse — see STATE.)*

## Measurements (2026-09-02, raw)

Method: `touch crates/agentlens-core/src/lib.rs` → `cargo test -p agentlens-core --lib --no-run
--offline`; metric = Σ size of files under `target/debug` with mtime ≥ cycle start (GNU stat), a
LOWER bound on bytes written (a file rewritten twice counts once; linker temps deleted before the
scan are uncounted). `settle` = first cycle, `measure` = second.

| profile | cycle | cargo wall | rewritten | files |
|---|---|---|---|---|
| stock dev | settle | 11 s | 100,740,576 B | 10 |
| stock dev | measure | 8 s | 100,740,550 B | 10 |
| bounded dev | settle (= FULL rebuild, profile changed) | 855 s | 1,463,750,050 B | 7,303 |
| bounded dev | measure | 150 s (load 28) | 93,755,108 B | 10 |

Like-for-like artifacts (old hash vs new hash, `du -sb` / `stat`):

| artifact | stock dev | bounded dev |
|---|---|---|
| `build/libduckdb-sys-<h>/` | 3.10 GB | 0.47 GB |
| `build/libduckdb-sys-<h>/out/libduckdb.a` | 1,565,780,544 B | 248,887,496 B |
| `deps/libduckdb-<h>.rlib` | 5,665,176 B | 3,333,464 B |
| `deps/agentlens_core-<h>` (lib-test binary) | 39,367,920 B | 34,008,304 B |
| touch-cycle `incremental/…/dep-graph.bin` | 42,888,145 B | 41,269,815 B |
| touch-cycle `incremental/…/query-cache.bin` | 18,447,703 B | 18,440,209 B |

Accumulation in `target/debug` (92.4 GB before, 93.8 GB after — nothing is ever pruned):
`.fingerprint` generations per crate: agentlens-core 2,997 · agentlens-store 140 · spanstore 85 ·
logscan 73 · ingest 70 · libduckdb-sys 18; `build/libduckdb-sys-*`: four dirs of ~3.1 GB.
