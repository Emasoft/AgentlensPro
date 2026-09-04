---
trdd-id: 4MJT92J7
title: alcore reads MCP_PORT from env with parse rules that differ from the TypeScript envPort
column: todo
created: 2026-09-04T16:04:40+0200
updated: 2026-09-04T16:39:18+0200
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

`grep -rn 'env::var' rust-core/crates --include=*.rs | grep -i port` returns **exactly one** hit.
**State that positively, because the absence is the useful half:** the grep covered all three port
variables, and `UI_PORT` and `OTLP_PORT` have **ZERO** `env::var` reads anywhere in the Rust tree
(`grep -cE 'UI_PORT|OTLP_PORT'` over the same output → 0). So the Rust side takes those two from
flags only, exactly as `freePort.ts` claims; `MCP_PORT` is the single exception, and the helper's
comment is wrong only about that one variable. The hit is —
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

**Both columns are RUN, not derived.** Rust column = `rustc`-compiled output of
`s.trim().parse::<u16>().ok()`, the exact expression at `server_stats.rs:68`. TS column = `node -e`
output of `Number(s)`, which is what `envPort` delegates to — with the caveat that `envPort` then
applies its own accept/reject predicate on top (that is why `'0'` and `'65536'` show a raw
`Number()` value here but are REJECTED by `envPort`, per `setupPortEnv.test.ts`'s `REJECTED`
vector). Raw `Number()` results: `'3e3'`→3000, `'0x1F80'`→8064, `'+8080'`→8080, `'0'`→0,
`' 8080 '`→8080, `'65536'`→65536.

| input | TS `envPort` (bare `Number()`) | Rust `.trim().parse::<u16>()` | diverge? |
|---|---|---|---|
| `'3e3'` | **3000** (accepted) | `None` → 4316 | **YES** |
| `'0x1F80'` | **8064** (accepted) | `None` → 4316 | **YES** |
| `'0'` | **rejected** → fallback | **`Some(0)`** | **YES — see below** |
| `'+8080'` | 8080 | `Some(8080)` | no |
| `' 8080 '` | 8080 | `Some(8080)` | no |
| `'65536'` | rejected | `None` | no |

**`'0'` inverts the usual direction:** TS `envPort` REJECTS `'0'` (it is in
`setupPortEnv.test.ts`'s `REJECTED` vector) and falls back to 4316; Rust ACCEPTS it as a valid
`u16` `Some(0)`. So the two engines report different numbers for the same input.

**ACCEPTANCE BOX 1 IS NOW ANSWERED, and it DEFLATES this row — recorded because an earlier version
of this card inflated it.** `Ports::default()` has exactly ONE caller: `lib.rs:565`, initializing
`CoreState.ports`. The only reads of `st.ports.*` anywhere are `server_stats.rs:574-575` — the
`/api/server-stats` JSON payload and a `canonical` flag (`st.ports.otlp == 4318`). **`Ports` is a
REPORTING struct. Nothing binds a listener from it.** The listeners bind from flags; `alcore serve`
additionally overwrites `mcp` from `--mcp-port` once `serve_mcp` claims the port.

So the real impact is **a reporting inaccuracy, not a binding hazard**: `/api/server-stats` can
state an `mcp` port that nothing is listening on. That is precisely what the struct's own doc
comment at `:55-58` already says — *"this field carried the env default (4316) while nothing
listened on it, so the server stated a port about itself that a client would find dead."*

**RETRACTED from an earlier version of this card:** that `MCP_PORT=0` could make the CLI's
`server stop` signal the wrong process. The scenario needed three links and had one — the parser
divergence. It was constructed from a plausible-sounding mechanism without tracing whether the
value could reach it. It cannot.

**And the citation was INVERTED, which is the worse half.** I invoked CLAUDE.md's account of
`findServerPid` as evidence the hazard was live. CLAUDE.md records that passage as TRDD-BSDR4TRM's
**FIX**: `findServerPid` reads `<dataDir>/server.pid` FIRST and accepts a REST-reported pid only
when that server reports the same data dir, landed precisely so port confusion could not misdirect
a signal. So I cited the remedy as the disease. A citation that names a real document and reverses
its sense is harder to catch than an unsourced claim, because the reference makes it look checked.

An earlier version of this table claimed `'+8080'` diverged. It does not — Rust's integer
`FromStr` accepts a leading `+`. That row was asserted from intuition about Rust rather than run,
and the run that corrected it is what surfaced `'0'`.

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

- [x] Every caller of `Ports::default()` is traced and listed. Decide from that list whether the
      env-derived `mcp` can reach a served response or a bound listener, or is always overwritten.
      **ANSWERED 2026-09-04:** exactly ONE caller — `lib.rs:565`, initializing `CoreState.ports`.
      The only reads of `st.ports.*` are `server_stats.rs:574-575` (the `/api/server-stats` JSON
      and a `canonical` flag). **`Ports` is a reporting struct; nothing binds a listener from it**,
      and `alcore serve` overwrites `mcp` from `--mcp-port` once `serve_mcp` claims the port. So the
      env-derived value can reach a SERVED RESPONSE but never a bound socket — the impact is a
      wrong number in `/api/server-stats`, which is the failure the struct's own doc comment at
      `:55-58` already describes ("stated a port about itself that a client would find dead").
- [ ] A decision is recorded: delete the env read in favour of the flag, OR align its parse
      semantics with `envPort`. Not "it's probably fine".
- [x] `freePort.ts`'s `alcoreArgsFromEnv` comment is corrected or narrowed to what is true. It
      currently states a blanket flags-only property that one grep disproves.
      **DONE 2026-09-04T16:39+0200.** NARROWED, not deleted — the comment's operational point (pass
      the flags or the child stomps the developer's live server) is still true and still load-bearing,
      so only the false universal was replaced. It now states the property that IS true and is the one
      isolation depends on — **for BINDING alcore is flags-only** — then names the exception
      explicitly (`server_stats.rs`'s `impl Default for Ports` reads `MCP_PORT`, with the divergent
      parse rules tabled above).
      **The first attempt at this fix FAILED review and the retry is what the box is ticked on.**
      `c17ef591`'s text asserted "nothing in the Rust tree reads UI_PORT or OTLP_PORT" — a fresh
      unbounded negative resting on the same four-way-restricted grep (`env::var` ∩ `-i port` ∩
      `crates/` ∩ `*.rs`), i.e. the SCOPE-LAUNDERING FAILURE THE COMMENT ITSELF CITES 99HUNXJS
      AGAINST, committed inside the sentence citing it. The widened search settles it properly:
      `env::var|env::vars|var_os|option_env|envy|config::Environment|figment` over ALL of
      `rust-core` returns 33 hits (no `build.rs`, no `.rs` outside `crates/`), of which the only
      literal port read is `server_stats.rs:68`; ~10 are `std::env::vars().collect()` wholesale
      ingestion and several are helpers taking a runtime key, so THAT grep alone still could not
      support the negative. The check that can: **the literals `UI_PORT`/`OTLP_PORT` occur 4 times
      in all of `rust-core` and all four are COMMENTS** — absent from executable Rust entirely — and
      no `format!("{}_PORT", ..)` or other constructed name exists. A map lookup cannot name a key
      whose literal does not exist. The comment now carries that scope instead of a bare universal.
      **`tsc` is NOT evidence here and was withdrawn from this box** (`c17ef591` cited `EXIT=0` in
      the position where evidence goes): the change is a doc comment, so tsc parses and discards it
      — it returns 0 for the unedited file and would return 0 for an outright lie. The only failure
      it could catch is an unterminated block comment. `AGPYOAA6` — *a check that measured nothing
      looks exactly like a check that passed* — recalled 40 minutes earlier and not applied here.
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
