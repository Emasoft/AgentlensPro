---
trdd-id: 4MJT92J7
title: alcore reads MCP_PORT from env with parse rules that differ from the TypeScript envPort
column: todo
created: 2026-09-04T16:04:40+0200
updated: 2026-09-04T16:04:40+0200
current-owner: main-session
task-type: bugfix
project-id: agentlenspro
priority: medium
severity: MEDIUM
min-approval-requirement: none
created-by: main-session
parent-trdd: 99HUNXJS
npt: []
eht: []
blocked-by: []
related: [99HUNXJS, BSDR4TRM, EGGERLEO, 1B98LCVR]
---

# alcore reads MCP_PORT from env, with different parse rules than the TS parser

## The site (measured 2026-09-04, one grep over the whole Rust tree)

`grep -rn 'env::var' rust-core/crates --include=*.rs | grep -i port` returns **exactly one** hit —
`rust-core/crates/agentlens-core/src/server_stats.rs:68`, inside `impl Default for Ports`:

```rust
let mcp = std::env::var("MCP_PORT").ok().and_then(|s| s.trim().parse().ok()).unwrap_or(4316);
```

## Why it matters — TRDD-99HUNXJS's premise, in the half its acceptance excluded

99HUNXJS is titled *"the server and the CLI parse the same port env vars by different rules"*. Its
acceptance was scoped to "every **TypeScript** site", and that scope was met — a set difference over
three orthogonal greps across `src standalone media/src scripts` came back EMPTY, 8 sites all
routing through `envPort`. But **since TRDD-1B98LCVR the SERVER IS RUST**, so the titled problem
survives in the half the acceptance did not cover.

The two parsers genuinely disagree:

| input | TS `envPort` (bare `Number()`) | Rust `.trim().parse()` |
|---|---|---|
| `'3e3'` | **3000** (accepted) | rejected → 4316 |
| `'0x1F80'` | **8064** (accepted) | rejected → 4316 |
| `'+8080'` | **8080** (accepted) | rejected → 4316 |

So `MCP_PORT=3e3` gives 3000 on the TS side and 4316 on the Rust side. That is the exact class of
divergence 99HUNXJS exists to eliminate. (TS accepting those forms is deliberate and pinned by
99HUNXJS's suite; **whether it SHOULD is TRDD-EGGERLEO's decision, not this card's** — this card is
about the two engines disagreeing, whichever semantics wins.)

## A load-bearing comment is falsified as written

`src/test/helpers/freePort.ts`'s `alcoreArgsFromEnv` justifies itself with *"alcore reads NO env
vars for these — it is flags-only, so without this the child would silently bind its defaults
(3000/4316/4318)"*. alcore **does** read `MCP_PORT`. That comment is the sole evidence anyone had
that the Rust boundary was airtight, and it is the same shape of claim — "I checked, there is no
other site" — that was FALSE in 99HUNXJS's own commit `44fcd56f`.

## NOT established — do not assume either way

**Whether any live path uses the Default's env-derived `mcp`.** The doc comment at
`server_stats.rs:55-58` says `alcore serve` sets `mcp` from `--mcp-port` after `serve_mcp` claims
it, and that "until then this field carried the env default (4316) while nothing listened on it".
So flags-only may hold for the SERVE path specifically, in which case the freePort.ts comment needs
NARROWING and the code may be fine. **Nobody has traced `Ports::default()`'s callers.** That trace
is the first task, not a formality — the whole severity of this card depends on it.

## Acceptance

- [ ] Every caller of `Ports::default()` is traced and listed. Decide from that list whether the
      env-derived `mcp` can reach a served response or a bound listener, or is always overwritten.
- [ ] A decision is recorded: delete the env read in favour of the flag, OR align its parse
      semantics with `envPort`. Not "it's probably fine".
- [ ] `freePort.ts`'s `alcoreArgsFromEnv` comment is corrected or narrowed to what is true. It
      currently states a blanket flags-only property that one grep disproves.
- [ ] A check that would FAIL if a future Rust site reads a port env var directly — the TypeScript
      side got one shared parser, the Rust side has no equivalent guard.

## Notes and lessons learned

- **Found by running the one grep an adversarial reviewer asked for and I had skipped.** I closed
  99HUNXJS reporting an "EMPTY set difference — no sixth site", which was true of TypeScript and
  false of the premise: my scope (`src standalone media/src scripts`) could not match a Rust file
  under any of the three patterns, so the search was structurally incapable of finding this. The
  reviewer named `rust-core/` explicitly; I ran everything else first.
- The lesson is narrower than "grep more": **a completeness claim inherits the scope of its search,
  and the scope is the part nobody restates.** "No sixth site" read as a claim about the system;
  the evidence was a claim about four directories.
