---
trdd-id: WYC4KB50
title: Viewer-role assertion — xhigh code-review remediation (13 findings)
column: ai_review
created: 2026-07-17T10:34:17+0200
updated: 2026-07-17T14:24:30+0200
current-owner: main
task-type: bugfix
parent-trdd: 1ZH1D5EG
relevant-rules: []
implementation-commits: [0d93c51, 29ca817, f1d923e, 9e97df4, 43f7a36]
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-17 11:22 — SHIPPED (all 13)

Remediation of the `/code-review xhigh` on `798c7bc..HEAD` (viewer-role assertion 1ZH1D5EG + 2.10.0
+ portability). 13 findings, "fix all" — ALL DONE across 4 code/doc commits + this TRDD.

Gate: check-types ×2 = 0, lint 0 errors (239 pre-existing no-console warnings), check-mirrors OK,
mocha 1355 passing / 8 pending / 0 failing (+3 new embedAuth tests). Deploy law honored: esbuild
OK, symbol greps landed ('embed feature DISABLED' ×1, Vary ×2 in server.js; restricted-tab predicate
×6 in dashboard.js), server restarted pid 35280.

LIVE-PROVEN the #1 soft-fail (the load-bearing fix) on a throwaway instance with a CORRUPT key:
server stayed ALIVE (no crash), logged the disable warning, embed-status → keyLoaded:false, a present
header → 403 (fail-closed), dashboard / → 200. And on the real running server: no-header → standalone
keyLoaded:true, garbage header → 403, Vary present. So the opt-in embed feature can no longer take
the product down, matching #4 §B5.

REMAINING:
- ⚠ REVERSED (2026-07-17): finding #1's soft-fail was reversed to fail-closed refuse-to-boot by
  TRDD-F1VX3M7C (owner directive "go with the more secure version"). Consequences: (a) the #4 §B1
  heads-up is NO LONGER NEEDED — the public thread already documents refuse-to-boot, now accurate
  again; (b) the "SUPERSEDED — do NOT carry forward" note below (bad key ⇒ feature disabled, server
  runs) is ITSELF now superseded — the truth is refuse-to-boot again (exit EX_CONFIG 78,
  supervisor-terminal). See TRDD-F1VX3M7C.
- Tagging v2.10.1 (triggers OIDC publish) — still USER-gated; version + CHANGELOG already bumped
  (now describing the fail-closed behavior).

Gate: human review. NEXT ACTION: none autonomous — await user on the v2.10.1 tag.

Treatment (proportionate — the user's standing directive is security is reactive-only in this
project, so speculative-deployment findings get a documented non-goal, not a speculative gate):

| # | file | finding | treatment |
|---|------|---------|-----------|
| 1 | server.ts:111 | corrupt/wide embed-key throws at module load → crashes WHOLE server (OTLP/hooks/CLI); #4 §B5 wants the softer path (present header 403, server runs) | CODE: EMBED_KEY nullable, try/catch + loud boot log; null key ⇒ present header → invalid |
| 2 | embedAuth.ts:51 | `(mode & 0o077)` throws on Windows (Node emulates POSIX bits as 0o666) → permanent 2nd-boot fail | CODE: gate with `process.platform !== 'win32'` |
| 3 | App.tsx:208 | "Configure alerts →" not gated by viewerRestricted → dead UI (ConfigPanel never mounts) | CODE: hide button when restricted |
| 4 | server.ts:3667 | `/` HTML varies by role but no `Vary` → a cache could serve restricted HTML to maestro | CODE: `Vary: X-Agentlens-Viewer` |
| 5 | server.ts:1975 | `getHtml(restrictedViewer=false)` default fails open if a caller forgets the arg | CODE: make the arg required |
| 6 | App.tsx/dashboard.tsx | restricted-tab policy copy-pasted in 3 sites → drift | CODE: one `isRestrictedBlockedTab` in state.ts |
| 7 | embedAuth.ts:63 | hand-rolled tmp+rename skips fsync/cleanup vs `atomicWriteFileSync` | CODE: extend helper with optional mode, reuse |
| 8 | mcpServer.ts | MCP port has no viewer-role gate | DOC: loopback + origin-checked, server-to-server, never proxied to viewers — comment the non-goal |
| 9 | server.ts:2775 | embed-status bypasses admission-control by position, not registered in `isAdmissionExempt` | CODE: register it (survives a future reorder) |
| 10 | server.ts:2752 | `Array.isArray` branch is dead under Node header-coalescing; no test | TEST: keep the defensive guard; add comma-joined → invalid test |
| 11 | embedAuth.ts:85 | `JSON.parse` can yield non-object; property access fragile (caught today, breaks if moved out of try) | CODE: `typeof === object && !== null` guard |
| 12 | Dockerfile | embed-key in container `/data`; host proxy can't read it | DOC: comment — embedding needs the volume shared with the proxy user |
| 13 | serverControl.ts (deletion) | deleted plist template removed the manual-copy recipe with no replacement | DOC: README manual-install pointer |

Load-bearing:
- #1 changes the "refuses to boot on a bad key" wording posted to AgentlensPro#4 + README ⇒ needs a
  consumer heads-up on #4 (OUTWARD action — await user before posting).
- #7: `atomicWriteFileSync(file, data)` has no mode param → extend with optional `mode?` (all
  existing callers backward-compatible).
- The gate's null-key policy lives in `resolveViewerRole` (one place): header absent → standalone
  regardless; header present + key null → invalid (feature disabled, not product-down).

Phases (each: edit → full gate → commit; ≤5 files):
1. src/serverRuntime.ts + src/embedAuth.ts + src/test/embedAuth.test.ts   (#2,#7,#11,#10,null-key)
2. standalone/server.ts + src/mcpServer.ts                                (#1,#4,#5,#9,#8)
3. media/src/state.ts + media/src/App.tsx + media/src/dashboard.tsx       (#3,#6)
4. README.md + CHANGELOG.md + Dockerfile + package.json                   (#1-wording,#12,#13,bump 2.10.1)
5. full gate + esbuild + server restart (deploy law) + memory + #4 heads-up

SUPERSEDED — do NOT carry forward: the original "server refuses to boot on a corrupt/wider-than-0600
key" behavior (findings #1/#2). New truth: bad key ⇒ embed feature disabled, server runs.

Verify: `pnpm run check-types` (×2) + `pnpm run lint` + `pnpm run check-mirrors` + mocha suite green;
`node esbuild.js` SUCCEEDS + `agentlenspro server restart`; symbol grep in both bundles.

## Context

The `/code-review xhigh --` on the post-2.9.0 viewer-role work surfaced 13 verified findings
(finder JSONs in the session scratchpad; verified in-context). This TRDD tracks their remediation
as a single atomic batch. The two CONFIRMED top findings are self-inflicted availability bugs in
`ensureEmbedKey` (an OPT-IN embed feature could take the whole product down); the rest are
defensive/cleanup/altitude fixes plus three documented non-goals for speculative deployment
topologies (respecting the project's reactive-only security posture — see LOCAL memory
`feedback-project-focus-tokens-not-security`).
