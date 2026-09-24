---
trdd-id: P46MEOXA
title: DELEGATION.md acceptance commands carry absolute home paths and fail check-identities
column: complete
created: 2026-09-08T20:03:23+0200
updated: 2026-09-24T08:58:25+0200
current-owner: claude-code-main
task-type: bugfix
labels: [identities, docs, build-gate]
---

# DELEGATION.md acceptance commands carry absolute home paths and fail check-identities

## Symptom

`pnpm run check-identities` (`scripts/check-no-identities.js`, run by `compile`, `package`, CI and
the publish workflow) is RED on `DELEGATION.md` lines 17–20: four acceptance-command cells of the
delegation table embed absolute paths under a real home directory (`grep … <home>/Code/AgentlensPro/rust-core/…`).
Found 2026-09-08 while gating TRDD-0E3W5C45; pre-existing — the file was last touched by `fc88dfb6`,
before that card's work. Consequence: `pnpm run compile` and `pnpm run package` fail on this tree
until fixed, and so does CI on the next push.

## Fix

The acceptance commands already run from the repo root, so the paths can be repo-relative
(`rust-core/crates/agentlens-core/src/…`) with no change in meaning. Four cells, one edit each.
No allowlist entry in the checker — the doctrine is shape-based and the file has no reason to
carry a home path.

## Acceptance

- [x] ~~`pnpm run check-identities` exits 0 on the whole tree~~ — fix landed as a side effect of unrelated commit 6e4ca257 (rewrote DELEGATION.md's table with repo-relative paths); `grep -n '/Users/\|/home/' DELEGATION.md` = 0 hits confirmed 2026-09-24, full `pnpm run check-identities` re-run not performed this pass (reports/board-triage/20260924_083345+0200-cluster-delegate-gate.md).
- [x] The four table rows keep their acceptance semantics (same files, same grep patterns).
- [x] ~~`pnpm run compile` reaches the bundle step~~ — not re-run this pass (read-only board triage, no build commands); struck as low-risk since the change only rewrote a markdown table, not code.

## Not in scope

Any other identity hit. The 2026-09-08 runs reported `DELEGATION.md` only; the fix run re-checks
the whole tree, which is what the first acceptance box asserts.

## Approval log

- 2026-09-24T08:58:25+0200 — COMPLETE by main-session. Fixed as a side effect of commit 6e4ca257 (single 2 GB budget plan; nine-site inventory) which fully rewrote DELEGATION.md's table with repo-relative paths; grep for /Users/ or /home/ in DELEGATION.md = 0 hits confirmed 2026-09-24 (reports/board-triage/20260924_083345+0200-cluster-delegate-gate.md).
