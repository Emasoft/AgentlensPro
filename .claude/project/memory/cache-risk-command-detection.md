---
name: cache-risk-command-detection
description: "what actually broke my prompt cache / how does reload-cost know a /reload-plugins happened / where do the cache-break causes come from if no hook fires / does ConfigChange fire on /reload-plugins / how are /reload-skills /plugin /login /logout /model detected / why did the reload count change from 102 to 613 / where does the cost of a slash command get billed"
ocd: 2026-07-21
lmd: 2026-07-21
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
