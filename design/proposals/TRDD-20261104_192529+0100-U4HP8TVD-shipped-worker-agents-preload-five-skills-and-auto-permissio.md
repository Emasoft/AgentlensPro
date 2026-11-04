---
trdd-id: U4HP8TVD
title: Shipped worker agents preload five skills and auto permission mode for every user
column: proposal
status: proposed
created: 2026-11-04T19:25:29+0100
updated: 2026-11-04T20:26:24+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: user
assignee: main-agent@agentlenspro
approved: false
implementation-commits: [a2ba6005, 18e6b49b]
---

# Shipped worker agents preload five skills and auto permission mode for every user

Relocated from TRDD-RBBEX59R (line "Outside this card", handoff 2026-11-04T18:13), verbatim, so it is not lost. Owned elsewhere; every item awaits the owner.

Owner questions on the shipped agents committed in fc2df568 and 88487010 (permissionMode auto and 5 preloaded skills for all users; a missing skill does not break the launch, measured on CC 2.1.318 -p; the lean-worker description says medium while its effort is high; the preload costs ~35-50k tokens per spawn, an estimate; micro-worker minimal footprint against the skills; the user rule delegation-and-orchestration.md names lean-worker as Sonnet).

Notes for the reader, not owner decisions:
- The ~35-50k tokens per spawn figure is an estimate from byte counts, not a measurement.
- A missing preloaded skill not breaking the launch was measured on CC 2.1.318 with -p only.
- The user rule delegation-and-orchestration.md is outside this repository.
- Sources added 2026-11-04 (from the session that wrote the agents, stated as reported, not re-measured when this card was edited): the five preloaded skill files total 126,557 bytes (graphify alone 47,544); micro-worker's last measured first request was 11,167 tokens, so preloading makes it roughly 4-5x larger (an estimate, not a measurement); the lean-worker description still steers "anything Haiku would get wrong" to an agent that now runs on Haiku; the edits live on branch fix/setup-agent-preflight and become permanent for users only after a merge to main and a release.

Supersedes TRDD-CA5U48BA, which trddgrep new created with a default mandate (pre-approved) that contradicted 'awaits the owner'.

## Approval log
2026-11-04 — the owner decided the preload half (verbatim under Owner decisions); the card's other questions still await the owner, so the column stays proposal.

## Owner decisions

- 2026-11-04 — preload half DECIDED by the owner, verbatim: «make all the agents that are of type worker (those installed by agentlenspro) to use the trick of the agentlens-tldr-worker.md to save tokens: that is, instead of including the required skills in the frontmatter array like this: [skills: tldr-code, fastedit, jgrep, quicksilver, graphify] the agentlens-tldr-worker.md does not include any skill in the frontmatter to preload, instead it put the basic commands and instructions to use the skills tools in the body of the agent.» The example the owner quoted is the 'Navigate with tldr' section of agents/agentlens-tldr-worker.md.
- Closed by this decision: the five-skill preload on cheap-worker, fast-worker, lean-worker and micro-worker. Moot: the missing-skill launch measurement; the ~35-50k estimate (the 126,557-byte figure stays as the doc-sourced CHANGELOG basis); micro-worker minimal footprint against the skills.
- Still open: permissionMode auto for every user; the lean-worker description vs its effort and model; the user rule that names lean-worker as Sonnet.
- Agent's reading, not an owner decision: "(those installed by agentlenspro)" means the four workers above; agentlens-tldr-worker already conforms. Five user-scope agents not shipped by agentlenspro also preload skills (js-test-writer, python-test-writer, merge-role-worker, smart-worker, sonnet-worker); the owner was asked on 2026-11-04 whether to extend the change to them, no answer yet.
- The implementation departs from the owner's example in two points: it does not copy the example's "Read with a tight offset/limit" paragraph, because these workers read with `tldr body` and the user's code-tools rule keeps the Read tool for images, PDFs and notebooks; and the example's own `tldr definition <symbol> <path>` line is broken (exits 2: tldr reads the second positional as a line number), so the workers and agents/agentlens-tldr-worker.md use `tldr definition --symbol <symbol> --file <file>`.
- Implemented in a2ba6005 (cheap-worker, fast-worker, lean-worker, micro-worker: skills preload removed, commands inline; agentlens-tldr-worker definition line fixed) and in 18e6b49b (review fold: quicksilver skips gitignored paths, the tldr search comment, the CHANGELOG headline); installed into ~/.claude/agents on 2026-11-04 by a direct copy the owner chose, because `agentlenspro --install-skill` is refused (exit 69) while the kill-switch is armed.
