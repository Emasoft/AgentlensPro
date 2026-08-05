---
name: cumulative-vs-per-turn-fields
description: "is total_cost_usd per turn or cumulative / my burn number is hundreds of times too high / the cost jumped after a server restart / d cost looks like one expensive turn / which statusline fields are lifetime totals / how do I difference a cumulative field safely / a cost and a token count that cannot both be true / burn looks wrong only for one model / a new model shipped and the cost numbers went strange / the fix is in the other file so this one is fine, right"
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


^ATOM-JQC5-5V9K [desc:"the third instance of the cumulative-delta bug is a COMPOSITION gap: two files each cite the other as the one handling it, and neither states the residue", keywords: each_file_assumes_the_other_handles_the_gap the_fallback_branch_is_gap-unaware unpriced_model_silently_returns_zero_cost a_new_model_ships_and_burn_quietly_overstates lookupRates_miss_returns_0_not_an_error cumulative_delta_survives_in_a_fallback composition_gap_between_two_correct_files burn_spikes_only_for_models_missing_from_pricing, type: project, ocd: 2026-08-05, lmd: 2026-08-05]

**The audit found the third instance, and it is not a missing check — it is a check that lives in
the OTHER file.** (TRDD-H693VQLU, 2026-08-05. Full site table:
`reports/cumulative-delta-audit/20260805_043236+0200-differencing-sites.md`.)

Only THREE sites in the whole codebase difference a genuinely cumulative observation; almost every
`totalCostUsd`-shaped identifier is one of our own aggregates, which is safe by construction. Two of
the three pass both rules. The third — `burnMonitor.statuslineCostUsd` — passes only on its main
path.

`statuslineUsage.ts` justifies suppressing its first delta by saying burnMonitor re-prices each turn
from its own buckets "and falls back to this delta only otherwise". burnMonitor's fallback does
exactly that: `return be.deltaCostUsd` when the model is unknown, and again when
`calcTokenCostUsd` yields 0 — which `pricing.ts` returns for **any model id not in the table**
(`if (!rates) return 0`, not an error). On that branch the cumulative delta is used as a turn cost,
gap-unaware, with nothing on either side marking it.

**Why it matters more than "a narrow branch" suggests:** it fires exactly when a NEW MODEL SHIPS and
is not yet priced — the moment people watch burn hardest — and it fails silently, upward.

**How to apply.** When one file's correctness comment CITES another file as the mitigation, that is
a claim to verify, not to trust: read the cited function's fallback branches specifically. A
mitigation with a fallback is a mitigation with a hole, and the hole inherits none of the comment's
confidence. Where a delta is unavoidable, carry the sampling interval WITH it (the `peaks` view's
`gap_s` column is the working shape) so a consumer can label an interval total instead of guessing.

## Notes and lessons learned
