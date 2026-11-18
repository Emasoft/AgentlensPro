---
trdd-id: 5FKVMOE3
title: An update of agentlenspro refreshes every installed hook, skill, agent and mod in Claude Code with no manual step
column: todo
status: tasked
created: 2026-11-18T01:24:13+0100
updated: 2026-11-18T01:27:03+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-18T01:24:13+0100
---

# An update of agentlenspro refreshes every installed hook, skill, agent and mod in Claude Code with no manual step

OWNER, 2026-11-18 (verbatim): «also the updates must trigger the updates of all installed extensions and hooks in claude.»

Reading of the main agent (not the owner words): after the package is updated (npm update, or a local deploy), the first launch brings every surface AgentlensPro installed into Claude Code to the new version: hook registrations, the status line registration, the skill folder, the shipped agents, the review mod, and the running server binary. No manual setup run is needed.

Step 1 (research, read-only): which of these surfaces the launch self-heal (maybeAutoSetup, REPAIR_STEPS) and autoSetupOnServerStart already converge on a version change, and which have no step. Report: reports_dev/update-refresh/20261118_013500+0100-update-refresh-surfaces.md.
Step 2: one increment per surface that has no step, each with a test.
Step 3: record on the release card TRDD-HSPUF5XH which surfaces refresh on update at the time of the publish.

Related: TRDD-RBBEX59R (the launch self-heal under the switch), TRDD-HSPUF5XH (release).

## Approval log

- 2026-11-18T01:24:13+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Owner clarifications 2026-11-18

2026-11-18T01:27:03+0100 — OWNER, 2026-11-18 (verbatim, two messages): «when i said that the update must trigger the update of all installed extensions and hooks, i don't mean that the npm package must use scripts post-instal. instead never use those, since they are vehicles for malicious code. i meant that simply at first execution the agentlenscli must detect if the installed extensions are out of date and then update them overwriting them with the new.» and «this means you have to insert a version number somewhere in every installed extensions from agentlenspro». DESIGN that follows (reading of the main agent, not the owner words): (1) no npm lifecycle script (postinstall, preinstall, install, prepare) in package.json, ever; a build check fails when one appears. (2) Every surface AgentlensPro installs into Claude Code carries the version of the package that wrote it: the hook registrations, the status line registration, the skill folder, each shipped agent file, the review mod. (3) At the first execution of the CLI after an update, the launch check compares each stamped version with the version of the running package, and overwrites every surface that is older or carries no stamp. (4) A surface the user edited by hand is still overwritten (the owner said overwriting); whether a backup copy is kept first is decided in the spec (related card TRDD-JCM1GZ1S: installAgents overwrites a same-name agent without a backup). Candidate golden PRRD rule, waiting for the owner word: no npm lifecycle scripts.
