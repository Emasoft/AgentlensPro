---
trdd-id: 1YXR6S47
title: The documented loose-credit strict-exempt polarity is inverted on the security axis
column: todo
created: 2026-09-13T21:39:12+0200
updated: 2026-09-13T21:40:16+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: security
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-13T21:39:12+0200
priority: high
---

# The documented loose-credit strict-exempt polarity is inverted on the security axis

Found 2026-09-13 by security assessment against verified source. This CONTRADICTS a rationale already written into a source comment and into a drafted commit message. Fix both.

## The claim that is wrong

The comment says: crediting must be LOOSE because a miss only over-blocks (noisy and safe), exemption must be STRICT because a false match lets an agent skip review entirely (silent and unsafe).

That reasoning only considers the loose predicate's MISS. Its FALSE MATCH is strictly worse than the strict predicate's:

1. SUPERSET. A bare whole-line marker trivially satisfies line-start, so every exemption injection is ALSO a crediting injection. Crediting fires on a strict superset of inputs.
2. WEAKER TRIGGER. The loose form has no end anchor, so ordinary prose matches — e.g. a line beginning with the measure marker followed by ' the impact of the change'. The strict form rejects it. Accidental occurrence is plausible for credit, near-nil for exempt.
3. WIDER EFFECT. Exemption releases ONE subagent's own gate. Crediting releases the MAIN gate for the whole turn, including the main agent's own edits.
4. DISABLES THE BACKSTOP. The supervisor's noteRole sets unreviewed = 0 on a credited pair — that is the alarm counter, so a successful credit also suppresses the escalation that would have surfaced the miss. Exemption leaves the alarm intact.

## Second finding — the null rule is a DENIAL OF SERVICE vector

Both predicates use 'm === r ? null : ...', so matching BOTH markers returns null. Injecting both markers into a LEGITIMATE reviewer's prompt means that reviewer is never credited, min(measure, review) >= lastWork never satisfies, and the main agent is permanently blocked. Fail-safe for integrity, fail-OPEN for availability: a gate that quoted text can wedge shut.

## Third finding — result text is a second injection surface

Verified: the supervisor calls noteRole(resultRole(resultText(b.content))). Crediting is fed by RESULT text, not only spawn prompts. So the 'needs two separate Agent spawns' bound collapses — one legitimate spawn plus one crafted RESULT clears the counter, and result text is agent output, precisely where content an agent read gets echoed back.

## On the strict predicate's actual guarantee

The strict form uses whitespace-star before the end anchor. Whitespace matches newline and the end anchor matches before a line terminator under the multiline flag, but backtracking makes trailing next-line text harmless — the match lands at the original line end. So STRICT MEANS WHOLE-LINE, NOT ISOLATED. It guarantees only that nothing but whitespace follows on that line. A bare marker line buried at line 400 of a pasted document exempts exactly as well as one written deliberately. The anchor does not mitigate the carded injection hazard.

## Acceptance
- [ ] Correct the source comment and any commit message repeating the inverted rationale. The honest statement: exemption is narrower in PRECONDITION but crediting is worse in CONSEQUENCE, and loose matching is the higher-risk half.
- [ ] Decide whether crediting should also be whole-line anchored. Ranking says yes; the cost is that a trailing space silently uncredits an honest reviewer, which is the wedge in finding 2.
- [ ] Test: a prompt line beginning with a role marker followed by ordinary prose must not credit.
- [ ] Test: both markers present must not permanently block an honest reviewer.
- [ ] Re-examine crediting from result text given finding 3.

## Approval log

- 2026-09-13T21:39:12+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## DECISION 2026-09-13 — the fix to ship

FALSE CREDIT beats the wedge. A wedged agent is loud, immediate and self-reporting — the main agent stops, the user sees it, someone investigates in minutes. A false credit is silent and the write is already in the tree. Trading availability for integrity IS the point of a gate. Note also who pays: a wedge blocks this session's author, who can diagnose it; a false credit harms whoever inherits the code, who cannot. And the wedge is recoverable by construction (the -1 to firstTs branch, or rewording one line); a shipped unreviewed write is not.
SHIP trim-then-exact-compare, NOT a tighter regex. Split the text on newline, trim each line, exact-compare against the two marker strings, take the first non-null. This kills all three failures the two regexes were juggling — trailing-space wedge (trim), prose false match (exact compare), CRLF (free) — and it reads as what it is. The whitespace-star-before-end-anchor form requires the reader to know that whitespace matches newline and then backtracks, which is why it was misread twice today.
RESULT TEXT must be stricter than spawn prompts, and the body's finding 3 is why. A spawn prompt is author-controlled, so a marker there states intent. Result text is agent OUTPUT, downstream of whatever that agent read — a fetched page, an issue body, a file. Crediting from anywhere within it lets the content the gate polices vote on whether it has been policed. Require the marker as the ENTIRE TRIMMED FIRST LINE of the result: an honest reviewer controls its own opening line, quoted material almost never lands there. That closes the collapse where one legitimate spawn plus one crafted result clears the counter.
REJECTED — a first-N-lines position bound. It does not survive the real threat: untrusted text pasted at the TOP of a brief is the common shape, not the rare one, and it adds a constant nobody can tune. Revisit only if injection is observed past the harness boilerplate.
REJECTED for now — signing or nonce-stamping the role declaration. Correct, and far more than this gate warrants until the exact-compare version is observed failing.
SEQUENCING: do NOT start this while another agent holds reviewGate. Land the in-flight guards/rename work first, then apply this as its own change with its own tests.
