---
name: agentlenspro-publish-pipeline
description: "how do I release / publish a new version of agentlenspro / npm publish fails E404 Not Found PUT / CI publish rejected / provenance badge missing / can I publish from local / how was the package bootstrapped on npm / zizmor flags the workflows / where are the SBOM and checksums for a release / my zizmor ignore comment is not working — the release pipeline, its laws, and the bootstrap history"
ocd: 2026-07-11
lmd: 2026-07-16
metadata:
  node_type: memory
  type: project
  tier: hub
  globs: [".github/workflows/publish.yml", "package.json"]
---

Releasing agentlenspro = **push a `vX.Y.Z` tag**. `.github/workflows/publish.yml` builds,
tests, publishes to npm via the OIDC **trusted publisher** (tokenless; provenance/SLSA
attestation automatic), and creates the GitHub Release. Verified live: v1.0.1 (run
29136419531) and v2.1.0. Laws:

- **npm authorizes the workflow FILENAME.** The npmjs trusted-publisher entry for
  `agentlenspro` is registered as `publish.yml` (GitHub Actions / Emasoft / AgentlensPro /
  environment EMPTY). Renaming the file or the entry alone breaks the token exchange with
  `E404 Not Found - PUT`.[^1]
- **No tokens anywhere in the publish job** — no `registry-url:` on setup-node, no
  `NODE_AUTH_TOKEN`; a present token makes npm silently take the legacy path. Node 24
  (bundles npm ≥ 11.5.1, the OIDC floor).
- **Retry without re-tagging**: `gh workflow run publish.yml` (Release/attestation steps
  are tag-guarded).
- **The SAME `vX.Y.Z` tag ALSO ships the Docker image** — `.github/workflows/docker.yml`
  fires on `v*` too and pushes `ghcr.io/emasoft/agentlenspro:{X.Y.Z, X.Y, X, latest}`
  (multi-stage Dockerfile: pnpm install → `node esbuild.js --production` → runtime stage).
  It is INDEPENDENT of the npm publish — one can fail while the other succeeds, so verify
  BOTH runs after a tag push (`gh run list` for tag `vX.Y.Z`), not just Release.[^3]
- **Verify a release**: registry `_npmUser` contains `trustedPublisher` + 2 attestations at
  `/-/npm/v1/attestations/agentlenspro@<ver>`; fresh 404s minutes after publish are CDN
  propagation, not failure. `npx -y agentlenspro@<ver> --version` from a fresh `HOME` is
  the strongest smoke test.
- **Tarball**: `package.json` `files` is the single allowlist; `.npmignore` is FORBIDDEN
  (it silently replaces `.gitignore` — the 1.0.0 dry-run once carried 11 private reports
  because of an inherited one).[^2] Build outputs must exist before `npm pack` (phantom
  `files` entries are silently skipped) — `prepublishOnly` runs `pnpm run package`.
- Trusted-publisher admin via CLI: `npm trust list|github|revoke` (npm ≥ 11.15, one
  interactive 2FA tap by design). Deep procedures: user-scope skills `npm-oidc-publishing`
  + `npm-pre/post-publish-checklist`.
- **Provenance artifacts on every Release** (TRDD-OMMPS5TF, 3cc7574): the package job
  generates `SHA256SUMS.txt` over the tarball + an SPDX SBOM (anchore/sbom-action,
  SHA-pinned) and attaches both as Release assets beside the tarball; `docker.yml` builds
  with `provenance: mode=max` + `sbom: true` (buildx attestations on the image manifest).
  The attest step's SUBJECT stays the tarball alone — SBOM/checksums ride as assets, they
  are not attestation subjects.
- **Workflow hardening laws** (zizmor 0 findings since 3cc7574): ALL actions SHA-pinned
  (first-party included — release paths sign attestations); `persist-credentials: false`
  on every checkout; NO dependency cache (`cache: pnpm`) in release-path jobs
  (cache-poisoning surface — ci.yml keeps its cache, CI ≠ release). A zizmor inline
  ignore only registers as its OWN comment marker `# zizmor: ignore[rule]` — appending
  the ignore text inside an existing pin comment does nothing.[^4]

History: 1.0.0 was the sanctioned LOCAL bootstrap publish (2026-07-11, browser/passkey
auth from a detached worktree of main — the registry cannot attach a trusted publisher to
a package that does not exist, npm/cli#8544); the trusted publisher was configured right
after, and every release since is CI-only. See also [[agentlenspro-identity]],
[[cache-ttl-model]].

## Notes and lessons learned

[^1]: [ocd:2026-07-11 lmd:2026-07-11] the user registered the trusted publisher as
  `publish.yml` while the repo's workflow was `release.yml`; every CI publish would have
  died at the exchange. Fixed by renaming the workflow (899292b) — the cheaper side to
  move. Lesson: treat (registered filename ↔ actual filename) as one invariant; check it
  in publish-readiness.
[^2]: [ocd:2026-07-11 lmd:2026-07-11] the fork inherited a stale `.npmignore` that silenced
  `.gitignore`, putting gitignored `reports/` and `design/` into the tarball dry-run.
  Deleted it and moved to the `files` whitelist (ec8be5e). Lesson: two selectors deciding
  one question is the bug class; keep exactly one.
[^3]: [ocd:2026-07-11 lmd:2026-07-11] the Docker publish (docker.yml) silently FAILED for
  v2.3.1 AND v2.4.0 while npm published fine — nobody noticed until v2.4.0, so `:latest`
  sat stuck at 2.3.0 for two releases. Cause: the Dockerfile `COPY media/dashboard.css`
  from the build context, but 2.3.1 made dashboard.css a gitignored esbuild build artifact
  (absent from a clean checkout), so `docker build` died `"/media/dashboard.css": not
  found`. A LOCAL build masked it — the dirty working tree still had the artifact, and
  `.dockerignore` excluded dashboard.js but not dashboard.css. Fixed in 2.4.1: drop the
  stale COPY (esbuild builds it in the builder stage; the runtime stage copies it from
  there) AND add dashboard.css to `.dockerignore` beside its dashboard.js sibling. Lessons:
  (a) when a tracked file becomes a gitignored build artifact, fix BOTH the Dockerfile COPY
  and `.dockerignore` in the same change; (b) verify a Docker release from a CLEAN context
  (git-archive / .dockerignore-excluded), never the dirty working tree — npm's
  build-before-pack hid the same class on the npm side; (c) a `vX.Y.Z` tag fans out to
  TWO publish workflows — check both conclusions.
[^4]: [ocd:2026-07-16 lmd:2026-07-16] two traps from the TRDD-OMMPS5TF hardening pass:
  (a) DO NOT append `zizmor: ignore[rule]` inside an existing comment (e.g. the SHA-pin
  version comment), BECAUSE zizmor only recognizes the ignore when it is its own `#`-marked
  comment on the line — the finding silently persists. DO give the ignore its own
  `# zizmor: ignore[rule]` marker. (b) DO NOT auto-"fix" `publish.yml:27
  id-token-write-unscoped` findings, BECAUSE it is a FALSE POSITIVE here — `id-token:
  write` is already job-scoped (package job: attest-build-provenance; publish job: npm
  OIDC) and Actions permissions cannot be scoped tighter than per-job. DO verify scoping
  against the live file before acting on that detector.
