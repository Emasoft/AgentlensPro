---
trdd-id: Y645B1ER
title: Supply-chain hardening — pnpm/.npmrc install-time safety belts
column: completed
created: 2026-06-24T01:28:48+0200
updated: 2026-08-18T12:45:00+0200
implementation-commits: [86d1b4d]
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

DONE — approved by USER 2026-07-06 and implemented in commit `86d1b4d` (see
"Approval log" + "Execution notes" below; column set to complete 2026-07-07 —
the frontmatter had lagged the execution). Originally surfaced by the
ai-maestro-janitor heartbeat supply-chain detectors.

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

## Approval log

- 2026-07-06T08:39:27+0200 — APPROVED by USER (owner directive "do all the improvements"). Executed directly.

## Execution notes (2026-07-06)

Implemented in commit `86d1b4d`. Verified against pnpm 11.9.0 / Node 26 locally:
`pnpm install --frozen-lockfile` clean (exit 0, esbuild builds, no lockfile
change), `pnpm run check-types` passes, all workflows parse as YAML.

Deviations from the original proposal text, and why:

- **Single source of truth in `pnpm-workspace.yaml`, not triplicated.** The
  proposal listed the same settings in `.npmrc` AND `package.json#pnpm`. To avoid
  drift, all pnpm supply-chain settings live only in `pnpm-workspace.yaml` (the
  modern pnpm 11 home for these, and where `allowBuilds` must live). `.npmrc` is
  left carrying only its existing `enable-pre-post-scripts`.
- **`minimum-release-age` → `minimumReleaseAge: 7200`** (minutes = 5 days).
- **`trust-policy=no-downgrade` → `trustPolicy: no-downgrade` + `trustPolicyExclude`.**
  Enabling it hard-failed `pnpm install` on three ubiquitous, legitimate transitive
  deps flagged as "possible package takeover" (chokidar@4.0.3, semver@5.7.2,
  undici-types@6.21.0). These were reviewed as false positives and excluded at
  their exact locked versions, keeping the gate strict for everything else
  (satisfies acceptance criterion 1: install still succeeds).
- **`block-exotic-subdeps` / `strictDepBuilds`** set explicitly (both already
  default true in pnpm 11 — pinned so a downgrade can't silently relax them).
- **`allowBuilds: {esbuild: true}`** — `esbuild` is the ONLY dependency with a
  build script (enumerated via `strictDepBuilds`); its postinstall links the
  native binary the build pipeline requires.
- **`packageManager: pnpm@11.9.0`** pins the package manager (version-only pin).
- **Reconciled build/CI surface** so the pnpm-11-only policy actually applies
  everywhere: Dockerfile bumped to `pnpm@11.9.0` and now COPYs
  `pnpm-workspace.yaml`; the conflicting `version: 10` input removed from
  `pnpm/action-setup` (packageManager provides the version). Workflows hardened
  per project conventions — least-privilege permissions, job timeouts, and full
  commit-SHA pins for all third-party actions (bumped to latest majors).
- **`/reports/` + `/reports_dev/` gitignored** (were not).

Follow-up for the merge/maintainer: the main checkout still has an UNTRACKED
`pnpm-workspace.yaml` (only `allowBuilds: {esbuild: true}`) — it is superseded by
this now-tracked, fuller version and should be replaced by it on merge.

- 2026-08-18T12:45:00+0200 — ARCHIVED by USER batch directive ("complete all TRDD"); validity re-verified: pnpm-workspace.yaml carries minimumReleaseAge/trustPolicy/blockExoticSubdeps/strictDepBuilds/allowBuilds as described; package.json packageManager pinned to pnpm@11.9.0.
