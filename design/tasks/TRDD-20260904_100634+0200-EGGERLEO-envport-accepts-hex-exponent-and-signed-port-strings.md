---
trdd-id: EGGERLEO
title: envPort accepts hex exponent and signed forms that nobody types as a port
column: todo
created: 2026-09-04T10:06:34+0200
updated: 2026-09-04T16:56:24+0200
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

## NEW EVIDENCE 2026-09-04T16:50+0200 — a second engine now has a vote, and it BREAKS the proposed fix

Filed as evidence only. **The decision is untouched and still `manager`** — this section adds an
argument the card did not have and corrects the one-line fix; it does not exercise box 1.

Since TRDD-1B98LCVR the server is Rust, and TRDD-4MJT92J7 established that `alcore` reads
`MCP_PORT` itself (`server_stats.rs:68`, `s.trim().parse::<u16>()`). So `envPort` is no longer the
only port parser in the product, and "what shape is a port" is now a question two engines answer
differently. **Both columns below were RUN** — Rust via `rustc`, TS via `node -e` on the card's own
proposed `/^\d+$/` guard:

| input | Rust `.trim().parse::<u16>()` | proposed TS `/^\d+$/` | agree? |
|---|---|---|---|
| `'8080'` | `Some(8080)` | ACCEPT 8080 | yes |
| `'3e3'` | `None` | REJECT | **yes — fix removes a divergence** |
| `'0x1F80'` | `None` | REJECT | **yes — fix removes a divergence** |
| `'0b11'` | `None` | REJECT | **yes — fix removes a divergence** |
| `'+8080'` | **`Some(8080)`** | **REJECT** | **NO — fix CREATES a divergence** |
| `' 8080 '` | `Some(8080)` | ACCEPT 8080 | yes |
| `'08080'` | `Some(8080)` | ACCEPT 8080 | yes |
| `'-1'` | `None` | REJECT | yes |

**Scope of the table: `MCP_PORT` only.** No Rust reader of `UI_PORT`/`OTLP_PORT` was found, so
there is nothing for them to diverge from; the table names no variable and must not be read as
covering all three. **Carrying the scope rather than restating the universal** (this is the third
card to state this fact and the first two dropped the scope): the literals occur 4× in `rust-core`,
all in comments, and no port name is built by string formatting — so no `env::vars()` map lookup or
`env::var(key)` helper in that tree can name them. A key arriving from a config file or CLI string
would evade that check, and the `target/` exclusion is safe only because no `build.rs` exists.
Full derivation on TRDD-4MJT92J7 / TRDD-VDQ2N8PX.

**This is an argument for rejecting non-decimal literals** — decimal-only is what the Rust half
already enforces by construction, so the change makes the two engines agree rather than imposing a
new opinion. Today they disagree on `3e3` (TS 3000 / Rust 4316) and `0x1F80` (TS 8064 / Rust 4316):
the same env var, **one live port and one wrong report**.

**CORRECTED 2026-09-04T16:52 — an earlier version of this line said "two different live ports".
That is FALSE and contradicts TRDD-4MJT92J7's own retraction, made hours earlier the same day:**
`Ports` is a REPORTING struct, `Ports::default()` has one caller, and the only reads of
`st.ports.*` are the `/api/server-stats` payload. The Rust 4316 never reaches a socket — the
listener binds from `--mcp-port` — and the trace shows binding code never reads `Ports` at all, so
this holds whether or not the flag is passed.
**One nuance the flat phrasing hides:** `server_stats.rs:55-58` says `alcore serve` OVERWRITES `mcp`
from `--mcp-port` once `serve_mcp` claims the port, calling the bad value what the field carried
*"until then"*. So the wrong report may exist only in a startup window rather than as an ongoing
property of `/api/server-stats`. Which one is NOT established — do not quote "one wrong report" as
a steady-state claim.

**The `+8080` rejection was ALREADY KNOWN — this card said so this morning**, in the very sentence
proposing the fix: *"This rejects `3e3`, `0x1F80`, `0b11` and `+8080` while accepting every input
the current parser accepts that is actually a port."* Only *Rust accepts it* is new here, so the
contribution is narrower than "catching it before it lands" implies.

**And that sentence is false on its own terms, before Rust enters the argument:** `+8080` IS
currently accepted and IS actually a port, so "rejects `+8080`" and "accepts every input the
current parser accepts that is actually a port" cannot both hold. The defect in the proposed fix
was visible on this card without any cross-engine evidence.

**The one-line fix as written is WRONG, and this is the part worth catching before it lands.**
Rust's integer `FromStr` accepts a leading `+`, so `/^\d+$/` would reject an input Rust accepts —
trading three divergences for a fourth instead of eliminating all four. The alignment-preserving
guard is:

```ts
const t = raw?.trim()
const n = /^\+?\d+$/.test(t ?? '') ? Number(t) : NaN
```

`Number('+8080')` is `8080`, so accepting the sign costs nothing and keeps the two engines
byte-identical on all eight vectors above. (Note `-8080` stays rejected by both — the regex has no
`-`, and a negative fails the range check regardless.)

**Whichever way box 1 is decided, the Rust side must be decided WITH it.** If TS goes decimal-only,
Rust already matches (modulo the `+`); if TS keeps `Number()`'s looseness, then TRDD-4MJT92J7's box
2 has to make Rust loose to match. That is **unwanted, not near-impossible** — an earlier version of
this line said "far harder ... near-impossible", which is unsupported: std ships
`u16::from_str_radix`, so matching `Number()` needs prefix dispatch on `0x`/`0b`/`0o` plus an f64
parse with an integer check, roughly fifteen unremarkable lines. The honest asymmetry is
**strict costs zero lines because Rust already enforces it; loose costs a hand-rolled parser
nobody wants.** Cost asymmetry is a consideration for box 1, not a settlement of it.

## The case AGAINST changing this, recorded because the section above argued only one side

An evidence section that lists only the arguments for one option does not decide the box, but it
makes the decision look foreclosed, which has the same effect by a slower route. The other side:

- **BSDR4TRM RATIFIED the current fallback semantics deliberately.** This card exists to revisit an
  approved decision; "the parser is loose" was a choice, not an oversight.
- **Nothing is broken.** `severity: low`, and every accepted oddity resolves to a real, in-range
  port. There is no reported incident.
  **On "unreached" — searched 2026-09-04T16:54, and the search cannot settle the question.** In
  THIS repository every occurrence of `3e3`/`0x1F80`/`+8080` is TRDD prose documenting the
  divergence itself; the only real port config is `Dockerfile` (`OTLP_PORT=4318`, `UI_PORT=3000`)
  and `README.md` (`OTLP_PORT=4319 UI_PORT=3001`), all plain decimal. **But a port env var lives in
  a DEPLOYED ENVIRONMENT, not in a repo**, so this is the wrong universe for the question and no
  grep here can answer it. An earlier version of this bullet asserted the negative flatly, and
  before that asserted it without searching at all. The supportable claim is narrow: *no
  odd-shaped port value appears in this repository's own configs; what any user's environment sets
  is not observable from here.*
- **A strict patch could move a live port silently.** Any existing config using `3e3` binds 3000
  today and would bind the fallback after the change. That is a behaviour change to a shipped
  product in service of a shape nobody has complained about.
- **The divergence's live impact is one wrong number in `/api/server-stats`** (see the correction
  above), which is the impact TRDD-4MJT92J7 already records — and which could equally be fixed on
  the Rust side by deleting the env read in favour of the flag (4MJT92J7 box 2), touching no TS at
  all and leaving ratified semantics alone.
  **This argument answers only HALF of this card, and the half it does not answer is the original
  complaint.** A Rust-side fix disposes of the *divergence*; it does nothing about `envPort`
  accepting `0x1F80` → 8064 on the TS side, which predates Rust entirely. Do not read this bullet
  as "nothing needs doing here".

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
