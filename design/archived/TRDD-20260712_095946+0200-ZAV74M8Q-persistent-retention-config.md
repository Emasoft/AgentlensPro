---
trdd-id: ZAV74M8Q
title: Persistent, discoverable retention config (config.json + agentlenspro config CLI)
column: published
created: 2026-07-12T09:59:46+0200
updated: 2026-08-18T12:45:00+0200
current-owner: claude-code-review
assignee: claude-code-review
priority: 3
severity: LOW
effort: M
task-type: feature
release-via: publish
delivery: direct-push
target-branch: main
feature-branch: feat/configurable-retention
test-requirements: [unit, lint, typecheck]
relevant-rules: []
attempts: 0
last-test-result: not-run
implementation-commits: []
---

# Persistent, discoverable retention config

## ⏵ STATE — READ FIRST — 2026-07-13

**✅ DONE + gated GREEN 938 passing / 0 failing (was 927 baseline; +11 new retentionConfig tests).**
All 5 steps landed: `src/retentionConfig.ts` (config-file layer), `standalone/server.ts` (5 constants
now `resolveRetention(DATA_DIR, process.env)` — behavior-identical when env unset), `src/cli/configCli.ts`
+ `main.ts` `case 'config'` + `diagnosticsCli.ts` USAGE, `src/test/retentionConfig.test.ts` (11 tests:
precedence, min-floor, fail-soft load, atomic set, preserve-other-keys, reject-below-min/unknown/NaN,
REFUSE-on-corrupt), README "Data retention" section. Bundle rebuilt (`node esbuild.js`). CHANGELOG
`[2.5.1]` + package.json → 2.5.1. Committed on `feat/configurable-retention`, merged --no-ff to main.
**✅ PUBLISHED as v2.5.1 (2026-07-13)** via OIDC (latest, trustedPublisher + SLSA attestations, docker,
GitHub Release, npx smoke); the local server was restarted onto the retention-config build.

---
_Superseded planning notes below (the work above is authoritative):_

## ⏵ STATE (original plan) — 2026-07-12

**Ask (user):** "make the retention configurable."

**Finding (verified):** retention is ALREADY fully env-configurable — `AGENTLENS_SPANS_RETENTION_DAYS`
(30), `AGENTLENS_SUMMARY_WINDOW_HOURS` (24), `AGENTLENS_BODIES_MAX_AGE_HOURS` (72),
`AGENTLENS_BODIES_MAX_GB` (8), `AGENTLENS_BODIES_RETENTION_DAYS` (31), each `Math.max`-floored, read at
server boot (standalone/server.ts:136/142/237-239). Nothing hardcoded-only. The REAL gaps: (1) it's
undocumented (the user didn't know); (2) shell env vars don't reach the launchd DAEMON (its own plist
env), so retention isn't *persistently* settable for the always-on runner.

**Fix:** a persistent `~/.agentlens/config.json` (in DATA_DIR — survives repo-delete/uninstall/upgrade
like the data it governs, and the daemon reads it every boot) with a `retention` section. Precedence
per knob: **env var > config.json > built-in default** (env stays the ops override; the file is the
persistent setting). Plus a small `agentlenspro config` CLI (list/get/set) with validation, and docs.

**PROGRESS (2026-07-12):** Step 1 DONE — `src/retentionConfig.ts` written (uncommitted, on branch
`feat/configurable-retention`). Exports: `RetentionConfig`, `RETENTION_META` (the single source of
truth table: key/env/def/min/unit/desc for all 5 knobs), `configPath`, `loadRetentionConfig`
(fail-soft), `resolveKnob`/`resolveKnobWithSource` (env>file>default, min floor), `resolveRetention`
(all 5 at once — server calls this), `findMeta`, `setRetentionKey` (atomic temp+rename, preserves
other keys, THROWS on corrupt file — no clobber).

**NEXT ACTION — Step 2, wire `standalone/server.ts`:** after `DATA_DIR` (line ~71) add
`const RET = resolveRetention(DATA_DIR, process.env)` (import from `../src/retentionConfig`), then
replace the 5 inline constants with `RET.*`:
- `SUMMARY_WINDOW_MS` (~L136, `(Number(process.env.AGENTLENS_SUMMARY_WINDOW_HOURS)||24)*3600e3`) → `RET.summaryWindowHours * 3600e3`
- `SPANS_RETENTION_DAYS` (~L142) → `RET.spansRetentionDays`
- `BODIES_MAX_AGE_MS` (~L237) → `RET.bodiesMaxAgeHours * 3600e3`
- `BODIES_MAX_BYTES` (~L238) → `RET.bodiesMaxGb * 1024 ** 3`
- `BODIES_RETENTION_DAYS` (~L239) → `RET.bodiesRetentionDays`
Re-read L128-145 + L235-240 for exact strings (Math.max floors now live inside resolveKnob). Then:
Step 3 CLI (`src/cli/configCli.ts` + `main.ts` `case 'config'` + `diagnosticsCli.ts` USAGE:
`config [list] | config get <key> | config set <key> <value>`); Step 4 tests
(`src/test/retentionConfig.test.ts`); Step 5 docs (README "Data retention"). REBUILD BUNDLE
(`node esbuild.js`) before the gate. Gate `bash scripts/safe-deploy.sh --dry-run` (baseline 927/0),
commit, merge --no-ff. DO NOT push (v2.5.1 — confirm with user first).

**Plan:**
1. `src/retentionConfig.ts` — `loadRetentionConfig(dataDir)` (fail-soft: missing/bad JSON → {}),
   `resolveKnob(meta, fileCfg, env)` (env > file > default, min floor), `setRetentionKey(dataDir,key,
   value)` (atomic temp+rename, PRESERVES other keys, REFUSES to write if the existing file is
   present-but-corrupt — never "start fresh on parse failure", per the settings-wipe gotcha). A
   `RETENTION_META` table (key, env name, default, min, unit) is the single source both server + CLI use.
2. `standalone/server.ts` — load the file once at boot; the 5 constants become
   `resolveKnob(...)` instead of inline `Number(env)||default`. No behavior change when unset.
3. `src/cli/configCli.ts` + `main.ts` `case 'config'` + USAGE — `config` (list effective value+source),
   `config get <key>`, `config set <key> <value>` (validates number ≥ min; prints "restart to apply").
4. Tests `src/test/retentionConfig.test.ts` — precedence, floor, fail-soft load, atomic set preserves
   + refuses-on-corrupt.
5. Docs — README "Data retention" note (the 5 knobs + `agentlenspro config set` + env) + `--help`.

**Gate:** `bash scripts/safe-deploy.sh --dry-run` GREEN (baseline 927/0). server.ts change → rebuild
bundle before gate (real-boot suites). Do NOT push (would be a v2.5.1 — confirm with user).

## Approval log
Tier-0 (agent-independent) — in-scope feature on the project's own source, reversible, no baseline
deviation. Authored under /go-on-yourself + the direct user request "make the retention configurable".
- 2026-08-18T12:45:00+0200 — ARCHIVED by USER batch directive ("complete all TRDD"); validity re-verified: src/retentionConfig.ts and src/cli/configCli.ts exist; standalone/server.ts:123 calls resolveRetention(DATA_DIR, process.env).
