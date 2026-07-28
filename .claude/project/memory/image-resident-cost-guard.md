---
name: image-resident-cost-guard
description: "why did reading a screenshot make the session expensive / does an image break the prompt cache / does an image invalidate the message cache / claude-cache-guard 700x overhead claim / why does cost keep climbing after I looked at a picture / what does the Read cache-guard warning mean / how do I turn off the image warning / is Read really in the burn-gate matcher"
ocd: 2026-07-28
lmd: 2026-07-28
metadata:
  node_type: memory
  type: project
  tier: component
---

Reading an image into a large session is expensive — but **not for the reason the popular write-up
gives**, and the difference decides whether a gate may deny.

**The rejected claim.** `0x0funky/claude-cache-guard` states that an image ANYWHERE in a request
invalidates the entire messages tier of the prompt cache, so the next call rewrites the whole
conversation at the cache-WRITE rate (~700x overhead; their case: 40 one-at-a-time image reads cost
81% of a session). **AgentlensPro cannot corroborate this for Claude Code.** `CacheBreakCause`
(`src/shared/summarizerTypes.ts`) enumerates the 14 prefix-break causes measured here — tools
changed/reordered, system-prompt timestamp, model/effort/fast-mode switches, MCP toggle, plugin and
skill reloads, plugin-set change, account switch, tool deny, injected-block mutation, compaction —
and **an image read is not one of them**. Adding an image APPENDS content, and appending is suffix
writing, which is what every turn does.

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

**Open measurement that would settle it.** Find turns whose only new content block is an image and
compare the reported `cache_creation` against the image block's own token count
(`get_cache_event_log` + the raw bodies). That resolves the ~40x disagreement AND directly tests the
invalidation claim — a full-prefix-sized `cache_creation` on such a turn would corroborate it. Until
someone runs it, warn-only is the honest position.

See also: [[agentlens-burn-token-model]] (the cost model this specialises — windows metered by cost,
`turns × per-turn-context`); [[cache-risk-command-detection]] (where the 14 `CacheBreakCause` values
come from — the taxonomy that refutes the invalidation claim); [[cache-ttl-model]] (the write tiers
the guard's price talk depends on: 1.25x at 5-min, 2x at 1-hour); [[hook-events-pipeline]] (the
PreToolUse path the guard rides); [[agent-fleet-cache-economics]] (the delegate-to-a-subagent remedy
priced).

## Notes and lessons learned
[^1]: [id:ATOM-UPSTREAM-MECHANISM-UNVERIFIED, status:valid, keywords:"imported_technique_wrong_premise upstream_claim_not_corroborated image_invalidates_message_cache deny_on_unverified_mechanism 700x_overhead", ocd:2026-07-28, lmd:2026-07-28]
  DO NOT encode an imported project's stated MECHANISM into an enforcing rule just because its
  ADVICE is good, BECAUSE the advice can be right for a reason that does not hold in this harness —
  here the remedies were correct but the "image invalidates the messages tier" premise is absent from
  the 14 causes measured in this repo, and a deny built on it would have blocked a hot-path tool on a
  fiction. DO check the imported premise against this repo's own measured taxonomy first, keep the
  advice, and downgrade enforcement to match what you can actually defend.
