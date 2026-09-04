---
trdd-id: VDQ2N8PX
title: Rust parses MCP_PORT by its own rules so the server and the CLI can still disagree
column: todo
created: 2026-09-04T10:19:22+0200
updated: 2026-09-04T16:58:30+0200
related: [4MJT92J7, 99HUNXJS, EGGERLEO, Q9WD3K5R]
current-owner: main-session
task-type: bugfix
project-id: agentlenspro
scope: project
min-approval-requirement: none
labels: [cli, server, config, rust, parity]
priority: low
severity: low
relevant-rules: []
npt: []
eht: []
implementation-commits: []
external-refs: []
---

# TRDD-99HUNXJS unified the TypeScript spellings. Rust was never in the census.

## ⚠ A DUPLICATE OF THIS CARD WAS FILED AT 16:04 — TRDD-4MJT92J7

Noted 2026-09-04T16:54. `4MJT92J7` covers the same site (`server_stats.rs:68`), the same two-engine
divergence, and the same EGGERLEO hand-off; it was filed 5h45m after this card by a session that
did not check the board first. **This card is the survivor** — earlier, and better developed.
(An earlier version of this line added *"`min-approval-requirement: none` against 4MJT92J7's
`medium`"*. **That is FALSE** — 4MJT92J7 is also `none`; `medium`/`MEDIUM` are its `priority` and
`severity`. Corrected 16:58.)

The supersede transition is NOT performed here (`<any non-design> → superseded` is non-exempt).
**But 4MJT92J7 is not empty, and its content must not be lost if it is archived:**

- **A real code fix already landed under it** (`c17ef591`, corrected by `0f1e9433`):
  `src/test/helpers/freePort.ts`'s `alcoreArgsFromEnv` doc comment asserted *"alcore reads NO env
  vars for these — it is flags-only"*, which this very defect falsifies. It now states the scoped
  truth instead. That comment was the only evidence anyone had that the Rust env boundary was
  airtight.
- ~~The `Ports::default()` caller trace~~ — **STRUCK 16:58: THIS CARD ALREADY HAD IT AND HAS IT
  BETTER.** The claim that 4MJT92J7 contributed this was written after reading only the first 60
  lines of this card — a completeness assertion over a partial read, which is the same failure
  shape as the port-site claims, applied to a card instead of a source tree. This card's
  *"Why severity is low — MEASURED rather than assumed"* section already carried `lib.rs:565`,
  ALSO located the overwrite site `alcore.rs:235-237` that 4MJT92J7 never found, ruled out a
  `..Default::default()` spread, and — decisively — flags the guard on `alcore.rs:235-237` as
  **UNVERIFIED**, where 4MJT92J7's box 1 asserts the overwrite flatly. So 4MJT92J7's box-1 work was
  a ~6h-later rediscovery of this section, and the duplication is DEEPER than first recorded, not
  shallower. Nothing to migrate here.

`rust-core/crates/agentlens-core/src/server_stats.rs:68`, in `impl Default for Ports`:

```rust
let mcp = std::env::var("MCP_PORT").ok().and_then(|s| s.trim().parse().ok()).unwrap_or(4316);
```

`Ports.mcp` is `u16`, so this is `parse::<u16>()`. That is a **sixth** spelling of "read a port
from the env", and 99HUNXJS's acceptance box 1 is scoped to TypeScript precisely because this one
exists and cannot import `envPort`.

## Where it disagrees with `envPort`

The `u16` type does most of the validation for free, so this is much closer to `envPort` than the
`parseInt` site was — it agrees on 8 of 10 of the card's table. Two rows differ:

| raw | `envPort` (TS) | `parse::<u16>()` (Rust) | |
|---|---|---|---|
| `'0'` | 4316 | **0** | the port-0 bug 99HUNXJS exists to fix, still live in Rust |
| `'3e3'` | 3000 | 4316 | TS accepts scientific notation, Rust does not |

Everything else — `''`, `'   '`, `'abc'`, `'-1'`, `'65536'`, `'80.5'`, `'8080/evil'` — falls back
to 4316 in both, though for different reasons. Be precise about what the type does: `u16` covers
the UPPER bound (`'65536'` overflows) and negatives (`'-1'` is unsigned-invalid), but it does NOT
cover `n > 0` — and that omission IS the `'0'` row. "The type does the range checking" is the
reading that makes these look equivalent; they are not.

`'0'` is the one that matters and is the same defect class: `MCP_PORT=0` makes the server report
`mcp: 0` about itself, a port a client will find dead.

Note `'3e3'` disagrees in the OPPOSITE direction from the rest of this family — here Rust is
STRICTER and arguably correct, which is the same question TRDD-EGGERLEO holds for the TS side. If
EGGERLEO lands, this row converges on its own.

## Why severity is low — and the reachability claim, MEASURED rather than assumed

The first draft of this card said "on the supported path the env var is never consulted by Rust at
all." **That was false, and asserted without checking.** Measured 2026-09-04:

- `rust-core/crates/agentlens-core/src/lib.rs:565` — `ports: server_stats::Ports::default()` is
  the ONLY construction site, and it is on the normal `CoreState` path. So the `MCP_PORT` env read
  runs on **every** start, managed or not.
- `rust-core/crates/agentlens-core/src/bin/alcore.rs:235-237` — `st.ports.{ui,otlp,mcp}` are then
  overwritten from the parsed flags.

So the correct statement is: the env value is always read, and is then overwritten at that one
site. **`severity: low` ASSUMES the overwrite at `alcore.rs:235-237` runs unconditionally on the
serve path — that guard is UNVERIFIED. If it is conditional, re-rate this card.** "Assumes" is
the load-bearing word; "normally" would smuggle in the thing that was not checked.

What keeps it `low` even in the worst case: nothing BINDS `ports.mcp`. `alcore serve` binds from
the parsed flag, and `ports` feeds `server_stats.rs:574`, a JSON status field. So the failure is a
status endpoint advertising a dead port — self-evident on the first connection attempt — not
silent corruption. Contrast the `telemetryConfig.ts` site fixed under TRDD-99HUNXJS, which
PERSISTED a bad value into the user's settings.json; that one earned its urgency. Reaching this
also needs `MCP_PORT=0` specifically, which no unset-variable expansion produces (that yields
`''`, which Rust rejects correctly).

**Still unverified:** the exact condition guarding `alcore.rs:235-237`, and what `ports.mcp` holds
if `serve_mcp` fails to claim the port. Someone raising severity should settle those two first —
the line numbers above are where to look. No `..Default::default()` spread of `Ports` exists
(checked), so that particular hazard is ruled out.

## The shape of a fix

There is no shared artifact to route through — that is the whole difficulty, and it is the same
one TRDD-Q9WD3K5R names about a two-language repo. Options, cheapest first:

- **Reject 0 in the Rust parse** (`.filter(|p| *p > 0)`), which closes the only defect row without
  inventing cross-language machinery. Probably the right answer.
- Make the Rust side refuse to read the env var at all and require the flag, so there is exactly
  one parser by construction. Bigger change; needs the unmanaged-run affordance re-thought.
- A shared spec both languages load. Rejected in advance for this card's size — see Q9WD3K5R on
  why two independently authored parsers are not automatically worse than one shared object.

## Acceptance

- [ ] `MCP_PORT=0` does not yield `Ports.mcp == 0`.
- [ ] A Rust test asserting the table above, so the TS and Rust rows can be compared by reading
      two test files rather than by reasoning about two parsers.
- [ ] Decide whether `'3e3'` converges here or in TRDD-EGGERLEO, not both.

## Related

- [[TRDD-99HUNXJS]] — unified the FIVE TypeScript sites; its box 1 is scoped to TypeScript and
  points here for the reason. Found during that card's second overclaim correction: a grep for
  `envPort` cannot see a site that never calls it, and a grep over `src`/`standalone` cannot see
  Rust at all.
- [[TRDD-EGGERLEO]] — the `'3e3'`/`0x1F80` strictness question on the TS side.
