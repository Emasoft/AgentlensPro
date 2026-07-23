---
trdd-id: 8N3KQW2R
title: investigate_burn reports nothing-burned while scanning the wrong bodies dir
column: todo
created: 2026-07-23T13:16:15+0200
updated: 2026-07-23T13:16:15+0200
current-owner: session-7877ae1f
task-type: bugfix
approval-tier: 0
severity: high
impacts: [cli, diagnostics, skill]
release-via: publish
test-requirements: [unit]
---

# investigate_burn reports nothing-burned while scanning the wrong bodies dir

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-23

**State:** diagnosed and evidenced, NOT yet fixed. No code touched. Two defects, both ✓ VERIFIED
by reading the source and measuring the filesystem.

**NEXT ACTION** — open `src/burnInvestigator.ts:375` and replace the hardcoded default:

```bash
grep -n "otel-bodies" src/burnInvestigator.ts        # → line 375, the hardcoded default
grep -n "effectiveBodiesDir" src/captureConfig.ts    # → line 77, the canonical resolver
```

**Facts (measured 2026-07-23):**

1. **Wrong directory (root cause).** `src/burnInvestigator.ts:375` is
   `const bodiesDir = opts.bodiesDir ?? path.join(os.homedir(), '.agentlens', 'otel-bodies')`.
   It never consults `capture.spoolDir`. The canonical resolver
   `effectiveBodiesDir(dataDir, captureOn)` already exists at `src/captureConfig.ts:77` and is
   used by `src/ramdisk.ts` and `src/cli/configCli.ts`. On this machine the spool holds
   **1,876** body files while the hardcoded path holds **0** (the 6.0 GB legacy corpus finished
   draining) — so the tool is blind on any install that redirects bodies, which is the
   documented setup for the 35 GB/day volume.
2. **Dishonest reporting (the part that misleads agents).** With zero files it still returns
   `verdict: "No API traffic found in the window — nothing burned here"`, `findings: 0`, all
   totals `0`, and coverage `requestFilesScanned: 0, bytesOnDisk: 0, complete: TRUE,
   note: "full coverage of the window"`. Absence of DATA is presented as absence of BURN.
   At the same instant `get_burn_status` reported **2,315,075 tokens/min across 7 sessions**.

**Why this matters more than a normal bug:** the shipped `agentlenspro-diagnostics` skill's
START-HERE router sends agents to `investigate_burn` FIRST for "what is burning tokens". An
ai-maestro Claude followed it this session and concluded "crisis fully resolved / burn healthy"
from a blind tool. Fixing (1) without (2) leaves the same trap on any machine whose spool is
unmounted or whose capture is off.

**SUPERSEDED — do NOT carry forward:** the earlier note that the empty dir's cause was
"unverified, possibly a RAM-disk spool artifact". It is verified: wrong path in the reader.

## Work

1. `src/burnInvestigator.ts` — resolve via `effectiveBodiesDir()`; keep `opts.bodiesDir` as the
   test override. Report the dir actually scanned in `coverage`.
2. Blind-spot honesty — when `requestFilesScanned === 0`: `complete: false`, and a verdict that
   names the blind spot and points at `--risk` / `get_burn_status` (live feed, never blind).
   Distinguish "capture off", "dir empty", "dir missing" in the note.
3. Tests (`src/test/`) — (a) with `bodiesDir` pointing at an empty dir, the verdict is a blind
   spot and `complete` is false; (b) the resolver honours a configured `spoolDir`.
4. Skill (`skills/agentlenspro-diagnostics/SKILL.md`) — the START-HERE router and Worked
   example 2 must state that `investigate_burn` depends on raw-body capture and name the
   never-blind cross-checks.
5. Deploy law: `node esbuild.js` must SUCCEED, then `agentlenspro server restart`. Publish
   2.11.3 by tag (OIDC, CI-only — never local, never a token).

## Verification

Pass criterion — these two must stop contradicting each other:

```bash
agentlenspro get_burn_status --full | head -20
agentlenspro investigate_burn --windowHours 1 --full | head -30
```

If `get_burn_status` shows burn while the investigator scanned 0 files, the investigator must
report BLIND, not "nothing burned here".

## Related

- PROJECT memory `agentlens-burn-token-model` — lesson `ATOM-INVB-BLIND` (the measured
  contradiction and the never-blind cross-checks).
- LOCAL memory `raw-body-capture-state-this-machine` — lesson `ATOM-BODY-WRONGDIR` (why the
  legacy dir is empty and where bodies actually land on this machine).
