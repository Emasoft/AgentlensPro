---
trdd-id: ACD2U95S
title: Per-session LOADED plugin version — detect sessions running stale hooks after an update
column: completed
created: 2026-07-21T21:34:29+0200
updated: 2026-08-18T12:45:00+0200
current-owner: main
task-type: feature
scope: project
implementation-commits: [c1742c3]
relevant-rules: []
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-21

**Shipped.** Answers AgentlensPro#5 (ai-maestro-janitor, owner-directed 2026-07-18): a plugin
update lands machine-wide, but hooks and skills are SESSION-LOADED, so a running session keeps
executing the OLD cached code until its own `/reload-plugins`. A fleet rollout therefore leaves
invisible old-behavior ghosts, and a ghost is indistinguishable from "the fix doesn't work"
(janitor TRDD-P7WU40G9: a session on 0.52.0 hooks kept using the old compact threshold for ~20
minutes after 0.53.0 shipped the fix).

**Surface:** `agentlenspro plugin-versions [--plugin P] [--activeMinutes N] [--staleOnly]`
(aliases `plugin-versions`, `stale-plugins`) → tool `get_loaded_plugin_versions`.
Module `src/loadedPluginVersions.ts`, tests `src/test/loadedPluginVersions.test.ts` (14).

**First live run — every live session on this machine is a ghost:**

```
scanned=13 withEvidence=13 stale=11 unknown=2   newestCached ai-maestro-janitor=0.59.0
1ba3bea5 0.58.0 → ~/Code/AI-MAESTRO-PLUGIN/ai-maestro-plugin
65af6f9e 0.55.0 → ~/Code/PERFECT_SKILL_SUGGESTER/perfect-skill-suggester
43e66c93 0.56.0 → ~/ai-maestro
7877ae1f 0.56.0 → ~/Code/AgentlensPro          (this session)
7c64a7ba 0.56.0 → ~/Code/EMASOFT-PROGRAMMER-AGENT
```

Zero sessions were current. That is the finding, not a demo.

## The three decisions, each forced by a measurement

**1. The source is the harness-emitted skill-load attachment — nothing else.**
Claude Code writes `{type:"attachment", attachment:{type:"invoked_skills", skills:[{path:
"plugin:<p>:<s>", content:"Base directory for this skill: …/plugins/cache/<market>/<plugin>/
<VERSION>/…"}]}, timestamp, sessionId, cwd, version, gitBranch}`. That header is emitted by the
harness at load time, so it cannot be authored, quoted or guessed by the model. Measured on a
40-transcript sample, the same versioned path also appears **465×** inside `tool_use:Bash` inputs
and **111×** in assistant text — decoys outnumbering the real signal ~2:1, and every one of them
is the model *touching* a path (often deliberately reading an OLD cached version), never proof of
a load. Pinned by a test.

**2. `loadedVersion` = MAX version observed, NOT latest-by-timestamp.**
This is the one that would have shipped wrong. A compaction REPLAYS earlier skill invocations as
fresh attachment records carrying their ORIGINAL (older) content, so record order stops being
chronological: **18 of 19** multi-version sessions measured are non-monotone in time, and the
latest-timestamp record is routinely an old version — one session whose history reaches 0.57.0
reports 0.41.0 last. Max is sound because a session's loaded version only moves forward (the cache
only gains versions; a reload takes the newest), so a replay can echo an old version but can never
invent a newer one than was really loaded.

**3. `stale` is TRI-STATE, because max can under-estimate.**
If a session reloaded and then invoked no skill from that plugin, the newer load left no trace.
That is reported as `stale: 'unknown'` (a reload timestamp later than our newest evidence), never
as a false `true`. The consumer contract with the janitor (AgentlensPro#2) is fail-open, and a
fabricated verdict is worse than an honest gap.

## Honest limits, stated in the payload rather than omitted

- **No pid.** A session id cannot be mapped to an OS process from the transcript substrate.
  `lastActivityTs` (transcript mtime) is the liveness proxy; `--activeMinutes` scopes it.
- **The blind spot is reported.** `sessionsScanned - sessionsWithSkillEvidence`: a session that
  invoked no plugin skill has no evidence and is ABSENT from rows — absence is not a clean bill of
  health. (60% of a 40-file sample carried any skill-load attachment at all.)

## Two defects caught by running it on real data, not by the tests

1. **O(n²) reload scan.** The first draft called `scanCacheRiskCommands` *inside* the per-file
   loop with `path.dirname(path.dirname(file))` — which is the projects ROOT, so it re-walked all
   ~300 transcripts for each transcript. Now scanned once up front into a `Map` by session.
2. **A lean row that read as self-contradictory.** The CLI's lean shaping clipped `versionsSeen`
   to 3 entries, so a row showed `loadedVersion: 0.55.0` with a `versionsSeen` not containing it —
   a correct verdict that looked like a bug. Fixed with `versionsSeenCount` (makes the clip
   visible) and a severity-first sort (`stale > unknown > current`, then activity, then session id)
   so truncation keeps the rows that matter. The session tie-break is load-bearing too: on a busy
   machine many live transcripts share an mtime to the millisecond, and an mtime-only sort
   reordered itself between two runs seconds apart.

## Notes and lessons learned

## Approval log

- 2026-08-18T12:45:00+0200 — ARCHIVED by USER batch directive ("complete all TRDD"); validity re-verified: src/mcpServer.ts:1170 exports `get_loaded_plugin_versions`, src/cli/diagnosticsCli.ts:224 aliases `plugin-versions`.
