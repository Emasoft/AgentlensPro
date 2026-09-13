---
trdd-id: 4J1QA18G
title: A write deferred inside an open agent window can be credited as reviewed by a fork that could not see it
column: todo
created: 2026-09-13T21:21:16+0200
updated: 2026-09-13T21:33:45+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: bugfix
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-13T21:21:16+0200
priority: high
---

# A deferred write may not arm again until the fork-timestamp floor resets

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes everything below) — 2026-09-13

THE DEFECT: a write falling inside a still-open non-roled agent interval does not arm that turn. Deferral is keyed on interval IDENTITY and self-closes correctly when the agent returns. But arming ALSO requires mtime > lastForkTs, and every armed turn spawns a fork that pushes that floor forward. Once the floor passes the write, it stops arming — until the floor RESETS.

MEASURED first-hand 2026-09-13, and this is what settles the severity:

- The gate MODULE is stateless (no writeFileSync; decideMainGate(scan) is a pure boolean function over a per-turn scan) — but module statelessness is NOT system statelessness, and concluding otherwise was an error. THE TRANSCRIPT IS THE STORE: fork entries are durably appended and never removed, so an entry recorded at time T permanently holds the floor above T while it is in the scan window. That IS a durable credited-marker, externalised rather than absent. The false-credit framing therefore SURVIVES — the write is un-armable while that entry persists, and no code needs to remember it. (The writeFileSync search was also narrow: it would miss appendFileSync, fs.promises, openSync+write, createWriteStream, renameSync and aliases.)
- Floor reset path 1: lastFork === -1 ? firstTs : lastForkTs, read verbatim. An empty fork window drops the floor to the start of the transcript.
- Floor reset path 2 is NOT a reset path — corrected 2026-09-13 after getting the direction backwards. The scan reads the LAST 4 MB, i.e. the most recent. lastForkTs is the MOST RECENT fork, so it is in-window BY CONSTRUCTION; what slides out is OLD content, which cannot lower the floor. 9.2 MB > 4 MB proves the window is exceeded, NOT that fork entries leave it. Likewise the -1 branch needs NO fork anywhere in the last 4 MB, near-impossible while the gate compels a fork on every armed turn. RECOVERY IS RARE. It fires only across a long stretch with no forks at all.
- NOT a reset path: compaction. Measured n=1 on this session manual compaction — 2401 pre-compaction entries survived in the transcript file, so it did not truncate. Scoped: not established for auto-compaction or other versions, and it was NOT verified that the gate reads this particular file.

CONSEQUENCE: a LATENCY defect with an unusual recovery profile, not a permanent hole. A deferred write can go unarmed for a stretch, then arm again at the next floor reset. Whether that stretch is acceptable is the open question.

STILL UNMEASURED — do not treat as settled:
- Whether a non-roled subagent own SubagentStop arms on its own writes. Plausible (its own transcript, its own floor, the -1 branch) but nobody ran it. ONE test settles it: a background subagent writes a file, assert its own SubagentStop arms.
- Line 44 of the effects module, the predicate conjoining the deferred set. Line 43 (ms > sinceMs &&) was read verbatim and short-circuits first, so line 44 cannot change the above — but it decides the SHAPE of any fix, so read it before patching.

NEXT ACTION: read line 44, run the subagent-coverage test, then choose between fixing the floor and dropping deferral in favour of TRDD-WAW0M092 (workers land files atomically on completion), which removes the mid-edit window upstream and may make this moot.
REPRODUCER (do this before reading any of the argument below): spawn a background agent; while it is still open, write a repo file; spawn any fork so lastForkTs advances; observe that the write never arms. That is the defect, in four steps.

## Supersession history

Everything below is the original body plus two rounds of correction, kept unedited as the audit trail. Three characterisations were tried and superseded — cancellation, then empty-credit-is-milder, then empty-credit-is-worse. The STATE block above governs; the stateless measurement retired all three.

Found 2026-09-13 by an adversarial review of the Q3 defer-intervals change, then verified against source. BLOCKS committing Q3 as designed.

## The chain (each line read from source, not inferred)

- reviewGate: applyEffects(rawScan, unreviewedEffects(cwd, rawScan.lastForkTs, {...})) -- so sinceMs IS lastForkTs.
- reviewGateEffects:43 -- return (ms) => ms > sinceMs && (activity === undefined ...
- reviewGateEffects:40 -- const deferred = new Set(deferIntervals ?? []), consumed at :44 via .some/covers/.has
- reviewGate -- const deferIntervals = deferCandidates.filter((a) => a.end === Infinity)

## The defect

Deferral is keyed on interval IDENTITY, which is correct and self-closing: the scan is stateless and re-derived every turn, so when the agent returns its end leaves Infinity, it drops out of deferIntervals, and the write becomes eligible again.

But eligibility ALSO requires mtime > lastForkTs, and that floor only moves forward. Every armed turn spawns a review fork, which advances lastForkTs. So:

1. Turn N: a write at time T lands inside an open non-roled agent interval. Deferred; does not arm.
2. That turn, or any later one, arms for some other reason and spawns a fork. lastForkTs becomes > T.
3. The agent returns. The write is no longer deferred -- but it is now STALE, so freshness() is false.
4. It never arms. Nobody reviews it.

This is the SAME failure that refuted the earlier deferral-by-timestamp proposal, reached by a different route. That proposal was rejected precisely because lastForkTs advances and makes the deferred write older than the floor. Q3 inherits it: the deferral is identity-based but the freshness floor is not.

## Severity depends on whose write it is -- both need deciding

- A SUBAGENT own writes are probably still covered by that subagent own SubagentStop gate, so deferring them in the main gate may be harmless. UNVERIFIED -- confirm before relying on it.
- MAIN-AGENT writes swallowed by a stale window have NO second gate. deferIntervals are index ranges, not per-agent scopes, so any main-agent write falling inside one is affected. This is the case with no fallback.

Q3 therefore converts reviewed-possibly-prematurely into possibly-never-reviewed for that class. That is a regression in the gate core guarantee, not a refinement.

## Candidate fixes (none chosen)

- Exempt deferred writes from the staleness floor: remember the write mtime against the interval rather than the global floor. Collides with the stateless-by-design constraint (TRDD-9FG0LSPG rejected stored fingerprints) -- the tension is the point, resolve it explicitly.
- Do not advance lastForkTs past an outstanding deferral.
- Drop deferral entirely and accept early arming, relying on the subagent own gate.

## Acceptance
- [ ] A test proving a deferred write still arms AFTER an intervening fork advances lastForkTs. It must redden on today code.
- [ ] Decide and record whether a subagent own SubagentStop genuinely covers its writes.
- [ ] Either fix the floor or drop deferral; do not ship Q3 until one is chosen.

## Approval log

- 2026-09-13T21:21:16+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## CORRECTION 2026-09-13 — supersedes the framing above

An adversarial check refuted the central claim. The mechanism traced above is real and its evidence is verbatim-read, but FOUR conclusions drawn from it are wrong. The body above is kept unedited as the audit trail; this section governs.
1. NOT cancellation. A failing `ms > sinceMs` means a review fork ran while that write was already on disk — that is freshness working as designed. The real defect is narrower and different: a fork reviews the TRANSCRIPT, and a background subagent's writes never appear there as content, so the write is CREDITED AS REVIEWED by a fork that had no visibility into it. Empty credit, not a lost write.
2. lastForkTs is NOT monotonic. Three reset paths: `lastFork === -1` falls back to `firstTs`; the scan reads only the last 4 MB, so a long session can slide every fork entry out of the window; and compaction can rewrite the transcript. A stalled write therefore RESURRECTS at the next transcript boundary. This is a latency bug with an odd recovery profile, not a permanent hole.
3. NOT the same failure as the refuted deferral-by-timestamp proposal. That one deferred BY timestamp, so the deferral itself decayed. This defers by interval identity, which self-closes correctly, and merely inherits an independent staleness floor that exists for a defensible reason. Same symptom, different mechanism — whoever works this card will hunt the wrong bug if they believe otherwise.
4. The subagent half is SETTLED, not unverified. A non-roled subagent's own SubagentStop scans its own transcript, where its writes are visible and attributable; if it never spawned a fork, `lastFork === -1` gives `firstTs` and everything is fresh, so it arms. Subagent writes are covered. The exposed case is MAIN-AGENT writes landing inside an open agent window — the exact shape of spawning a background worker and continuing to edit.
5. REPLACES the first acceptance row. Do not test that a deferred write arms after an intervening fork — if a fork ran with the write in scope, not arming may be correct. Test instead: a write made by a background subagent, invisible in the parent transcript, must not be credited as reviewed by a parent-turn fork.
6. Q3 is NOT blocked by this. The gate is not deployed, so the hole cannot fire; ship Q3 with this card referenced and a do-not-deploy-until-resolved line in the commit message. Line 44's exact predicate still needs reading before anyone writes the fix, since it decides the shape of the patch.
--- AMENDMENT (same day, after a second adversarial check): the correction above over-corrected. Five fixes follow. Where this amendment and the six points disagree, THIS governs.
A. Point 1 softened the WRONG DIRECTION. A falsely-credited write is WORSE than an uncancelled one, not better. An unarmed-but-pending write is an OPEN obligation — the floor may reset, a boundary may re-expose it, a human may notice. A write credited as reviewed is a CLOSED obligation: nothing reopens it, and every downstream consumer reads the gate's silence as a pass. The vocabulary of point 1 ('NOT cancellation', 'empty credit, not a lost write', 'latency bug', 'resurrects') de-escalates while conceding something strictly more severe.
B. Point 2's compaction reset path is FALSE — measured, not argued. The session transcript is append-only jsonl: after this session's 20:53 compaction the file still held 2401 entries timestamped before it (9.2 MB, 3259 lines). Compaction changes what the MODEL sees, not the file the gate scans. Two reset paths survive and both have evidence: the verbatim-read 'lastFork === -1 ? firstTs' branch, and the 4 MB scan window — live right now, since 9.2 MB already exceeds it. Resurrection is therefore RARER than the correction claimed.
C. Point 4 must read ARGUED, NOT MEASURED. It promoted an UNVERIFIED to SETTLED on a chain nobody executed, which is exactly what the three-marker scheme exists to prevent. The chain also has an unnoticed gap: nothing verified that the subagent path even reaches unreviewedEffects with its own floor — the '-1 to firstTs' branch applying there was inferred. One small measurement settles it: a background subagent writes a file, assert its own SubagentStop arms.
D. Point 6's reason is unsound and self-defeating. 'Cannot fire because not deployed' is a race, not a safety property — and esbuild bundles the WORKING TREE, not HEAD, so the uncommitted diff was always one command from deployment. Holding therefore protected nothing either. Commit anyway, but for RULE 0 and the working-tree fact, never for 'cannot fire'. A line in a commit message binds no future session; a reddening test or a blocked column would.
E. Point 3 overstates separation. 'Different mechanism' is right, but both are timestamp-floor interactions — say 'different mechanism, shared root', so nobody misses that fixing the floor may address both. Also: the header says FOUR conclusions are wrong and then lists SIX points; the count is wrong, treat all six as amended by this section.
