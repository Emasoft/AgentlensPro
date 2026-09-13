---
trdd-id: 4J1QA18G
title: A write deferred inside an open agent window can be credited as reviewed by a fork that could not see it
column: todo
created: 2026-09-13T21:21:16+0200
updated: 2026-09-13T22:36:24+0200
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
OPEN VERIFICATION ITEM (2026-09-13): the guard test 'returned agents must leave deferIntervals' EXISTS, passes, and drives the real scanner (the test file makes 15 calls to scanMainTranscriptLines and 16 to scanSubagentTranscriptLines, so it is not a hand-built fixture). Its ASSERTION has NOT been read by the coordinator — only the worker's mutation report attests it. Do not treat the guard as confirmed until someone reads it. The sound assertion is REFERENCE IDENTITY: two spawns, one returned and one still open, assert deferIntervals.length === 1 AND that the survivor is the OPEN one by identity (strictEqual against the activity entry). The mutation adds members, so a copy passes a length check that coincidentally matches. Known vacuity shapes to rule out: asserting on scan.activity instead of scan.deferIntervals (the mutation leaves activity untouched, and the two fields are adjacent in the returned scan); a fixture whose transcript contains the spawn but never the agent's RETURN, so end stays Infinity legitimately under both versions; asserting a.end === Infinity about a member, which the filter guarantees by construction. Note the test file has a dropActivity helper that strips exactly activity and deferIntervals from comparisons — if that helper is used in these tests, they are vacuous.
COUNTERVAILING DEFECT, found 2026-09-13 — deferral also fails in the OPPOSITE direction, and this card told only one half. The freshness predicate is EXISTENTIAL: activity.some(a => covers(a, ms) && !deferred.has(a)). A write covered by a deferred interval AND ANY non-deferred interval is fresh and ARMS. So deferral does not mean 'this write belongs to an open agent'; it means 'no OTHER interval also claims it'. Overlapping windows therefore silently defeat deferral. This is LIVE, not theoretical: agents dispatched in the SAME response start milliseconds apart, so their windows overlap by construction, and this session did that repeatedly. Net: whether a write is deferred or armed depends on how many other agents happen to have overlapping windows — a race on dispatch timing, not a policy. Both failures are real and opposite; fix the predicate, not just the floor.
ON THE SLACK WINDOW — a review claimed the start-side slack has no mechanism and should be dropped. That is WRONG; the constant documents itself. ATTRIBUTION_SLACK_MS = 1000 with the comment 'mtimes and transcript timestamps come from the same clock; git times are whole seconds.' Whole-second truncation rounds DOWN, so a write's reported time can appear up to 1s EARLIER than it really was — which is exactly the mechanism the backward reach compensates for. Do NOT drop 'ms >= a.start - SLACK' on the latency argument: latency was the reviewer's inference, truncation is the documented reason, and they imply opposite fixes. The 1s magnitude does bound the manufactured-overlap window, but not for same-response dispatches, which are milliseconds apart.
SEVERITY RAISED 2026-09-13 — the mitigation this card relied on DOES NOT EXIST. Verified: applyEffects takes a MainScan (signature: 'export function applyEffects(scan: MainScan, fx: Effects): MainScan'), and there is exactly ONE production call site, fed by rawScan.lastForkTs from the MAIN scan. The file-write effects scan therefore runs ONLY on the main path. A subagent's SubagentStop does NOT arm on its own file writes — it arms on TEXT (proposal-shaped lines) only. Earlier entries on this card said a non-roled subagent's writes are 'probably covered by its own SubagentStop' and used that to narrow the defect to main-agent writes. THAT IS FALSE. Deferring a subagent's writes in the main gate leaves them covered by NOTHING, so the exposed class is every write by a still-open non-roled agent, not just the coordinator's. Supersedes the STILL-UNMEASURED bullet about subagent coverage: it is now measured, and the answer is the unfavourable one.
CONSEQUENCE for the exemption's justification: the regress that the roled-agent exemption prevents is NOT driven by a measure agent's file writes (it has none the scan can see — its report lands in gitignored reports/, and the scan uses git status --untracked-files=all, which surfaces untracked but NOT ignored files). The real mechanism is TEXT ARMING: textArms tests for a proposal-shaped line, and a measure agent's report proposes corrections by construction. Two existing test names corroborate that the subagent gate arms on text — 'an unroled lean-worker is still gated (C3)' and 'a marked proposal in a subagent return'. The exemption is still a termination precondition for the two-role tightening; state the reason as text arming, not writes.
SEVERITY RAISE RETRACTED — MEASURED 2026-09-13, and the measurement retires the whole argument chain above it. decideSubagentGate's signature is (agentType: string, scan: { didWork: boolean; reviewed: boolean; ownRole?: Role | null } | null). It takes didWork — NOT a MainScan, NOT effects paths. And toolUseWork returns { cause: 'edit' } for editor tool_use blocks. So A SUBAGENT DOES ARM ON ITS OWN WRITES, via its own tool_use blocks rather than via filesystem mtimes. The earlier entry claiming subagent writes are covered by nothing was an ARGUMENT FROM ABSENCE ('the effects scan is main-only') and it was WRONG: main-only effects entails only that the subagent gate does not learn about writes FROM MTIMES.
THE ASYMMETRY IS BY DESIGN, not a hole. A MAIN agent cannot see a subagent's or a Bash command's writes in its own transcript, so it needs the mtime scan — that is what unreviewedEffects is FOR. A SUBAGENT's own writes are right there as tool_use blocks, so it needs no mtime scan. Record this so nobody re-derives the wrong conclusion from the single-call-site observation, which is true and misleading on its own.
PROCESS NOTE, kept deliberately: this card's severity moved FOUR times in one evening (cancellation, then milder, then worse, then raised) and every move was driven by an ARGUMENT, each time in the direction of the most recent reviewer. The fifth move — this retraction — is the only one driven by reading the code, and it cost one tldr call. The direct check was recommended twice before it was performed. Freeze severity on this card until a claim is measured; do not move it on reasoning again.
BOTH LINKS NOW MEASURED (2026-09-13), closing the chain. (a) toolUseWork DOES handle Bash: reviewGate imports commandWriteReason from reviewGateTriggers and calls it ('const why = commandWriteReason(cmd, cwd)'), so write-shaped Bash commands count as work — which matters because every worker in this project writes via fastedit, a Bash command, not the Edit tool. (b) SUBAGENTS DO ARM ON TOOL_USE: the subagent scan contains 'else if (toolUseWork(b, cwd) !== null) didWork = true', and didWork is exactly the field decideSubagentGate consumes. Subagent write coverage is REAL and the earlier retraction is sound on its stated reason, not merely by luck.
THE EXEMPTION'S JUSTIFICATION — state it MECHANISM-AGNOSTICALLY, because it has already been written with the wrong mechanism once: 'A roled agent doing its job arms its own gate through the same work predicates as any other subagent — tool_use writes and/or proposal-shaped output text. The gate's remedy is to demand a measure agent and a review agent, each of which would arm the same way. Without the exemption that does not terminate.' That is true under every combination of the arming paths, so it cannot be falsified by a detail. Cite the code's own words rather than any cross-module comment: decideSubagentGate opens with 'THE RECURSION GUARD — a review fork is itself a subagent; reviewing it spawns a reviewer for...'. The function states the termination concern directly.
STILL UNMEASURED, carried forward deliberately: whether isEphemeralTarget excludes reports/. It is a SEPARATE predicate from the effects scan's gitignore exclusion (git status --untracked-files=all surfaces untracked but not ignored), and nothing establishes the two agree. Moot for this session — every worker wrote src/cli and src/test paths, which no reasonable ephemeral predicate excludes — but it decides whether a measure agent that writes ONLY a gitignored report arms at all. Read isEphemeralTarget before relying on either answer.
READ-DEBT DISCHARGED and the guard's SCOPE LIMIT measured, 2026-09-13. The assertion was read in full (copy the file to a scratch .txt and read that — the sanctioned route the tldr/fastedit rule already prescribes). It is NOT vacuous: it asserts on deferIntervals rather than activity, the fixture DOES contain the agent's return as a tool_result, it does not assert end === Infinity, and it drives the production scanner on real JSONL envelopes rather than a pre-built Activity array. Under the copy mutation the snapshot keeps end Infinity, the post-loop filter passes it, the array is length 1, and deepStrictEqual against the empty array fails — it reddens for the right reason. Emptiness is STRONGER than reference identity for this fixture, not weaker: the expected length is 0 and the mutation strictly adds, so no coincidental match is possible.
THE SCOPE LIMIT, so nobody over-trusts this guard: 'move the filter inside the scan loop' names SEVERAL distinct edits with different outcomes. If the mutated filter still runs on every iteration, the final evaluation happens on the LAST line, by which time the interval has closed — the array comes out empty and the test PASSES GREEN UNDER A REAL DEFECT. It reddens only when the filter is evaluated at push time or its result is captured before the return. The references-vs-copies hazard this card names IS caught; that sibling class is not. A second test would close it: two spawns, one returned and one still open, asserting the survivor is the OPEN one by reference identity — which also catches a mutation that keeps the wrong element.

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
