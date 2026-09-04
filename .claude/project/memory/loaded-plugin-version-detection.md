---
name: loaded-plugin-version-detection
description: "which plugin version is a session actually running / why does the fix not work after a plugin update / stale hooks after auto-update / old-behavior ghost session / how does plugin-versions know the loaded version / why is stale sometimes unknown / can I map a session id to a pid"
ocd: 2026-07-21
lmd: 2026-09-04
metadata:
  node_type: memory
  type: project
  tier: component
publish-globally: false
---

^M7HHMDON [desc:"a live session keeps running the plugin version it loaded at start; plugin-versions names each session's loaded version and the first run found 11 of 13 sessions stale", keywords:"the_fix_does_not_work_after_a_plugin_update old_behavior_after_updating_a_plugin session_still_running_old_plugin_code how_to_tell_which_plugin_version_a_session_loaded stale_hooks_after_auto_update ghost_session_old_behavior plugin_update_did_not_take_effect why_is_my_fix_not_working_after_update check_loaded_plugin_version agentlenspro_plugin-versions_command", ocd:2026-07-21, lmd:2026-09-04]
A Claude Code session loads a plugin's hooks and skills ONCE and keeps running that code until its
own `/reload-plugins` lands — so after a machine-wide plugin update, live sessions keep executing
the OLD version. Such a session is an **old-behavior ghost**, and its symptom is indistinguishable
from "the new fix doesn't work". `agentlenspro plugin-versions` (tool `get_loaded_plugin_versions`,
`src/loadedPluginVersions.ts`, TRDD-ACD2U95S, answers AgentlensPro#5) names the loaded version per
session. First live run: **13 live sessions, 11 stale, 2 unknown, zero current** — including the
session that wrote the feature.

^BI01KLC2 [desc:"the only trustworthy signal of a loaded skill version is the harness-emitted attachment record, since it cannot be authored, quoted, or guessed by the model", keywords:"where_does_plugin_version_detection_get_its_data attachment_record_invoked_skills harness_emitted_skill_load_evidence cannot_fake_or_guess_loaded_skill_version attachment_type_invoked_skills_path how_is_loaded_skill_path_captured session_id_cwd_version_gitBranch_in_attachment trustworthy_source_of_plugin_version", ocd:2026-07-21, lmd:2026-09-04]
**The source is the `attachment` record, and only that.** When Claude Code loads a skill it writes
`{type:"attachment", attachment:{type:"invoked_skills", skills:[{path:"plugin:<p>:<s>",
content:"Base directory for this skill: …/plugins/cache/<market>/<plugin>/<VERSION>/…"}]},
timestamp, sessionId, cwd, version, gitBranch}`. The harness emits it at load time, so — unlike a
versioned path in assistant prose or a Bash argv — it cannot be authored, quoted or guessed by the
model, and it carries the session, the project, the Claude Code version and the branch for free.

^1N1MHW7K [desc:"stale is tri-state true/false/unknown, and the newest cached version comes from one directory listing filtered to digit-prefixed folder names", keywords:"stale_field_true_false_unknown_meaning why_is_stale_sometimes_unknown coercing_stale_to_boolean_is_wrong newest_cached_plugin_version_lookup plugin_cache_directory_has_non-version_folders tsconfig.test.json_sorts_as_newest_bug how_to_find_newest_cached_plugin_version", ocd:2026-07-21, lmd:2026-09-04]
`stale` is **tri-state**: `true` (behind the cache) · `false` (current) · `'unknown'` (a reload
happened after the newest evidence, so the real version is ≥ what we saw but unseeable). Consumers
must branch on all three; a `!!stale` coercion turns every honest gap into a false alarm. Newest
cached version is one read of `~/.claude/plugins/cache/<market>/<plugin>/`, keeping only dir names
starting with a digit (the cache also holds `tsconfig.test.json` and `walkthrough/`, which would
otherwise sort as "newest").

^4JN5P9SL [desc:"no session-to-pid mapping exists so transcript mtime is the liveness proxy, and sessions with no skill-load evidence are silently absent from the output rows", keywords:"can_I_map_a_session_id_to_a_pid no_process_id_at_transcript_layer lastActivityTs_liveness_proxy activeMinutes_option_meaning sessions_missing_from_rows_output absence_of_skill_evidence_is_not_a_clean_bill_of_health sessionsScanned_vs_sessionsWithSkillEvidence why_is_a_session_missing_from_plugin-versions_output", ocd:2026-07-21, lmd:2026-09-04]
**No pid exists at this layer** — a session id cannot be mapped to an OS process from the
transcript, so `lastActivityTs` (transcript mtime) is the documented liveness proxy and
`--activeMinutes` scopes it. The blind spot is a number, not a silence: `sessionsScanned −
sessionsWithSkillEvidence` counts sessions that invoked no plugin skill, and those are **absent
from `rows`** — absence is not a clean bill of health (~60% of a 40-file sample had any skill-load
attachment at all).

^RHFWV2AP [desc:"this page shares its detection substrate and anti-grep discipline with cache-risk-command-detection, and its hook-platform background lives on hook-events-pipeline", keywords:"related_pages_for_plugin_version_detection same_substrate_as_cache_risk_detection lastReloadTs_join_with_cache_detection four_detection_layers_reused hook_events_pipeline_background claude_code_hook_types_reference see_also_cache-risk-command-detection", ocd:2026-07-21, lmd:2026-09-04]
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
