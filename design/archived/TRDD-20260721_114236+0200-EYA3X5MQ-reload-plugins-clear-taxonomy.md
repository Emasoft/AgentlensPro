---
trdd-id: EYA3X5MQ
title: Add /reload-plugins + /clear to the diagnostic taxonomy (CLI + dashboard) + a reload-cost command
column: completed
created: 2026-07-21T11:42:36+0200
updated: 2026-08-18T12:45:00+0200
current-owner: main
task-type: feature
scope: project
implementation-commits: [c6a2a1a, 4429c34, 7231f63, a0cbdbd, 39be84e, 6ceb574]
relevant-rules: []
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-21

**Goal:** name `/reload-plugins` (the machine's #1 cache-break cost, ~$235: skill catalog
$154.65/315× + agent catalog $80.63/124×, today mislabeled generic) and `/clear` (the
floor-reset remedy) in the diagnostic taxonomy; surface both in CLI + dashboard; add a
`reload-cost` CLI shortcut (tool `get_plugin_reload_costs`) listing recent reloads with
cache-write tokens + $; add a full lifecycle-events view (CLI + dashboard) from the hook store.

**Plan file:** `~/.claude/plans/swift-riding-otter.md` (approved).

**NEXT ACTION:** none — P7 (exact transcript detection) is shipped + deploy-verified. Only the ship
decision remains USER-gated: the commits are unpushed on local main (leave-local stands).

**P7 — EXACT detection from the transcript (2026-07-21, USER-directed).** The USER pointed out that
the JSONL records the command itself; it does, and that supersedes the "co-churn is the only path"
conclusion. Claude Code persists every built-in command as a `type:"user"` entry holding an
ANCHORED `<command-name>` block. `src/cacheRiskCommands.ts` reads it: 1453 events over 12,642
transcripts in 5.0s — 613 /reload-plugins, 507 /compact, 125 /model, 97 /login, 62 /plugin,
32 /clear, 16 /reload-skills, 1 /mcp. New causes SKILLS_RELOADED / PLUGIN_CHANGED /
ACCOUNT_SWITCHED; new `CacheBreakTurn.tsMs` joins a command to the turn that paid for it (first
turn at or after T). `reload-cost` → tool `get_cache_risk_costs`: PLUGINS_RELOADED $227.87 ·
MODEL_SWITCHED $52.06 · COMPACTION $51.86 · ACCOUNT_SWITCHED $38.41 · PLUGIN_CHANGED $14.73 ·
CLEAR $4.49 · SKILLS_RELOADED $0.12 (22 sessions analysed; byKind reconciles to the totals exactly).
Dashboard: "Cache-breaking commands" in the Lifecycle tab + `GET /api/cache-risk-commands`.
Commits: 0ce0098, 724035f, 6f00c65, 743394b, 55f4075.

**Three correctness rules P7 had to learn the hard way (all measured, all now pinned by tests):**
1. **ANCHOR the match.** Loose 687 vs anchored 613 — 11% of "reloads" were prose QUOTING the tag,
   including this feature's own notes.
2. **ONE turn, ONE charge.** Two /login 18s apart billed the same turn twice until fixed; verified
   0 double-charged turns after.
3. **Never let a cap read as a total.** The dashboard rendered "300 commands" — exactly the cap —
   hiding 73; it now says "showing 300 of 373", and per-kind chips are computed over the full window.
Plus one deletion: NO catalog-size field. `Reloaded: 34 plugins · …` is printed to the live
conversation but is NOT on disk (14 records machine-wide contain it, none a command entry).

**P3 EXPERIMENT CLOSED — REFUTED (2026-07-21 13:04):** `/reload-plugins` does **NOT** fire
`ConfigChange`. Method: USER ran `agentlenspro --install-hooks` (ConfigChange registered in
`~/.claude/settings.json`, all 12 pre-existing hook events preserved — safeConfigEdit clean),
restarted Claude, ran `/reload-plugins` (34 plugins · 117 skills · 75 agents · 27 hooks). Result:
the reload emitted **zero** hook events of any kind, and a full scan of the store (13 files,
**40,858 records**) finds `ev == ConfigChange` **0 times, ever**. Controls: the newest record
post-dates the reload (capture alive, not a write gap); the ingest has NO event allowlist
(`hookEventStore.ts:34` stores `hook_event_name` verbatim), so a fired event could not have been
dropped; the 16 `grep ConfigChange` hits are the assistant's own text inside
`last_assistant_message` payloads, not events. The ConfigChange registration STAYS — a mid-session
config change is itself a real cache-break cause worth timestamping — but its comment in
`src/cli/hookInstall.ts` was corrected from "CANDIDATE reload signal" to the refutation, so no
future session re-runs this experiment.

**SUPERSEDED by P7 — "co-churn is the ONLY detection path" was WRONG.** That conclusion, written
here and in two other places on 2026-07-21, held only for the HOOK layer. The USER pointed out the
obvious third source: the JSONL transcript records the command itself. See P7.

**P5/P6 DONE:** Lifecycle dashboard tab + `/api/lifecycle-events`; PLUGINS_RELOADED label
auto-renders in Cache/Traces (shared CAUSE_LABEL — 'Plugins reloaded' verified in dashboard.js).
Default lifecycle view excludes STOP + SESSION_END noise → surfaces boundaries. Commit 6ceb574.
Deploy: esbuild + server restart, symbol-grep confirms all new symbols shipped; screenshots in
`reports/screenshots/lifecycle-tab-*.png`. All gates green, suite 1395.

**DONE:**
- Deliverable 0 — extended USER hooks reference `claude-code-hook-types` (full ~30-event catalog +
  no-plugin-reload-hook fact); cross-linked from `hook-events-pipeline`. Commit c6a2a1a.
- P1 — PLUGINS_RELOADED in both taxonomies + confidence + co-churn. Commit 4429c34.
- P2 — `src/lifecycleEvents.ts` pure model (/clear + siblings; ConfigChange pre-wired). Commit 7231f63.
- P3 — ConfigChange added to HOOK_EVENTS capture list (empirical confirm pending install+restart).
  Commit a0cbdbd.
- P4 — `reload-cost` (alias→get_plugin_reload_costs, COMPOSITION path) + get_lifecycle_events. LIVE-
  VERIFIED: 102 reloads/$9.19; /clear detected (this session, 10:19:36). Precision guard (reload =
  re-registration of EXISTING catalogs) dropped 197/$145 false-positive over-count → 102/$9.19.
  Commit 39be84e. Full suite 1394 green.

**Load-bearing facts (verified):**
- Timing: `/reload-plugins` is a local command (no API call); the changed catalog rides the
  stable prefix of the NEXT model turn → billed as that turn's `cache_creation`. One occurrence
  = one reload. The classifier already attributes a turn's cache_creation to its first divergent
  prefix element.
- Detection, in order of trust: (1) **the TRANSCRIPT** — Claude Code persists every built-in
  command it runs as an anchored `<command-name>` entry, so /reload-plugins, /reload-skills, a
  mutating /plugin, /login|/logout, /mcp and /model are EXACT, timestamped and retroactive
  (`src/cacheRiskCommands.ts`, P7); (2) co-churn inference, kept only as a labeled residue for
  turns no command explains (it over-counts). NO hook sees any of this: there is no plugin-reload
  hook, built-ins don't fire `UserPromptSubmit`, and `ConfigChange` is REFUTED (P3 above).
  `/clear` = `SessionStart{clear}` (also captured by the hook store). Full hooks reference: USER
  memory `[[claude-code-hook-types]]`.
- Two live taxonomies both need the cause: `src/shared/cacheBreak.ts` (P4, drives
  `get_cache_break_report` + dashboard `CAUSE_LABEL`) and `src/cacheBreakTimeline.ts` (drives
  `get_cache_break_timeline`). `cacheBreak.ts` has an UNUSED `PLUGIN_TOGGLE` enum value — repurpose.
- Deploy law: change ships only after `node esbuild.js` SUCCEEDS + `agentlenspro server restart`
  + symbol-grep the rebuilt bundle. Gates: check-types ×2 + lint + check-mirrors + mocha.
  `media/src/` must re-export shared symbols, never re-declare (check-mirrors).

**Phases:** P1 taxonomy+co-churn · P2 lifecycle model (`/clear`) · P3 ConfigChange hook (empirical
test) · P4 CLI (`get_plugin_reload_costs` + `reload-cost` + `get_lifecycle_events`) · P5 dashboard
(cause label + lifecycle view) · P6 deploy+verify+screenshots.

**SUPERSEDED — do NOT carry forward:** (none yet).

## Context

See the approved plan file for the full rationale, investigation findings, and phase detail.
This TRDD tracks execution; the plan is the design of record.

## Approval log

- 2026-07-21 — USER approved the plan (ExitPlanMode) after review of scope, detection design,
  and the three clarifying decisions (command name `reload-cost`; add a hook for detection;
  full lifecycle-events view for `/clear`).
- 2026-08-18T12:45:00+0200 — ARCHIVED by USER batch directive ("complete all TRDD"); validity re-verified: src/mcpServer.ts:1122 exports `get_cache_risk_costs` (CLI alias `reload-cost`) and src/cacheRiskCommands.ts exists.

## Notes and lessons learned
