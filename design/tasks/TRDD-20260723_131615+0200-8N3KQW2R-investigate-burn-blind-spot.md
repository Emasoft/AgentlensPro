---
trdd-id: 8N3KQW2R
title: investigate_burn reports nothing-burned while scanning the wrong bodies dir
column: publish
created: 2026-07-23T13:16:15+0200
updated: 2026-07-23T13:42:00+0200
implementation-commits: [590c308]
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

**State:** FIXED and verified in commit `590c308`; skill + CHANGELOG updated; version bumped to
2.11.3. Remaining: tag and let CI publish.

**NEXT ACTION** — publish (tag-driven OIDC, CI-only — never `npm publish` locally):

```bash
git add package.json CHANGELOG.md skills/agentlenspro-diagnostics/SKILL.md \
  design/tasks/TRDD-20260723_131615+0200-8N3KQW2R-investigate-burn-blind-spot.md
git commit -m "chore(release): 2.11.3"
git tag v2.11.3 && git push && git push --tags
```

**Proof it works** — same 1h window, before → after:
`0 files scanned / "nothing burned here" / complete:true`
→ `614 request + 613 response bodies across BOTH dirs, 32,060,504 equiv tokens, est $179.03,
3 findings (top FORK_STORM)`.

**Trap found while verifying:** the global `agentlenspro` on PATH is a symlink to the *published*
package (`/opt/homebrew/lib/node_modules/agentlenspro`), NOT this repo — `npm link` is not in
effect, so CLAUDE.md's "globally-linked" claim is stale. A local rebuild + `server restart` does
NOT change what the `agentlenspro` command runs. Verify new code with
`node -e 'require("./out/test/<mod>.js")'` or re-link.

**Also fixed here (same root cause, unasked):** six sibling readers shared the hardcoded path —
`burnGuard` (`--risk`), `cacheBreakTimeline`, `cacheCreationForensics`, `forensicsIndex`,
`heartbeatCost`, `sessionBurnProfile`. Leaving them would have kept `--risk` — the cross-check the
new BLIND verdict points at — reading the same empty directory.

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
