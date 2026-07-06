---
trdd-id: KT87QPM0
title: Statusline usage ingestion — exact live per-turn buckets + context size + cost, no server queries
column: complete
created: 2026-07-06T23:07:02+0200
updated: 2026-07-06T23:20:00+0200
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
implementation-commits: [3ab4973]
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

**DONE (2026-07-06, commit `3ab4973`).** Files: src/statuslineUsage.ts (NEW
StatuslineUsageReader), src/summarizers/summarizerTypes.ts (StatuslineUsageAgg +
optional `statusline?` on card), src/database/writer.ts (cost precedence:
statusline.totalCostUsd > 0 overrides estimate), src/extension.ts +
standalone/server.ts (overlay at the 2 Claude enqueue sites each), and
~/.claude/statusline.py (write_usage_jsonl, single-log O_APPEND). Log path resolver
mirrored byte-for-byte Py↔TS: $AGENTLENS_STATUSLINE_LOG → <CLAUDE_CONFIG_DIR>/agentlens/
statusline-usage.jsonl → ~/.claude/agentlens/statusline-usage.jsonl. 13-field records.
VERIFIED LIVE: this session (777b8f52) feeds valid lines (cache_read 235718,
used% 24.0, cost $338.08, 1M window); check-types(src+media)+lint+esbuild EXIT 0;
statusline renders + dedups. Report: reports/mcp/P7-statusline-ingestion-REPORT-20260706_231546+0200.md.

**Deferred (optional, media-owning agent):** mirror StatuslineUsageAgg into
media/src/types.ts + read session.statusline to show exact live used%/window/5-buckets
as first-class UI. Not needed for P7 to work (overlay uses only fields webview already has).
**Persistence limit (acceptable):** cost_usd + peak_context_per_turn ARE persisted;
the transient `statusline` object (used%/window/last-turn buckets) is live-only (no DB cols).
