---
trdd-id: U4HP8TVD
title: Shipped worker agents preload five skills and auto permission mode for every user
column: proposal
status: proposed
created: 2026-11-04T19:25:29+0100
updated: 2026-11-04T21:24:41+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: user
assignee: main-agent@agentlenspro
approved: false
implementation-commits: [a2ba6005, 18e6b49b, 12ae0ed0, 74f19755, d29e0bc7]
---

# Shipped worker agents preload five skills and auto permission mode for every user

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-11-04
- Increment A (ship sonnet-worker and smart-worker) is committed as 12ae0ed0, local and unpushed. Verification: the worker ran check-types, eslint --quiet, check-identities, check-dist-contents and compile-tests (exit 0); the main agent reran the unit suite (mocha merged the named files with the .mocharc spec, so the whole suite ran): 3358 passing, 13 pending, 0 failing, autoSetup and shipped-agent tests included. Review folds: 74f19755 (smart-worker description without the model version and with a PICK IT WHEN line; sonnet-worker opener) and d29e0bc7 (example blocks rewritten; its premise was wrong, because the Agent catalog shows only the description, so body examples never reach the caller, and its counter-examples may read to the worker as a refusal). Still open: sonnet-worker's description ships a dated local incident sentence and a machine-specific ~140k token figure (provenance unverified).
- NEXT ACTION: the owner's answers (above); then copy both agents into ~/.claude/agents/ and cmp them (autoSetup overwrites a differing copy at the next CLI launch anyway, see TRDD-JCM1GZ1S); then increment B (js-test-writer, python-test-writer).
- Waiting on the owner: confirmation to hold merge-role-worker; keep or cut sonnet-worker's incident sentence; whether to drop d29e0bc7's counter-examples and fix routing in smart-worker's description instead (drop "Launch many in parallel for fan-out", trim the task list); permissionMode auto (already on all 7 shipped agents; 12ae0ed0 adds two more); the lean-worker questions. The installAgents overwrite risk is proposed in TRDD-JCM1GZ1S.
- Do not push 12ae0ed0 before the owner rules on the incident sentence.

Relocated from TRDD-RBBEX59R (line "Outside this card", handoff 2026-11-04T18:13), verbatim, so it is not lost. Owned elsewhere; every item awaited the owner when relocated; the Approval log records what has since been decided.

Owner questions on the shipped agents committed in fc2df568 and 88487010 (permissionMode auto and 5 preloaded skills for all users; a missing skill does not break the launch, measured on CC 2.1.318 -p; the lean-worker description says medium while its effort is high; the preload costs ~35-50k tokens per spawn, an estimate; micro-worker minimal footprint against the skills; the user rule delegation-and-orchestration.md names lean-worker as Sonnet).

Notes for the reader, not owner decisions:
- The ~35-50k tokens per spawn figure is an estimate from byte counts, not a measurement.
- A missing preloaded skill not breaking the launch was measured on CC 2.1.318 with -p only.
- The user rule delegation-and-orchestration.md is outside this repository.
- Sources added 2026-11-04 (from the session that wrote the agents, stated as reported, not re-measured when this card was edited): the five preloaded skill files total 126,557 bytes (graphify alone 47,544); micro-worker's last measured first request was 11,167 tokens, so preloading makes it roughly 4-5x larger (an estimate, not a measurement); the lean-worker description still steers "anything Haiku would get wrong" to an agent that now runs on Haiku; the edits live on branch fix/setup-agent-preflight and become permanent for users only after a merge to main and a release.

Supersedes TRDD-CA5U48BA, which trddgrep new created with a default mandate (pre-approved) that contradicted 'awaits the owner'.

## Approval log
2026-11-04 — the owner decided the preload half (verbatim under Owner decisions); the card's other questions still await the owner, so the column stays proposal.
2026-11-04 — the owner decided to ship sonnet-worker, smart-worker, merge-role-worker, js-test-writer and python-test-writer with agentlenspro (verbatim under Owner decisions); merge-role-worker is held: a departure from the owner's answer, flagged to the owner on 2026-11-04, awaiting their confirmation; the column stays proposal (permissionMode auto and the lean-worker questions still await the owner).

## Owner decisions

- 2026-11-04 — preload half DECIDED by the owner, verbatim: «make all the agents that are of type worker (those installed by agentlenspro) to use the trick of the agentlens-tldr-worker.md to save tokens: that is, instead of including the required skills in the frontmatter array like this: [skills: tldr-code, fastedit, jgrep, quicksilver, graphify] the agentlens-tldr-worker.md does not include any skill in the frontmatter to preload, instead it put the basic commands and instructions to use the skills tools in the body of the agent.» The example the owner quoted is the 'Navigate with tldr' section of agents/agentlens-tldr-worker.md.
- Closed by this decision: the five-skill preload on cheap-worker, fast-worker, lean-worker and micro-worker. Moot: the missing-skill launch measurement; the ~35-50k estimate (the 126,557-byte figure stays as the doc-sourced CHANGELOG basis); micro-worker minimal footprint against the skills.
- Still open: permissionMode auto for every user; the lean-worker description vs its effort and model; the user rule that names lean-worker as Sonnet.
- Agent's reading, not an owner decision: "(those installed by agentlenspro)" means the four workers above; agentlens-tldr-worker already conforms. Five user-scope agents not shipped by agentlenspro also preload skills (js-test-writer, python-test-writer, merge-role-worker, smart-worker, sonnet-worker); the owner was asked on 2026-11-04 whether to extend the change to them and answered the same day (second owner decision below).
- The implementation departs from the owner's example in two points: it does not copy the example's "Read with a tight offset/limit" paragraph, because these workers read with `tldr body` and the user's code-tools rule keeps the Read tool for images, PDFs and notebooks; and the example's own `tldr definition <symbol> <path>` line is broken (exits 2: tldr reads the second positional as a line number), so the workers and agents/agentlens-tldr-worker.md use `tldr definition --symbol <symbol> --file <file>`.
- Implemented in a2ba6005 (cheap-worker, fast-worker, lean-worker, micro-worker: skills preload removed, commands inline; agentlens-tldr-worker definition line fixed) and in 18e6b49b (review fold: quicksilver skips gitignored paths, the tldr search comment, the CHANGELOG headline); installed into ~/.claude/agents on 2026-11-04 by a direct copy the owner chose, because `agentlenspro --install-skill` is refused (exit 69) while the kill-switch is armed.
- 2026-11-04 — second owner decision, verbatim, answer to the question «Should they get the same change?» about sonnet-worker, smart-worker, merge-role-worker, js-test-writer and python-test-writer (user-scope agents agentlenspro did not install): «Ship them with agentlenspro». The option text the owner picked: «Add them to the repo's agents/ and the install list, then apply the same change. All users would get them on install.»
- Agent plan for that decision (agent decision, advisor consulted): increment A, committed as 12ae0ed0, ships sonnet-worker and smart-worker (same family as cheap/fast/lean; same Tools block; their bodies' sibling names lean-worker fixed to their own names; smart-worker's broken tldr definition form and Read offset/limit bullet replaced). Increment B ships js-test-writer and python-test-writer as a separate commit and review, because their own MANDATORY tldr rule (G5) needs a repair, not a block paste. merge-role-worker is HELD, not shipped: its description and body bind it to scripts/distill/prompts of the corpus-merge pipeline, so for other agentlenspro users it would be dead weight in their Agent catalog; this departs from the owner's literal answer and needs their confirmation, and until then it is not shipped.
- Increment B defects found 2026-11-04 (to fix in B): js-test-writer has a duplicate `permissionMode: auto` frontmatter key; its line 82 says the Edit tool is deliberately absent while `tools:` lists Edit (grep-verified 2026-11-04); its G5 rule lists `tldr definition <symbol> <path>` (exits 2), `tldr extract` and `tldr explain` (to verify against `tldr --help`); js-test-writer carries escaped backticks (114 lines with a backslash before a backtick, grep-counted 2026-11-04, not each inspected; python-test-writer's one match, line 758, is a Windows path ending in a backslash before a closing backtick, not an escape); js-test-writer line 1148 says tldr-code is preloaded, false once the preload is removed. Decide in B whether G5 points to the shared Tools block or keeps its own repaired list, one source either way.
- Disclosures to the owner (2026-11-04): every shipped agent's description is paid by every user in every session in the Agent-tool catalog, while the preload saving accrues only per spawn; once shipped, `installAgents` overwrites these names on every run, so they are edited in the repo's agents/, not in ~/.claude/agents/; sonnet-worker's description carries a dated local incident sentence that would ship to every user (owner's call; asked 2026-11-04, awaiting answer).
