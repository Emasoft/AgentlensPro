---
trdd-id: 6E6416B8
title: Remove all VS Code extension code — keep standalone server + webview + MCP
column: complete
created: 2026-07-07T11:00:01+0200
updated: 2026-07-08T09:18:40+0200
current-owner: null
assignee: null
priority: 4
severity: MEDIUM
effort: L
task-type: refactor
parent-trdd: TRDD-TKN5VALS
relevant-rules: []
release-via: none
target-branch: fix/logreader-large-jsonl
test-requirements: [typecheck, lint]
impacts: [install-script, ci-pipeline]
external-refs: []
implementation-commits: [74886f1, 1ca6bce, bda1cd7]
last-test-result: pass
last-test-at: 2026-07-08T09:18:40+0200
---

# TRDD-6E6416B8 — Remove the VS Code extension

## ⏵ STATE — DONE (2026-07-08). Authoritative.
User (2026-07-07): "remove all code pertinent to the vscode extension, i'm not interested in that." COMPLETE.
All `vscode` references are gone from `src/`, `standalone/`, `media/` (grep = NONE). The standalone server
+ webview dashboard + MCP are the only shipped surfaces and boot headless with no VS Code.

Landed in 3 commits (branch fix/logreader-large-jsonl):
- 74886f1 — build/release detach (esbuild targets, package.json, release.yml, .vscode-test.mjs)
- 1ca6bce — delete extension host + its test + vscode mock; gut src/test/setup.js
- bda1cd7 — de-vscode the 7 retained shared modules + tests; add src/vscodeCompat.ts; sync pnpm-lock

### What was REMOVED
- Files: `src/extension.ts`, `src/dashboardPanel.ts`, `src/sidebarPanel.ts`, `src/autoConfig.ts`
  (imported only by extension.ts; `autoConfigNode.ts` is the standalone's KEEP sibling),
  `src/test/extension.test.ts`, `src/test/__mocks__/vscode.js`, `.vscode-test.mjs`.
- `src/test/setup.js` gutted to a no-op (kept — `.mocharc.cjs` requires it).
- esbuild.js: the `extension` target + `copySqlWasm()` (dist/ was the extension bundle dir).
- package.json: `engines.vscode`, `activationEvents`, `main`, `contributes`, `galleryBanner`; devDeps
  `@types/vscode`/`@vscode/test-cli`/`@vscode/test-electron`; scripts `test`/`pretest`/`vscode:prepublish`.
- release.yml: the `vsce` package/upload steps + the `publish-vsce` job (kept npm + GitHub Release).

### What was KEPT + de-vscoded (structural stand-ins in `src/vscodeCompat.ts`)
`database/{migration,reader,writer}.ts`, `exportData.ts`, `otlpCollector.ts`, `sessionRepository.ts`,
`sessionStore.ts` — vscode `Uri`/`workspace.fs`/`FileType`/`OutputChannel`/`ExtensionContext` replaced by
`UriLike`/`joinUri`/`WriteBlobFs`/`ReadBlobFs`/`DirBlobFs`/`FileType`/`OutputChannelLike`; the blob file
system is now injected (no fs → graceful no-op / null, exactly as a missing file). These are reachable only
from the (deleted) extension + unit tests; standalone never imported them.

### CORRECTIONS to the original inventory (verified against the live tree, per claim-verification)
- ✗ `media/src/sidebarWebview.ts` and the `sidebar` esbuild target are NOT extension-only — the standalone
  server serves `/sidebar.js` (server.ts:1395) and its header says "Works in both VS Code webview and
  standalone". They are KEPT. Only `src/sidebarPanel.ts` (the extension-host provider) was removed.
- `pnpm-lock.yaml` WAS updated (out of original scope): `pnpm run <script>` auto-reconciles node_modules to
  package.json and dropped the 3 vscode devDeps; the lockfile must match or CI `--frozen-lockfile` fails.

## Acceptance — ALL MET (2026-07-08)
- `node esbuild.js` builds only media/sidebar/standalone/cli — EXIT 0.
- `pnpm run check-types` EXIT 0 (with @types/vscode removed from node_modules — proves zero vscode imports).
- `pnpm run lint` EXIT 0, 0 errors (62 pre-existing no-console warnings).
- Unit suite: 351 passing / 1 pending / 0 failing (baseline 352 minus the deleted extension.test sample).
- Standalone booted headless (empty HOME, isolated ports 13000/14316/14318, AGENTLENS_NO_TELEMETRY_CONFIG=1,
  temp DATA_DIR): UI 200 (title + /sidebar.js served), dashboard.js 200, sidebar.js 200, MCP `initialize`
  JSON-RPC handshake OK (serverInfo: agentlens). Production ports 3000/4316/4318 untouched.
- `grep -rn "from 'vscode'|require('vscode')|import('vscode')"` over src/standalone/media = NONE.
