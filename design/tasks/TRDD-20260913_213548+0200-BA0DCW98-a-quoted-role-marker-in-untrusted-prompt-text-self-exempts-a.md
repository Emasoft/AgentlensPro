---
trdd-id: BA0DCW98
title: A quoted role marker in untrusted prompt text self-exempts an agent from its own review gate
column: todo
created: 2026-09-13T21:35:48+0200
updated: 2026-09-13T21:40:49+0200
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

- [ ] A test asserts the marker is NOT honoured when it appears after 50+ lines of quoted
      external material preceding it in the same prompt (i.e. buried past any reasonable
      boilerplate bound).
- [ ] Whichever mitigation is chosen is implemented in `exemptRoleStrict` (and, if it changes the
      marker's own text/shape, in `creditRoleLoose` and the `MEASURE_ROLE_RULE`/`REVIEW_ROLE_RULE`
      directive strings the harness publishes to agents).
- [ ] Existing tests in reviewGate.test.ts covering the marker anchoring (including the new
      "trailing prose" asymmetry test) still pass unmodified in intent.

## Why this is carded, not hot-fixed

Changing the marker format changes the PROMPT CONTRACT with every already-deployed roled agent
(MEASURE/REVIEW workers spawned per the gate's own directive strings) — a live-migration
concern, not a one-line patch. It needs a deliberate rollout decision, hence a tracked card
rather than an in-place fix.

## Approval log

- 2026-09-13T21:35:48+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
