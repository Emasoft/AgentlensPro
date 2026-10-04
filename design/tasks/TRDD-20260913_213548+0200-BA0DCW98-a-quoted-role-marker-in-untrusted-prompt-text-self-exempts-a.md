---
trdd-id: BA0DCW98
title: A quoted role marker in untrusted prompt text self-exempts an agent from its own review gate
column: ai_review
created: 2026-09-13T21:35:48+0200
updated: 2026-10-04T13:55:48+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: security
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-13T21:35:48+0200
implementation-commits: [90446356]
---

# A quoted role marker in untrusted prompt text self-exempts an agent from its own review gate

## Mechanism

`exemptRoleStrict` (src/cli/reviewGate.ts) matches the `ROLE: MEASURE`/`ROLE: REVIEW` marker
ANYWHERE in an agent's prompt TEXT, not just in trusted, harness-authored boilerplate. If an
agent's prompt embeds untrusted third-party text — a fetched doc, an issue body, a pasted
transcript, a commit message — and that text happens to contain a bare marker line matching
`^ROLE: MEASURE\s*$` or `^ROLE: REVIEW\s*$` on its own line, the agent SELF-EXEMPTS from its own
review gate. No bug is needed to trigger this, only a quotation containing the marker text
(written here in backticks mid-sentence to avoid arming the very hole this card describes, e.g.
a line reading `` `ROLE: MEASURE` `` quoted verbatim from some external source).

## Provenance

This was an ACCEPTED design decision in the original brief for the strict/loose predicate split
(matching "ANYWHERE in the prompt" was deliberate, to fix an earlier regression where a
first-line-only rule missed every roled agent because the harness prepends boilerplate ahead of
the `ROLE: ...` line). It is escalated to a tracked card now because TWO INDEPENDENT reviews
flagged it as a genuine trust boundary rather than an acceptable residual.

## Candidate mitigations

1. Require the marker within the first N lines AFTER the harness's own boilerplate — i.e.
   position-bounded as well as `$`-anchored, so a marker buried deep in quoted third-party
   material past the boilerplate no longer counts.
2. Use a marker shape that cannot occur in ordinary prose or pasted external text — e.g. a
   per-session nonce, or a syntax such as `ROLE::MEASURE` (double colon) that no legitimate
   external document is likely to contain verbatim.
3. Simpler than both above: require the marker to be the prompt's literal FIRST non-whitespace line, full stop -- no boilerplate-length bookkeeping needed, since the harness always prepends its own boilerplate before a roled agent's `ROLE: ...` line (per the runMainGate directive-construction comment). Cheaper than option 1 (no drift-prone N-line/boilerplate-length tracking) and non-breaking (no marker-shape change). Considered and should be evaluated before 1/2; recorded here so it isn't silently dropped (peer review finding, 2026-09-13).

## Acceptance criteria

- [x] A test asserts the marker is NOT honoured when it appears after 50+ lines of quoted
      external material preceding it in the same prompt (i.e. buried past any reasonable
      boilerplate bound).
- [ ] Whichever mitigation is chosen is implemented in `exemptRoleStrict` (and, if it changes the
      marker's own text/shape, in `creditRoleLoose` and the `MEASURE_ROLE_RULE`/`REVIEW_ROLE_RULE`
      directive strings the harness publishes to agents).
- [x] Existing tests in reviewGate.test.ts covering the marker anchoring (including the new
      "trailing prose" asymmetry test) still pass unmodified in intent.

## Why this is carded, not hot-fixed

Changing the marker format changes the PROMPT CONTRACT with every already-deployed roled agent
(MEASURE/REVIEW workers spawned per the gate's own directive strings) — a live-migration
concern, not a one-line patch. It needs a deliberate rollout decision, hence a tracked card
rather than an in-place fix.

## Approval log

- 2026-09-13T21:35:48+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
2026-09-24T09:06:30+0200 -- Implementation (worker, TRDD-BA0DCW98). Split declaredRole into two predicates in src/cli/reviewGate.ts: declaredRole (credit path, reads the parent's own Agent tool_use input.prompt -- never harness-wrapped) is now anchored to the prompt's literal FIRST non-whitespace line (candidate option 3), closing the hole for the parent-gate-release direction. declaredRoleOwnTranscript (self-exemption path, feeds ownRole/subagentExempt, reads a spawned agent's OWN first transcript entry) is LEFT UNANCHORED, unchanged, on live orchestrator direction: per TRDD-3U8AIHXK that read may carry harness-added preamble ahead of the marker, so anchoring it without measuring the real wrapped shape risks falsely de-exempting every real REVIEW/MEASURE fork and deadlocking the gate. Box 2 (implement in exemptRoleStrict, i.e. the self-exemption predicate the card's own title describes) is therefore left UNCHECKED -- the literal self-exempt scenario in the card title is NOT fully closed; only its credit-side counterpart is. Follow-up needed: measure a real MEASURE/REVIEW fork's own first transcript entry to learn the actual wrapped shape, then anchor declaredRoleOwnTranscript the same way. Sites checked: reviewGate.ts declaredRole (fixed) + declaredRoleOwnTranscript (deliberately left, documented); reviewSupervisor.ts:86 (reads b.input?.prompt, same shape as the credit site, automatically covered, no edit needed); reviewLoop.ts roleFromPromptFirstLine (already first-line-anchored, untouched per scope boundary -- file owned by TRDD-40M4UPK3) and ownFileRole (substring match on own transcript first 5 lines, feeds mayWrite's WRITE-DENIAL for role forks -- false positive only makes the agent MORE restricted, not less, so left as-is, not a self-exemption vector); reviewGateTriggers.ts NOT touched (owned by TRDD-J2K6IM4R, concurrently modified by another worker during this session -- its diff in git status is NOT mine). Tests: reviewGate.test.ts declaredRole suite rewritten for first-line semantics (cases a/b/c/d from the assignment all present); new declaredRoleOwnTranscript suite locks the deliberately-unchanged loose behavior. Checks: check-types, lint (0 errors, 456 pre-existing warnings), compile-tests all exit 0; mocha --grep reviewGate|reviewSupervisor: 95 passing. Mutation check: reverted declaredRole's anchor, confirmed 4 tests including the 50-line-buried case (b) go red, restored via file copy, reconfirmed 95 passing. Reports: reports/ba0dcw98/.
- 2026-09-24T09:47:45+0200 — column → ai_review by main-session. first-line credit anchoring landed in 25113e6d and 7ecc6ad7; box 2 residual carded as 8YM21R5X

## Notes

2026-09-24: directive/message parity worker pass. REVIEW_ROLE_RULE/MEASURE_ROLE_RULE and demandText() in src/cli/reviewGate.ts now say the marker must be the prompt's FIRST line (matching declaredRole's actual anchor); REVIEW_GATE_DIRECTIVE already said 'literal FIRST non-blank line' and needed no change. reviewSupervisor.ts already imports and reuses declaredRole from reviewGate.ts (line 23/86) -- no parity gap there, verified by reading. Added a parity test (src/test/reviewGate.test.ts, 'the FIRST-line instruction and declaredRole agree') asserting a prompt built exactly as instructed is credited and one line of prose before the marker is not. Mutation check: reverting declaredRole to the old unanchored /m regex made 6 tests fail (incl. the new parity test); restored exactly, git diff confirmed clean of the mutation. types/lint/compile-tests/mocha all green (136/136 on reviewGate+reviewGateTriggers+reviewSupervisor). Deploy still needs: bundle delta enumerated (node esbuild.js diff), a rollback copy of standalone/cli.js kept before deploy, and a live probe against the running collector once deployed -- none of that was done in this worker pass (RULE 1 scope: no build/install/restart).
2026-09-24: review-fork correction to the note above -- the directive's self-exemption sentence (line ~138, describing subagentExempt/ownRole via declaredRoleOwnTranscript) WAS wrong and DID need a fix (my first pass wrongly called it already-correct): it borrowed declaredRole's first-line wording for a check that is deliberately unanchored. Fixed to state the two checks separately, with the residual pointed at TRDD-8YM21R5X. Also fixed a self-contradictory demandText() parenthetical ('nothing before it, not even blank lines with text' vs the code's actual leading-blank-line tolerance) and corrected the mutation report's list of which tests actually failed (verified from the log: 6 failures were the buried-marker, second-marker, short-preceding-prose, first-line-anchor MUTATION CHECK, one scanTranscriptLines test, and the new parity test -- NOT the trailing-prose or dollar-anchor tests as first written). Added a supervisor-side parity test. Full detail: reports/ba0dcw98/20260924_092919+0200-predeploy-review-fixes.md. types/lint/compile-tests/mocha all still green (137/137).
2026-10-04: worker wA re-ran the gate suites (scoped run reviewGate|reviewSupervisor: 105 passing, 0 failing). Box 2 is re-scoped to TRDD-8YM21R5X (declaredRoleOwnTranscript anchoring) and stays unticked here.
2026-10-04: code and tests done at 90446356; effective only after the installed hook bundle is rebuilt (owner).
