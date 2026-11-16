# TRDD-EW2UYTQ5 build plan — PROPOSED (revision 2, not approved by the owner; no code started)

Legend: V = VERIFIED (read, file:line; each cited line was re-read from the file with sed -n after the last review, 40 spot checks). I = INFERRED (not traced). "default, pending owner" = owner default applied, not answered.
Paths relative to /Volumes/EmaUITEK4TBSSD/Code/AgentlensPro, branch fix/setup-agent-preflight. Line numbers drift with edits: re-grep before citing in a card.

## 0. Rationale (one sentence)
Today install state is implicit (heal-toward-shipped-set) and the only off switch is one global brake that also uninstalls things; the owner wants an explicit per-extension ledger, a registry, and two independent axes: PROFILE (what is installed) and ENABLE flag (what runs).

## 1. Data model

### 1.1 Extension registry (static, in code; one source of truth)
`src/cli/extensions/registry.ts` (new). Row = `{id, type, group, installer, flagSupport, exemptFromDisable}`.
- type: `skill | agent | hook | settings | statusline | mod | rule`
- group (function): `capture` (lifecycle hook, otel env, raw bodies, statusline), `guard` (burn gate, cache-guard, delegate gate), `review` (review gate, supervisor, review mod), `skills`, `agents`.
- ids derived, never re-spelled: skills from SKILL_NAMES (src/cli/hookInstall.ts:704, 5 names V), agents from AGENT_NAMES (:834, 9 names V), hooks from CURRENT_CMDS (:146 V: hook, gate, review-gate, review-supervisor, delegate-gate), env keys from ownedKeys (src/telemetryConfig.ts:164 V) / ownedTelemetryKeys (:193 V), statusline from STATUSLINE_SURFACES (hookInstall.ts:480 V), rules from RULE_NAMES (src/cli/surfaces.ts:24, EMPTY V), mod = agentlenspro-review-mod plugin (detected only, via installed_plugins.json, reviewModInstalled hookInstall.ts:138 V).
- Hook granularity: one `installHooks` call installs all hooks together (hookInstall.ts:400 V). Per-hook install needs the per-command logic split out of rebuildEventMatchers (:256 V) and buildEventOps (:314 V); the same review-mod exclusion is written twice (:277,:281 and :349,:352 V) - one source after the split.
- delegate-gate registration is REMOVED (comment hookInstall.ts:285, :355 V) pending TRDD-SA99VCPZ: registry row `installable:false`.
- review-gate and review-supervisor are skipped when the review mod is installed (hookInstall.ts:277-281 V): registry encodes that mutual exclusion.

### 1.2 Install ledger
File `<dataDir>/install-ledger.json` (same dir as the DISABLED flag, killSwitch.ts:41 V). Written only by the install/uninstall engine.
```
{ version:1, createdAt, profile:"name|null",
  entries:{ "<ext-id>": {
     installedAt, source:"profile|cli|dashboard|setup",
     files:[{path, sha256, mode}],            // skill tree files, agent .md, scripts; hash AT INSTALL TIME
     settings:[{file, jsonPath:["env","OTEL_X"], hadKey, priorValue, writtenValue}],   // path ARRAYS, never line numbers
     hookCommands:["agentlenspro hook", ...]  // hooks identified by command needle, never by array index
  } } }
```
- Generalizes the existing telemetry marker: ManagedKeyRecord {hadKey, priorValue} (src/telemetryConfig.ts:56 V) and the `written` ownership list (:73 V). First prior value is kept forever (comment :537 V). Existing marker is imported read-only first, folded in later (I: migration details untested).
- Statusline stores the original command so it can be unwrapped (unwrapStatuslineCommand hookInstall.ts:520 V).

### 1.3 Enable/disable flags (per extension, file based)
- Dir `<dataDir>/switch/`; file `<ext-id>.off` present = OFF. Global `DISABLED` stays master (killSwitch.ts:41 V). Effective on = installed AND NOT global-off AND NOT `<id>.off`.
- Hooks: flag read first, before stdin (pattern exists: `if (agentlensDisabled()) { return 0 }` hookHandlers.ts:497 V). Read fails open (unreadable = ON), same direction as killSwitch.ts:31,:128-130 V.
- Settings keys (otel env): a flag cannot stop Claude Code reading an env value; enable/disable may flip a value only for keys agentlenspro ADDED (ledger hadKey:false), per owner. Reaches NEW sessions only (disableCli.ts:2-8 comment: 0 of 13 running sessions stopped V). CLI and dashboard must say so.
- Skills: no flag read possible (Claude loads them). Candidate in-place switch `skillOverrides: "off"` (card; NOT measured). Agents: `permissions.deny` `Agent(<name>)` (card; NOT measured). Rules: none known (RULE_NAMES empty). All Step 0 measurements (section 5); until measured, `status` shows `n/a` for these.
- Exempt from off (owner): statusline, review-gate, review-supervisor, review mod.

### 1.4 Profiles
`<dataDir>/profiles/<name>.json` = `{name, extensions:[ids], settingsGroups:[...], alerts:{...}}`. Profile = desired INSTALLED set only; never enable state. Applying = diff(installed, wanted) -> install missing, uninstall extra; switch flags untouched both ways (owner). Created only in the dashboard; CLI loads by name.

## 2. CLI verb surface
No `uninstall` verb exists on the main CLI (`daemon install|uninstall` is the background service: serverControl.ts:1175-1180 V). `disable <words>` is today the free-text reason (disableCli.ts:21 V), so extension targets use flags; bare `disable`/`enable` keep their global meaning.
```
agentlenspro install   [--all | --function <g> | --type <t> | --id <ext> ...] [--dry-run] [--yes]
agentlenspro uninstall [--all | --function <g> | --type <t> | --id <ext> ...] [--dry-run] [--yes] [--force]
agentlenspro enable    [--function <g> | --type <t> | --id <ext> ...]     # no flags = today's global enable
agentlenspro disable   [--function <g> | --type <t> | --id <ext> ...] [reason...]
agentlenspro profile load <name> [--dry-run]       # no create/save/delete in CLI (owner)
agentlenspro profile list
agentlenspro status    [--json]    # per ext: installed, hash drift, on/off, profile; settings rows; "running sessions keep old env until restart"
```
- `setup` stays the first-run installer (README must say so, card) and equals `install --all` + server + self-test (STEPS setup.ts:1703 V).
- `install`/`uninstall` never touch on/off flags; `enable`/`disable` never install or remove (owner).
- New verbs go into AUTOSETUP_EXCLUDED_VERBS (autoSetup.ts:54 V) and the verb lists main.ts:114 and :163 (V), or autoSetup heals what uninstall just removed.
- `--force` on uninstall removes even user-edited items (default, pending owner: KEEP and LIST edited items).
- Aggregated settings groups are `--function` groups; `--id settings:<group>`.

## 3. Reuse / replace map
| Piece | Verdict |
|---|---|
| src/safeConfigEdit.ts SafeEditOp set/delete/append_unique/remove_by_substring, path ARRAYS (:20-32 V) | REUSE as the only writer. Path arrays meet the owner's "navigate by path, not line number"; they are not literal jq. jq is an external binary (present at /opt/homebrew/bin/jq here, not a dependency) -> question 1 |
| hookInstall.ts installHooks :400 V | REUSE per hook by parameterizing rebuildEventMatchers :256 / buildEventOps :314 by command set |
| installSkill :790, installAgents :854, installSkills :887 (V) | REUSE; add ledger write (hash via skillTreeHash :759 V). No per-skill uninstall exists: new |
| telemetryConfig.ts ensureTelemetryConfig :524 / removeTelemetryConfig :669 (V) | REUSE install. Uninstall must CHANGE: it restores marker priorValue with `if (finalEnv[key] !== rec.priorValue) ops.push(set ...)` (:699 V) and never compares the current value with the marker's `written` list (whole function :669-731 read V). Needed: restore only when current value is in `written`; else leave and report |
| installStatusline :603 V | REUSE, add ledger entry |
| disableCli.ts runDisableCli :20 V | REPLACE: moves skills/rules aside (:24 -> surfaces.ts:51 V), stops the server (:39 V), removes the raw-body key (:56 V), keeps statusline only with `--keep-statusline` (:30 V; README.md:182 documents all of this) |
| surfaces.ts disable/enableAgentlensSurfaces :51 / :72 V | REMOVE move-aside; keep arm/disarm only |
| autoSetup.ts detectDrift :98, ensureInstalled :237 V | CHANGE: drift must read the ledger's desired state. It skips only on the global flag (:248 V), so any per-item uninstall would be reinstalled on the next CLI launch |
| setup.ts REPAIR_STEPS :1707 V (hooks, skill, otel-env) | REUSE as engine steps behind install --all |
| hookRuntimeConfig.ts :16 + /api/hook-config (ui.rs:1653,:1662 V) + Alerts.tsx HooksSection :572 V | KEEP as owner of warn-vs-block mode and (later) thresholds; ownership split in 4.7 |
| alcore no-collection mode (bin/alcore.rs:223 V; lib.rs:359-362 V) | REUSE for "dashboard stays up when disabled": guards + status-line ingest run, no telemetry stored. Set once at boot, restart is the only transition (lib.rs:359 V) -> disable restarts the server in that mode instead of stopping it (default, pending owner) |
| Review mod plugin | I: no CLI path installs/removes a plugin (only detection, hookInstall.ts:138). Question 4 |

## 4. Child cards (dependency order; each bounded, independently testable)
All tests run against a scratch HOME + DATA_DIR (section 5), never the real ~/.claude; real tests, no mocks.

4.1 **Registry + ledger + read-only `status`.** New registry.ts, ledger.ts (atomic write), `agentlenspro status`. Backfill infers the ledger from the current install (hash skills/agents, find hook needles, read telemetry marker) changing nothing. Accept: on a scratch HOME after `setup --yes`, `status --json` lists 5 skills, 9 agents, the hook commands (minus delegate-gate), the env group; settings.json byte-identical before/after `status`; second run idempotent.

4.2 **autoSetup reads the ledger.** detectDrift/ensureInstalled heal only ledger-desired items; new verbs added to the exclusion lists. Accept: delete one ledger entry by hand -> next launch does not reinstall it; delete an installed item still desired -> reinstalled (today's behaviour kept). MUST precede every uninstall card.

4.3 **Skills + agents install/uninstall.** `install|uninstall --type skill|agent --id`. Uninstall compares current hash to ledger hash; edited item KEPT and listed unless `--force` (default, pending owner). Also fixes: installSkill rewrites any file that differs from shipped (`if (!same) ... writeFileSync` hookInstall.ts:811-815 V) and detectDrift calls installed != shipped "stale" (autoSetup.ts:131-133 V), so a user-edited skill is overwritten on the next launch today -> three-way compare (shipped, install-time, current) for heal too. Accept: edited skill survives launch and uninstall; unedited one is removed; other files in ~/.claude/agents untouched.

4.4 **Per-hook install/uninstall.** Parameterize the matcher logic by command; keep the review-mod exclusion. Accept: scratch settings.json with a foreign hook on PreToolUse: `install --id hook:gate` adds only the gate matcher, uninstall removes only it, foreign hook byte-identical; `jq` structural diff shows only agentlenspro entries.

4.5 **Settings groups + restore-to-original.** Group env keys (capture/otel, raw-bodies, statusline) with ledger prior values; uninstall restores per key; a value the user changed (not in `written`) is LEFT and reported (fixes :699). Accept: set key to user value A after install -> uninstall leaves A and prints it; untouched keys return to prior or are deleted; `env` dropped only if agentlenspro created it (:711 V); settings.json equals the pre-install snapshot on every path not user-edited.

4.6 **Whole `uninstall`** = 4.3+4.4+4.5 over all ledger entries + marker cleanup + plugin decision (question 4). Accept: scratch HOME round trip: snapshot settings.json -> `setup --yes` -> user edits one key and one skill -> `uninstall` -> settings.json equals snapshot except the user's edit; edited skill kept and listed; ledger empty; next launch installs nothing.

4.7 **Per-extension flags + disable rewrite.** `switch/<id>.off`; `extensionOff()` in each hook entry (pattern hookHandlers.ts:497); rewrite runDisableCli (flag only; statusline and review/measure always on; no move-aside; no key strip except agentlenspro-added values). Ownership split (proposal): DISABLED + switch/ = on/off; hook-config.json = warn/enforce + thresholds; ledger = installed. Accept: with all flags off every non-exempt hook exits 0 with no output and no server spawn; statusline capture still appends; `status` shows installed=true on=false; install/uninstall leave the switch/ dir checksum unchanged.

4.8 **Server collection-off mode, dashboard up.** `disable` restarts alcore in no-collection mode (not stop); `enable` restarts normal; start refusals serverControl.ts:295 and :916 (V) reconsidered; README.md:182 rewritten. Hot toggle (Rust) optional. Accept: disabled -> UI port answers /api/hook-config, no new bytes in otel-bodies after a Claude request; enable -> collection resumes.

4.9 **Profiles + `profile load`.** File format, apply engine = diff + 4.3-4.5 calls, flags untouched. Accept: load A then B -> installed set equals B; switch/ checksum unchanged; unknown name exits non-zero.

4.10 **Dashboard API.** GET /api/extensions, POST install|uninstall|enable|disable, profile CRUD. Privileged: add to the guarded-path list (ui.rs:1541-1545 V, like /api/hook-config); engine is TypeScript, alcore is Rust -> shell out to the CLI (I). Accept: POST without viewer header refused; POST install then `agentlenspro status` agrees.

4.11 **Dashboard right panel.** No right-panel component found by grep (the only runtime switch card is Alerts.tsx HooksSection :572; I: panel is new). Mirrors CLI: tree by function/type, install and on/off toggles, "restart needed" banner for settings rows, profile save/load. Accept: headless real-browser test toggles an extension and `status` agrees; screenshots light+dark in reports_dev.

4.12 **Alert/block thresholds.** Extend hook-config schema in TS (hookRuntimeConfig.ts:16) and Rust (server_stats) with per-parameter warn|block and thresholds; panel section. Accept: changing a threshold changes a gate decision with no restart.

4.13 **README + docs.** Add the `agentlenspro setup` first-run line right after the install line (README.md:58 V; none today); document install/uninstall/profile/status; fix README.md:182 (disable semantics) and the "no switch" text near README.md:334 per feature stop list.

## 5. Risks and measure-first (scratch dirs only)
- Scratch isolation (grep scope: src, standalone, rust-core, scripts, excluding test dirs, target, node_modules): CLAUDE_CONFIG_DIR is read by LOG-DISCOVERY and usage code only - src/logReader.ts:56,:604, src/subscriptionUsage.ts:197,:217, rust-core/crates/agentlens-logscan/src/discovery.rs:78, rust-core/crates/agentlens-core/src/ui.rs:3356,:4536 (V). It is NOT read by src/cli/*, src/telemetryConfig.ts or scripts/safe_config_edit.py (no match V). The installer takes paths from `home = opts.home ?? os.homedir()` (setup.ts:118,:138-140 V), `os.homedir()` in surfaces.ts:28 and hookInstall.ts:138 (V), and settings from AGENTLENS_CLAUDE_SETTINGS (cliCore.ts:93 V). So scratch = `HOME=<tmp> DATA_DIR=<tmp>/data` + own ports (one server per data dir, CLAUDE.md); an existing browser test sets a private HOME and CLAUDE_CONFIG_DIR (src/test/browser/dashboardSmoke.test.ts:264 V). Verify every write path follows HOME before the first run.
- Step 0 measurements (card, open): (a) `skillOverrides: off` hides a skill live? (b) `permissions.deny Agent(x)` blocks a subagent live? (c) which settings.json keys re-read live vs session start; (d) does `claudeMdExcludes` cover ~/.claude/rules? Run in a throwaway claude session with scratch HOME. Unmeasured = unsupported.
- Heal-vs-uninstall war (autoSetup) is the top risk -> 4.2 first.
- Concurrency: ledger, settings.json and the autoSetup lock (.autosetup.lock, autoSetup.ts:153 V). Ledger writes under that lock; settings only via safeConfigEdit.
- Backfill: existing installs have no ledger; a wrong inference could remove a user's own similar hook. Needles are literal (GENERATION_NEEDLES hookInstall.ts:293 V); dry-run first.
- Disable semantic change invalidates tests/docs asserting move-aside + key strip (I: sweep src/test needed).
- Telemetry env changes reach new sessions only (2026-07-14 incident, disableCli.ts:2-8 V).
- Raw bodies are "mandatory" (README.md:334) and the heal loop re-adds them; resolved by 4.2 + question 7.

## 6. Open questions for the owner
1. jq: literal `jq` in product code (external dependency) or path-array addressing via safeConfigEdit (equivalent, already verified)? Plan assumes the latter; jq only in tests/diagnostics.
2. Statusline under `disable`: today OFF unless `--keep-statusline`; your text says it keeps running. Make it always-on (plan default)? On uninstall: remove the wrapper?
3. Dashboard while disabled (default, pending owner): restart server in no-collection mode. Accept the restart, or require a hot toggle (Rust work)?
4. Review mod: should `install`/`uninstall` manage the plugin (needs `claude plugin` CLI calls, I unverified), or only the hook half?
5. User-edited item on uninstall (default, pending owner): KEEP and LIST; confirm the same for HEAL (autoSetup must stop overwriting edited skills; today it does).
6. Skills/agents/rules off-switch: accept `skillOverrides` / `permissions.deny Agent()` if measured live, else "not switchable" with install/uninstall only?
7. Raw-body capture is documented mandatory: may a profile omit it, and may disable flip an agentlenspro-added value?
8. Profile storage: machine-wide (`<dataDir>/profiles`) or per project?
9. Alert thresholds: which parameters to expose (burn gate, cache guard, advisor, image resident cost, ...)?
10. delegate-gate (registration removed pending TRDD-SA99VCPZ): list as non-installable?

## 7. Revision 2 (2026-11-16)
- jq: settings.json writes stay in safeConfigEdit (JSON path arrays, the CLAUDE.md rule); every inspection, test, card and design note uses jq paths. Open for the owner: must the shipped CLI call jq at runtime.
- disable switches off the telemetry and raw-body values agentlenspro added, by changing the value, never removing a key or a user-set value; reaches new sessions only, and CLI/dashboard say so. Measure first which value turns each key off in a new session.
- Settled by owner words: statusline always on under disable; thresholds cover all tracked parameters and events (card 12 starts from a code inventory); review mod is "no plugin" (whether a mod loads at user scope outside a plugin is a platform fact to look up); delegate-gate non-installable until TRDD-SA99VCPZ.
- Profile apply follows the uninstall edited-item rule (keep and list).
- Card 7 migration: an already-disabled install has files parked in <dataDir>/disabled-surfaces; move them back and record them in the ledger.
- Measure-first preflight: verify an authenticated Claude session can run against a scratch config before designing live-switch tests on a scratch HOME.
- Card 10 not designed: alcore shelling out to the TS CLI is INFERRED; alternative is porting the engine to Rust. API and profile files carry registry ids only, never paths, commands or values; name which agentlenspro binary alcore would run; read the standalone-server-security-model memory page first.
- Open owner questions: (1) jq at runtime in the shipped CLI; (2) restart into no-collection mode while disabled vs a hot toggle; (3) may a profile omit raw-body capture; (4) profiles machine-wide or per project; (5) defaults pending owner: uninstall keeps and lists edited items, dashboard stays up while disabled.
