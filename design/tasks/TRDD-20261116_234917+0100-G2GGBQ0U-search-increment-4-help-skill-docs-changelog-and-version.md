---
trdd-id: G2GGBQ0U
title: search - increment 4 help skill docs changelog and version
column: backburner
status: tasked
created: 2026-11-16T23:49:17+0100
updated: 2026-11-17T01:14:52+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-16T23:49:17+0100
---

# search - increment 4 help skill docs changelog and version

Increment 4 of 4 of the owner's 2026-11-16 search request (quoted in full on TRDD-UIQS9RXZ). Needs increments 1 to 3.

## Plan
1. `SEARCH_USAGE` in src/cli/searchCli.ts lists every flag with one line each and three worked examples (find an error across the project; what did a subagent report; when did the model change).
2. The `agentlenspro-diagnostics` skill (skills/ in this repo) gains a short section: use `agentlenspro search` instead of reading transcripts; ids in examples must be visibly fake.
3. CLAUDE.md, CLI block: one entry for `agentlenspro search`, citing the measurement report.
4. A final report `reports/search/<timestamp>-project-wide-search.md` with the measured timings from the three cards (note: `/reports/` is gitignored in this repo, TRDD-G4DDKLZ9).
5. `src/cli/foreignTelemetry.ts` READ_ONLY_VERBS and the verb lists in src/cli/main.ts: confirm `search` is classed as a read-only investigation verb.
6. CHANGELOG.md entry and a minor version bump in package.json, in the same change.
7. `pnpm run compile` (check-types, lint, the guards, bundle). The release itself (tag and push) is the owner's act.

## Acceptance
- [ ] `agentlenspro search --help` shows every flag that exists and no flag that does not (a test compares the usage text with the KNOWN set).
- [ ] Skill, CLAUDE.md, CHANGELOG and version updated; `pnpm run check-identities` clean.
- [ ] `pnpm run compile` exit 0.
- [ ] After `node esbuild.js`, the bare command `agentlenspro search <pattern>` run in this project returns hits (which install the bare command resolves to is checked first).

## Approval log

- 2026-11-16T23:49:17+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

- 2026-11-16 23:53 — Item 5 corrected: 'search' is in the verb lists of src/cli/main.ts (lines 120, 173) but NOT in READ_ONLY_VERBS of src/cli/foreignTelemetry.ts (measured by the harness). This increment must read what READ_ONLY_VERBS gates and DECIDE whether search belongs in it, with the reason recorded.
- 2026-11-17 01:14 — DECIDED (main agent, in the owner's stead): search joins READ_ONLY_VERBS in src/cli/foreignTelemetry.ts (line 41). FACTS: search reads transcript files off disk, needs no server and writes nothing (src/cli/searchCli.ts, read whole); today it is refused while the kill switch is on (gate at foreignTelemetry.ts line 89), and the switch has been on since 2026-10-27, so no agent on this machine can use it. Owner directive of 2026-10-29 quoted in that file: a read must never be blocked by the off-switch brake. To do in this card: add the verb, a test that search passes the gate while DISABLED, then node esbuild.js and one end-to-end run of the bundle (never done so far). Also carried here from TRDD-UIQS9RXZ: a memory limit below 2GB with 4 threads is unmeasured.
