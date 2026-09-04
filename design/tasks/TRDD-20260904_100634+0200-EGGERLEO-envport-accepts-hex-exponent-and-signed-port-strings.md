---
trdd-id: EGGERLEO
title: envPort accepts hex exponent and signed forms that nobody types as a port
column: todo
created: 2026-09-04T10:06:34+0200
updated: 2026-09-04T10:28:30+0200
current-owner: main-session
task-type: bugfix
project-id: agentlenspro
scope: project
min-approval-requirement: manager
labels: [cli, config, validation]
priority: low
severity: low
relevant-rules: []
npt: []
eht: []
implementation-commits: []
external-refs: []
---

# `envPort` validates the range but not the SHAPE, so `0x1F80` is a valid port

`src/cli/cliCore.ts::envPort` is the one parser every port site shares (TRDD-99HUNXJS,
TRDD-BSDR4TRM). It rejects out-of-range and non-integer values, but it delegates
string→number to bare `Number()`, which accepts several literal forms nobody types into a
`UI_PORT`.

Measured 2026-09-04 with `envPort(raw, 4316)`:

| input | result | |
|---|---|---|
| `'8080'` | `8080` | correct |
| `'3e3'` | `3000` | accepted — scientific notation |
| `'0x1F80'` | `8064` | accepted — hex |
| `'0b11'` | `3` | accepted — binary |
| `'+8080'` | `8080` | accepted — leading sign |
| `' 8080 '` | `8080` | accepted — already trimmed, fine |
| `'1_000'` | `4316` | rejected |
| `'Infinity'` | `4316` | rejected |

All five accepted oddities bind a real port silently. None is a typo shape that a user would
recognise in an error message, and `0x1F80 -> 8064` in particular means a value that looks
nothing like `8064` resolves to it.

## Why this is filed rather than fixed

`envPort`'s fallback-on-malformed semantics were **ratified** in TRDD-BSDR4TRM's ai_review, and
TRDD-99HUNXJS's STATE block explicitly declined to re-litigate them on a LOW-severity card. This
is the same class of decision: a behaviour change to a shared, ratified parser. It gets its own
card rather than riding along on a test rewrite.

Note this is a *looseness*, not the `Number('')  === 0` *bug* that 99HUNXJS fixed. Nothing binds
port 0 and nothing throws; the accepted values are all real, in-range ports. That is why it is
`severity: low`.

## The likely fix, if approved

One line — require a decimal literal before `Number()` does anything:

```ts
const t = raw?.trim()
const n = /^\d+$/.test(t ?? '') ? Number(t) : NaN
```

This rejects `3e3`, `0x1F80`, `0b11` and `+8080` while accepting every input the current parser
accepts that is actually a port. `Number.isInteger`/range checks stay as they are.

**The regex MUST test the TRIMMED string, and the ordering above is what makes it safe.**
`/^\d+$/.test(' 8080 ')` is `false`, so testing `raw` directly would reject a currently-valid
input — a real regression. Checked for other legitimate inputs the guard would break and found
none: `'08080'` (leading zero) passes the regex and `Number` still gives 8080; a 20-digit string
passes the regex and is then rejected by `n < 65536`, exactly as it is today.

**`min-approval-requirement: manager`, not `none`** — this card exists to revisit a decision
ratified in TRDD-BSDR4TRM's ai_review. It was filed as `none` on 2026-09-04 and corrected the same
day: a card whose prose concedes it overturns a prior approval cannot also declare itself
self-approvable. That field is what a future session greps to decide whether it may just do this.

## While you are in `envPort` anyway

`src/telemetryConfig.ts` needs to know whether the parser ACCEPTED the input or fell back, and
today asks by probing with two different fallbacks (`envPort(raw,1) !== envPort(raw,2)`). That
works and is drift-proof, but it is a question the function could answer directly — e.g. returning
`{ port, fellBack }`. **Not proposed here:** exactly one call site needs it, and widening the
return type of a function with several callers to serve one CLI diagnostic is speculative. Noted only
because this card already opens the file; if a second site ever needs the distinction, that is
when the shape is earned.

## Acceptance

- [ ] Decide whether non-decimal literals should be rejected, or documented as accepted.
- [ ] If rejected: `/^\d+$/` guard in `envPort`, and the `3e3` row in
      `src/test/setupPortEnv.test.ts` moves from ACCEPTED to REJECTED.
- [ ] The decision recorded here before the code lands (same discipline TRDD-99HUNXJS used).

## Related

- TRDD-99HUNXJS — unified the port parser; its test suite currently PINS `3e3 -> 3000` as
  today's behaviour, deliberately, with a comment pointing here. Those rows are supposed to go
  red if this card changes the parser.
- TRDD-BSDR4TRM — where `envPort`'s fallback semantics were ratified.
