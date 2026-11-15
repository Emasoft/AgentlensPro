---
trdd-id: EW2UYTQ5
title: agentlenspro CLI and dashboard install, uninstall and switch each extension it ships one by one in realtime
column: design
status: tasked
created: 2026-11-15T20:55:31+0100
updated: 2026-11-15T21:07:15+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: refactor
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: false
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-15T20:55:31+0100
---

# agentlenspro CLI and dashboard install, uninstall and switch each extension it ships one by one in realtime

## Owner decision (verbatim, 2026-11-15)
> agentlenspro should not be a plugin. all components should be installed as standalone user scoped elements. each one indipendently. skill, hooks, agents, mods, etc. no plugin.
> the reason for this is that all the extensions must be dynamically switcheable on and off at any time and at runtime.

(Orchestrator paraphrase, not owner text:) Asked whether a mod can exist only as a plugin (mod docs: "A mod is a plugin of JavaScript/TypeScript event handlers") and whether standalone skills, agents and settings hooks have no runtime switch, the owner chose: "One plugin per part (Recommended)" — split into small single-part plugins, each switched on or off separately with `/plugin enable|disable` plus `/reload-plugins`; no bundle.

## Owner directive (verbatim, 2026-11-15, later)
> every skill, every hook, every agent, every mod, every rule: each one of them must be installable and uninstallable atomically via the agentlenspro cli. or using the dashboard right panel. all in realtime. including all changes to the settings.json file (maybe aggregated per functionality to make easier for the user to switch them on or off). disable as an option should be a similar realtime change. not only it must uninstall the hooks (except those of the statusline and the adversarial and measurer reviews) but it must change the settings.json to remove or switch off the telemetry options so that claude will not keep saving logs or raw bodies that nobody is collecting.
> packaging? what packaging? agentlenspro it its a tool installed via npm. it installs extensions only after being installed.
Resolution (orchestrator reading of the line above): no repackaging of agentlenspro itself. The npm-installed CLI stays the installer and manager; each extension it installs (skill, agent, hook group, rule, settings.json telemetry group) is a standalone user-scoped element switched one by one from the CLI and the dashboard's right panel. The review mod stays the one plugin, because a mod loads only from a plugin. The per-part-plugins plan below is superseded.
> packaging? what packaging? agentlenspro is a tool installed via npm. it installs extensions into claude (at user scope) only after being installed.

## Superseded plan (one plugin per part — replaced by the resolution above; kept as the parts inventory)
Parts inventory (2026-11-15):
- mod: agentlenspro-review-mod (register.js + show.py command hook), already a plugin
- skills (repo skills/): agentlenspro-diagnostics, agentlenspro-cache-guard, agentlenspro-scan-and-fix, agentlenspro-visualize-context, verification-before-completion
- agents (repo agents/): agentlens-tldr-worker, cheap-worker, fast-worker, js-test-writer, lean-worker, micro-worker, python-test-writer, smart-worker, sonnet-worker
- settings.json hooks written by `agentlenspro --install-hooks` (src/cli/hookInstall.ts:400): `agentlenspro hook` (lifecycle capture), `agentlenspro gate` (burn gate), the Read cache-guard
- stays in settings.json (not plugin components): OTEL env, status line
- rules (~/.claude/rules files agentlenspro ships, if any)

## Step 0 (gate, before any build; the plugin-per-part checks are superseded, the realtime checks still apply)
Measure that `/plugin disable` + `/reload-plugins` mid-session stops a plugin's hooks, skills and agents with no restart, and enable brings them back. Not yet verified.
Also verify (docs found 2026-11-15): plugin skills and agents are renamed `plugin-name:name` (skills reference chapter line 469), which would break every bare-name reference; standalone skills can be hidden with the settings key `skillOverrides` ("off"). On that basis the main agent now recommends standalone elements switched by the agentlenspro CLI and dashboard, with only the mod kept as a plugin; this awaits the owner's answer. Also measure whether settings.json hooks and env telemetry changes apply to a running session or only after restart.

## Approval log

- 2026-11-15T20:55:31+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-15T21:03:25+0100 — column → backburner. plan awaits the owner's answer on standalone vs per-part plugins
- 2026-11-15T21:05:49+0100 — column → design. owner resolved the packaging question
