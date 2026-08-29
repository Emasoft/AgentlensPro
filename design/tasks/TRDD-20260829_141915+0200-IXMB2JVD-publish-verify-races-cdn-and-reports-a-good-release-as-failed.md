---
trdd-id: IXMB2JVD
title: The post-publish verify races the CDN and reports a successful release as a failed workflow run
column: dev
created: 2026-08-29T14:19:15+0200
updated: 2026-08-29T14:19:15+0200
current-owner: main-session
task-type: infra
scope: project
project-id: agentlenspro
relevant-rules: []
implementation-commits: []
---

# The post-publish verify races the CDN

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-08-29

- **The v2.32.0 release SUCCEEDED.** Do not re-run it, do not re-tag it, and do not read the red
  `Release=failure` on run 33250890531 as a broken publish. Verified on the live registry:
  `npm view agentlenspro version` → **2.32.0**;
  `_npmUser` → `GitHub Actions <npm-oidc-no-reply@…>` (so OIDC, NOT a token fallback);
  `dist.attestations` present with SLSA provenance.
- **Fix applied** in `.github/workflows/publish.yml` — the tarball fetch is now retried, not just
  the metadata lookup. Unverified in CI until the next release exercises it.

## What happened

`publish-npm` published correctly and then failed its own verification step
"Verify the REGISTRY tarball (not a local copy)" with:

```
curl: (22) The requested URL returned error: 404
##[error]Process completed with exit code 22.
```

## The mechanism (the part worth remembering)

The step had a retry loop, and it guarded the wrong thing:

```bash
for i in 1 2 3 4 5; do
  npm view "agentlenspro@$VER" dist.tarball > /tmp/url.txt 2>/dev/null && break   # METADATA
  ...
done
curl -fsSL "$(cat /tmp/url.txt)" -o /tmp/published.tgz                            # TARBALL — once
```

**Registry METADATA and the TARBALL propagate on different schedules, and metadata wins.** So the
loop reliably succeeded in seconds while the single un-retried `curl` hit an edge that did not yet
have the file. Measured here: `npm view` reported 2.32.0 with full provenance while BOTH `curl`
and `npm pack agentlenspro@2.32.0` returned 404 for minutes afterwards — from a developer machine,
not just from the runner, so this is CDN propagation and not a runner-network artifact.

## Why this is worth a card rather than a shrug

Under `set -euo pipefail` the race turns a **successful release into a red workflow run**, and that
is the dangerous direction of failure:

- The obvious reaction to a red publish job is to re-run it.
- The re-run then dies with `E403 cannot republish over existing version`.
- That reads as a second, different, more alarming failure — on a release that was fine all along.

`CLAUDE.md` already records "fresh 404s right after publish are CDN propagation, not failure" as
lore. This card makes the workflow itself honour that, so the knowledge does not have to be
remembered by whoever is looking at a red X at the time.

## Fix

Retry the tarball fetch (10 attempts, 20 s apart) and fail with an explicit message only if the
tarball never becomes fetchable while its metadata is live. The metadata loop is kept — it is
still the right guard for its own step.

## Acceptance

- [ ] The next release's `publish-npm` job goes green end-to-end, including the registry-tarball
      verification, with no manual intervention.
- [ ] The published v2.32.0 tarball carries 16 `bin-native` entries, all `-rwxr-xr-x` — the check
      the failing step was supposed to perform, to be run by hand instead. **STILL PENDING: at the
      time of writing the tarball had not propagated, so this has NOT been verified.** Do not mark
      it done from the fact that the publish succeeded — the exec bit is a separate property, and
      losing it is exactly how a package installs cleanly and then fails at spawn.
- [ ] A propagation delay produces retry log lines, never a failed job.
