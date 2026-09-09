# Delegation plan — alcore memory: one 2 GB DuckDB budget, the boot crash loop, the guard, the hook ceiling

Units: 9
Created: 2026-09-08T22:45:13+0200

Gate: **OPEN — 9 units** (≥3 independent units, ≥5 files, >30 min; rows 7–9 added 2026-09-09). Prior ledger (TRDD-7YPQWKPG,
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
| 6 | One 2 GB DuckDB budget: inventory of the eight instance sites with file:line and the single-budget shape, written into the card (TRDD-DKBGT7MQ) | `design/tasks/TRDD-20260908_100232+0200-DKBGT7MQ-*.md` | Plan agent (dkbgt7mq) | the card's STATE block lists every `memory_limit` site with file:line and one proposed shape, each claim marked VERIFIED/INFERRED | done |
| 7 | Unit-4 evidence: mutation check (single-transaction test must fail), release rebuild, isolated boot on a copy of the real corpus (TRDD-5JZQFVO8) | `reports/trdd-5jzqfvo8/*.md`, `rust-core/target/release/alcore` | lean-worker (5jzqfvo8-evidence) | `grep -q 'panicked' reports_dev/5jzqfvo8/03_mutation.txt` and the report records a boot with no `log-sweeper died` and a card count | verified |
| 8 | Unit-5 finalization per review: brake scoped to this file's suites (not the mocha root), dead `return`s after `this.skip()` removed, one shared `assertNoSurvivingServer` helper (TRDD-YGEV6QDD) | `src/test/cliHotPathLatency.test.ts`, `src/test/setupVerb.test.ts`, `src/test/helpers/noSurvivingServer.ts` | lean-worker (ygev6qdd-final) | `npx mocha --no-config --ui tdd --require src/test/setup.js out/test/test/cliHotPathLatency.test.js out/test/test/setupVerb.test.js` exits 0 on an idle machine (load < 8) | pending |
| 9 | Cards current: TRDD-YGEV6QDD and TRDD-5JZQFVO8 STATE blocks carry the verified facts and review findings; new card for merging the two diverted capture dirs back into the real data dir | `design/tasks/TRDD-20260908_224151+0200-YGEV6QDD-*.md`, `design/tasks/TRDD-20260908_224153+0200-5JZQFVO8-*.md`, one new `design/tasks/TRDD-*-diverted-capture-*.md` | lean-worker (cards-0909) | each of the three files has a STATE block whose first line carries a `date`-sourced 2026-09-09 timestamp and names its NEXT ACTION | verified |

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
reports/hook-timeout-30/20260908_224450+0200-installer-ceiling-30s.md (predates this ledger by
23 s, so it is not cited as evidence; the scoped re-run above is the fresh artifact). The live
settings.json in the home dir: all 19 agentlens entries carry `timeout: 30` (jq listing in the
worker report; re-listed by the coordinator before the worker ran — already 30).

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

**Unit 6 — `done`, not `verified`:** the Plan agent returned its report inline (read-only mode),
persisted verbatim at `reports/dkbgt7mq/20260908_231114+0200-single-2gb-budget-plan.md`; the
card's STATE now carries the 9-site inventory with file:line and the chosen shape. The coordinator
has first-hand verified only site A (`card_store.rs:82,112-116,142-168`) and the restore path
(`log_reader.rs:732-751`); the other rows and the DuckDB-internals claims are the agent's until
re-read, so the row stays `done`.

**Unit 7 —** coordinator read both worker reports in full.
`reports/trdd-5jzqfvo8/20260909_114357+0200-mutation-build-real-corpus-boot.md`: the
single-transaction mutant panicked at `card_store.rs:168` ("Out of Memory Error … 255.9 MiB/256.0
MiB used", exit 101, 188 s), the test file was restored to its exact diff shape, and
`rust-core/target/release/alcore` was rebuilt at Sep 9 11:39:51; its boot #1 SKIPPED the restore
(no `log-delta-version.json` copied → `cold-rescanning`, 0 cards), which is why a second boot was
dispatched. `reports/trdd-5jzqfvo8/20260909_120028+0200-real-corpus-boot-restore-exercised.md`:
boot #2 with the version stamp copied — `restored 35258 session cards`, no panic, no
`cold-rescanning`, alive at +126 s, footprint 608 MB (peak 894 MB), restore lock 14,738 ms.
Coordinator grepped `reports_dev/5jzqfvo8/09_boot.txt` first-hand: the only line matching
`restored|cold-rescanning|panicked|log-sweeper died` is the restore line
(`reports_dev/verify-1205.txt`). NOT established by this run: the resident footprint against the
real 4.38M-span store and the live transcript scan (no spans dir copied), and
`demote_cold_timelines` on the real corpus — the deploy reads `server.log` for `RSS HARD CAP` vs
`Out of Memory` before judging a post-deploy exit.

**Unit 9 —** coordinator grepped the three cards (`reports_dev/ledger-check-1140.txt`): each STATE
header reads `2026-09-09 11:36`, matching the frontmatter `updated: 2026-09-09T11:36:35+0200`, and
each carries one `NEXT ACTION` line —
`design/tasks/TRDD-20260908_224151+0200-YGEV6QDD-hot-path-test-leaks-alcore-daemon.md`,
`design/tasks/TRDD-20260908_224153+0200-5JZQFVO8-card-store-oom-crash-loop.md`,
`design/tasks/TRDD-20260909_113635+0200-81BW1CS9-diverted-capture-in-two-leaked-tmp-data-dirs.md`;
committed at dbebe144.
<!-- colony-check: 2026-09-09T10:05:02.122Z sha256:bc1578b6f0004a0d -->
<!-- colony-check: this is a CONTENT BINDING, not a verdict. It records which bytes were checked, never whether they passed. Re-run ledger-check.mjs on this file for a verdict. -->
