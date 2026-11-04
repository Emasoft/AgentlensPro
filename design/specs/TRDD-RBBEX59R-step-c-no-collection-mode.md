# TRDD-RBBEX59R step (c): no-collection mode

Status: 2026-11-04. The round-2 proposal was reviewed in two rounds of MEASURE and REVIEW forks; this spec adds the round-2 folds, reviewed separately (review of the spec and TRDD-PB9ZEN46), whose fixes are applied here. Owner card: TRDD-RBBEX59R. Every choice below is an agent decision under the owner delegation of 2026-11-03 («do as you think is best. base your decisions on verified facts. consult the advisor.»); the advisor was consulted before round 1, between the rounds, and after round 2. Rust paths are relative to rust-core/crates/agentlens-core/; TS paths to the repo root.

## Rationale (one sentence)

Under the off switch, `agentlenspro hook` and `agentlenspro gate` must keep feeding and running the guards against a server that runs but stores no telemetry, no raw bodies and no hook-event log.

## Measured facts it rests on

- src/cli/hookHandlers.ts:497 returns 0 under the switch, before the hook and gate split: today the gate allows everything and the in-memory hook ring gets nothing.
- Five refusals keep the server down under the switch: src/cli/serverControl.ts:295 (ensureServer), :916 (runSupervise), :1139 (the server revive verb), src/cli/setup.ts:1397, and the hook revive: reviveDisabledOnDisk() (src/cli/hookHandlers.ts:100-106), checked at :363 and also used by src/cli/storeAdmin.ts:156 as the precondition that no revive can happen during a store rewrite.
- alcore exits 78 when <data>/DISABLED exists (src/bin/alcore.rs:217-225) and 64 on an unknown argument (usage(), :96); the supervisor respawns a 64 with backoff. alcore has no default data dir; alcoreServeArgs (src/cli/serverControl.ts:197-212) always passes --data-dir from its own dir parameter, default dataDir().
- The supervisor calls alcoreServeArgs() inside start(), and every respawn calls start() again (src/cli/serverControl.ts:935-1015), so its arguments are recomputed on every spawn.
- Under the armed switch on this machine the OTEL exporter keys stay in settings.json; only OTEL_LOG_RAW_API_BODIES is absent.
- The gate counts SubagentStart from the ring only within 60 s or 2 min of each event ts (src/burn/agent_gate.rs:700-780). RUNAWAY_FANOUT fires at starts60 >= 8 (:391), after THRASH_ACTIVE and before FANOUT_HEADSUP; it denies only a non-fork agent (fork means subagent_type exactly "fork", :318), and only in enforce mode. Lines :325-340 and the tool-name filter were not read.
- `agentlenspro gate` writes the server body verbatim and always exits 0. A deny is {"hookSpecificOutput":{"permissionDecision":"deny",...},"systemMessage":"[agentlens burn-gate] blocked an agent launch (<CODE>). ..."}.
- The only writer of the NO_REVIVE brake is `agentlenspro server stop --stay-down` (src/cli/serverControl.ts:1101); :1057 removes it; the disable verb never writes it. Evidence: grep of noRevivePath, NO_REVIVE_FILE and NO_REVIVE over every src/**/*.ts, tests excluded. No NO_REVIVE file exists on this machine.
- The DISABLED file on this machine was armed 2026-10-27T11:35Z and records no reason.

## c1 — Rust (one commit on fix/setup-agent-preflight)

1. A no_collection flag on CoreState, set once at boot from --no-collection OR from <data-dir>/DISABLED. Boot no longer exits 78 for DISABLED. A restart is the only transition. The file read is a backstop for an alcore started outside the CLI; the CLI flag is the authoritative input.
2. One --no-collection arm in the argument loop (src/bin/alcore.rs:103-185) and in the usage() text.
3. OTLP: in the mode, handle (src/lib.rs:1302-1369) checks the mode right after the body read and returns the empty 200 before parse_payload (:1345), the tap (:1352) and ingest. Port 4318 stays bound (D1).
4. bodies_pass (fn at src/chores.rs:525) returns early in the mode; that covers the boot call (:1439), the 60 s timer (:1490) and the only tap.body call (:774). The burn-tick body scan (src/ui.rs:4445-4448) is untouched: it reads files as a guard input.
5. ingest_hook_event (src/hook_events.rs:244-327): validation and the status-line bridge stay first and unchanged. Then:
   - write path (mode off AND captureEnabled true): as today. Append (:275); on Ok: tap.hook, ring push, persist counters (hook_event_writes and bytes), the accepted counter, P5; on Err: 500 and nothing else, so a later spool replay cannot double-count.
   - ring-only path (mode on, OR capture off): ring push, the accepted counter, P5, then 200 {"ok":true,"dropped":"<reason>"}. No disk write, no tap, no persist counters.
   - D4: hookEvents.receivedSinceBoot in /api/server-stats is redefined as accepted events (both paths); the write count stays in persistence.hookEventWrites (src/server_stats.rs:549). One meaning per field; this also ends the self-test failure today seen with capture off.
   - Beyond the rationale, by the card decision to put B7 in (c): the ring-only path also applies in normal mode with capture off.
6. The spool drain runs only under the write-path condition, checked on every tick at both callers (src/chores.rs:1420-1427 at boot, :1639-1649 every 30 s). Needed because drain_hook_spool keeps proof-None files without unlinking them (src/hook_events.rs:360-425), so the ring-only path would re-ring them every tick with ts set to now.
7. capture_down_since (src/server_stats.rs:409-419) returns None in the mode (status-line samples keep activity true while no bodies arrive).
8. /api/server-stats gets a top-level collection: "on" | "off". Consumers: the c2 enable restart, the setup self-test, the tests.
9. Stale comments: src/bin/alcore.rs:205-216 and :245-247; src/chores.rs:536-539.
10. Tests, each with a mutation run whose output is recorded in the report:
    - tests/disabled_refuses_boot.rs becomes a spawned no-collection boot test (free_ports, temp dirs, --no-log-scan): with the DISABLED file, and separately with --no-collection and no file, it boots and collection reads "off"; an OTLP POST gets 200 and writes no span and no log-event; a SubagentStart hook POST gets 200 dropped, receivedSinceBoot rises by 1 and no hook-events file appears; a status-line POST is stored; captureDownSince is absent. Each absence assertion sits beside a positive one (collection "off", receivedSinceBoot +1) so the test fails when the read path is broken.
    - an in-process CoreState test: the ring and P5 in the mode and with capture off; the disk-Err path puts nothing in the ring.
    - tests/ui.rs:580-591 flips: with capture off the event is in the ring, has no disk record, and counts as received; the status-line route and the 400s still do not count. tests/server_stats.rs:175 values updated; :82 key order unchanged.
    - drain test: a spool file is kept in the mode and with capture off, and drained otherwise.

## c2 — TypeScript (branch feat/rbbex59r-c2, created from the c1 sha, worktree at builds_dev/rbbex59r-c2/)

1. Split src/cli/hookHandlers.ts:497. Under the switch, hook forwards with spool:false and gate runs normally. reviveDaemonDetached still runs on a failed POST, by design; its brakes stay: the 15 s stampede lock, NO_REVIVE, and the crash-loop backoff (reviveBackoffGate, 30 s up to 30 min).
2. Remove the refusals: ensureServer :295, runSupervise :916, setup.ts:1397, the agentlensDisabled() half of the server revive verb guard :1139, and the agentlensDisabled() half of reviveDisabledOnDisk (:100-106). For storeAdmin.ts:156 this is the correct change too: once the switch no longer brakes revive, it must not count as a brake for a store rewrite, so ts-repair then requires `agentlenspro server stop --stay-down`.
3. alcoreServeArgs pushes --no-collection when agentlensDisabled(dir) is true, dir being its own parameter, the one it passes as --data-dir. It honours the --force-install-telemetry env override (src/cli/killSwitch.ts:124-130).
4. Leaving the mode: runEnableCli (src/cli/disableCli.ts:85) resolves the data dir once and uses it for agentlensDisabled, enableAgentlensSurfaces and killSwitchPath; this will close the card follow-up on the env-default and ctx.dataDir split once c2 lands. After lifting the flag it reads /api/server-stats; if a server answers with collection "off" and its dataDir equals that dir, it restarts it:
   - it honours NO_REVIVE: no overrideBrake, no clearReviveBrake, no resetReviveBackoff (unlike the server restart arm, src/cli/serverControl.ts:1126-1131); with NO_REVIVE armed it says so and does not restart;
   - when a supervisor owns the child, it stops the child only and lets the supervisor respawn it (the respawn recomputes the arguments, so it comes back collecting); stopServer followed by ensureServer would race that respawn for the pid lock;
   - with no supervisor it uses stopServer, then ensureServer;
   - if the env half stays armed, the enable verb cannot lift it: it says so and does not restart.
   Its message "the server is revived by the next hook" is corrected.
5. The disable verb is unchanged here: it stops the server (B10 stays in (d)); the next failed hook POST revives it into the mode after the 15 s stampede lock, or after the crash-loop backoff (at least 30 s) when reviveBackoffGate counts the stop as a quick death (it counts a spawn that finds no live owner within 5 minutes; which stops trigger it is inferred, not measured).
6. setup final self-test (src/cli/setup.ts:1514-1590) in the mode: one read after the OTLP 200 asserts the synthetic span is NOT visible, beside the positive check that collection reads "off" (the absence read alone could not fail); the hook leg keeps reading receivedSinceBoot (now accepted events). Outside the mode it is unchanged.
7. Text: src/cli/killSwitch.ts:27-29 (DISABLED no longer means every side effect off; NO_REVIVE via `agentlenspro server stop --stay-down` is the brake that keeps the process down); the note text at :153-156; stale comments at src/cli/serverControl.ts:899-906, 952-959, 992-997; the Lifecycle capture description at media/src/tabs/Alerts.tsx:642 ("off = accept + drop" becomes off = not stored, still counted by the guards).
8. Existing tests that flip, each with its new assertion and a recorded mutation run:
   - src/test/killSwitch.test.ts:141: hook under the switch posts with spool false, and no spool file appears.
   - killSwitch.test.ts:162: the switch no longer blocks the auto-revive; NO_REVIVE still does.
   - killSwitch.test.ts:170: ensureServer under the switch spawns with --no-collection.
   - killSwitch.test.ts:288: runSupervise under the switch starts, and its child args carry the flag on every respawn; a respawn after the flag is lifted carries no flag.
   - src/test/autoSetup.test.ts:1417-1427: ensureServer under DISABLED spawns once, with the flag.
   - src/test/portSelect.test.ts:232-247: server revive under the env half proceeds, and still refuses when a stranger holds 4318.
   - src/test/serverEndpoints.test.ts:50-51: receivedSinceBoot rises for a ring-only event.
   - new unit tests: the flag is set exactly when the switch is armed for that dir (file half, env half; the env override gives no flag); the enable restart happens only when the server reports "off" and the dir matches, and not when NO_REVIVE is armed; the enable verb reports that it cannot lift the env half; storeAdmin ts-repair refuses under the switch without NO_REVIVE.
9. Joint test (the owner requirement «keep the guards» made observable):
   - setup: c1 built once in the main tree (cargo build --release in rust-core), the binary copied into the worktree bin-native/darwin-arm64/, then codesign -s - --force; in the worktree pnpm install and node esbuild.js; the worktree standalone/cli.js runs through node, never the agentlenspro on PATH. HOME and DATA_DIR isolated; OTLP, UI and MCP pinned to free ports, never 4318 or 3000. AGENTLENS_GATE, AGENTLENS_GATE_MODE, AGENTLENS_DISABLED and OTEL_* cleared from the env. One session id per launch. No supervisor runs during the test. No Bash command line of a worker may contain the enable, disable or uninstall-hooks verbs after the CLI name (src/cli/reviewLoop.ts:129 denies them); the test source drives them through node.
   - precondition for legs 3 and 4: read the ensureInstalled path and every module the disable and enable verbs call for launchctl, systemctl or machine-wide process scans, and confirm none reaches the real machine; `server stop` scans the machine for a supervisor (src/cli/serverControl.ts:1112-1121). Measured 2026-11-04: no launchctl, systemctl, spawnSync or execFileSync in src/cli/disableCli.ts, surfaces.ts or autoSetup.ts; the ensureInstalled path is not yet read.
   - leg 1, DISABLED file, explicit server start: collection "off"; 8 hook SubagentStart; gate on an Agent tool_use with subagent_type general-purpose and a prompt that does not match keep-warm: stdout hookSpecificOutput.permissionDecision is "deny" and systemMessage contains "(RUNAWAY_FANOUT)"; exit 0; no hook-events file, no span. The payload shape (tool_name, transcript_path) is pinned from the gate input parser and agent_gate.rs:282-340, not from memory.
   - leg 1b, cache-guard: one gate call on a large-image Read with the switch armed gives the cache-guard warn; the payload shape is pinned the same way.
   - leg 2, env half only (AGENTLENS_DISABLED=1, no file): collection "off", which only the CLI flag can cause. Mutation: drop the push in alcoreServeArgs and this leg fails.
   - leg 3, revive-driven: arm with the disable verb through node, start nothing, send one hook event, wait out the revive (timeout in minutes, see c2 item 5), then collection "off" and the RUNAWAY deny after 8 starts.
   - leg 4, enable, from the leg-1 file-only state with a clean env: the server restarts and collection reads "on".
   - cleanup: server stop in a finally block; afterwards no alcore or supervisor process whose argv names the test DATA_DIR may remain (process table snapshotted to a file, then searched).

## Decisions

- D1 port 4318: alcore keeps binding it and drops what arrives. The exporter keys are present under the switch (measured), so exporters keep sending and the server discards; binding avoids connection errors in every session and needs no new code. Supersedes decision 2 wording on 4318.
- D2 backlog on enable: not caused by (c) (today :497 returns before spooling; c2 passes spool:false). Drained records stamped with the drain time (src/hook_events.rs:138-141, :397), and 200 or more kept files starving the periodic drain, are existing normal-mode defects: TRDD-PB9ZEN46.
- D3 status line: server-side ingest kept; CLI-side capture still stops under the switch unless --keep-statusline was armed, until (d) fixes B11, so cache-state and cache-expired stay dark until then.
- D4 receivedSinceBoot means accepted events (c1 item 5).

## Kept, stopped, recorded

- Kept: the log sweeper (decision 4), status-line ingest and its tap, the ring and the guards, P5, the burn-tick body scan, the dashboard, the hook-config toggles, the review gate.
- Stopped: OTLP ingest and its tap; the raw-body pass and its tap; the hook-event disk log and its tap; the spool drain.
- Recorded, not fixed:
  - an armed switch now means a resident alcore running the log sweeper; the owner directive keeps the sweeper, so this cost is accepted; it is unmeasured (deploy check below);
  - a stranger on 4318, or a crash-looping server, leaves the guards off under the switch for up to 30 min per backoff cycle;
  - a DISABLED file created by hand while a collecting server runs: the CLI switches at once (spool false) while the server keeps writing hook events until its next restart;
  - THRASH_ACTIVE never fires and COLD_RESUME_* stays armed for its full window once raw bodies stop;
  - last-compact and the cache-expired resumeStaleness field cannot answer ((e));
  - the ring loses its history across a restart;
  - the TTL auth regime loses the OTLP part of the 5h percentage, keeps the log-sweeper cards; worst case Subscription;
  - the --hooks diagnostics verb exits 69 under the switch, so the panel is reachable only from the dashboard ((d), B8).

## Order and deploy

- c1 on this branch. A merge and a tag would ship it through publish.yml; the deploy gate below bars that too.
- c2 on feat/rbbex59r-c2 in builds_dev/rbbex59r-c2/ (cargo workspace members are an explicit list, pnpm-workspace.yaml has no packages key, lint, tsc and mocha use explicit dirs: none walks it), never checked out in this npm-linked tree, because any build here (node esbuild.js, pnpm run compile) would ship it to every session.
- Deploy c1 and c2 together, only when all hold:
  - TRDD-12FGMAEP has landed or the owner recorded a waiver;
  - memory check: alcore in no-collection mode with the real HOME read-only (that the sweeper reads ~/.claude and writes only DATA_DIR is inferred; verify during the run, e.g. lsof on the alcore pid), the clone store as DATA_DIR, ports pinned away from 4318 and 3000; pass = RSS and mimalloc commit flat over N minutes and below the cap with H of headroom. N and H are the owner values;
  - the owner has said whether deploying on this machine is wanted, given the switch was armed on 2026-10-27 with no reason recorded.
- The PR that lands c1 and c2 carries the CHANGELOG entry, the version bump, and the docs sweep: README.md:182 and :336 and src/cli/killSwitch.ts:27; skills/agentlenspro-diagnostics/SKILL.md:55 belongs to (d).

## Out of scope

The (d) remainder (verb refusals, repair skip, skills move, --keep-statusline, the uninstall-hooks brake, B10), (e), the B8 panel toggle, a server status line for the mode, --force-install-telemetry under the file half (an existing conflict), PreCompact on disk (the reasoning for that departure from the advisor stays on the card, in the first (c) re-cut bullet).

## Review disposition

- Round 1 review: all 12 findings applied, with B7 normal-mode half kept in (c) by the card decision and labelled beyond the rationale.
- Round 1 MEASURE: the supervisor call-site fix was dropped (alcoreServeArgs always passes its own dir); the fifth refusal and the setup self-test failures were added.
- Round 2 review: #2 (revive after disable), #4 (supervisor arguments) and #6 (shared predicate) resolved by measurement; #1, #5, #7b, #7c and #8 to #13 applied; #7a rejected because --force-install-telemetry alone spawns no server (measured), so its unit test is the real test; #3 (the memory-check pass values) is the owner call.
- Spec review: findings 1 to 9 applied (NO_REVIVE evidence widened and cited; isolation precondition for legs 3 and 4; enable honours NO_REVIVE and lets a supervisor respawn; leg 1 payload pinned; cleanup scoped to the test DATA_DIR; inferred claims marked; absence checks paired with positive ones; citations fixed).

## Evidence (reports_dev/rbbex59r/, gitignored, this machine only)

20261104_012003+0100-increment-c-code-map.md, 20261104_013213+0100-increment-c-code-map-2.md, 20261104_013048+0100-code-map-review.md, 20261104_013023+0100-card-edits-review.md, 20261104_014519+0100-recut-review.md, 20261104_014828+0100-advisor-verdict-recut.md, 20261104_015432+0100-db67bf48-review.md. The MEASURE and REVIEW reports of both rounds and the spec review exist only in the session transcript; their content is carried by this spec.
