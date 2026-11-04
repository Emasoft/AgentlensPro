# TRDD-RBBEX59R step (d): the switch stops only collection

Status: 2026-11-04, v1, draft. Not yet reviewed. Owner card: TRDD-RBBEX59R. Every choice below is an agent decision under the owner delegation of 2026-11-03 («do as you think is best. base your decisions on verified facts. consult the advisor.»); the advisor was consulted on 2026-11-04. This spec follows design/specs/TRDD-RBBEX59R-step-c-no-collection-mode.md (c1 landed as 503ad3e0, c2 and B8 as 7ec4b22c..5e1fbf50 on feat/rbbex59r-c2). Paths are relative to the worktree W = builds_dev/rbbex59r-c2 (branch feat/rbbex59r-c2 at 5e1fbf50) unless marked otherwise; line numbers refer to W and must be re-measured before any write (section 5). The input is the code map reports_dev/rbbex59r/20261104_113727+0100-d-code-map.md ("the map", sections 1 to 11, gitignored, this machine only).

## 1. Rationale (one sentence)

The switch stops only the collection of telemetry and raw bodies (and the hook event logging to disk), so no CLI verb, no repair, no move of the operator skills and no status-line capture may be suppressed by it.

Owner directives, verbatim from the card (2026-11-03):

- «the disabled state should never disable the adversarial review hook!»
- «to be clear: the disabled mode should ONLY stop the collection of the telemetry logs and raw bodies! it should not do anything else!»
- «to be precise, it should also stop the event logging of the hooks monitoring the claude code events, except for the statusline hook that collect the realtime data. it should not stop the hook for the adversarial review or other hooks or the rate-limiting guard hooks, for example the hooks alerting or blocking the spawn of more than 5 agents simultaneously. or the others set via the dashboard right panel. these should stay, and only activated or deactivated via the dashboard right panel.»
- «do as you think is best. base your decisions on verified facts. consult the advisor.»
- «write down all those bugs. then fix them.»

Bugs this spec fixes (card numbering): B4 (verb refusals, repair skip, skills move), B9 (review-gate brake), B10 (disable stops the server; superseded by D5, not coded), B11 (status-line capture stops under the switch).

## 2. Decisions (agent decisions under the delegation of 2026-11-03, advisor consulted 2026-11-04)

- D1 Build (d) on feat/rbbex59r-c2 in W, as new commits. This supersedes the card sentence that (d) "was meant to deploy alone". Why: d3 makes the status line always POST to the server and deletes the disk fallback; on the currently deployed CLI a switch-armed machine has no server (the start refusals and the hook revive refusal of the deployed code), so the POST fails and the `--keep-statusline` disk append is the only status-line capture on this machine. Deploying d3 without c1 and c2 would lose status-line capture here. So (d) deploys with c1 and c2, behind the TRDD-12FGMAEP gate. (The statement about the deployed behaviour is inferred; the statuslineCapture.ts code is read.)
- D2 Commit order: d2, then d1, then d3. Why: removing the disabledNotice refusal (d1) while autoSetup.ts:248 (the repair skip) stays would make `agentlenspro --uninstall-hooks` under the switch one command and durable, because nothing would repair the hooks while the switch is armed. That is weaker than today, where the refusal forces lift, uninstall, re-arm. With d2 first (repair runs under the switch, the refusal still stands) every intermediate commit is at least as safe as today.
- D3 `--uninstall-hooks` gets parity with the non-armed state: no switch-specific refusal. Why: the switch no longer changes what protects the review gate. The gate is re-registered by the next launch of a verb outside AUTOSETUP_EXCLUDED_VERBS (autoSetup.ts:54-64), and the review supervisor warns when the gate is not registered (reviewSupervisor.ts:131-138). A new "keep the gate on uninstall" behaviour would be a new feature, not required by the directives. Rewrite the comment at reviewGate.ts:1101-1110 accordingly: the gate ignores the switch because the switch only stops collection; removal is by `--uninstall-hooks`, healed at the next non-excluded launch, with the supervisor warning. Recorded as a weakening against today's armed state (single command), accepted as parity; the owner may reverse it.
- D4 Foreign telemetry keeps parking the skills. Why: owner order 2026-10-02, TRDD-AGZ0XZKW: «if disabled, disable both rules and skills»; the directives of 2026-11-03 are about the operator switch and do not name the foreign case. Only the operator or environment disable stops parking. Implementation: a parameter on disableAgentlensSurfaces (surfaces.ts:51-66); the foreign path (disableForForeignTelemetry, foreignTelemetry.ts:57-59) passes "park", disableCli.ts passes "do not park"; the restore path (enableAgentlensSurfaces, surfaces.ts:72-87) is unchanged. Revisable by the owner; this is the map section 9 item 3 and section 3 hazard B, decided toward the narrower change.
- D5 B10 is superseded, not coded. `disable` stops the server (disableCli.ts:41-52) and does not restart it. The next hook POST or status-line POST that fails fires a detached server revive, and alcoreServeArgs adds `--no-collection` while the switch is armed (serverControl.ts:216), so the server comes back in the mode. After d3 the status line POSTs on every refresh (refreshInterval is 3 seconds in ~/.claude/settings.json on this machine, measured), per session, so the guards are dark for seconds, not until the next hook. The NO_REVIVE brake stays the only way to keep it down. The claim that a failed status-line POST (forwardHookEvent with spool false on STATUSLINE_ENDPOINT) triggers a revive is TO MEASURE (section 5); if it does not, the gap lasts until the next hook event.
- D6 `--keep-statusline` is removed together with its marker file (DISABLED-KEEP-STATUSLINE). runDisableCli keeps ignoring dash arguments as it does today (disableCli.ts:23 filters arguments starting with `-` out of the reason); no rejection is written for one obsolete flag.
- D7 The skills parked on this machine (~/.agentlens/disabled-surfaces/skills, from 2026-10-27) and the inert DISABLED-KEEP-STATUSLINE file are left in place. `enable` restore skips names already live (surfaces.ts:81, `fs.existsSync(to)` then continue), so after repair re-installs a skill the parked copy stays stale; accepted. No cleanup code.
- D8 The OTEL_* environment keys stay installed under the switch. Sending is not collecting, and the server drops OTLP in the mode. Only the raw-body key is held absent (rawBodiesHeldAbsent, unchanged by (d)).
- D9 EXIT.DISABLED (69, cliErrors.ts:29) is deleted with disabledNotice: one version of the code, no legacy. STEP 0 sweep (run 2026-11-04, output reports_dev/rbbex59r/c2-logs/d-exit69-sweep.txt, 142 hit lines): the grep `exit(ed)? ?(code )?69|EXIT\.DISABLED|is DISABLED|== ?69|-eq 69` over ~/.claude/hooks, ~/.claude/plugins/cache, ~/.local/bin, ~/.claude/statusline.py and ~/.claude/settings.json found no hit in ~/.claude/hooks, ~/.local/bin, ~/.claude/statusline.py or ~/.claude/settings.json (all four exist and were searched), and no hit that mentions agentlens, agentlenspro or the switch anywhere. All 142 hits are in ~/.claude/plugins/cache and are unrelated: plugin publish and validation scripts, their tests and reference pages (the string "DISABLED" for a plugin dependency state, "verification is DISABLED", a compaction-point assertion of 690_000) and one minified vendor file (visual-explainer pele.mjs, a parser error text). Verdict: no consumer of agentlenspro exit 69 outside the repo. If a later sweep finds one, it becomes a card note, not an edit outside the repo. Inside the repo the remaining users are src/cli/foreignTelemetry.ts:109, src/test/autoSetup.test.ts, a comment at src/cli/main.ts:268 and the built bundle standalone/cli.js (regenerated by the build, not edited).

## 3. Per-commit change list (order d2, d1, d3; one bounded commit each, verified before the next)

### d2: repair skip, skills parameter, review-gate comment (B4 part 2 and 3, B9 comment)

Files and lines (map sections 2, 3, 4):

- src/cli/autoSetup.ts:248: delete the `if (trigger !== "enable" && agentlensDisabled(...) ...) return null` line with its comment (:241-247); update the header comment (:20-27) and the trigger "server" doc (:64-66, "never arms, lifts or works around the kill-switch"). The foreign callers autoSetup.ts:270 (conflict plus no --force-install-telemetry arms the switch and returns EXIT.CONFIG 78) and its message (:271-272) stay unchanged, because the foreign path keeps parking (D4). Hazard to settle first (section 5, item 2): today a foreign-armed switch falls through the skip for launches but not for trigger "server"; after the deletion a server start under a foreign-armed switch could re-install the skills that were just parked. If measured so, keep a narrowed skip for the foreign case only (killSwitchArmedForForeign true), not for the operator or environment case.
- src/cli/surfaces.ts:51-66: add a parameter to disableAgentlensSurfaces so that the move loop runs only when asked; update the header comment (:1-13). Callers: disableCli.ts:26 passes "do not park"; foreignTelemetry.ts:57-59 (disableForForeignTelemetry) passes "park" and keeps returning the moved count for the two foreign callers autoSetup.ts:270 and setup.ts:1223, which keep parking and keep their messages.
- src/cli/disableCli.ts:74: drop the "N moved to disabled-surfaces" line.
- src/cli/reviewGate.ts:1101-1110: rewrite the comment as in D3. src/cli/reviewLoop.ts:129 is left unchanged (the `--uninstall-hooks` half stays; the "cannot be disabled" wording of the reason is touched only if the line is touched anyway).

Tests (src/test/autoSetup.test.ts; map sections 2 to 4 give the pre-(d) line numbers, re-read each test before editing):

- Change: :430-441 ('disable arms the switch with the reason and moves ONLY the shipped skills') becomes: operator disable arms the flag with the reason and moves nothing; keep the restore test (:445-457) by seeding disabled-surfaces/skills by hand and asserting enableAgentlensSurfaces restores byte-identical. :566-572 ('an operator-armed kill-switch is never repaired around') becomes the inverse (see Add). :594-602 and the second half of :610-631 ('disabled by the env var: nothing is restored') change in the same way for the operator and environment halves; the --force-install-telemetry override assertions stay. :1055-1066 ('a parked surface stays parked across a server start, whoever armed the switch') keeps only the foreign half; the operator half is replaced. :1081 ('nothing parked') is re-read and adjusted.
- Unchanged by D4: :475-490 (no flag plus foreign, skills parked) and :688-722 (enable with foreign present ends DISABLED, skills moved; foreign removed then enable restores).
- Add: armed switch (operator reason) plus a missing skill: a launch restores it (recorder calls include the skill step), OTEL env is written, the raw-body key stays absent; the same for a server start (trigger "server"); armed switch plus the review gate hook missing: the next non-excluded launch re-registers it (the B9 guarantee; reuse recorder(['hooks'])); foreign-armed plus server start: skills stay parked (pins the section 5 item 2 outcome).
- Mutation that must fail the new test: restore the deleted line 248; the new "armed switch, launch restores the skill" test must fail. Second mutation: make the new parameter never park, the retained foreign parking test must fail.

Docs (map section 7): skills/agentlenspro-diagnostics/SKILL.md:57 (the claim that `server` and `daemon` restarts do not self-heal the install is false after this commit, and the map errata 10 says it already looks false today: check against autoSetup.ts:219-233 first); README.md disable paragraph (:182) only for the skills sentence, if any; the `--keep-statusline` text is d3.

### d1: verb refusals (B4 part 1)

Files and lines (map section 1):

- src/cli/foreignTelemetry.ts: delete disabledNotice (:75-109) and DISABLED_PASSTHROUGH (:38); drop imports that become unused (detectTelemetryConflicts, EXIT, killSwitchHalf; fs is still used by recordedReason). Keep HOOK_PATH_VERBS, READ_ONLY_VERBS, isAllAccountsStatus, FOREIGN_REASON, killSwitchArmedForForeign, recordedReason, enableIfForeign and disableForForeignTelemetry. Rewrite the header (:3-9) and the comments (:19-33: "SILENT no-ops", "serverControl has its own terminal DISABLED handling", false since c2).
- src/cli/main.ts: remove the import (:32; keep isAllAccountsStatus) and the call block with its comment (:262-277); fix the `case 'disable'` comment (:321-326).
- src/cli/cliErrors.ts:28-29: delete `DISABLED: 69` and its comment (D9).
- src/cli/diagnosticsCli.ts:33-39: USAGE ("disables its hooks and skills", "Exit 69 = agentlenspro is DISABLED"); skills/agentlenspro-diagnostics/SKILL.md:55-56.
- Verbs that stop being refused under the switch: every verb that is not a hook-path, read-only or passthrough verb, including `--hooks`, `--stop-server`, bare `agentlenspro`, `dashboard`, `--install-*`, `telemetry`, singular `get_account_status` and every diagnostics tool. The telemetry and `--install-otel` paths stay safe because rawBodiesHeldAbsent guards the only collection write (telemetryConfig.ts:125,140).

Tests (src/test/autoSetup.test.ts):

- Delete the suite 'a disabled agentlenspro tells whoever runs it how to reactivate' (:728-777).
- Add ONE test: with the switch armed, a verb that was refused is not refused and runs. The seam: after d1, cliMain(['budget']) runs runBudgetCli and has no seam, so use a tool name that falls to the default case with deps.diagnostics injected (as the singular get_account_status test near :1605-1615 does) and assert that the injected dependency was called and the result is not 69. Also assert `--hooks`, `--stop-server` and the bare launch are not refused.
- Edit: :610-631 (drop the disabledNotice assertions, keep the override and not-mutated assertions), :945-952 (drop the disabledNotice null assertions, keep the spawn-argument assertions), :1335-1348 and :1387-1402 (drop the notice assertions, keep the read-only and no-server assertions), the get_account_status suite :1596-1615 (the singular form is no longer refused: replace the 'stays refused (69)' test with 'singular proxies to the server under the switch'; the --all test stays).
- Check that disabledRawBodies.test.ts already covers telemetry and `--install-otel` under the switch; add one cliMain-level test only if it does not.
- Mutation that must fail the new test: restore the `disabledNotice(argv)` call in main.ts (with the function restored); the not-refused test must fail.
- Order note (map 11): after d1 and d2 `agentlenspro --uninstall-hooks` runs maybeAutoSetup first (re-installing the hooks) and then strips them, and the next non-excluded launch installs them again; hooks present mid-run in a test are not a bug.

Docs: SKILL.md:55-56, diagnosticsCli.ts USAGE, CHANGELOG entry (new entry; the entries at :112 and :118 are history).

### d3: status line always POSTs (B11, D6)

Files and lines (map section 6):

- src/cli/statuslineCapture.ts:146-165 (captureStatusline): delete the `if (agentlensDisabled())` branch; the function always builds the record and POSTs it with forwardHookEvent (path STATUSLINE_ENDPOINT, spool false). Delete appendSampleToDisk (:128-139, comment :124-127, comment :149-151) and the imports that become unused (:43; check flattenSample, dayKey and dataDir use).
- src/cli/killSwitch.ts: delete keepStatuslinePath, keepStatuslineArmed and armKeepStatusline (:46-68), the marker unlink in disarmKillSwitch (:183-191) with its comment (:183-186), the header mention (:12) and the flag body text mention (:158; the killSwitch.test.ts:118-123 assertion on 'agentlenspro enable' must still hold).
- src/cli/disableCli.ts: remove the `--keep-statusline` handling (:27-34), the 'keep: ... status-line capture stays ON' line (:71), the line at :78 and the import (:12). Per D6 dash arguments stay ignored.
- Rust: untouched. statusline_store.rs matches WAL files by pattern (starts_with "wal-" and ends_with ".ndjson", lines 146 and 423 of that file, verified in the map), so a leftover wal-cli.ndjson from before d3 still seals and reads.

Tests:

- Delete src/test/statuslineCapture.test.ts:299-358 (the suite 'disabled with --keep-statusline writes straight to disk').
- Add: armed switch plus a server answering (the fake server the file's other tests use): captureStatusline POSTs the record to STATUSLINE_ENDPOINT; armed switch plus server down: nothing is written to disk and nothing is spooled.
- Mutation that must fail the new test: restore the `if (agentlensDisabled()) return` branch in captureStatusline; the POST test must fail.
- Joint test (opt-in, section 4): one new leg with the armed switch, a status-line POST, and the sample stored by the real no-collection server.

Docs: README.md:182 (disable paragraph), skills/agentlenspro-diagnostics/references/operations.md:80-95 (:84 keep-statusline), SKILL.md:55-57, references/budget.md:121 (table row), CHANGELOG new entry (no version bump unless asked). README.md:336 (foreign case) stays accurate under D4.

## 4. Verification

Per commit, in W, never in the npm-linked main tree:

- `pnpm run check-types`
- `npx eslint <the files the commit touched> --quiet`
- `pnpm run compile-tests && npx mocha` on the targeted files: out/test/test/autoSetup.test.js, statuslineCapture.test.js, killSwitch.test.js, disabledRawBodies.test.js, noCollectionEnable.test.js, cliDispatch.test.js, tsRepairBrake.test.js (map section 8 list).
- The commit's mutation (section 3), shown red, then restored and green.

Once, after d3: the full `pnpm run test:unit` under `nice -n 15`, only when the one-minute value of `sysctl -n vm.loadavg` is below 20 (it was 47.88 at the time of writing, so not yet). Baseline on the card: 3377 passing, 27 pending, 0 failing; deleted tests lower the count, so report the delta. Then the opt-in joint test `AGENTLENS_RBBEX59R_JOINT=1 npx mocha out/test/test/noCollectionJoint.test.js` (needs the alcore in W's bin-native, codesigned with `codesign -s - --force`), with the new leg (armed switch, status-line POST stored by the no-collection server). Builds (`node esbuild.js`, `pnpm run compile`) only in W, because a build in the main tree is a live deploy to every session. Docs sweep at the end: `grep -rn "exit 69\|EXIT.DISABLED\|keep-statusline\|disabled-surfaces\|uninstall-hooks.*refused"` over src, README.md, CHANGELOG.md and skills in W (the CHANGELOG history entries stay).

## 5. TO MEASURE before any write (load-bearing lines; W = /Volumes/EmaUITEK4TBSSD/Code/AgentlensPro/builds_dev/rbbex59r-c2)

Each item: the claim, then the command.

1. disabledNotice has one call site (main.ts:271) and one definition (foreignTelemetry.ts:80-109): `grep -rn "disabledNotice" W/src W/standalone/cli.ts` (code), and `tldr body W/src/cli/foreignTelemetry.ts --from 75 --to 110 -f text`. Also `grep -rn "EXIT.DISABLED" W/src` (expected: foreignTelemetry.ts:109 and src/test/autoSetup.test.ts only).
2. autoSetup.ts:248 text and the foreign-case behaviour: `tldr body W/src/cli/autoSetup.ts --from 190 --to 290 -f text`. Settle: with line 248 deleted, does trigger "server" under a foreign-armed switch re-install parked skills (the foreign path returns before repair only for launches)? Decides whether a narrowed foreign-only skip stays.
3. surfaces.ts:51-66 and its callers: `tldr body W/src/cli/surfaces.ts --from 1 --to 100 -f text`, `grep -rn "disableAgentlensSurfaces\|disableForForeignTelemetry" W/src`.
4. statuslineCapture.ts:146-165: `tldr body W/src/cli/statuslineCapture.ts --from 120 --to 170 -f text`.
5. killSwitch.ts:46-68 and :183-191: `tldr body W/src/cli/killSwitch.ts --from 40 --to 70 -f text` and `tldr body W/src/cli/killSwitch.ts --from 150 --to 195 -f text`.
6. reviewGate.ts:1101-1110: `tldr body W/src/cli/reviewGate.ts --from 1090 --to 1130 -f text`.
7. Whether forwardHookEvent with spool false on STATUSLINE_ENDPOINT triggers a revive on failure (D5): `tldr body W/src/cli/hookHandlers.ts --from 330 --to 370 -f text` (the revive gates, read in part) and `tldr body W/src/cli/hookHandlers.ts --from 415 --to 480 -f text` (forwardHookEvent); `grep -n "STATUSLINE_ENDPOINT" -r W/src` (defined at statuslineCapture.ts:72, used at :158).
8. cliErrors.ts DISABLED users: `grep -rn "DISABLED" W/src/cli/cliErrors.ts W/src/cli/foreignTelemetry.ts W/src/cli/main.ts` (the cacheBreakTimeline.ts hit is the word CACHING_DISABLED, unrelated).
9. Refresh interval claim in D5: `grep -o '"refreshInterval"[^,}]*' ~/.claude/settings.json` (measured 2026-11-04: 3).

## 6. Hazards and not in (d)

Remaining from the map, section 9:

- cache-state and cache-expired stay dark under the switch until d3 is deployed; last-compact stays dark until (e) (B6: PreCompact is not on disk under the switch).
- Foreign telemetry still blocks launches with exit 78 (autoSetup.ts:262-277, not disabledNotice) and still parks the skills (D4); whether it should is an owner decision.
- (d) cannot deploy alone (D1): deploy c1, c2, B8 and (d) together, behind the TRDD-12FGMAEP gate (whole-process memory backstop landed or owner waiver) and the owner's answer on deploying on this machine. Merge with --no-ff, no rebase, so the SHAs recorded on the card stay valid. Any build in the main tree is a live deploy.
- After d3 the status line POSTs every 3 seconds per session; with the server down every POST fails, and revive is gated by the revive lock, NO_REVIVE and the backoff (hookHandlers.ts:344-363): no new spawn storm is expected, but this is unmeasured under that load.
- A repair under the switch re-writes the OTEL_* keys (D8): Claude Code keeps exporting to 4318 and the server drops it.
- `--uninstall-hooks` under the switch becomes a single command (D3); the gate comes back at the next non-excluded launch, and a session that runs no further CLI verb does not heal (whether a live Claude Code session re-reads the hooks in settings.json is not verified).
- Stale parked skills after `enable` (D7).

Not in (d): the disable-time restart of the server (B10, D5), (e) (last-compact exits 2 when its newest record predates the switch file mtime), whether foreign telemetry should still block verbs, the TypeScript rebuild and deploy (deploy gate TRDD-12FGMAEP), the B8 follow-up notes on the card.
