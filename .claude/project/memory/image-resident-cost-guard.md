---
name: image-resident-cost-guard
description: "why did reading a screenshot make the session expensive / does an image break the prompt cache / does an image invalidate the message cache / claude-cache-guard 700x overhead claim / why does cost keep climbing after I looked at a picture / what does the Read cache-guard warning mean / how do I turn off the image warning / is Read really in the burn-gate matcher"
ocd: 2026-07-28
lmd: 2026-08-18
metadata:
  node_type: memory
  type: project
  tier: component
publish-globally: false
---

Reading an image into a large session is expensive — but **not for the reason the popular write-up
gives**, and the difference decides whether a gate may deny.

**The rejected claim.** `0x0funky/claude-cache-guard` states that an image ANYWHERE in a request
invalidates the entire messages tier of the prompt cache, so the next call rewrites the whole
conversation at the cache-WRITE rate (~700x overhead; their case: 40 one-at-a-time image reads cost
81% of a session). **MEASURED FALSE for Claude Code on 2026-08-04 — see `ATOM-SJEX-S7GY` below**:
seven consecutive image appends each wrote exactly the image's own 3,252 tokens and re-read
everything before them. Adding an image APPENDS content, and appending is suffix writing, which is
what every turn does.

Until that measurement the position here was the weaker **"cannot corroborate"**, argued from
`CacheBreakCause` (`src/shared/summarizerTypes.ts`) not containing an image cause. That argument was
never sound — an enum records what WE instrumented, not what the API does — and it also miscounted
the enum as 14 when it has **18** values. The conclusion held; the reasoning is superseded by the
measurement. See `[^2]`.

**The mechanism that IS measured.** Resident cost (`src/shared/residentCost.ts`):
`cost ≈ turns × per-turn-context`. A block rides forward in the transcript from the step that added
it until a compaction evicts it, and is re-billed (cache-read) on every turn in between. An image is
the worst offender because it is dense AND resident — the cost is never the one read, it is the read
times every turn that follows. Both mechanisms imply the SAME remedies (delegate the look to a
subagent, batch every image into one turn, write the verdict down, `/compact` after), so the advice
is unaffected by the correction; only the mechanism sentence and the price tag change.

**Consequences encoded in the code** (`evaluateImageReadGate`, `src/agentGate.ts`):

- **WARN-ONLY.** That module's contract is to deny only high-confidence disaster signatures, because
  "a gate that cries wolf gets `AGENTLENS_GATE=off`'d and then prevents nothing". A per-turn resident
  tax is not a forming fork storm. `imgDenyTokens` (300k) exists and escalates the PHRASING only.
- **No per-image token figure is quoted.** The two figures available disagree by ~40x (the platform's
  `(W×H)/750` capped ~1,600 for a full page, versus the measured ≈525k/8 ≈ 65k per image). The guard
  quotes only the session context size, which it reads from the transcript's own `usage`.
- **A unit test pins the honesty**: the reason string must not contain "invalidat".
- **`Read` is the first non-rare tool in `GATE_MATCHER`**, so its cost is bounded on the CLI side and
  NOT by the matcher: `runGateCheck` answers a non-image Read locally with one JSON parse and no
  network call. The predicate is shared (`src/shared/imageReads.ts`) rather than written twice —
  two copies drift silently in the safe-looking direction (the CLI skipping a read the server would
  have warned on). `.pdf` counts (Read renders its pages visually); `.svg` does not (text/XML source).
- **Its own switch**, so "this warning is chatty" never costs the fork-storm protection:
  `--hooks cacheguard=off` (runtime, all sessions) or `AGENTLENS_CACHE_GUARD=off` (per process,
  before any network call).

Shipped in 2.17.0. Evidence (gitignored, machine-local):
`reports/cache-guard/20260728_201256+0200-image-cache-premise-check.md`.

**That open measurement has been RUN (2026-08-04) — see `ATOM-SJEX-S7GY`.** It resolved both halves:
the invalidation claim is false for appends, and the ~40x per-image disagreement settles at
**3,252 tokens** for a 1568px image, matching `(W x H)/750` to 0.8%. The "525k for 8 images" figure
was the whole resident context misattributed to the images — wrong by ~20x. Warn-only remains the
correct posture, now for a stronger reason: the mechanism the guard declined to assert is positively
known to be false, not merely unproven.

See also: [[agentlens-burn-token-model]] (the cost model this specialises — windows metered by cost,
`turns × per-turn-context`); [[cache-risk-command-detection]] (where the 18 `CacheBreakCause` values
come from — the taxonomy that refutes the invalidation claim); [[cache-ttl-model]] (the write tiers
the guard's price talk depends on: 1.25x at 5-min, 2x at 1-hour); [[hook-events-pipeline]] (the
PreToolUse path the guard rides); [[agent-fleet-cache-economics]] (the delegate-to-a-subagent remedy
priced).


^ATOM-SJEX-S7GY [desc:"MEASURED: appending an image does NOT invalidate the cache; a 1568px image is 3,252 tokens, not 65k", keywords: does_appending_an_image_break_the_prompt_cache how_many_tokens_is_an_image per_image_token_cost 8_image_paste_cost image_append_is_a_suffix_write image_cache_invalidation_measured, ocd: 2026-08-04, lmd: 2026-08-04]

MEASURED 2026-08-04 — this CLOSES the "open measurement" this page flagged. 8 x 1568px images read
one per turn in an isolated subagent: `cache_creation` stayed flat at exactly **3,252 tokens** (the
image's own size) while `cache_read` grew by exactly **+3,252** each turn. Seven consecutive
appends, zero invalidations. Appending an image is suffix writing, confirmed directly rather than
inferred. Per-image cost is `(W x H)/750` — 3,278 predicted vs 3,252 measured (0.8%) — and there is
**no ~1,600 cap** at this size, which also retires the ~40x figure disagreement: the "525k tokens
for 8 images" number was the whole resident context misattributed to the images, wrong by ~20x.
The API doc's "Images | messages INVALID | adding/removing images anywhere in the prompt" row
describes MUTATING or REMOVING an image already inside the prefix, not appending one — consistent
with Anthropic's own `cache_miss_reason` enum, which carries no image cause and defines
`messages_changed` as an earlier entry "altered, reordered, or removed RATHER THAN APPENDED TO".
The shipped guard needs no change: warn-only, priced on resident cost, unit-test-pinned never to
assert invalidation. Every one of those choices survives the measurement. This settles the
imported-mechanism doubt this page originally flagged before it was measured[^1].
Evidence: `reports/image-cache-test/20260804_144500+0200-image-append-cache-measurement.md`. [^2]

## Notes and lessons learned
[^1]: [id:ATOM-UPSTREAM-MECHANISM-UNVERIFIED, status:valid, keywords:"imported_technique_wrong_premise upstream_claim_not_corroborated image_invalidates_message_cache deny_on_unverified_mechanism 700x_overhead", ocd:2026-07-28, lmd:2026-07-28]
  DO NOT encode an imported project's stated MECHANISM into an enforcing rule just because its
  ADVICE is good, BECAUSE the advice can be right for a reason that does not hold in this harness —
  here the remedies were correct but the "image invalidates the messages tier" premise is absent from
  the 14 causes measured in this repo, and a deny built on it would have blocked a hot-path tool on a
  fiction. DO check the imported premise against this repo's own measured taxonomy first, keep the
  advice, and downgrade enforcement to match what you can actually defend.
[^2]: [id:ATOM-JN0K-TBEO, status:valid, desc:"our enum records what WE instrumented, never what the API does", keywords:"absence_from_our_own_enum_is_not_evidence is_our_taxonomy_proof_of_API_behaviour how_to_settle_a_cache_mechanism_question two_turn_measurement arguing_from_absence_of_a_cause", ocd:2026-08-04, lmd:2026-08-04] DO NOT settle a question about API MECHANISM by checking whether our own taxonomy contains the cause, BECAUSE an enum records what WE chose to instrument, not what the API does — the image row sat "not corroborated" on exactly that reasoning while the API doc's invalidation table said the opposite, and neither side had measured anything (the argument also cited "the 14 causes" when there were 18, so it was not even accurate about our own enum). DO run the two-turn measurement the doubt names: append ONLY the thing under test and read `cache_creation` against `cache_read`.
