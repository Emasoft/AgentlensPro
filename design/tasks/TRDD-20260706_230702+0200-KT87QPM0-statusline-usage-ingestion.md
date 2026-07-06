---
trdd-id: KT87QPM0
title: Statusline usage ingestion — exact live per-turn buckets + context size + cost, no server queries
column: dev
created: 2026-07-06T23:07:02+0200
updated: 2026-07-06T23:12:00+0200
current-owner: claude-opus-4-8
assignee: claude-opus-4-8
priority: 2
severity: HIGH
effort: M
task-type: feature
parent-trdd: TKN5VALS
relevant-rules: []
release-via: none
delivery: direct-push
target-branch: fix/logreader-large-jsonl
test-requirements: [typecheck, lint]
impacts: [config-schema]
attempts: 0
implementation-commits: []
external-refs: [https://code.claude.com/docs/en/statusline.md]
---

# TRDD-KT87QPM0 — Statusline usage ingestion (P7, follow-on to TKN5VALS)

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-07-06

**Goal (user):** use the Claude Code statusline as an authoritative, rate-limit-free
source of the EXACT per-turn token buckets + context size + cost, by having
statusline.py append them to a log AgentLens ingests — instead of AgentLens
querying any server (which gets rate-limited). Full plan:
reports/mcp/P7-statusline-ingestion-SPEC.md.

**Findings:** statusline.py already gets the full JSON on stdin each turn
(context_window.current_usage = the exact 5 buckets, total_input/output,
context_window_size, used_percentage; cost.total_cost_usd; session_id;
workspace.project_dir; model). It already has write_context_snapshot() (~L164):
throttled, atomic, security-hardened per-session snapshot. Extend that pattern.

**Two parts:** (1) EXTEND /Users/emanuelesabetta/.claude/statusline.py (backed up:
statusline.py.bak-p7-20260706_225155) with an append-only JSONL writer of the FULL
per-turn record; (2) ADD an AgentLens src/ ingestion source that tails/parses it
and upserts exact buckets+context+cost into session/turn records. Precedence:
statusline = AUTHORITATIVE numbers; .jsonl parser = per-source COMPOSITION drill.
The AgentLens ingestion GLOBs nothing — it tails the ONE shared log by byte-offset.

**CRITICAL — ONE log, concurrency-safe (user, 2026-07-06):** AgentLens needs a
SINGLE log (NOT per-session — SSD space), yet MANY Claude instances run
statusline.py concurrently. Design: ONE shared append-only file (e.g.
~/.claude/agentlens/statusline-usage.jsonl). Conflict-free WITHOUT per-session
files and WITHOUT locks: each write = open O_APPEND, write the WHOLE JSON line
(+\n) in ONE os.write(), close — line < 4096 B (PIPE_BUF) so POSIX guarantees the
O_APPEND write lands atomically at EOF and never interleaves (syslog-style
multi-writer sharing). OPEN-APPEND-CLOSE PER CALL (no cached fd) so rotation is
safe. NO read-modify-write/truncate/flock. SSD-friendly: keep ≤1/10s throttle +
DEDUPE (skip append when this session's record is unchanged since its last).
AgentLens is the SINGLE reader — tail by byte-offset, owns any size-cap rotation
(rename+recreate); records carry session_id to demultiplex the shared file.

**Owns (files):** ~/.claude/statusline.py + src/** + standalone/** + src/mcpServer.ts.
Webview (media/**) change, if any, is DEFERRED to orchestrator (the 5 buckets
already exist in TimelineEntry, so likely none).

**NEXT ACTION:** background Opus agent (running, id abd8bf0c72cb823e1) implementing
under HARD constraints: no git ops, no media/** edits, src-only verify
(`npx tsc -p tsconfig.json --noEmit` + lint EXIT 0), prove statusline.py still
renders + JSONL appends via sample-stdin test. Orchestrator serializes the commit
after P6, then find_context_hogs (TRDD-9804PKIM) serializes after THIS (shared
src/mcpServer.ts + standalone/server.ts).
