---
trdd-id: 6E6416B8
title: Remove all VS Code extension code — keep standalone server + webview + MCP
column: dev
created: 2026-07-07T11:00:01+0200
updated: 2026-07-08T08:50:00+0200
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
---

# TRDD-6E6416B8 — Remove the VS Code extension

## ⏵ STATE — READ FIRST
User (2026-07-07): "remove all code pertinent to the vscode extension, i'm not interested in that."
DEFERRED during P8 because the burn-diagnosis instrument took priority; do this AFTER the P8 ingestion
work lands (it shares files — do it last to avoid churn).

## Inventory (verified this session)
REMOVE (VS-Code-extension-only): `src/extension.ts`, `src/dashboardPanel.ts`, `src/sidebarPanel.ts`,
`media/src/sidebarWebview.ts`; the vscode mock/test scaffolding (`src/test/__mocks__/vscode.js`,
`src/test/setup.js` vscode bits, `src/test/extension.test.ts`); package.json `contributes`/
`activationEvents`/`main`/`engines.vscode` + vscode dev-deps + the `pnpm test` (vscode-test) wiring;
the `extension` + `sidebar` esbuild targets in `esbuild.js` (targets: `src/extension.ts`→dist/extension.js,
`media/src/sidebarWebview.ts`→media/sidebar.js).
KEEP (shared, used by standalone): everything under `src/**` that the standalone imports — `logReader`,
`database/*`, `summarizers/*`, `otlpCollector`, `otlpParser`, `sessionStore`, `spanSummarizer`,
`mcpServer`, `contextComposition`, `contextHistory`, `cacheBreak`, `pricing`, `statuslineUsage`,
`instructionAdvisor`, `instructionFiles`, `autoConfig`, `exportData`, `sessionRepository`, `types`; the
whole `media/src/**` webview (dashboard) the standalone serves; `standalone/**`.

## Method
- `src/mcpServer.ts` already makes `getHistory`/`getComposition` optional — the extension call site
  (`src/extension.ts:~546`) is removed with the file; standalone stays fully wired.
- Files importing the `vscode` module: `src/database/{migration,writer,reader}.ts`, `src/autoConfig.ts`,
  `src/otlpCollector.ts`, `src/sessionStore.ts`, `src/exportData.ts`, `src/sessionRepository.ts`, etc.
  These are SHARED — they use `vscode` only for optional integration (e.g. workspace paths, output
  channels). Do NOT delete them; instead make the vscode usage optional/guarded or inject the few needed
  values, so the standalone build has zero `vscode` dependency. Verify each with a grep of the actual usage
  before touching (claim-verification rule).
- Per RULE 0: commit before deleting; stage by name; never `git add -A`.

## Acceptance
- `node esbuild.js` builds ONLY the standalone + webview + cli targets (extension/sidebar targets gone),
  EXIT 0; `pnpm run check-types` (src+media) EXIT 0; the standalone server + MCP + dashboard run headless
  with no VS Code present; no remaining `import ... 'vscode'` in any file the standalone bundles.
