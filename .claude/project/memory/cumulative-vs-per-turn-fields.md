---
name: cumulative-vs-per-turn-fields
description: "is total_cost_usd per turn or cumulative / my burn number is hundreds of times too high / the cost jumped after a server restart / d cost looks like one expensive turn / which statusline fields are lifetime totals / how do I difference a cumulative field safely / a cost and a token count that cannot both be true"
ocd: 2026-08-01
lmd: 2026-08-01
metadata:
  node_type: memory
  type: project
  tier: aspect
---

# cumulative-vs-per-turn-fields


^ATOM-0OK5-R23F [desc:"Which AgentlensPro fields are lifetime totals vs per-turn, and the two rules a delta of a cumulative field must satisfy — a baseline and a gap — each of which shipped a bug.", keywords: total_cost_usd_is_cumulative_not_per_turn burn_number_hundreds_of_times_too_high cost_spiked_after_a_server_restart differencing_a_lifetime_total which_fields_are_per_turn cost_and_token_count_mutually_inconsistent, ocd: 2026-08-01, lmd: 2026-08-01]

## Cumulative vs per-turn fields, and the two rules for differencing them

Mixing these up produced the two largest wrong numbers this project has reported. Both came from the
status-line payload, but the rule is about the SHAPE of a field, not about that payload.

| shape | fields | safe to sum? |
|---|---|---|
| **CUMULATIVE (session lifetime)** | `cost.total_cost_usd`, `context_window.total_input_tokens`, `total_output_tokens` | never — difference them, under both rules below |
| **PER-TURN (last completed call)** | `context_window.current_usage.{input,output,cache_creation_input,cache_read_input}_tokens` | yes, but see the SNAPSHOT trap |

**RULE 1 — a delta needs a BASELINE. The first observation bills nothing.** A reader holding state in
memory re-meets every live session at sample one after a restart, with `prev` at 0, and charges that
session's whole history as one turn. MEASURED: an account bucket reported **$2,097.68** of 5-hour
spend against 265,845 tokens, and $2,097.53 was exactly one long-running session's lifetime cost.

**RULE 2 — a delta needs a GAP CHECK.** Sampling stops while a session is idle, so the pair of
samples bracketing an idle stretch carries every turn in between. Read as one turn's cost it
overstates by however many turns the gap hid — this is how a $0.35 warm turn got reported as a $5
cold write. Show the interval beside the delta and label anything past ~60 s an INTERVAL total.

**The SNAPSHOT trap on the per-turn side:** `current_usage` describes the LAST COMPLETED turn and is
re-published on every render whether or not a turn happened. Summing per sample counted one turn up
to 2,575 times (36.7× cost over-count). Key a turn by its INPUT buckets — fixed when the request is
sent — never by `output_tokens`, which grows while the response streams.

**The detector that found both:** two figures in one report that **cannot both be true**.
$2,097.68 over 265,845 tokens implies $7,890/MTok when the dearest rate in the table is $25 — a 300×
internal contradiction, visible without knowing which number was wrong. Cheaper than auditing either.

See [[statusline-capture-and-store]] (the store and its own traps), [[cache-ttl-model]] (the rates a
recomputed cost must use), [[agentlens-burn-token-model]].

## Notes and lessons learned
