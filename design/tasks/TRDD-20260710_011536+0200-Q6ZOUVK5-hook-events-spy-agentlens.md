---
trdd-id: Q6ZOUVK5
title: Hook-events pipeline — spy-agentlens.sh replaces spyglass, lifecycle signals into AgentLens
column: dev
created: 2026-07-10T01:15:36+0200
updated: 2026-07-10T01:15:36+0200
current-owner: agentlens-session
task-type: feature
release-via: none
priority: 2
effort: M
labels: [hooks, ingestion, cli, spyglass]
test-requirements: [lint, typecheck]
relevant-rules: []
---

# Hook-events pipeline — spy-agentlens.sh replaces spyglass

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-10

**Current state:** starting implementation (nothing landed yet).

**Plan (phased, commit per phase, local-only, stage by name, NEVER push):**
1. `src/hookEventStore.ts` (NEW) + `standalone/server.ts`: POST `/api/hook-events` (validate,
   append NDJSON daily bucket `~/.agentlens/hook-events/YYYY-MM-DD.ndjsonl`, cap body 512KB),
   GET `/api/hook-events?session=&ev=&since=&until=&limit=` (bounded, newest-first),
   retention purge (31d default, `AGENTLENS_HOOK_EVENTS_RETENTION_DAYS`) on boot + hourly,
   byte-accounting into server-stats.
2. `scripts/spy-agentlens.sh` (NEW): stdin → single fire-and-forget curl (`--max-time 1`,
   `--data-binary @-`, silent no-op when server down, always exit 0, NO stdout).
3. `scripts/agentlens-cli.js`: `--install-hooks` / `--uninstall-hooks` via safeConfigEdit —
   install adds the spy-agentlens hook on the LIFECYCLE-ONLY event subset AND removes every
   spyglass-collect.sh entry + `env.SPYGLASS_DIR` (the "replace spyglass" the user asked);
   uninstall removes only spy-agentlens entries. Merge-preserving: never clobber other hooks
   (janitor etc.) registered on the same events.
4. Docs: USAGE, repo skill SKILL.md rows (+ `--install-skill` sync), install.sh final note.
5. Rebuild, restart server, end-to-end verify, TRDD → complete.

**Decisions (from the investigation, 2026-07-10):**
- Lifecycle event subset ONLY (10): SessionStart, SessionEnd, Stop, StopFailure, PreCompact,
  PostCompact, PermissionRequest, Notification, SubagentStart, SubagentStop.
  Explicitly NOT PreToolUse/PostToolUse/PostToolBatch/PostToolUseFailure/UserPromptSubmit —
  fully redundant with JSONL transcripts + raw OTEL bodies, and they are the only
  high-frequency hooks (2+ process spawns per tool call = all of spyglass's overhead).
- Value ranking: StopFailure (rate-limit turn deaths → window-budget calibration) >
  PreCompact trigger + PostCompact (exact COMPACTION cause for the cache-break classifier) >
  SessionStart/End/Stop (live-session truth + idle-gap measurement) > Permission/Notification
  (idle-on-human explanation) > SubagentStart/Stop (realtime spawn tree).
- spyglass forwarder flaws fixed in the rewrite: python3 -c spawn per fire (server already
  gets hook_event_name in the payload), `echo $!` stdout leak, 3 processes → 1 script + curl.
- Analytics integration (burnMonitor calibration from StopFailure, classifier consuming
  PreCompact) is a FOLLOW-UP once data accumulates — this TRDD ships capture + query.

**Load-bearing facts:**
- spyglass server (:9999) is DOWN; its 28 hook registrations have been dead curls for months.
- Real settings mutations ONLY via safeConfigEdit (scripts/safe_config_edit.py) — set/delete
  ops; hooks arrays must be computed (read → filter/append → set whole `hooks.<Event>` path).
- Hook config changes need a session RESTART to take effect (settings read at session start).
- lean-ctx blocks `python3 -c` and heredocs in MY shell — scripts go to scratchpad files.
- AGENTLENS_CLAUDE_SETTINGS env override exists for testing on a scratch copy first.

## Context

The user ran claude-spyglass (hook → localhost:9999 collector) before AgentLens; its server is
gone but 28 hook registrations remain in ~/.claude/settings.json, burning 3 process spawns per
fire (2× per tool call) for nothing. Investigation (this session) concluded: ~8-10 lifecycle
events carry signals AgentLens genuinely lacks (exact rate-limit turn deaths, compaction
boundaries with trigger, session lifecycle); the tool-call-frequency events are fully redundant
with the JSONL + raw-OTEL-bodies ingestion. User verdict: "do as you think its best. also do
all the improvements needed. you have my full trust."

## Verification

- `curl POST /api/hook-events` with a fake payload → 200; GET returns it; malformed → 400;
  >512KB → 413.
- `echo '<payload>' | bash scripts/spy-agentlens.sh` → event lands; server down → silent, 0.
- `--install-hooks` on a SCRATCH settings copy: 28 spyglass entries removed, SPYGLASS_DIR
  removed, 10 agentlens entries added, janitor hooks untouched, idempotent second run.
  Then the real run.
- `pnpm run check-types` + `pnpm run lint` 0 errors; `node esbuild.js` clean; server restart
  healthy (`agentlens-cli --status` shows hook-events line).
