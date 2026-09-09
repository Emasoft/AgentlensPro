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
| 4 | The collector survives its boot sweep on ~/.agentlens — the card-store OOM fix (TRDD-5JZQFVO8), shape decided by unit 2 | `rust-core/crates/agentlens-core/src/log_reader.rs`, `rust-core/crates/agentlens-core/tests/card_store.rs` | lean-worker (5jzqfvo8) | `cargo test --manifest-path rust-core/Cargo.toml -p agentlens-core --test card_store` exits 0 | verified |
| 5 | No test revives a real alcore daemon on the canonical ports (TRDD-YGEV6QDD): both tmp-HOME suites brake the revive and pin isolated ports | `src/test/cliHotPathLatency.test.ts`, `src/test/setupVerb.test.ts` | lean-worker (ygev6qdd) | `npx mocha --no-config --ui tdd --require src/test/setup.js out/test/test/cliHotPathLatency.test.js out/test/test/setupVerb.test.js` exits 0 and no `alcore serve --data-dir /var/folders` process younger than the run exists afterwards (the literal "none at all" was unsatisfiable when authored: pid 68584 had squatted since 22:43) | verified |
| 6 | One 2 GB DuckDB budget: inventory of the eight instance sites with file:line and the single-budget shape, written into the card (TRDD-DKBGT7MQ) | `design/tasks/TRDD-20260908_100232+0200-DKBGT7MQ-*.md` | Plan agent (dkbgt7mq) | the card's STATE block lists every `memory_limit` site with file:line and one proposed shape, each claim marked VERIFIED/INFERRED | verified |
| 7 | Unit-4 evidence: mutation check (single-transaction test must fail), release rebuild, isolated boot on a copy of the real corpus (TRDD-5JZQFVO8) | `reports/trdd-5jzqfvo8/*.md`, `rust-core/target/release/alcore` | lean-worker (5jzqfvo8-evidence) | `grep -q 'panicked' reports_dev/5jzqfvo8/03_mutation.txt` and the report records a boot with no `log-sweeper died` and a card count | verified |
| 8 | Unit-5 finalization per review: brake scoped to this file's suites (not the mocha root), dead `return`s after `this.skip()` removed, one shared `assertNoSurvivingServer` helper (TRDD-YGEV6QDD) | `src/test/cliHotPathLatency.test.ts`, `src/test/setupVerb.test.ts`, `src/test/helpers/noSurvivingServer.ts` | lean-worker (ygev6qdd-final) | `npx mocha --no-config --ui tdd --require src/test/setup.js out/test/test/cliHotPathLatency.test.js out/test/test/setupVerb.test.js` exits 0 (the run's load is recorded in Evidence, not gated here — the checker re-runs at whatever load it finds) | verified |
| 9 | Cards current: TRDD-YGEV6QDD and TRDD-5JZQFVO8 STATE blocks carry the verified facts and review findings; new card for merging the two diverted capture dirs back into the real data dir | `design/tasks/TRDD-20260908_224151+0200-YGEV6QDD-*.md`, `design/tasks/TRDD-20260908_224153+0200-5JZQFVO8-*.md`, one new `design/tasks/TRDD-*-diverted-capture-*.md` | lean-worker (cards-0909) | each of the three files has a STATE block whose first line carries a 2026-09-09 timestamp and names its NEXT ACTION | verified |

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

**Unit 4 —** coordinator ran the acceptance concurrently with the commit of `86acd104` (same
content modulo one doc-comment line); the checker's own re-run in
`reports_dev/ledger-check-1215.txt` is the post-commit run:
`cargo test --manifest-path rust-core/Cargo.toml -p agentlens-core --test card_store` →
`test result: ok. 11 passed; 0 failed`, 188.79 s, exit 0
(`reports_dev/5jzqfvo8/10_cargo_test_card_store.txt`). The unit title's "survives its boot sweep
on ~/.agentlens" is established on a COPY of the corpus (unit 7, boot #2), not yet on the real data
dir — that is the owner-gated deploy.

**Units 5 and 8 —** one run covers both (same files, same command), armed as a background wait:
`reports_dev/unit8-idle-mocha.txt` — the gate opened at load 6.71 (one sample, 12:07:26; not
re-sampled at mocha end), `pnpm run compile-tests` exit 0, then the mocha command → 23 passing in
11 s, exit 0; all five `setupVerb` suites ran (the probe suite is dry-run-only, verified at
`src/cli/setup.ts:567`, `:967`, so it needs no brake). Process table afterwards
(`reports_dev/unit8-ps-after.txt`, three lines match the needle): the job's own shell (pid 13517,
21 s — the snapshot-writer's argv carries the literal), pid 68584 (13 h 24 m, `al-setup-OYnBpx`,
the TRDD-81BW1CS9 squatter), and pid 2218 (3 d 8 h, a worktree agent's DEBUG `alcore` on an
`al-shutdown-2141` fixture — a third, older leak, recorded on the YGEV6QDD card). No `alcore
serve` line is younger than the run. Load remains only the INFERRED cause of the 23:00
ETIMEDOUTs (two variables changed since: load, and the per-suite brake). The checker's re-run
inherits whatever load it finds (a red receipt at load 20+ is that shape, not a regression) and
runs against `out/` without recompiling.

**Unit 6 —** the Plan agent's inventory (persisted verbatim at
`reports/dkbgt7mq/20260908_231114+0200-single-2gb-budget-plan.md`) was re-verified site by site by
a read-only worker that quoted the ACTUAL cited lines
(`reports/dkbgt7mq/20260909_122118+0200-inventory-verification.md`); the coordinator read the quoted
lines, not the verdict column. 9/9 cited lines carry the claimed limit: A `card_store.rs:82,131`
256MiB file-backed; B `statusline_store.rs:230-238` env-else-2GB; C/D `transcript_sql.rs:402,574`
2GB; E `bodies_evidence.rs:70-86` env-else-2GB; F `lib.rs:42,138` `DEFAULT_MEMORY_LIMIT = "8GB"`;
F1 `chores.rs:288` 2GB; F2 `body_archive.rs:135` 8GB; G `session_summary_sql.rs:127` 1GB (dead).
An independent sweep (`grep -rn -E "memory_limit|MEMORY_LIMIT|max_memory"` over `rust-core/crates`
with a QUOTED `--include='*.rs'`) finds no production site the inventory misses and no phantom row;
the only uncovered hits are under `tests/` or `memory_limit_scope.rs`. Every row carries a marker.
One off-by-one in the STATE prose: `alstore.rs:105` is the `threads` line, the call is `:106`.
The chosen shape's DuckDB-internals claims (`try_clone()` through one `connect()`, TEMP-table
isolation) remain the agent's — this row verifies the inventory-and-marker acceptance, not the
design.

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
header reads `2026-09-09 11:36` (the frontmatter `updated: 2026-09-09T11:36:35+0200` was read for
YGEV6QDD and 5JZQFVO8 only, not for the new card), and each carries one `NEXT ACTION` line —
`design/tasks/TRDD-20260908_224151+0200-YGEV6QDD-hot-path-test-leaks-alcore-daemon.md`,
`design/tasks/TRDD-20260908_224153+0200-5JZQFVO8-card-store-oom-crash-loop.md`,
`design/tasks/TRDD-20260909_113635+0200-81BW1CS9-diverted-capture-in-two-leaked-tmp-data-dirs.md`;
committed at dbebe144. The `date`-sourced clause was dropped from the cell: it is not verifiable
from the artifact.
<!-- colony-check: 2026-09-09T10:26:09.188Z sha256:221de7cf0f9b40aa -->
<!-- colony-check: this is a CONTENT BINDING, not a verdict. It records which bytes were checked, never whether they passed. Re-run ledger-check.mjs on this file for a verdict. -->
