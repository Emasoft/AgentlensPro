---
trdd-id: HSPUF5XH
title: Bump and publish agentlenspro only after every open card is terminal and every known issue is fixed
column: blocked
created: 2026-09-03T10:48:30+0200
updated: 2026-09-03T11:15:00+0200
current-owner: main-session
task-type: infra
min-approval-requirement: user
release-via: publish
created-by: main-session
npt: []
eht: []
pre-block-column: todo
blocked-by: [EAK9R8IY, DMWOBWFH, 2R36W8Q1, IXMB2JVD, N60JUWU3, UTFVMVT8, CAJ5RCP9, 9SYRK6SW, QE114936, POLG0613, 768NEX6E, 7YPQWKPG, 99HUNXJS, 7NHUU6GK, ZSX34J8F, 2R0AXCKL, TP3BA3ED, 2TQHNMEC, 70D0TUBZ]
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-03

**NEXT ACTION:** wait for `blocked-by` to drain. Re-run
`grep -H '^column:' design/tasks/*.md` and remove any id from `blocked-by`
whose card has reached a terminal column (`complete`, `cancelled`,
`superseded`) or moved out of the gating set (`dev|testing|todo|blocked|plan|dispatch`).
When `blocked-by` is empty, restore `column: pre-block-column` value (`todo`),
then proceed to run the acceptance gates below before touching version/tag.

**Backburner triage 2026-09-03** (report:
`reports/board-sweep/20260903_111058+0200-backburner-triage.md`): WORK NOW → 99HUNXJS, 7NHUU6GK,
ZSX34J8F, 2R0AXCKL, TP3BA3ED, 2TQHNMEC are added to `blocked-by`; Z8WJZV8E archived superseded
(re-filed as TRDD-70D0TUBZ, itself added to `blocked-by`).

**ACCEPTED NON-BLOCKING by main-session:** E32TO0XC (explicit future-scope research, no defect),
IXVHM52P (fix landed, verification has a `review-after:` date and no repro set).

**ZSX34J8F is USER-GATED on the disk action:** 98 GB in `rust-core/target/debug`;
`~/.claude/rules/never_free_space.md` forbids the agent freeing disk space unilaterally — the
main session will propose the retention rule and the exact command and wait for the user before
this card can close.

## User order (verbatim, 2026-09-03)

> "just bump and publish a new version. but do that only after you completed
> all TRDDs and fixed all issues."

## Approval log

- 2026-09-03T10:48:30+0200 — APPROVED by USER (verbatim order above).

## Blocking cards (must reach a terminal column before this gate opens)

| id | column | title (file) |
|---|---|---|
| EAK9R8IY | blocked | ship-alcore-per-platform-npm |
| DMWOBWFH | blocked | rust-core-rewrite-ts-ui-only |
| 2R36W8Q1 | testing | summary-cache-livelocks-under-fleet-ingest |
| IXMB2JVD | testing | publish-verify-races-cdn-and-reports-a-good-release-as-failed |
| N60JUWU3 | testing | graceful-shutdown-starves-behind-a-state-lock-holder |
| UTFVMVT8 | testing | composition-routes-rebuild-the-summary-under-the-state-lock |
| CAJ5RCP9 | todo | durable-cache-event-history-joining-otel-and-statusline |
| 9SYRK6SW | testing | api-call-writer-at-bodies-pass-ingest |
| QE114936 | dev | mcp-tool-handlers-rebuild-the-summary-under-the-state-lock |
| POLG0613 | testing | one-unexplained-early-break-cold-write-after-a-heartbeat-fire |
| 768NEX6E | blocked | bodies-pass-scans-the-parquet-store-every-minute |
| 7YPQWKPG | todo | duckdb-is-the-memory-alcore-keeps-no-resident-data-model |

## User-gated cards (NOT blocking this gate — human_review/proposal/backburner)

These sit outside the pipeline's open-work zone by design (deferred or
awaiting a human verdict, not "in progress"); they do not gate the release
unless the user says otherwise:

- E32TO0XC — account-monitoring-skill-distillation (backburner)
- 99HUNXJS — server-and-cli-parse-port-env-differently (backburner)
- Q8ZW00CI — boot-warn-blames-the-documented-brake-override (human_review)
- IXVHM52P — duckdb-memory-ceiling-oom (backburner)
- Z8WJZV8E — sink-precondition-is-boot-only-and-never-reprobes (backburner)
- 7NHUU6GK — retention-gate-keeps-volumes-holding-a-re-emitted-body-forever (backburner)
- 465EXTJ6 — alcore-is-not-at-parity-with-the-typescript-server-on-14-behaviours (human_review)
- ZSX34J8F — target-debug-generation-accumulation-needs-a-sweep (backburner)
- 2R0AXCKL — real-corpus-tests-time-out-under-host-contention (backburner)
- TP3BA3ED — ts-store-twin-flushes-only-three-dirs (backburner)
- 2TQHNMEC — every-bodies-pass-rebuilds-the-dedup-sets-from-the-whole-corpus (backburner)

## Definition of done — board drain

- [ ] Every id in `blocked-by` above has reached `complete`/`cancelled`/`superseded`
      (re-check `grep -H '^column:' design/tasks/*.md`; none remain in
      `dev|testing|todo|blocked|plan|dispatch`).
- [ ] No NEW card has entered the gating set in the meantime (re-check at the
      moment of publish, not just when this TRDD was authored).

## Definition of done — gates green (run in order, on this machine)

- [ ] `pnpm run compile` — passes (tsc ×2 + lint + esbuild ×4, includes
      `check-mirrors`, `check-identities`, `check-dist-contents`, `check-guards`).
- [ ] `cargo test` — rust-core store crate green.
- [ ] `cargo test` — rust-core core crate green.
- [ ] `cargo clippy -- -D warnings` — zero warnings across the workspace.
- [ ] alcore rebuilt from current source (fresh inode — verify via `ls -li`
      before/after, per `agentlenspro-ops-lessons-deploy-and-install`).
- [ ] Fresh-inode alcore deployed to the live server (`agentlenspro server restart`
      or the alcore-specific swap procedure — verify the running pid's binary
      is the new inode, not the old one).
- [ ] 15-minute hold read PASS (per O3ICDRLO's own acceptance recipe — no
      burn-tick hold ≥ 250ms observed over the window).
- [ ] The `api_call` table is observed filling on the live server (per
      9SYRK6SW's own acceptance recipe).

## Release recipe (run only after every box above is checked)

Per `.claude/project/memory/agentlenspro-publish-pipeline.md` and
`CLAUDE.md` §Releases — OIDC trusted publishing, CI-only:

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry —
   **same commit**.
2. Tag `main` `vX.Y.Z` (annotated), push the tag.
3. `.github/workflows/publish.yml` publishes to npm via the registered
   OIDC trusted publisher (no token, no local publish) with automatic SLSA
   provenance, then creates the GitHub Release.
4. Post-publish verification: registry `_npmUser` contains
   `trustedPublisher`, and `dist.attestations` exist for the published
   version. A human `_npmUser` with no attestations means the token
   fallback fired — investigate before declaring done.
5. Refresh local install (`npm link` / global reinstall as applicable),
   then `agentlenspro setup` to converge hooks/config to the new version.

**NEVER** publish locally (the 1.0.0 bootstrap is the only sanctioned
exception, already done), and **NEVER** add a `registry-url:` / auth token
to `publish.yml` — a present token silently masks OIDC.
