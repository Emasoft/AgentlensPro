---
trdd-id: K7PQ2M4V
title: Full revision of the CLI sources for production readiness
column: dev
created: 2026-07-23T16:16:51+0200
updated: 2026-07-23T17:59:27+0200
implementation-commits: [baf2ad3]
current-owner: session-7877ae1f
task-type: refactor
approval-tier: 0
severity: medium
impacts: [cli]
release-via: publish
test-requirements: [unit]
---

# Full revision of the CLI sources for production readiness

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-23

**State:** first finding found, fixed and shipped (`baf2ad3`) BEFORE the delegated review returned —
it came from the defect class the reviewer structurally cannot see. The externalizer batches 1-5
files per request, so cross-file duplication across 20 files is its blind spot; that is where the
first real bug was. Delegate the per-file read, keep the whole-repo view yourself.

**Landed so far:**

- **The data directory was resolved in ten places, nine of them hardcoded.** `$DATA_DIR` is a
  documented contract and the test suite's isolation mechanism, so a relocated store left every
  reader on the default — empty, "nothing found". TRDD-8N3KQW2R's blind-spot one level up. One
  resolver now: `src/dataDir.ts`, evaluated per call.
- **Namespaced the variable** on the user's warning that `DATA_DIR` is collision-prone (Docker, CI,
  data tooling all set it). `AGENTLENS_DATA_DIR` wins; the bare name is still honoured because
  dropping a shipped contract would relocate real stores. `server status` prints which won.
- **Fixed a test env leak this surfaced:** `killSwitch.test.ts` set `DATA_DIR` at module scope and
  never restored it, so four "REAL captured bodies" suites had been silently skipping.

**Per-file review triage (each finding verified against source; false positives dropped):**

- `serverControl.ts` — `6eed437` (5 failures-that-read-as-success, a NaN defeating a fallback, 3 dedups).
- `hookInstall.ts` — `c1120eb` (one factory per hook shape); TOCTOU split to TRDD-T0CT9U4X.
- `setup.ts` — `eed1c64` (stale-capture-key presence test = the 35 GB/day burn detector; storeSpanCount
  ENOENT-only; parseNodeFloor → null instead of a hardcoded floor).
- `diagnosticsCli.ts` + `configCli.ts` — `79add08`. diagnostics: reject a non-JSON `call` arg,
  guard `batch`/`--since`/`--until` missing values, and fix the burn-guard "server back" log ordering
  (endpoint is stateless — verified rpc sends no session header — so re-init only while __down).
  config: sink-before-source ON order, settings-key-first OFF order, and usage errors now return the
  shared `EXIT.USAGE` (64). Dropped 2 false positives (ON "ignores EnsureResult" — it only exists on
  success; OFF `finally` cleanup — would tear the sink down under a live source).

**Follow-ups surfaced (tracked, not yet done):**

- `diagnosticsCli.ts` has NO test file — `runDiagnosticsCli` / `parseToolFlags` / `call` / `batch` /
  `runGuard` are entirely untested. A proper suite is a distinct task (delegate to js-test-writer with
  an explicit test count), not an inline addition to this triage.
- `spoolCli.ts` returns bare `1` for an unknown subcommand (ramdiskSpool.test.ts:198 pins it) — same
  usage-error-should-be-`EXIT.USAGE` inconsistency just fixed in configCli; fix when triaging spoolCli.

**Origin:** the user's verdict on the CLI written earlier in the session — *"the code is still far
from production ready. do a full revision of the cli sources, improve what you can."* Deferred once
by the user, resumed 2026-07-23 16:16.

**NEXT ACTION** — read the review reports, then fix in phases:

```bash
ls -t reports/cli-revision/ | head
```

**Method, and why.** The review is delegated to the LLM Externalizer (`high_quality_scan`, one
report per file, `reports/cli-revision/`). Two reasons, both load-bearing:

1. It runs on OpenRouter, so it costs **nothing against the Anthropic 5h/7d window** — which sat at
   77% used / 27% elapsed when this started. A self-review inside this (very large) session would
   re-bill the whole prefix on every turn.
2. Its findings are a HYPOTHESIS list, never a work order. Every finding is verified against the
   source before any edit — LLM reviewers produce confident false positives, and the project's
   claim-verification rule applies unchanged.

**Scope:** `src/cli/*.ts`, 20 files / 4,574 lines. The five the user named are the priority:
`setup.ts` (944 L), `diagnosticsCli.ts` (571 L), `serverControl.ts` (448 L), `hookInstall.ts`
(305 L), `configCli.ts` (205 L). `watchCli.ts` / `budgetCli.ts` / `lineLog.ts` / `attribution.ts`
were already revised this session and are in scope only for a second pass.

**Regression baseline captured BEFORE any change** — these must not get worse:

| gate | baseline |
|---|---|
| `pnpm run check-types` (×2) | 0 errors |
| `pnpm run lint` | 0 errors, **267 warnings** (pre-existing `no-console` in tests) |
| `pnpm run check-mirrors` | OK — 117 shared exports |
| mocha | **1552 passing**, 11 pending |

**Judging criteria given to the reviewer** (the project laws it must find violations of): fail-fast
with no silent fallbacks; user-config mutation ONLY via `safeConfigEdit`; no back-compat or dead
code; one source of truth; exit codes 0/1/2/64 as an interface; a signal listener must re-raise so
Ctrl-C still terminates.

**Already fixed this session, do NOT re-litigate:** the `runRisk` failure-shape advice and the
`/api/server-stats` version field (both in 2.11.4), and the `investigate_burn` blind-spot plus the
hardcoded bodies dir across seven readers (2.11.3).

## Work

1. Read each report; classify every finding CONFIRMED / REFUTED / NEEDS-CHECK against the source.
2. Fix CONFIRMED findings in phases of at most 5 files, running the full gate between phases.
3. Add a regression test for every behavioural fix — a fix with no test is an unverified claim.
4. Release the batch; append the commits here as they land.

## Verification

```bash
pnpm run check-types && pnpm run lint && pnpm run check-mirrors
pnpm run compile-tests && npx mocha --ui tdd out/test/test/ --recursive
node esbuild.js && agentlenspro server restart
```

Pass criterion: every gate at or better than the baseline above, and each fix carries a test that
fails before it and passes after.

## Related

- `[[agentlenspro-ops-lessons]]` — the deploy law and the config-wipe incident behind the
  `safeConfigEdit` rule.
- TRDD-8N3KQW2R — the blind-spot fix that preceded this and shipped as 2.11.3.
