---
trdd-id: AGZ0XZKW
title: agentlenspro installs itself on first run when skills or the install are missing or stale, and hook deadlines are tuned live from the dashboard
column: todo
status: tasked
created: 2026-10-02T16:44:51+0200
updated: 2026-10-02T18:08:26+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-02T16:44:51+0200
---

# agentlenspro installs itself on first run when skills or the install are missing or stale, and hook deadlines are tuned live from the dashboard

## Approval log

- 2026-10-02T16:44:51+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-02T18:08:37+0200 — owner orders 1-13 recorded verbatim under 'Owner order (superseding)'; scope re-titled; the init alias is dropped.

## Owner order

Owner, verbatim (2026-10-02): "`agentlenspro init` once should be enough and idempotent. from then on it will be handled via the dashboard config"
Decision (a): DROPPED (see Owner order (superseding)) — there is no `init` alias; `setup` stays the explicit repair verb and the install heals itself at every launch (src/cli/autoSetup.ts).
Decision (b): timeout control = "Ceiling at init, live knobs": init registers a fixed generous ceiling (HOOK_TIMEOUT_SEC, being raised 30 to 120 by another worker); the dashboard edits each hook EFFECTIVE internal deadline via the server-side hook-config.json, live, no Claude Code restart; the server never writes ~/.claude/settings.json.

## Scope

1. DROPPED: the `init` alias. Replaced by src/cli/autoSetup.ts: every non-hook CLI launch checks skills, agents, hooks (120 s), per-key telemetry env (raw body dumps included) and repairs only what failed, through safeConfigEdit; foreign telemetry stops the run (see Owner order (superseding)).
2. LIVE DEADLINE KNOBS (blocked, see Blocked): hookHandlers.ts reads inner deadlines AGENTLENS_HOOK_TIMEOUT (2s) / AGENTLENS_GATE_TIMEOUT (4s) from env. Make the hook process read them from <dataDir>/hook-config.json per invocation via the existing hookRuntimeConfig.ts reader (file beats env beats default). The hook must read the FILE, not ask the server, because the deadline matters exactly when the server is down. Clamp below HOOK_TIMEOUT_SEC. Add the fields to the server hook-config schema/validation (rust-core server_stats.rs ~:82,130-170) and two numeric inputs in the dashboard hook-config UI (media/src/tabs/Alerts.tsx).
3. Docs: the diagnostics skill tells an agent that sees "agentlenspro is DISABLED" to run the printed reactivate command.

## Acceptance

- [ ] Two launches in a row over a converged install: the second repairs nothing and prints nothing (fast path ~4 ms measured).
- [ ] A dashboard edit of the gate deadline is honoured by the very next hook invocation with no restart (test: plant hook-config.json, run the hook command, measure its network deadline).
- [ ] settings.json is never written by the server.

## Blocked

Scope item 2 is blocked until branch wt/port-guard merges: it edits src/cli/hookHandlers.ts, which that branch owns. (trddgrep has no field wired for a branch blocker; blocked-by must name a card.)

## Owner order (superseding)

Owner orders of 2026-10-02, verbatim, in the order given. They REPLACE the `init` idea: the init alias is dropped.
1. "maybe it is better to just automatically run the setup at first launch of the agentlenspro cli. no need for agentlenspro setup or init."
2. "no confirmation needed. autoinstall at first run if detects stale or missing skills"
3. "skills, agents, hooks, anything missing must be restored automatically at each launch of the cli"
4. "the safe editing of the ~/.claude/settings.json (to enable full telemetry logs and raw dumps body, set the output paths, the timing, etc.) must be also done and ensured but with the super safe editing script we created."
5. "raw body dumps is not an optin, its mandatory. if you install agentlenspro you know you are installing a tool that reads the raw dumps and all telemetry and hooks and the status line, etc. all of it." (reverses TRDD-BKF5NZD3)
6. "the only thing that must be carefully evaluated is if the user already has a configured settings for the telemetry that output the files into some company intranet server or some central gateway for the telemetry. if the tool finds an already configured telemetry that uses different parameters and outputs from those of agentlenspro, then it must stop and report an error message"
7. "without telemetry raw dumps agentlenspro is non functional, so it cannot be skipped, but only exited with error, warning the user that since an already configured telemetry is in place, agentlens cannot run, and advise to manually remove the company/existing setup from settings.json or to use --force-install flag once to automatically replace it."
8. "no, force install exists exactly to overwrite the company settings of telemetry, and write the agentlenspro settings instead. without force-install option the agentlenspro cli will exit with error disabling all hooks and skills, saying that there is a setup of telemetry and that it cannot touch it unless the --force-install is used. maybe use --force-install-telemetry to make this even clearer."
9. "if agentlenspro is disabled, it must automatically disable both rules and skills. only the agents can be still left, since they are independent from the agentlenspro cli."
10. "make sure to write a message in case someone execute the agentlenspro cli when it is disabled. the message must inform the agent that to reactivate the agentlenspro it must use the right command (example: agentlenspro reactivate)" — the reactivate verb is the existing `agentlenspro enable`.
11. "when enabled, it must always check the settings.json telemetry settings first, and if the company settings are still in place, it must deactivate again. only if the telemetry settings are gone or are those of agentlens then it must restore/install anything missing."
12. "only the --force-install-telemetry flag will overwrite the telemetry settings in settings.json and restore/install all telemetry settings. --force-install-telemetry implicitly include the enable command, since it restores all missing things."
13. "--force-install-telemetry overrides all env vars and enable agentlenspro. but the next time agentlenspro is executed, if the env vars are set to disable it, and no --force-install-telemetry is used, then it will regularly disabled again, as normally does when the env var is found set."
Implemented in: src/cli/autoSetup.ts (ensureInstalled: one order for launch and enable; forceInstallTelemetry), src/cli/foreignTelemetry.ts, src/cli/surfaces.ts (disableAgentlensSurfaces / enableAgentlensSurfaces, RULE_NAMES empty), src/telemetryConfig.ts (foreign-pipeline guard, ownership marker, managed-settings overwrite), src/cli/killSwitch.ts (in-process env override), src/cli/main.ts (flag + dispatcher).
Deviation recorded: parked skills live in <dataDir>/disabled-surfaces/, not <dataDir>/disabled/ — on a case-insensitive filesystem `disabled` collides with the `DISABLED` kill-switch flag file (mkdir failed ENOTDIR in the test run).
