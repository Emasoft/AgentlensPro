---
trdd-id: I5O38KKP
title: CI never runs check-pricing-export, so alcore can ship a rates table behind pricing.ts
column: proposal
created: 2026-09-02T05:20:27+0200
updated: 2026-09-02T05:20:27+0200
current-owner: unassigned
task-type: infra
scope: project
project-id: agentlenspro
min-approval-requirement: user
priority: high
blocked-by: []
implementation-commits: []
external-refs: []
---

# CI never runs check-pricing-export, so alcore can ship a rates table behind pricing.ts

## The gap (VERIFIED 2026-09-02)

`rust-core/crates/agentlens-core/pricing.rs` embeds `pricing.json` with `include_str!`; the json is
exported from `src/shared/pricing.ts` by `scripts/export-pricing.js`, and `pnpm run
check-pricing-export` fails when the two disagree. That check is wired into `compile` and
`package` — but `.github/workflows/ci.yml` runs neither: its node job runs `check-no-mirrors`,
`check-memory-lessons`, `check-no-identities`, `check-dist-contents` and `node esbuild.js`
individually (lines 74–100), and `publish.yml` builds the binaries from whatever `pricing.json`
is committed.

Measured today: `pnpm run check-pricing-export` → exit 1 at HEAD (`pricing.json` last regenerated
`04378a30`, 2026-08-26; `pricing.ts` changed 2026-09-01 in `525bbcf8` + `46576993`). Nothing in
the 2.33.2 gate touched it (the gate ran `check-types`, `check-mirrors`, `check-dist-contents`,
the unit suite, the browser smoke, clippy — not `compile`). So the alcore binaries built for
2.33.2 price the models added on 2026-09-01 by longest-prefix match — the trap TRDD-SIGBCMGL
closed on the TS side — and CI on the pushed tree would stay green.

## Proposal (a `.github/workflows/` edit — USER approval, tier 3 in this mono-agent project)

- [ ] Add `run: node scripts/export-pricing.js --check` to the node job of `ci.yml`, next to the
      other `scripts/check-*.js` steps, and to `publish.yml` before `build-binaries` starts.
- [ ] Regenerating the json itself is NOT this card: TRDD-MF4YQWWA runs `node
      scripts/export-pricing.js` while settling the sonnet-5 scheduled-price question, and the
      binaries are rebuilt for the release as usual.

## Approval log

- 2026-09-02T05:20:27+0200 — Filed from the review-fork finding on the MF4YQWWA pull; awaiting
  USER decision (workflow file).
