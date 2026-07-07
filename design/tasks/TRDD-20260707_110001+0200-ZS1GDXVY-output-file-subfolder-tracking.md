---
trdd-id: ZS1GDXVY
title: Track project-slug subfolder output files (tool-output dumps) as expandable trace leaves
column: complete
created: 2026-07-07T11:00:01+0200
updated: 2026-07-07T14:30:00+0200
current-owner: null
assignee: null
priority: 2
severity: MEDIUM
effort: L
task-type: feature
parent-trdd: TRDD-TKN5VALS
relevant-rules: []
release-via: none
target-branch: fix/logreader-large-jsonl
test-requirements: [typecheck, lint]
impacts: []
implementation-commits: []
external-refs: []
---

# TRDD-ZS1GDXVY — Output-file / subfolder tracking

## ⏵ STATE — DONE (2026-07-07)
Implemented per orchestrator scope guard. Phase A (harvest referenced scratch paths from jsonl
tool_use inputs + toolUseResult output-file, correlate to producing tool step by tool_use id) +
Phase B (bounded scratch-tree index, 500-file cap with truncation flag). Stored in SQLite
(`generated_files` table + writer/reader, idempotent via SCHEMA_SQL CREATE IF NOT EXISTS; survives
restart). Lazy content fetch via `/api/generated-file` (standalone) + `loadGeneratedFile`
postMessage (VS Code), scratch-path-guarded, 200KB cap + truncation notice, overflow:visible.
Surfaced on the Traces tool-step drill (`Output files`) + a session-level `Generated files` group
in both Traces and the History tab. `get_session_detail` MCP output carries a compact
`generatedFiles` summary (count + top-5 by size). Token estimate = bytes/4 behind
`estimateTokensFromBytes` (single swap point for TRDD-IQENK7JM). Missing/deleted files → `missing`
flag / `exists:false` "file gone" state. Privacy: absolute paths stay local — the export allowlist
(both paths) never includes generatedFiles.
Gates: check-types + lint + esbuild clean; unit tests 208 passing / 1 pending / 0 failing (194
baseline + 14 new); headless proof PASS (correlated leaf in /api/timeline, content via
/api/generated-file, /etc/passwd refused). Key files: src/generatedFiles.ts, src/logReader.ts,
src/database/{schema,db,writer,reader}.ts, standalone/server.ts, media/src/GeneratedFilesView.tsx.

## ⏵ STATE — READ FIRST
User: "every output file saved in the subfolders of the projects slugs must be tracked and showed as
expandable leaf" … "the subfolders data with the tools's output dumps."

Claude Code writes artifacts under session/project scratch dirs — e.g.
`/private/tmp/claude-501/<project-slug>/<sessionUuid>/scratchpad/…`, and tool-output dumps referenced by
`output-file` in task-notifications (e.g. `…/tasks/<taskId>.output`). These files are the real content of
many tool results and sub-agent outputs but are NOT surfaced.

## Spec
1. **Index** the per-session scratch/subfolder tree: for each active session, watch
   `/private/tmp/claude-*/<project-slug>/<sessionUuid>/**` (scratchpad, tasks, etc.) and any `output-file`
   paths referenced in the session's jsonl (Task toolUseResult `output-file`, background-task outputs).
   Record path, size, mtime, and lazy-load content on demand (never load all into memory).
2. **Attach** each output file as an expandable LEAF on the step/tool-call that produced it (correlate by
   the task/tool_use id where possible, else list under the session as a "generated files" group). Each
   leaf: filename + size + token estimate + expand→content (blob-backed, cap large files, `overflow:visible`).
3. **Store** the index in the AgentLens DB so it survives reload; refresh via the same watcher as R-B.
4. Respect the reports-location/privacy rules — these are local paths; do not leak them off-machine.

## Acceptance
- A session that wrote scratchpad/task-output files shows them as expandable leaves in the trace with
  their real content; correlated to the producing tool call where identifiable. check-types+lint+esbuild
  clean; headless proof.
