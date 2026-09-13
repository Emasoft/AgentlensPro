---
trdd-id: WAW0M092
title: Worker writes arm the main gate as the coordinator's own, and the demanded remedy cannot review them
column: todo
created: 2026-09-13T21:29:52+0200
updated: 2026-09-13T21:33:15+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: refactor
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-13T21:29:52+0200
priority: medium
---

# Background workers write into the repo mid-edit so the gate arms on files nobody has finished writing

Identified 2026-09-13 as the ROOT-CAUSE alternative to Q3 (deferIntervals). Q3 suppresses the symptom at the safety gate; this fixes the cause in the dispatcher. Cheaper and more honest.

## The pathology, observed live

On three consecutive turns the Stop gate armed naming files a still-running background worker was mid-edit:

- reviewGate + reviewSupervisor + reviewGate.test
- reviewGateTriggers.test
- reviewGate

Each cost one full adversarial fork (~300k tokens; ~900k total) to review content that was not finished being written. The amplifier is that janitor heartbeat fires are TURNS, landing on a schedule uncorrelated with worker completion — so the main agent is forced to end turns while workers write, whether or not it wants to.

## Why this is NOT an argument for Q3

Those three arms were CORRECT. The main agent stages and commits the workers' output; a worker's own SubagentStop review happens in the worker's context, on the worker's understanding of its own brief, and is not a review on behalf of the agent that will commit. The gate saying 'left unreviewed changes on disk' was literally true each time — the coordinator had read none of it.

Q3 would have suppressed all three arms (mechanism verified: non-roled Agent spawn, end === Infinity, write mtime inside the open interval, freshness consults the deferred set). That makes Q3 a change to a SAFETY GATE motivated by TOKEN COST, which is the archetypal bad change. Record it as an observation, never as validation.

## The fix, upstream

Workers write to a scratch path and LAND files into the repo only on completion (atomic rename). Then no mid-edit window exists, the gate's mtime view matches reality, and the arm happens once, on finished content that is actually reviewable.

Benefits over Q3: no safety-gate change; no interaction with the staleness floor (TRDD-4J1QA18G); the arm still fires, so unread worker output is still surfaced to whoever commits it.

## Worked example — the marker near-miss (belongs with the marker trust-boundary card)

The prompt dispatching one of these workers contained the text ROLE + colon + MEASURE inline, in backticks, mid-sentence, as part of an instruction warning against emitting it. The crediting predicate is anchored to line-start, so it did not match and the worker stayed non-roled. Had that instruction been formatted on its own line, the worker would have been credited as roled, excluded from defer candidacy, and behaved differently. The injection surface came within one line-break of firing in the very turn it was being carded. Use this as the test fixture.

## Acceptance
- [ ] Workers write to scratch and land atomically on completion; no repo file carries a mid-edit mtime.
- [ ] Re-run a multi-worker session and confirm the gate arms once per landed change, not once per turn.
- [ ] Decide explicitly whether Q3 is still wanted once this lands, or whether it becomes redundant.

## Approval log

- 2026-09-13T21:29:52+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## AMENDMENT 2026-09-13 — the body above inverts the causal claim

1. WRONG, and it was the organising sentence: scratch-path is NOT the root-cause fix and Q3 is NOT the symptom fix. The gate arms on mtime > lastForkTs, not on mid-edit-ness. A file landed atomically at completion is STILL newer than the last fork, so it still arms. Scratch-path reduces arm COUNT (roughly 3x here: once per worker instead of once per turn-while-writing); it does not eliminate the arm. The actual cause of these arms is that a background agent's write is attributed to the coordinator's turn — and the change that fixes ATTRIBUTION is Q3. They are complementary, not alternatives.
2. STRIKE the sentence calling Q3 'a change to a SAFETY GATE motivated by TOKEN COST'. That is false about Q3's origin: Q3 predates this session's cost observation and has a stated correctness rationale (an open agent's writes are incomplete, so judging them is premature). Being caught over-reading evidence once does not license under-reading it. What survives is only: record the live observation, never as validation.
3. Q3 is RESCUED by a point the body missed. The gate's prescribed remedy is a fork that must make ZERO tool calls and sees only inherited transcript context — a worker's file writes are not in the parent transcript as content. So the remedy is structurally INCAPABLE of reviewing what it armed on. Every such arm spawns a fork that cannot see the write and advances lastForkTs past it, marking it reviewed. Three occurrences is the EXPECTED rate for this input class, not bad luck. Deferring until the worker returns, when the diff can actually be read, is therefore strictly more honest than crediting it unreviewed now: Q3 converts a false 'reviewed' into 'not yet judged'. That is a correction, not a silencing — conditional on fixing the staleness floor (TRDD-4J1QA18G).
4. The proposed mechanism adds a SILENT LOST-UPDATE RACE. Copy-out, edit, rename-back is read-modify-write with no compare-and-swap; two concurrent workers, or a worker and the coordinator, and the last rename silently wins. A mid-edit window is transient and observable; a lost update is permanent and silent — a strictly worse failure class, and this session ran three workers concurrently. Also: rename(2) is atomic per PATH, so a multi-file change (the rename touched three) is a SEQUENCE of renames, i.e. a coarser mid-edit window, not none. And editing a detached copy breaks the tree-sitter tooling's model, since impact analysis would run against a tree that no longer matches the edit target.
5. The CHEAPEST fix is not on this card at all: batch writes into fewer turns. Roughly half this session's fork count came from placing each card write in its own turn; batching costs nothing and would have halved it. Do that before restructuring any worker I/O.
6. 'Q3 would have suppressed all three arms' was REASONED, not executed — mark it so. The raw-token figures (~300k each, ~900k total) are unweighted and this project's doctrine forbids that accounting: forks inherit the parent cache at 0.1x while fresh workers pay a cold prefix write at 1.25x, so the forks were the cheap half. Drop or weight the figures. The marker near-miss fixture belongs on the marker trust-boundary card, not here — a card holding another card's fixture is how fixtures get lost. Acceptance row 1 is untestable as written (you cannot observe the absence of a transient); rewrite as 'a worker's repo file mtime changes exactly once per worker run'. Row 3 belongs on Q3's card.
