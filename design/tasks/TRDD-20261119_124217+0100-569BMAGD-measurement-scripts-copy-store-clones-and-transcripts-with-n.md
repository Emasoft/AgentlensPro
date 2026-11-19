---
trdd-id: 569BMAGD
title: Measurement scripts copy store clones and transcripts with no size check
column: dev
status: tasked
created: 2026-11-19T12:42:17+0100
updated: 2026-11-19T13:01:41+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: infra
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T12:42:17+0100
---

# Measurement scripts copy store clones and transcripts with no size check

## Approval log

- 2026-11-19T12:42:17+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Problem

A read-only sweep (reports_dev/test-data-cap/20261119_124500+0100-copy-sweep.md) found 77 copy sites in scripts/ and scripts_dev/: 17 size-checked, 3 inside the cap wrapper only, 17 single small files, 36 with no check, 4 with absent sources. The owner order (2026-11-16, verbatim: "no, the cap is 4GB. i don't care about testing full data size.") is that a measurement uses a sample of at most 4 GB, never a full-size clone; CLAUDE.md records that no measurement script enforced it.

## Decision

Data copies in measurement scripts go through scripts/capped-copy.sh (du -sk counts an APFS clone in full, refuses above 4194304 KB, refuses an existing destination). Converted (verified 12:57 by a diff of each file against its .bak-20261119-cap backup, plus bash -n or ast.parse; all 26 clean): h3d5zbo1/clone.sh:12, the ten 2hra/2hra270y/7yp arm copies of BASE, the nine 735q3jf4 dd-base/pristine copies, cores-harness.sh:200, duckplan-e1b/e1b.py:204,281, digest-final-pass/measure.py:23, stress.py:36, digest-rss/run.py:24, digest-scan-timing/drive.py:22 plus a total budget for its 200 copies. A full-store clone is now refused, which is the intended outcome. Left as is, not test data: o3u-out-noprefilter (old compiled build snapshots of production migration code), scripts/safe-deploy.sh:147 (deploys built binaries), samplefix.sh binary backup, the media asset copies of five soak/ingest scripts, txt-copybuild.cjs (compiled modules), scripts/test-cargo-target-retention.sh:91 (test data the test builds itself; unmeasured, presumed small).

## Progress log

2026-11-19 12:57 — 26 files converted, scripts_dev is gitignored so the backups (*.bak-20261119-cap) are the restore point. Worker report: reports_dev/test-data-cap/20261119_124214+0100-capped-copy-conversion.md. The worker skipped cores-harness.sh (its STEP 2 misread a parent mkdir as the destination); the main agent applied it: the copy names projects/$(basename "$src"), absent after the rm -rf, the same final path cp -R produced. capped-copy.sh runs /bin/cp -cpR on Darwin, so file and directory sources both work; the originals used cp -cR or cp -R, so -p only adds preserved modes and times. Not covered: a NEW ad-hoc copy command typed by an agent is still unchecked; only these scripts and the tests are.
2026-11-19 (between 12:59 and 13:09; the clock was not read) — Cross-volume check: /bin/cp -c and /bin/cp -cpR from the boot disk to the external volume both exit 0 with identical contents (a file and a small directory), so the clone flag falls back to a copy across volumes. Cards notified: 2HRA270Y, 735Q3JF4, H3D5ZBO1, 7YPQWKPG. No owning card was notified for cores-harness.sh or the digest-* scripts (none found). Whether a .bak-20261119-cap file existed before the worker ran cannot be shown (cp -p keeps the source dates); the suffix was new this session.
