# Delegation plan — alcore memory: one 2 GB DuckDB budget, the boot crash loop, the guard, the hook ceiling

Units: 6
Created: 2026-09-08T22:45:13+0200

Gate: **OPEN — 6 units** (≥3 independent units, ≥5 files, >30 min). Prior ledger (TRDD-7YPQWKPG,
committed at fc88dfb6) archived as a copy at
`reports_dev/delegation-archive/20260908_224513+0200-DELEGATION-7YPQWKPG.md`, not deleted.

Every row is `pending` and `## Evidence` is empty at creation. Units 1–3 were spawned BEFORE this
file existed (the colony gate was invoked mid-flight); their workers' self-reports are claims, and
the rows stay `pending` until the coordinator re-runs each acceptance.

Owner directives driving this ledger (2026-09-08): "ensure the installer of the agentlenspro hooks
uses a 30 seconds timeout"; "verify that the server alcore do not use 10+ Gb or ram but a maximum
of 2Gb, using duckdb as the only memory"; "256mb limit? duckdb memory limit should be 2Gb".

| # | Unit | Files (mine) | Worker | Acceptance | Status |
|---|------|--------------|--------|------------|--------|
| 1 | Installer emits a 30 s ceiling on every hook entry (TRDD-B07NR7ZI) | `src/cli/hookInstall.ts`, `src/test/cliMatchers.test.ts` | lean-worker (hook-timeout-30) | `npx mocha --no-config --ui tdd --require src/test/setup.js out/test/test/cliMatchers.test.js` exits 0 | verified |
| 2 | Root cause of the boot crash loop at card_store.rs:168 (TRDD-5JZQFVO8), with file:line call path and a minimal fix proposal | `reports/card-store-oom/*.md` | sleuth (card-store-oom) | the report names the call path with file:line and the pinned-block mechanism, marked VERIFIED/INFERRED per claim | verified |
| 3 | Rebuilt RSS guard fires on an isolated instance (TRDD-WKLD508O): 1 MB cap exits 1 with a culprit log, 512 MB control stays up | `reports/trdd-wkld508o/*.md`, `rust-core/target/release/alcore` | lean-worker (wkld508o-probe) | `grep -q 'Verdict: guard FIRED' reports/trdd-wkld508o/20260908_224712+0200-isolated-rss-guard-probe.md` | verified |
| 4 | The collector survives its boot sweep on ~/.agentlens — the card-store OOM fix (TRDD-5JZQFVO8), shape decided by unit 2 | `rust-core/crates/agentlens-core/src/log_reader.rs`, `rust-core/crates/agentlens-core/tests/card_store.rs` | lean-worker (5jzqfvo8) | `cargo test --manifest-path rust-core/Cargo.toml -p agentlens-core --test card_store` exits 0 | pending |
| 5 | No test revives a real alcore daemon on the canonical ports (TRDD-YGEV6QDD): both tmp-HOME suites brake the revive and pin isolated ports | `src/test/cliHotPathLatency.test.ts`, `src/test/setupVerb.test.ts` | lean-worker (ygev6qdd) | `npx mocha --no-config --ui tdd --require src/test/setup.js out/test/test/cliHotPathLatency.test.js out/test/test/setupVerb.test.js` exits 0 and the process table afterwards has no `alcore serve --data-dir /var/folders` | pending |
| 6 | One 2 GB DuckDB budget: inventory of the eight instance sites with file:line and the single-budget shape, written into the card (TRDD-DKBGT7MQ) | `design/tasks/TRDD-20260908_100232+0200-DKBGT7MQ-*.md` | Plan agent (dkbgt7mq) | the card's STATE block lists every `memory_limit` site with file:line and one proposed shape, each claim marked VERIFIED/INFERRED | pending |

## Rules of this ledger

- One row per unit. No two rows share a file.
- Acceptance is checkable: a command, a test, a measurable criterion. "Works" is not acceptance.
- Status: `pending` → `done` (worker reported) → `verified` (coordinator checked it themselves).
- One criterion per row. A disjunction is unfalsifiable and breaks the re-run.
- `node ~/.claude/skills/colony/scripts/ledger-check.mjs DELEGATION.md` RUNS each verified row's acceptance command and appends a content-bound receipt. No receipt = never checked.
- No "done" for the task until every row is `verified`.
- Unit 4 depends on unit 2 (the fix shape is the investigator's finding); it is one unit, sequenced, not a disjunction.

## Evidence

**Unit 1 —** coordinator re-ran the acceptance: `pnpm run compile-tests` exit 0, then
`npx mocha --no-config --ui tdd --require src/test/setup.js out/test/test/cliMatchers.test.js`
exit 0, 13 passing (`reports_dev/unit1-cliMatchers-scoped.txt`); `node esbuild.js` exit 0 and the
bundle carries `HOOK_TIMEOUT_SEC` 5× (`reports_dev/unit1-esbuild.txt`). Read the worker's diff of
`src/cli/hookInstall.ts` in full; softened one over-claim in its comment ("would have reverted" →
"which value a rebuild would have kept was never measured"). Worker report:
`reports/hook-timeout-30/20260908_224450+0200-installer-ceiling-30s.md` (predates this ledger by
23 s; the scoped re-run above is the fresh artifact). Live `~/.claude/settings.json`: all 19
agentlens entries carry `timeout: 30` (jq listing in the worker report; re-listed by the
coordinator before the worker ran — already 30).

**Unit 2 —** `reports/card-store-oom/20260908_224702+0200-boot-sweep-oom-root-cause.md` (§1–§5).
Coordinator verified first-hand: `log_reader.rs:732-751` is one `begin()`…35k `put_log_session`…
`commit()`; `card_store.rs:82` `MEMORY_LIMIT = "256MiB"`, `:154-168` the single-row `INSERT … ON
CONFLICT` with `.expect("upsert a session card")`. The pinned-block mechanism (transaction-local
storage vs the PK ART index) is marked INFERRED in the report with a discriminator; unit 4's
isolated boot on the real snapshot is that measurement.

**Unit 3 —** `reports/trdd-wkld508o/20260908_224712+0200-isolated-rss-guard-probe.md`: probe A
(cap 1 MB) exit 1 at 14 ms uptime with the culprit log written; probe B (cap 512 MB) exit 124 with
`/api/server-stats` answering at +8 s; both children confirmed dead. Coordinator ran the acceptance
grep: PASS. Deploy of the rebuilt binary is a separate, owner-gated step (guard + 2 GB cap on the
real collector), not this unit.
