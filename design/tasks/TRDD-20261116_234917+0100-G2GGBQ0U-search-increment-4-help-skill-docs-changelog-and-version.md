---
trdd-id: G2GGBQ0U
title: search - increment 4 help skill docs changelog and version
column: dev
status: tasked
created: 2026-11-16T23:49:17+0100
updated: 2026-11-17T12:14:46+0100
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
- 2026-11-17T11:58:57+0100 — column → todo by main-agent@agentlenspro. increments 1 to 3 and the three follow-ups are landed; dispatched
- 2026-11-17T11:58:59+0100 — column → dev by main-agent@agentlenspro. increments 1 to 3 and the three follow-ups are landed; dispatched

## Notes

- 2026-11-16 23:53 — Item 5 corrected: 'search' is in the verb lists of src/cli/main.ts (lines 120, 173) but NOT in READ_ONLY_VERBS of src/cli/foreignTelemetry.ts (measured by the harness). This increment must read what READ_ONLY_VERBS gates and DECIDE whether search belongs in it, with the reason recorded.
- 2026-11-17 01:14 — DECIDED (main agent, in the owner's stead): search joins READ_ONLY_VERBS in src/cli/foreignTelemetry.ts (line 41). FACTS: search reads transcript files off disk, needs no server and writes nothing (src/cli/searchCli.ts, read whole); today it is refused while the kill switch is on (gate at foreignTelemetry.ts line 89), and the switch has been on since 2026-10-27, so no agent on this machine can use it. Owner directive of 2026-10-29 quoted in that file: a read must never be blocked by the off-switch brake. To do in this card: add the verb, a test that search passes the gate while DISABLED, then node esbuild.js and one end-to-end run of the bundle (never done so far). Also carried here from TRDD-UIQS9RXZ: a memory limit below 2GB with 4 threads is unmeasured.
- 2026-11-17 01:18 — CORRECTION: the line above is a PROPOSAL FOR THE OWNER, not a decision. Every verb now in READ_ONLY_VERBS is there by a recorded owner decision, and the kill switch is the owner's. READ, all consumers (grep over src and standalone/cli.ts): foreignTelemetry.ts line 89 (the DISABLED gate) and autoSetup.ts line 55 (AUTOSETUP_EXCLUDED_VERBS, read by maybeAutoSetup at line 192), so adding search would do two things: let it run while disabled, and stop it from running the launch self-heal (it would never write settings, hooks or skills, nor start a server). main.ts lines 104 and 148 and the disk files only mention the set in comments (comments read through grep, the code around main.ts 104 and 148 not read). Nothing is built until the owner says yes.
- 2026-11-17 01:20 — CORRECTION of 'every verb in READ_ONLY_VERBS is there by a recorded owner decision'. READ in the doc comment at foreignTelemetry.ts lines 28 to 40: only the four disk verbs are named as owner decisions (2026-11-16); cache-expired is there by a card fix (TRDD-CS2W7E77); for cache-state, last-compact, model-headroom and statusline-history that comment names no decision. READ in src/cli/main.ts: lines 100 to 109 are a table of time ceilings for polled verbs (cache-expired, cache-state, last-compact at 1,500 ms), and its comment says a test (autoSetup.test.ts) requires every key of that table to be in AUTOSETUP_EXCLUDED_VERBS; lines 144 to 152 are a table of reasons for verbs that carry no ceiling. The requirement runs from the ceiling table to the excluded set, not back, so adding search to the set needs no ceiling by that comment; whether search needs a line in the reasons table was not checked (the test file was not read). The proposal for the owner stands as a proposal.

## Notes and lessons learned

- 2026-11-17 11:44+0100, main agent, from the harness review of the turn that closed TRDD-O3U0K4HY. THE --fuzzy HELP GETS A COST SENTENCE in this increment. The gate rule on TRDD-O3U0K4HY was: over 15 s in either mode means a scope sentence in the --fuzzy help. It passed on 3.20 s and 3.91 s (whole command, default mode, 20 shown, pattern `permission denied`, 2,277 hits, 1 minute load 11 to 12). Later runs of the same command on the same build crossed it: 16.48 s at load 30 to 71, then 31.76, 34.30 and 41.96 s at 1 minute load 54 to 148 (reports_dev/O3U0K4HY/main-gate/settle-fuzzy-vs-plain.txt, frozen build builds_dev/o3u-out-7fe63866). The plain search of the same pattern, run in alternation, took 25.24, 29.88 and 29.60 s, so the wall time is the shared host, not the fuzzy mode: user CPU is 13.65 to 14.69 s plain against 18.58 to 18.72 s fuzzy in those six runs, a ratio of about 1.3 (the 11:06 fuzzy runs used 9.20 and 10.98 s of user CPU; why the CPU time itself doubles under load was not examined). The rule as written uses whole-command wall time and it tripped, so the sentence is owed. Text to state: --fuzzy costs about 1.3 times the CPU of a plain search (measured on a 2,972 MB project), with no promise of seconds.
- 2026-11-17 11:58+0100, main agent. DISPATCHED to one worker, with two changes to the plan, decided by the main agent: (1) plan item 6, no version bump in this card: TRDD-HSPUF5XH says the bump and the publish wait until every open card is terminal, so the CHANGELOG entry goes under the existing Unreleased heading and package.json stays at 2.34.0. This departs from the CLAUDE.md convention (bump in the same change), which that card overrides until the release. (2) plan item 5 is NOT built: adding search to READ_ONLY_VERBS stays a proposal for the owner (notes of 2026-11-17 01:18 and 01:20 above). Consequence for the last acceptance box: while the kill switch is on, the bare command may be refused; the worker is told to copy the refusal verbatim and stop, and never to touch the switch. The search follow-ups TRDD-6DRB39PR, TRDD-RSV3UEJ9 and TRDD-WC4VBIMX landed first (e343ec69), so the help describes the fixed behaviour.
- 2026-11-17 12:03+0100, main agent, after the harness review. (1) The no-bump decision was first written from the TITLE of TRDD-HSPUF5XH only (a lookup printed another card's row). Now read on that card: its front matter, STATE head, the owner's order and the release steps (not all 291 lines). The owner's order of 2026-09-03, verbatim: 'just bump and publish a new version. but do that only after you completed all TRDDs and fixed all issues.' Its STATE says the gates run before touching version or tag, and its release step 1 puts the bump and the CHANGELOG entry in the same commit. So the bump waits; the decision stands. (2) The worker brief lists six files to edit and also orders pnpm run compile. Checked: standalone/cli.js and media/dashboard.js are gitignored, so the bundle step changes no tracked file. The bare command agentlenspro resolves to this repository's standalone/cli.js (a link), so a successful bundle step DEPLOYS the CLI on this machine at once: every agentlenspro verb then runs the new bundle. The collector is stopped and is not restarted by this.
- 2026-11-17 12:14+0100, main agent. KNOWN DANGLING CITATION, kept on purpose: the CLAUDE.md entry for agentlenspro search cites a report under reports/search/, and /reports/ is gitignored in this repository, so the path exists on this machine only. This follows the file's own rule (doctrine cites a report under reports/) and its neighbours, all of which dangle the same way; the fix belongs to TRDD-G4DDKLZ9. The citation is removed from the CHANGELOG. These instructions were SENT to the worker at 12:11 (queued for its next tool round); whether they were applied is checked at handback, not assumed.
