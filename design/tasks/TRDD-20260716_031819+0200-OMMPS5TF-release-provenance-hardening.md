---
trdd-id: OMMPS5TF
title: Release-path provenance hardening — SBOM + checksums + image SBOM attestation
column: ai_review
created: 2026-07-16T03:18:19+0200
updated: 2026-07-16T03:37:27+0200
current-owner: main
task-type: security
severity: major
scope: project
npt: []
eht: []
---

# Release-path provenance hardening — SBOM + checksums + image SBOM attestation

USER (2026-07-16): "fix all issues" — from the janitor provenance-audit (4 MAJOR findings) and
workflow-security drift.

## Findings triage (verified against the live workflow files before acting)

| finding | verdict | action |
|---|---|---|
| `publish.yml:27 id-token-write-unscoped` (HIGH) | **FALSE POSITIVE** — `id-token: write` is already JOB-scoped (package job needs it for `actions/attest-build-provenance`; publish-npm job for npm OIDC). Workflow-level block is `contents: read` only. Actions permissions cannot be scoped tighter than per-job. | document; no change |
| `prov-release-asset-no-checksum` (MAJOR) | REAL — the Release attaches the tarball with no checksum file | add SHA256SUMS generation + attach |
| `prov-sbom-absent-but-release-built` + `prov-release-without-sbom-anywhere` (MAJOR) | REAL — no SBOM tool anywhere in the repo's workflows | add anchore/sbom-action (SHA-pinned) SPDX SBOM, attach to Release |
| `prov-in-toto-attestation-missing-on-build` (docker.yml) (MAJOR) | PARTIAL — `provenance: true` already set on build-push; missing the SBOM attestation and max-mode provenance | `provenance: mode=max` + `sbom: true` |

## Plan

1. `publish.yml` package job: after `npm pack` — generate `SHA256SUMS.txt` over the tarball;
   generate SPDX SBOM via anchore/sbom-action (pin to full SHA, latest release); attach both to
   the GitHub Release `files:` list; extend the attest step subject to cover the tarball (subject
   unchanged — the tarball IS the subject; SBOM+checksums ride as release assets).
2. `docker.yml` build-push step: `provenance: mode=max`, `sbom: true` (buildx-generated SPDX
   attestation on the image manifest).
3. Constraint: NEVER touch the OIDC publish job's auth surface (no registry-url, no token,
   filename stays `publish.yml` — npm authorizes the FILENAME).
