---
name: hook-events-pipeline
description: "how does AgentLens capture Claude Code lifecycle events / where do StopFailure PreCompact SessionStart events come from / what is spy-agentlens.sh / hook-events store, --install-hooks, why not PreToolUse / Stop hook error every turn"
ocd: 2026-07-10
lmd: 2026-07-21
metadata:
  node_type: memory
  type: project
  tier: component
---

AgentLens captures Claude Code **lifecycle hook events** (TRDD-Q6ZOUVK5, commit c923f85):
`scripts/spy-agentlens.sh` (one fire-and-forget curl, always exit 0, no stdout) is registered
by `agentlenspro-cli --install-hooks` (bin renamed at the AgentlensPro fork; was `agentlens-cli`) on 11 lifecycle events — SessionStart/End, Stop,
StopFailure, Pre/PostCompact, PermissionRequest, Notification, SubagentStart/Stop, and
**ConfigChange** (TRDD-EYA3X5MQ — a `skills`-sourced ConfigChange is the candidate hook signal
for a `/reload-plugins`; `src/lifecycleEvents.ts` maps it, `isReloadConfigChange` tags it) — and POSTs
the raw payload to `POST /api/hook-events`. `src/hookEventStore.ts` persists them as
append-only NDJSON daily buckets in `~/.agentlens/hook-events/` (31d retention); query via
`GET /api/hook-events?session=&ev=&since=&until=&limit=`.

**Why:** these events carry signals the JSONL transcripts and raw OTEL bodies LACK — exact
rate-limit turn deaths (StopFailure), compaction boundaries + trigger (PreCompact), true
session lifecycle. Consumption into burnMonitor (measured window ceiling) and the cache-break
classifier (COMPACTION with `evidence: hook`) is planned in TRDD-8ENYLEIO.

**Deliberately NOT hooked unmatched: PreToolUse/PostToolUse/UserPromptSubmit** — fully
redundant with existing ingestion, and per-tool-call hooks are where all overhead and all
cache-break damage lives (additionalContext reminders get stripped in place mid-transcript →
prefix re-bill; that mechanism measured at ≈44% of cache-break waste, see the CHANGELOG 0.9.0
context).[^1] **The ONE narrow exception (TRDD-GOD0108C, 0.10.0): the burn-gate** —
`scripts/spy-agentlens-gate.sh` on PreToolUse/PostToolUse **matched to `^(Task|Agent|Workflow)$`
only** (agent launches are rare). SYNC (async hooks cannot deny), 3s timeout, one curl to
`POST /api/agent-gate` (decision p50 0.9ms, end-to-end 14ms), fail-open on any error,
`AGENTLENS_GATE=off` kill-switch, `AGENTLENS_GATE_MODE=warn` downgrade. It denies the four
measured disaster launches (THRASH_ACTIVE / RUNAWAY_FANOUT / COLD_RESUME_FANOUT /
FORK_STORM_FORMING) with the reason fed back to the model; PostToolUse injects ONE deduped
additionalContext advisory per session+risk per 10min. See [[burn-gate]] docs in the skill.

**Why:** capture is optional — every future consumer must degrade to inference when the store
is empty and label which evidence it used.

**How to apply:** install/replace via `--install-hooks` ONLY (safeConfigEdit transaction;
preserves other tools' hooks; removes dead claude-spyglass entries); never hand-edit
settings.json. Hook config changes need a session restart.

**See also** the general Claude Code hook-event catalog (all ~30 events, payloads, matcher
support, I/O schema, and the "no plugin-reload hook / detect via ConfigChange-or-inference"
fact): USER-scope reference `[[claude-code-hook-types]]`.

**See also** `[[cache-risk-command-detection]]` — the OTHER capture path. Some events arrive by
BOTH routes (`/clear` is `SessionStart{source:clear}` here and a `<command-name>` transcript entry
there), but the prefix-breaking commands (`/reload-plugins`, `/reload-skills`, `/plugin`, `/login`)
reach NO hook at all and are visible only in the transcript. `ConfigChange` is registered by
`--install-hooks` because a mid-session config change is itself a real cache-break cause — NOT
because it detects a plugin reload; that hypothesis was measured and refuted 2026-07-21.

See also: [[image-resident-cost-guard]] (the PreToolUse consumer that put `Read` — the first
non-rare tool — into `GATE_MATCHER`, and how its per-call cost is bounded CLI-side).

## Notes and lessons learned
[^1]: [ocd:2026-07-10 lmd:2026-07-10] Two field lessons from shipping this. (a) The
  bucket-name regex \d{4}-\d{2}-\d{2} also matches calendar-invalid names ('2026-13-99' →
  NaN, '2026-02-31' overflows): NaN silently defeated BOTH the read fast-path and the
  string-compare purge — an unpurgeable file counted forever. Fixed with bucketDayMs()
  round-trip validation (a5b3519); parse dates once, validate by round-trip, compare
  numerically. (b) AgentLens's own pending-prompt Stop hook '[ -f "$f" ] && cat …' exited 1
  on every turn with no pending file → a "Stop hook error" banner every turn (a073e3d). A
  hook's happy path must be exit 0: absent-optional-input is the NORMAL case, not an error.
