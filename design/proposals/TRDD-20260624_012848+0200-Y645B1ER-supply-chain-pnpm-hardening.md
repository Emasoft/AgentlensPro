---
trdd-id: Y645B1ER
title: Supply-chain hardening — pnpm/.npmrc install-time safety belts
column: proposal
created: 2026-06-24T01:28:48+0200
updated: 2026-06-24T01:28:48+0200
current-owner: emanuele
task-type: security
approval-tier: 2
release-via: none
impacts: [dependencies, config-schema]
test-requirements: [lint]
relevant-rules: []
external-refs: []
---

# Supply-chain hardening — pnpm/.npmrc install-time safety belts

Parked for later evaluation (user: "leave it as a TRDD proposal, we will
evaluate it in the future"). Surfaced by the ai-maestro-janitor heartbeat
supply-chain detectors. NOT yet approved or applied.

## Proposed changes

Add install-time supply-chain guards to the project's package-manager config:

- **`.npmrc`**
  - `minimum-release-age=7200` — refuse packages published < 5 days ago
    (blocks the fresh-published-malware window).
  - `trust-policy=no-downgrade` — block silent version downgrades.
  - `block-exotic-subdeps=true` — refuse exotic (non-registry) transitive deps.
- **`package.json` → `pnpm` block**
  - `minimumReleaseAge: 7200`, `trustPolicy: 'no-downgrade'`,
    `blockExoticSubdeps: true`.
- **`strictDepBuilds: true`** (pnpm 10.3+, in `pnpm-workspace.yaml` / `.npmrc` /
  `package.json#pnpm`) — fail install on unreviewed dependency build scripts.

## Why it's a proposal, not an auto-fix

- These change **install behavior**: `strictDepBuilds`/`minimumReleaseAge` can
  fail `pnpm install` on unreviewed build scripts or freshly-published deps, so
  it needs a conscious decision + a pass to allowlist legitimate build scripts.
- `origin` is the upstream `RogerReed/agentlens`; this repo's work is being kept
  local/unpushed, so applying this would be a local commit (or an upstream PR)
  the maintainer should weigh.
- Tier-2 (deviates from the project's current baseline) → evaluate before apply.

## Acceptance criteria (when evaluated)

1. `pnpm install` still succeeds (allowlist any legitimate build scripts the
   strict gate flags).
2. CI green on the changed config.
3. No runtime behavior change for the shipped extension/standalone/docker.

## Evidence

- ai-maestro-janitor heartbeat `[package-manager-policy]` (4 gaps) +
  `[supply-chain-fingerprints]` (`pnpm-strict-dep-builds-unset`), 2026-06-23.
