---
name: cache-risk-command-detection
description: "what actually broke my prompt cache / how does reload-cost know a /reload-plugins happened / where do the cache-break causes come from if no hook fires / does ConfigChange fire on /reload-plugins / how are /reload-skills /plugin /login /logout /model detected / why did the reload count change from 102 to 613 / where does the cost of a slash command get billed / why are so many breaks UNCLASSIFIED / an injected memory file keeps breaking the cache / a memory curator rewrote MEMORY.md under a live session / usertext block changed at msg[0]"
ocd: 2026-07-21
lmd: 2026-08-01
metadata:
  node_type: memory
  type: project
  tier: component
---

AgentlensPro names the slash commands that break the prompt cache by reading them out of the
**Claude Code transcript**, not from a hook and not by inference (`src/cacheRiskCommands.ts`,
TRDD-EYA3X5MQ). Claude Code persists every built-in command it runs as a `type:"user"` JSONL entry
whose content is a `<command-name>` block with `timestamp` and `sessionId` — so `/reload-plugins`,
`/reload-skills`, a mutating `/plugin`, `/login`, `/logout`, `/mcp`, `/model`, `/clear` and
`/compact` are all recoverable **exactly, retroactively, with nothing installed**.

**There are four possible detection layers; know which one you are on.**

| layer | sees a plugin reload? | notes |
|---|---|---|
| hook | **NO** | no plugin-reload event exists; built-ins don't fire `UserPromptSubmit`; `ConfigChange` was measured and REFUTED |
| transcript | **YES, exact** | the source this module uses |
| OTEL body | only if archiving is on | empty on a machine that never enabled it |
| derived effect (catalog co-churn) | approximately | over-counts; kept only as a labeled residue |

**Cost attribution.** The command itself makes no API call — its changed prefix rides the NEXT
model request — so a command at time T is billed on the **first turn at or after T**. The join key
is `CacheBreakTurn.tsMs` (`src/shared/cacheBreak.ts`), which is why that field exists.

**Three invariants any consumer must keep.** Each was a real defect first:

1. **ANCHOR the match to the start of the message.** Transcripts quote their own markers —
   assistant messages, tool_results and compaction summaries all contain `<command-name>` — so a
   loose search counted 687 reloads where 613 happened (11% inflation), including this feature's
   own design notes.
2. **One turn, one charge.** Several commands can precede the same next turn (two `/login` 18s
   apart did); they broke the prefix once, together. Charge the earliest, list the rest at 0 with
   the reason.
3. **A cap must never read as a total.** Report the true total alongside a capped page, and compute
   per-kind aggregates over the FULL window — chips computed from a truncated page under-report
   precisely the kinds frequent enough to be truncated.

**Not available: catalog sizes.** `/reload-plugins` prints `Reloaded: 34 plugins · 117 skills · …`
into the live conversation, which looks parseable, but it is **not persisted** — machine-wide only
14 records contain that line inside a stdout tag and none is a command entry; every one is a quote.
Do not build on it.

**Surfaces:** CLI `agentlenspro reload-cost` (tool `get_cache_risk_costs`, per-kind totals in
`byKind`, inference residue in `unexplainedReloadTurns`), dashboard "Cache-breaking commands" in the
Lifecycle tab, and `GET /api/cache-risk-commands` (windowed — the scan is mtime-bounded, so a 7-day
window is ~1.4s vs ~5s for all history).

**See also** the HOOK capture path, which is a different source for the overlapping lifecycle events
(`/clear` also arrives as `SessionStart{source:clear}`): `[[hook-events-pipeline]]`. The general
Claude Code hook/event catalog and the ConfigChange refutation live in the USER-scope reference
`[[claude-code-hook-types]]`. Cost/TTL background: `[[cache-ttl-model]]`, `[[agentlens-burn-token-model]]`.
The sibling reader on the same substrate — which plugin VERSION a session has loaded, and the
`attachment` record type that proves it — is `[[loaded-plugin-version-detection]]`; it consumes the
`/reload-plugins` events this page produces as its `lastReloadTs` join.

See also: [[image-resident-cost-guard]] (the same `CacheBreakCause` taxonomy used as EVIDENCE OF
ABSENCE — an image read is not among the 14, which is why the image guard warns instead of denying).

See also: [[ctxmap-exact-measurement-cost]] — this page classifies WHY a prefix broke; that one is
the tool that MEASURES what is in the prefix, and what measuring it exactly costs.


^ATOM-Z7A0-4ODB [desc:"Injected auto-memory files fell through every instruction-file matcher into UNCLASSIFIED — a curator rewriting them under live sessions re-mutates msg[0] in every session that injects them.", keywords: UNCLASSIFIED_cache_break injected_memory_file_broke_the_cache MEMORY.md_rewritten_under_a_live_session usertext_block_changed_at_msg_0 memory_curator_invalidates_prefix, ocd: 2026-08-01, lmd: 2026-08-01]

`get_cache_break_causes` reported ~19% of all classified break tokens as UNCLASSIFIED, with the actor
recorded only as `usertext block changed at pos 38: msg[0] user` — nothing anyone could act on.
Reading the raw captured bodies showed the changing region was the INJECTED AUTO-MEMORY file: its
path is neither `CLAUDE.md` nor under `.claude/rules/`, so it matched neither instruction-file
matcher and fell through to `usertext`.

That is the worst place for a blind spot, because memory files are rewritten by a curator agent while
other sessions are LIVE — one write re-mutates `msg[0]` and re-writes the whole prefix in every
session that injects it. Hence `MEMORY_FILE_CHANGED` (`src/cacheBreakTimeline.ts`), matched AFTER
`rule` and BEFORE `hook` so a memory page that merely QUOTES a hook marker is still attributed to the
file injection, not to a hook that never fired.

Honest limit: naming this cause did NOT empty the UNCLASSIFIED bucket. The dominant remaining actor
is a mutation in the LEAD region of `msg[0]`, before the first `Contents of` boundary — unreproduced,
because those captures had already rotated off the spool. That one is open.


^ATOM-0CUW-IVP6 [desc:"MEASURED breakpoint layout: system[2]/system[3]/last-message — and why 'first divergent block' is NOT what decides a cache hit", keywords: why_did_the_classifier_blame_the_wrong_block is_first_divergent_block_the_right_criterion where_are_the_cache_control_breakpoints cache_broke_but_no_block_changed system[0]_changes_every_turn_but_the_turn_is_warm 20_block_lookback_overflow, ocd: 2026-08-04, lmd: 2026-08-04]

MEASURED 2026-08-04 from live raw request bodies: Claude Code places **3 of the 4 allowed**
`cache_control` breakpoints, at **`system[2]`, `system[3]`, and the LAST message block** — `1h` on a
main-conversation subscription turn, `5m` on the interleaved subagent stream. The layout was stable
across the sample, but it is MEASURED, not contractual: parse the markers, never assume positions.

The load-bearing consequence: **`system[0]` (the `x-anthropic-billing-header` block) changes on EVERY
request, while those same turns bill 0.3-0.7% write against ~440k warm read.** If "the first block
that changed" were what decides a cache hit, every turn would be a full cold rewrite. They are not.
A change BEFORE the first breakpoint does not decide the hit, a change AFTER the governing
breakpoint cannot have caused a miss, and a break can happen with NO block changed at all (the
20-block lookback overrunning is sufficient on a tool-heavy turn).

`src/shared/cacheBreak.ts` has no breakpoint model — `firstDivergentBlock()` set-diffs blocks and
names the first change — so it can name a block that could not have caused the break, and every
consumer inherits that. Tracked as TRDD-V8YOWHVT, which blocks adding the ~18 unmodelled causes. [^4]

## Notes and lessons learned
[^1]: [id:ATOM-LAYR-ONLY, status:valid, keywords:"no hook sees it therefore undetectable only detection path wrong layer enumerate layers before concluding", ocd:2026-07-21, lmd:2026-07-21]
  DO NOT conclude "no hook observes X, therefore X is only detectable by inference" — that claim
  shipped into a code comment, a TRDD and a memory page — BECAUSE the question had been scoped to
  the HOOK layer while the transcript had been recording the command all along. DO enumerate the
  layers (hook · transcript · OTEL body · derived effect) before calling any one of them the only
  one.
[^2]: [id:ATOM-QUOT-CNT, status:valid, keywords:"grep raw file text counts quoted markers inflated count parse records not substrings 687 vs 613", ocd:2026-07-21, lmd:2026-07-21]
  DO NOT measure how often something happened by grepping raw transcript text, BECAUSE transcripts
  QUOTE their own markers, so the count includes assistant prose, tool_results and compaction
  summaries — it read 687 reloads for 613, and "626 persisted stdout lines" that were 14 real
  records plus prose. DO parse the record, require the block to anchor at the start of the message,
  and count records, never substrings.
[^3]: [id:ATOM-ONE-TURN, status:valid, keywords:"two commands same turn double charged cache_creation counted twice one turn one charge", ocd:2026-07-21, lmd:2026-07-21]
  DO NOT charge each command the full `cache_creation` of the turn it maps to, BECAUSE two commands
  seconds apart map to the SAME next turn and the prefix was rewritten once — two `/login` 18s apart
  double-billed a real turn until it was caught on live data. DO charge the earliest command and
  list the others at 0 with the reason.
[^4]: [id:ATOM-J4J4-NGJG, status:valid, desc:"an attribution method that ignores the mechanism launders a guess into a number", keywords:"classifier_named_a_culprit_it_cannot_justify wrong_culprit_worse_than_no_culprit diffing_interleaved_streams_as_one prove_the_emitter_before_naming_it", ocd:2026-08-04, lmd:2026-08-04] DO NOT ship a culprit-naming diagnostic whose attribution method does not model the mechanism it attributes, BECAUSE it converts a guess into a confident number that sends someone to fix the wrong component — cacheBreak.ts names "the first changed block" while the API keys on the prefix ending at a `cache_control` breakpoint with a 20-block lookback, so its answer can be a block that provably could not have caused the break. DO make the verdict say UNATTRIBUTABLE when the evidence cannot single out a culprit; a wrong name is strictly worse than no name.
