---
trdd-id: YGETIBJS
title: Deploy the two-role review gate — rebuild and restart the server
column: blocked
created: 2026-09-13T22:38:39+0200
updated: 2026-09-14T08:45:32+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: infra
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-13T22:38:39+0200
blocked-by: [40M4UPK3]
unblock-when: [trdd:40M4UPK3]
pre-block-column: todo
blocker-probe: [trddgrep, why, YGETIBJS]
blocker-holds-if: not-match:READY
---

# Deploy the two-role review gate — rebuild and restart the server

The gate changes are COMMITTED and NOT DEPLOYED. This card is the deploy step, parked at blocked ON PURPOSE so the hold is a BOARD STATE rather than a sentence in a commit message that binds nobody.

## Why this is blocked, not todo

3555741c's net runtime change is ONE tightening (the main gate now needs two roled reviewers) and TWO RELAXATIONS: writes inside a still-open non-roled agent's window stop arming, and a roled agent skips its own gate. Each relaxation has an open defect card. Deploying now ships both.

Nothing mechanical currently prevents it: the CLI is npm-linked into this checkout (type -a shows exactly ONE match on PATH), so anyone running the repo's bundler for an unrelated reason deploys the relaxations at the next hook fire, with no confirmation step and nothing going red.

## Blocked by
- 1YXR6S47 — the loose-credit polarity is inverted; fix decided (whole-line exact compare, trimEnd, fail closed on ambiguity)
- 4J1QA18G — deferral is timing-dependent in BOTH directions
- BA0DCW98 — a quoted role marker self-exempts an agent

## The deploy procedure, when unblocked
1. Run the repo's bundler — and VERIFY IT EXITED 0. A FAILED bundle run leaves the STALE output in place with an unchanged mtime, so it looks current (CLAUDE.md, commit 36c87c8: code sat un-shipped for a day this way).
2. grep the bundle output for a symbol new to this change; do not trust the mtime.
3. Run the server restart verb — the hook path picks up the new bundle at the next fire, but the LONG-LIVED SERVER does not.
4. A Claude Code session restart is NOT the lever and is not required for a bundle change.

## Acceptance
- [ ] All three blockers terminal.
- [ ] Build verified by symbol grep, not mtime.
- [ ] Server restarted; hook observed emitting the two-role message rather than the single-fork one.
NOTE on what this card does and does not do: it ENFORCES NOTHING, because no build step reads the board. Its value is DISCOVERABILITY: the janitor heartbeat prints blocked cards on every fire, so the hold surfaces unprompted instead of being reachable only by someone who already knows which commit to read. unblock-when lets trdd-drift restore the card automatically once all three blockers are terminal. If holds like this recur, real enforcement is one more check script in the existing compile and package chain that exits non-zero while a blocked deploy card exists.

## Approval log

- 2026-09-13T22:38:39+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Hold repointed 2026-09-14

The three blockers 1YXR6S47, 4J1QA18G and BA0DCW98 are superseded by TRDD-40M4UPK3, whose redesign deletes their code paths; the hold now waits on 40M4UPK3 so superseding them cannot release the deploy early.
