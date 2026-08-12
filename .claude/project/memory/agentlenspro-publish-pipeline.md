---
name: agentlenspro-publish-pipeline
description: "how do I release / publish a new version of agentlenspro / npm publish fails E404 Not Found PUT / CI publish rejected / provenance badge missing / can I publish from local / how was the package bootstrapped on npm / zizmor flags the workflows / where are the SBOM and checksums for a release / my zizmor ignore comment is not working / I pushed the tag but no release workflow ran / a file I committed is missing from the published package / the agent or skill did not reach users after publishing / feature missing after npm install / the tarball does not match the repo / what does the files allowlist actually ship — the release pipeline, its laws, and the bootstrap history"
ocd: 2026-07-11
lmd: 2026-07-31
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
[[cache-ttl-model]], [[agentlenspro-ops-lessons]] (ops doctrine that cites this pipeline),
[[dashboard-tree-render-topology]] (a rebuild here needs a server restart, same discipline
that page's dashboard-bundle rule follows).


^ATOM-V9M7-ODAK [desc:"the files allowlist is the sole tarball selector and omits SILENTLY — .claude/ was absent, so shipped agents reached no consumer", keywords: agent_not_shipped_to_users file_missing_from_npm_tarball published_package_missing_files files_allowlist_omits_silently dot_directory_not_packed version_bump_ships_nothing .claude_not_in_tarball, ocd: 2026-07-31, lmd: 2026-07-31]

The npm `files` allowlist is the ONE selector deciding the tarball, and its failure mode is silent
OMISSION: a path not listed simply does not ship, and nothing errors at pack or publish time. Until
2.20.0 `.claude/` was absent from it, so `.claude/agents/micro-worker.md` and its vendored
`verification-before-completion` skill existed in the repo and on GitHub but reached zero consumers
— and a version bump alone would have burned an immutable version on a tarball substantively
identical to 2.19.0. 2.20.0 adds `.claude/agents/` and `.claude/skills/` only: `.claude/project/memory/`
is excluded (1.6 MB of contributor notes that nothing can read from inside `node_modules`, since
memgrep resolves `<git-root>/.claude/project/memory` — the CONSUMER's repo, not ours), and
`.claude/settings.json` is excluded because its PreToolUse hook references
`scripts/deny-playwright-init-agents.js`, which is not itself in the allowlist. npm's handling of
dot-directories in `files` is not self-evident, so inclusion was verified with
`npm pack --dry-run --json` before tagging and against the published tarball afterwards
(`npm pack agentlenspro@2.20.0` + `tar -tzf` → 18 files, 992 KB, both `.claude` paths present, zero
memory/settings entries). [^6] [^7]

## Notes and lessons learned

[^1]: [id:ATOM-PUBLISH-FILENAME-MISMATCH, status:valid, keywords:"npm_publish_fails_E404_Not_Found_PUT trusted_publisher_registered_filename_mismatch renamed_workflow_to_match", ocd:2026-07-11, lmd:2026-07-11] the user registered the trusted publisher as
  `publish.yml` while the repo's workflow was `release.yml`; every CI publish would have
  died at the exchange. Fixed by renaming the workflow (899292b) — the cheaper side to
  move. Lesson: treat (registered filename ↔ actual filename) as one invariant; check it
  in publish-readiness.
[^2]: [id:ATOM-NPMIGNORE-SHADOWS-GITIGNORE, status:valid, keywords:"npmignore_silently_overrides_gitignore private_reports_in_tarball_dry_run files_allowlist_single_selector", ocd:2026-07-11, lmd:2026-07-11] the fork inherited a stale `.npmignore` that silenced
  `.gitignore`, putting gitignored `reports/` and `design/` into the tarball dry-run.
  Deleted it and moved to the `files` whitelist (ec8be5e). Lesson: two selectors deciding
  one question is the bug class; keep exactly one.
[^3]: [id:ATOM-DOCKER-PUBLISH-SILENT-FAIL, status:valid, keywords:"docker_publish_silently_failed_while_npm_succeeded latest_tag_stuck_two_releases dockerfile_copy_gitignored_build_artifact verify_from_clean_context", ocd:2026-07-11, lmd:2026-07-11] the Docker publish (docker.yml) silently FAILED for
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
[^4]: [id:ATOM-ZIZMOR-IGNORE-OWN-COMMENT, status:valid, keywords:"zizmor_ignore_comment_not_working ignore_must_be_its_own_comment_marker id_token_write_unscoped_false_positive", ocd:2026-07-16, lmd:2026-07-16] two traps from the TRDD-OMMPS5TF hardening pass:
  (a) DO NOT append `zizmor: ignore[rule]` inside an existing comment (e.g. the SHA-pin
  version comment), BECAUSE zizmor only recognizes the ignore when it is its own `#`-marked
  comment on the line — the finding silently persists. DO give the ignore its own
  `# zizmor: ignore[rule]` marker. (b) DO NOT auto-"fix" `publish.yml:27
  id-token-write-unscoped` findings, BECAUSE it is a FALSE POSITIVE here — `id-token:
  write` is already job-scoped (package job: attest-build-provenance; publish job: npm
  OIDC) and Actions permissions cannot be scoped tighter than per-job. DO verify scoping
  against the live file before acting on that detector.
[^5]: [id:ATOM-TAG-PUSH3, status:valid, keywords:"pushed_the_tag_but_no_release_ran git_push_tags_triggered_nothing publish_workflow_never_fired more_than_three_tags_at_once npm_version_did_not_change", ocd:2026-07-23, lmd:2026-07-23]
  DO NOT release with a bare `git push --tags`, BECAUSE GitHub silently drops tag-push events
  when MORE THAN THREE tags arrive in one push — on 2026-07-23 that push carried 24 never-pushed
  legacy `v0.x` tags alongside `v2.11.3`, so ZERO workflow runs were created: no error, no run in
  the list, npm still on 2.11.2, and the release looked done. DO push exactly one tag
  (`git push origin vX.Y.Z`); if it is already pushed, recover with
  `gh workflow run publish.yml --ref vX.Y.Z` (the tag-guarded steps make it safe) and confirm with
  `npm view agentlenspro version` plus `_npmUser` = the OIDC bot and `dist.attestations` present.
[^6]: [id:ATOM-LFVJ-JN99, status:valid, desc:"repo content is not published content — diff the tarball, not the working tree", keywords:"shipped_but_missing committed_but_not_published tarball_does_not_match_repo feature_missing_after_install verify_tarball_not_repo npm_pack_before_tagging", ocd:2026-07-31, lmd:2026-07-31] DO NOT assume content ships because it is committed, pushed, and visible on GitHub, BECAUSE the npm `files` allowlist omits SILENTLY — no warning at pack, none at publish — so the first symptom is a user reporting a missing feature after the version is already immutable. DO diff the TARBALL, not the repo: `npm pack --dry-run --json` before tagging, and `npm pack <pkg>@<ver>` + `tar -tzf` after publishing, asserting both the paths you expect to be present AND the ones you deliberately excluded.
[^7]: [id:ATOM-3Y0P-K3MT, status:valid, desc:"the recurring worm-self-propagation hit on this page is prose (a description: recall surface); sanitizing it would break recall", keywords:"agent-context-integrity_false_positive worm-self-propagation_flagged npm_publish_flagged_in_memory_page injection_pattern_in_CLAUDE.md_context detector_flags_documentation_prose do_not_sanitize_description_field", ocd:2026-08-12, lmd:2026-08-12] DO NOT "sanitize" this page when the agent-context-integrity detector flags it for `worm-self-propagation` (it fires on lines 3 and 30, both times on the string `npm publish`), BECAUSE both hits are prose, not code: line 3 is the page's own `description:` — the memory system's RECALL SURFACE, which is REQUIRED to carry the symptom words a future session will search with ("npm publish fails E404 Not Found PUT"), and line 30 is the sentence "It is INDEPENDENT of the npm publish". Editing either to quiet the detector would make this page unfindable by the exact query it exists to answer, which is a far worse outcome than a recurring false positive. DO verify and move on: read the two cited lines, confirm `git log --format='%an' -- <path>` shows only this repo's own identity, and record nothing further — the detector itself states no fixer is recommended and that a prose detector cannot distinguish describing a pattern from performing one.
