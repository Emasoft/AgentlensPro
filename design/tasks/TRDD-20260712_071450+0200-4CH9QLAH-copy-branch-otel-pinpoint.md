---
trdd-id: 4CH9QLAH
title: Copy fully-expanded branch tree + OTEL↔JSONL pinpoint (Phase 3)
column: published
created: 2026-07-12T07:14:50+0200
updated: 2026-08-02T14:25:00+0200
current-owner: claude-code-review
assignee: claude-code-review
priority: 3
severity: LOW
effort: L
task-type: feature
parent-trdd: null
labels: [dashboard, webview, observability, ux]
release-via: publish
delivery: direct-push
target-branch: main
feature-branch: feat/copy-branch-otel
merge-strategy: merge
must-pass-tests-before-merge: true
test-requirements: [unit, integration, dev-browser-headless, lint, typecheck]
audit-requirements: []
review-requirements: [code-review]
impacts: [public-api]
relevant-rules: []
attempts: 0
last-test-result: not-run
implementation-commits: [f27e1d2, 458e462, 123031f, f79e9e4]
---

# Copy fully-expanded branch tree + OTEL↔JSONL pinpoint (Phase 3)

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-16 17:26

**✅ SHIPPED END-TO-END — column → ai_review.** Verified 2026-07-16: all Phase-3 sub-phase
commits are merged to `main` and shipped in **v2.8.0** (published to npm via OIDC today), and the
one dangling item in the 07-12 block below is resolved — the live server has long been redeployed,
so `/api/branch-dump` is in the shipped bundle (grep-verified 3 hits in `standalone/server.js`)
and the 404-fallback path the dev-browser test exercised no longer applies. The "NOT pushed"
note is stale (main is pushed through 8bb7913). Remaining gate: human review.

(Superseded 2026-07-12 block, kept for lineage:)

## STATE (superseded) — 2026-07-12

**What this is:** Phase 3 (final feature phase) of the approved plan
`~/.claude/plans/cheerful-herding-meteor.md`. Phases 0a/0b/1/2 are DONE + merged (gate 911/0).
Adds a per-branch **"copy fully-expanded tree"** button to the dashboard's real DOM tree
(Traces.tsx) + subagent branches, plus a toolbar-level "copy this session" on the canvas
Flow tab, that serializes a branch to a self-describing TEXT tree with **session-id + project-slug
header**, **OTEL↔JSONL match keys** per llm/api_request node, and **big-output → dump-file path**
substitution (written by a new localhost-only server endpoint under the Claude projects tree).

**Surface map (evidence):** `reports/phase3-explore/20260712_071450+0200-surface-map.md`.

**Design corrections vs the plan (verified 2026-07-12):**
- Flow.tsx is a `<canvas>` — SemNode drops spanId/requestId; per-branch DOM buttons are IMPOSSIBLE
  there. Scope for Flow = ONE toolbar-level "copy this session's tree" button (serializes the same
  session via the shared serializer). Per-branch buttons live in **Traces.tsx** (session header
  @1487 + subagent-branch header @1114) — that IS the "session timeline + subagent trees" scope.
- The PURE serializer goes in **`src/shared/branchSerialize.ts`** (runtime-neutral) so the 911-mocha
  suite tests it AND the webview imports it — satisfies the anti-mirror doctrine (`check-mirrors`).
  Async fetch/DOM/clipboard glue stays webview-side in `media/src/CopyBranchButton.tsx`.
- No synchronous expand-all primitive exists — every descendant load is an async postMessage/fetch.
  So the webview glue is async: recurse `childrenByParent`, fire `loadSessionDetail` per descendant,
  await the `sessionTimelines`/`blobCache` signals, THEN call the pure serializer.

**✅ ALL SUB-PHASES DONE + verified (2026-07-12), gate GREEN 927/0. Merged to main via the
whole-Phase-3 `--no-ff` merge; NOT pushed (v2.5.0 release deferred to plan end, user-confirmed).**
- Commits: 3a `f27e1d2` · derived-fix `458e462` · 3b `123031f` · 3c `f79e9e4` · docs.
- **Mount correction (verified live):** the Traces/Flow TABS do not exist in this UI — the session
  tree renders inside the **Sessions detail** (`TimelineWaterfall` + `FlowCanvas`, Sessions.tsx). The
  ⧉ tree button is wired on the Sessions section bar (primary, per-session) + `SubAgentBranch` header
  + `FlowCanvas` toolbar; the dead `SessionBlock` (Traces-tab-only) mount was reverted.
- **Dev-browser verified (headless):** button renders on the section bar; one click produced a 101 KB
  self-describing tree (session-id+slug header, per-node OTEL match keys), zero runtime error. The
  endpoint happy-path is covered by the 4 real-boot mocha tests; the live canonical server is a stale
  pre-endpoint build (20 h uptime) so it 404s /api/branch-dump → this PROVED the button's graceful
  'omitted'-marker fallback. The dump files materialize once the canonical server is redeployed.
- Slug for the dump POST = `(projectPath||workspace).replace(/[/\\.]/g,'-')` — the Claude project-dir
  encoding, verified to match this project's real `-Users-…-AgentlensPro` dir.

**Sub-phases (each: gate `bash scripts/safe-deploy.sh --dry-run` GREEN ≥911, commit on
`feat/copy-branch-otel`):**
- **3a** — `src/shared/branchSerialize.ts` (pure) + `src/test/branchSerialize.test.ts`. Pure fn:
  `SerialNode` tree → `{ text, dumps }`. Handles indent, session/slug header, per-node OTEL match-key
  line, threshold → `@@DUMP:id@@` placeholder + a dump entry. No DOM, no fetch, no Node imports.
- **3b** — `POST /api/branch-dump` in `standalone/server.ts` (rebuild bundle first) +
  `src/test/branchDump.test.ts` (real boot). Writes each dump under
  `~/.claude/projects/<slug>/agentlens-branch-dumps/<session>-<ts>-<n>.txt`, realpath-containment
  guarded (reuse the `generatedFiles` canonical-path pattern), CSRF/loopback guarded. Rejects
  traversal + foreign slug. Returns `[{id, path}]`.
- **3c** — `media/src/CopyBranchButton.tsx` (async materialize → shared serialize → dump-POST →
  clipboard) + wire into Traces.tsx (session + subagent-branch headers) + Flow.tsx toolbar. Rebuild
  dashboard bundle; dev-browser headless screenshot light+dark. Gate + commit. Merge Phase 3 --no-ff.

**Gate gotchas (carried from Phase 1/2):**
- `bash scripts/safe-deploy.sh --dry-run` is authoritative (resolves Node 20 for mocha; pnpm crashes
  under Node 20). Baseline **911 passing / 0 failing**.
- 3b touches `standalone/server.ts` → **rebuild `node esbuild.js` BEFORE gating** (real-boot tests
  spawn the built bundle; `--dry-run` does not rebuild). 3a (src/shared) and 3c (media/src) do NOT
  need a rebuild for mocha, but 3c needs `node esbuild.js` for the dashboard bundle + a dev-browser pass.
- Do NOT push/tag — v2.5.0 release is cut only after Phase 3, confirmed with the user first.

## Requirement (plan req 7, verbatim intent)

Per-branch floating "copy fully-expanded tree" button that: forces lazy children to load, serializes
the branch as a fully-expanded text tree, copies to clipboard; header = session id + project slug;
big output → dump-file path (under `~/.claude/projects/<slug>/agentlens-branch-dumps/`, written by a
new server endpoint); per api_request/llm node, an OTEL raw-request link + grep-able match key
(requestId/spanId/traceId) so the matching OTEL data is trivially found.

## Serialized-payload shape (design)

```
# AgentlensPro branch dump
# session: <sessionId>   project: <workspace-slug>   source: <source>/<dataSource>
# match keys: ⟨span=… req=… trace=…⟩ per node — grep the OTEL bodies dir / raw *.request.json
────────────────────────────────────────
● session <sessionId>  <userRequest?>
  ├─ [llm] <label> · <model> · <outTok>tok · $<cost>   ⟨span=<spanId> req=<requestId> trace=<traceId>⟩
  │    thinking: …
  │    response: …            (or, if > THRESHOLD: [output 41232 chars → dump: <abs path>])
  ├─ [tool] <name>  ⟨span=<spanId>⟩
  │    input: …
  │    result: …             (blob-backed → fetched, threshold-checked)
  └─ ▸ subagent <childSessionId>  (spawnedByTurn=<n>, type=<spawnSubagentType>)
       ├─ … (recurses)
```

THRESHOLD default 8 KB per node body (env/const). Over-threshold bodies become `@@DUMP:id@@`
placeholders in the pure output; the glue POSTs the collected dumps, gets real paths back, and
string-replaces the placeholders before writing to the clipboard.

## Verification

- Each sub-phase: `bash scripts/safe-deploy.sh --dry-run` GREEN (≥911).
- 3a: pure-fn unit tests (indent, header, match-key line, threshold→placeholder+dump, empty branch).
- 3b: real-boot test — POST a dump, assert file under the projects tree, assert traversal + foreign
  slug rejected, assert loopback-only.
- 3c: dev-browser headless screenshot (light+dark) of the button on a session + subagent branch;
  manual "copy → pastes a complete self-describing tree with session/slug header + OTEL match keys +
  dump-file path for big output".

## Approval log

Tier-0 (agent-independent) per `~/.claude/rules/trdd-approval-tiers.md`: in-scope feature work on the
project's own source, reversible, no baseline deviation, no cross-project reach. Authored directly at
`column: dev` under the standing `/go-on-yourself` directive + the user-approved plan.
- 2026-08-02 — AI review PASSED (ai_review backlog audit): this card's own STATE block already recorded the work as shipped end-to-end and it re-verified against the code today. Column ai_review → human_review; the remaining gate is the human, exactly as the STATE block says.
- 2026-08-02 — HUMAN gate closed by USER delegation ("evaluate the whole status of the project and decide yourself. just base all decisions on verified facts."). release-via publish already satisfied: the four sub-phase commits (f27e1d2, 458e462, 123031f, f79e9e4 — now recorded in implementation-commits, which was empty) re-verified ancestors of origin/main today; shipped in v2.8.0 per the STATE. Column human_review → published (terminal as itself).
