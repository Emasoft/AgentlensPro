---
trdd-id: JCM1GZ1S
title: installAgents overwrites a user's own same-name agent without a backup
column: proposal
status: proposed
created: 2026-11-04T21:15:10+0100
updated: 2026-11-04T21:24:58+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: user
approved: false
---

# installAgents overwrites a user's own same-name agent without a backup

Problem: installAgents (src/cli/hookInstall.ts, the function after AGENT_NAMES) overwrites any existing ~/.claude/agents/<name>.md whose bytes differ from the shipped file, with no backup. Its doc comment says so on purpose: an existing file with a shipped name is overwritten, because that is what makes an upgrade work. A user who already has their own agent under a shipped name loses it on install, and again at every CLI launch: autoSetup (src/cli/autoSetup.ts, the agentDrift loop) marks a file whose bytes differ as stale and repairs it through installAgents, so a restored file is overwritten again. Every name in AGENT_NAMES is exposed (7 as of 17d39d8f); the generic names sonnet-worker and smart-worker, shipped by 12ae0ed0 (TRDD-U4HP8TVD), are likelier to collide (an inference from the names, not data).

Proposed, for the owner to decide: before overwriting a file that differs, tell an older agentlenspro copy apart from the user's own file, and back up (or refuse to overwrite and report) only the user's own. Open question: how to tell them apart — a provenance marker in the shipped frontmatter, or a hash of every shipped version. A third option removes the collision instead: ship the workers under a namespaced name, as agentlens-tldr-worker already is, at the cost of a rename for existing users. A backup should reuse the backup-then-rename discipline safeConfigEdit already applies to user config, not a new mechanism.

Found by the adversarial review of commit 12ae0ed0 on 2026-11-04.

## Approval log
