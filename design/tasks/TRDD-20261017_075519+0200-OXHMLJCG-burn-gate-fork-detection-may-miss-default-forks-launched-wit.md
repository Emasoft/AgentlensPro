---
trdd-id: OXHMLJCG
title: Burn-gate fork detection may miss default forks launched with no subagent_type
column: todo
status: tasked
created: 2026-10-17T07:55:19+0200
updated: 2026-10-17T07:55:26+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-17T07:55:19+0200
related: [3EZ6SJ2Z, DIZ289UQ]
---

# Burn-gate fork detection may miss default forks launched with no subagent_type

Found 2026-10-17 while closing TRDD-3EZ6SJ2Z. The gate's fork exemption keys on subagent_type == 'fork' (src/agentGate.ts and rust-core/crates/agentlens-core/src/burn/agent_gate.rs). This repo's CLAUDE.md (doctrine 5) records that CC >= 2.1.232 makes fork spawning the default. If an Agent call with no subagent_type is a fork on those versions, the gate treats it as a fresh agent and can deny it for RUNAWAY_FANOUT, which is the bug 3EZ6SJ2Z fixed, in a new form.
Evidence (docs_dev/20261017_074841+0200-runaway-fanout-fork-deny-check.md and docs_dev/20261017_074934+0200-runaway-fanout-fork-launch-denominator.md): after the 2026-09-05 deploy, 50 Agent launches carried no subagent_type, and 1 of them was denied (2026-09-23T09:27:39Z). It was launched from inside a subagent transcript of the llm-externalizer project, on CC 2.1.280; its input keys were description and prompt only, and the same file's other launches all set subagent_type: fork.
Not established: whether a no-type Agent call is actually a fork on CC >= 2.1.232, and whether a subagent (as opposed to the main thread) can fork at all.
First step: verify from Claude Code's own documentation or changelog what an Agent call with no subagent_type spawns, on the main thread and inside a subagent. Then read the spawned agent's transcript for the 2026-09-23 deny and check whether it begins with the parent's context (a fork) or with a fresh prompt. Only if no-type calls are forks: widen fork detection in both twins, with a test in each that fails on the old code.

## Approval log

- 2026-10-17T07:55:19+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
