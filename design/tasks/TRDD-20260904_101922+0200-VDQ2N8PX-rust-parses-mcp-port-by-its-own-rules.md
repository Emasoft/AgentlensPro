---
trdd-id: VDQ2N8PX
title: Rust parses MCP_PORT by its own rules so the server and the CLI can still disagree
column: todo
created: 2026-09-04T10:19:22+0200
updated: 2026-10-04T13:02:36+0200
related: [4MJT92J7, 99HUNXJS, EGGERLEO, Q9WD3K5R, 1B98LCVR]
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
implementation-commits: [c17ef591, 0f1e9433]
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
- **The `Ports` trace — SETTLED 17:05, after THREE wrong characterizations. The mundane truth:**
  **both cards reach the same severity conclusion by different routes.** 4MJT92J7 adds
  `server_stats.rs:575` and the `canonical` flag (`st.ports.otlp == 4318`), which appear nowhere
  here, and phrases its reader claim as exhaustive ("the ONLY readers of `st.ports.*`") where this
  card says `ports` *feeds* `:574`. **Neither is load-bearing**, because THIS card already asserts
  the conclusion directly and already decouples it from the unverified guard: *"What keeps it low
  EVEN IN THE WORST CASE: nothing BINDS `ports.mcp`. `alcore serve` binds from the parsed flag."*
  So the only genuine migration is `:575` + `canonical` — a second field on the same status
  endpoint, minor.

  **The three wrong versions, recorded because the pattern is the finding:** (1) 16:54 — "4MJT92J7
  holds work this card does not", written after reading 60% of this card; (2) 16:58 — "this card is
  strictly better, nothing to migrate", which discarded the `:575` finding; (3) 17:02 —
  "complementary; the read-side half is load-bearing and unique", which is false because this card
  reaches the no-binding conclusion on its own. Each was written from whichever card I had read
  most recently, and **not once were the two texts compared side by side** — the comparison the
  claim was about.

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

- [x] `MCP_PORT=0` does not yield `Ports.mcp == 0`.
- [x] A Rust test asserting the table above, so the TS and Rust rows can be compared by reading
      two test files rather than by reasoning about two parsers.
- [ ] Decide whether `'3e3'` converges here or in TRDD-EGGERLEO, not both.

## Related

- [[TRDD-99HUNXJS]] — unified the FIVE TypeScript sites; its box 1 is scoped to TypeScript and
  points here for the reason. Found during that card's second overclaim correction: a grep for
  `envPort` cannot see a site that never calls it, and a grep over `src`/`standalone` cannot see
  Rust at all.
- [[TRDD-EGGERLEO]] — the `'3e3'`/`0x1F80` strictness question on the TS side.
2026-09-24T08:56:26+0200 — migrated from superseded TRDD-4MJT92J7 (duplicate, same server_stats.rs:68 target, filed 16:04:40 same day, this card is the survivor): (a) server_stats.rs:575 canonical-flag observation (st.ports.otlp == 4318); (b) implementation-commits c17ef591/0f1e9433 are the already-landed freePort.ts doc-comment fix for this port-parsing defect class (TS side; the Rust-side '>0' filter at server_stats.rs:68 remains the open WORK-S item on this card).

## Notes

2026-10-04 — server_stats.rs: mcp_port_from_env filters 0 (falls back to 4316); test capture_block_tests::mcp_port_from_env_rejects_zero_and_invalid_spellings red without the filter (MCP_PORT=Some("0") left 0 right 4316), green with it; lib server_stats 4 passed, clippy -D warnings clean. Box 3 left open: '3e3' stays 4316 and is pinned in the test; whether it converges is TRDD-EGGERLEO's, the owner's call.
