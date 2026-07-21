---
name: loaded-plugin-version-detection
description: "which plugin version is a session actually running / why does the fix not work after a plugin update / stale hooks after auto-update / old-behavior ghost session / how does plugin-versions know the loaded version / why is stale sometimes unknown / can I map a session id to a pid"
ocd: 2026-07-21
lmd: 2026-07-21
metadata:
  node_type: memory
  type: project
  tier: component
---

A Claude Code session loads a plugin's hooks and skills ONCE and keeps running that code until its
own `/reload-plugins` lands — so after a machine-wide plugin update, live sessions keep executing
the OLD version. Such a session is an **old-behavior ghost**, and its symptom is indistinguishable
from "the new fix doesn't work". `agentlenspro plugin-versions` (tool `get_loaded_plugin_versions`,
`src/loadedPluginVersions.ts`, TRDD-ACD2U95S, answers AgentlensPro#5) names the loaded version per
session. First live run: **13 live sessions, 11 stale, 2 unknown, zero current** — including the
session that wrote the feature.

**The source is the `attachment` record, and only that.** When Claude Code loads a skill it writes
`{type:"attachment", attachment:{type:"invoked_skills", skills:[{path:"plugin:<p>:<s>",
content:"Base directory for this skill: …/plugins/cache/<market>/<plugin>/<VERSION>/…"}]},
timestamp, sessionId, cwd, version, gitBranch}`. The harness emits it at load time, so — unlike a
versioned path in assistant prose or a Bash argv — it cannot be authored, quoted or guessed by the
model, and it carries the session, the project, the Claude Code version and the branch for free.

`stale` is **tri-state**: `true` (behind the cache) · `false` (current) · `'unknown'` (a reload
happened after the newest evidence, so the real version is ≥ what we saw but unseeable). Consumers
must branch on all three; a `!!stale` coercion turns every honest gap into a false alarm. Newest
cached version is one read of `~/.claude/plugins/cache/<market>/<plugin>/`, keeping only dir names
starting with a digit (the cache also holds `tsconfig.test.json` and `walkthrough/`, which would
otherwise sort as "newest").

**No pid exists at this layer** — a session id cannot be mapped to an OS process from the
transcript, so `lastActivityTs` (transcript mtime) is the documented liveness proxy and
`--activeMinutes` scopes it. The blind spot is a number, not a silence: `sessionsScanned −
sessionsWithSkillEvidence` counts sessions that invoked no plugin skill, and those are **absent
from `rows`** — absence is not a clean bill of health (~60% of a 40-file sample had any skill-load
attachment at all).

Same substrate and same discipline as `[[cache-risk-command-detection]]`, which supplies the
`lastReloadTs` join and whose "four detection layers" and anti-grep lessons apply here unchanged.
Hook/event platform background: `[[hook-events-pipeline]]`, `[[claude-code-hook-types]]`.

## Notes and lessons learned
[^1]: [id:ATOM-RPLY-TSMP, status:valid, keywords:"latest timestamp record wrong version compaction replays attachment original content non-monotone 18 of 19", ocd:2026-07-21, lmd:2026-07-21]
  DO NOT read a session's current state from the LATEST-TIMESTAMP transcript record, BECAUSE a
  compaction REPLAYS earlier attachments as fresh records carrying their ORIGINAL older content —
  18 of 19 multi-version sessions measured are non-monotone in time, and one whose history reaches
  0.57.0 reports 0.41.0 last. DO take the MAX over a monotone quantity (a loaded version only moves
  forward), so a replay can echo an old value but never invent a newer one.
[^2]: [id:ATOM-TOUCH-LOAD, status:valid, keywords:"versioned path in bash argv assistant text is not proof of load 465 vs 111 decoys model read old version deliberately", ocd:2026-07-21, lmd:2026-07-21]
  DO NOT treat a versioned plugin path found in a Bash input or assistant text as evidence of what
  the session LOADED, BECAUSE those are the model TOUCHING a path — often deliberately reading an
  OLDER cached version — and they outnumber the real signal ~2:1 (465 Bash + 111 text vs the
  attachments, on a 40-transcript sample). DO accept only the harness-emitted record, which the
  model cannot author.
[^3]: [id:ATOM-LEAN-CLIP, status:valid, keywords:"lean shaping truncated array row self-contradictory loadedVersion missing from versionsSeen add count field", ocd:2026-07-21, lmd:2026-07-21]
  DO NOT return a list field whose meaning depends on being complete, BECAUSE the CLI's lean
  shaping clips long arrays and a clipped row read `loadedVersion: 0.55.0` with a `versionsSeen`
  not containing it — a CORRECT verdict that looked like a bug. DO ship an explicit count beside
  the list and sort by severity so truncation keeps the rows that matter.
[^4]: [id:ATOM-SORT-FLAP, status:valid, keywords:"sort by mtime unstable live transcripts share millisecond order changed between runs tie break session id", ocd:2026-07-21, lmd:2026-07-21]
  DO NOT sort session rows by transcript mtime alone, BECAUSE on a busy machine many live
  transcripts share an mtime to the millisecond and the output reordered itself between two runs
  seconds apart. DO add a deterministic tie-break (session id) after the meaningful keys.
