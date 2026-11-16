---
name: memory-scope-leak-detector-false-positives
description: "janitor flags a PROJECT memory page as leaking machine-private data / memory-scope-leak detector false positive / should I demote this page to LOCAL scope / .local suffix flagged as machine-host / pii us_passport id shape collision / can I trust the memory-scope-leak detector's verdict / a page with settings.local.json in its text got flagged / a governance id like G20260731 got flagged as a us passport / do I need to move this wiki page out of PROJECT scope / is this memory-scope-leak hit real or a shape match / how do I verify a memory-scope-leak candidate before acting / demoting a correctly-PROJECT page destroys shared knowledge / what counts as machine-private data in a wiki page / why did pii:us_ssn fire on this page / detector says demote to LOCAL but the page looks fine / cache-risk-command-detection flagged as a high-entropy secret / snake_case recall keywords trip the entropy heuristic / verify a high-entropy-secret hit before demoting a page / split-lineage digest flagged as us_ssn / the ops lessons pages flagged for pii us_ssn are false positives / github outbound identity page flagged as machine-host / an @handle stored as a recall keyword looks like an ssh host"
ocd: 2026-09-05
lmd: 2026-10-20
publish-globally: false
metadata:
  node_type: memory
  type: project
  tier: component
---

# memory-scope-leak-detector-false-positives


^ATOM-136O-9PIH [desc: "verify a memory-scope-leak hit before acting — .local suffix and pii id-shape collisions are common false positives", keywords: memory_scope_leak_false_positive pii_us_passport_shape_collision machine-host_dot_local_suffix demote_to_local_scope should_I_approve_this_leak_candidate verify_before_demoting_a_project_page settings.local.json_flagged governance_id_flagged_as_passport shape_match_not_meaning_match do_not_delete_knowledge_on_a_false_positive janitor_surfaces_never_edits memory-scope-leak_detector_verdict, ocd: 2026-09-05, lmd: 2026-09-23, claude_mem_ref: memory-scope-leak-proposed.md, claude_mem_hash: 91d24f8e5440cf48]

The PROJECT memory scope (`<git-root>/.claude/project/memory/`) is git-tracked
and PUSHED, so it MUST NOT carry machine/user-private material. The pages below
carry a leak class that MAY belong in the LOCAL scope
(`~/.claude/projects/<slug>/memory/`, never pushed).

**VERIFY EACH MATCH BEFORE ACTING — these are SHAPE matches, not meaning
matches, and a false positive is COMMON.** Demoting a correctly-PROJECT page
removes it from the pushed corpus every contributor shares, so acting on an
unverified hit DESTROYS shared knowledge. Open the page, find the token, and
confirm it is genuinely machine/user-private. Known systematic collisions:

- `machine-host` fires on ANY `.local` suffix. Legitimate non-host senses seen
  in practice: scope/team placeholders (`default.local`, `myteam.local`,
  `org.local`) and the FILENAME `settings.local.json` — a page documenting that
  config file is flagged for naming its own subject.
- `pii:us_passport` is `[A-Z]` + 8 digits, which is also the shape of a
  governance/verdict id (`G20260731`) and of many date-suffixed ids. A corpus
  that mints ids in that shape collides with it systematically.

Only when the hit is REAL: demote the offending fact to LOCAL (move it, or
rewrite the page portable). If the hit is a false positive, leave the page
ALONE — do not 'fix' it, and do not delete the knowledge. The janitor only
SURFACES — it never edits a page (RULE 0), and neither should an agent acting
on an unverified match.






^ATOM-7KQ3-P2XM [desc: "the detector's live finding list as of 2026-10-21 — the eight PROJECT pages the memory-scope-leak detector currently flags", keywords: current_live_memory-scope-leak_findings_list which_pages_are_flagged_today is_my_page_in_the_current_leak_candidate_list todays_demote-to-local_list re-run_the_detector_to_clear_a_stale_finding current_false-positive_candidates_as_of_date what_pages_does_the_detector_currently_flag live_list_of_pii_and_machine-host_hits up_to_date_memory-scope-leak_report does_the_live_list_still_name_this_page detector_findings_as_of_2026-10-21 the_eight_pages_the_detector_flags_today buffer_note_mirrored_into_the_wiki, type: reference, ocd: 2026-10-21, lmd: 2026-10-21, claude_mem_ref: memory-scope-leak-proposed.md, claude_mem_hash: 91d24f8e5440cf48]
As of 2026-10-21 the detector's live finding list (re-run each pass; check the
buffer note `memory-scope-leak-proposed.md` for the current state) named:

- `.claude/project/memory/agentlenspro-ops-lessons-concurrency-and-event-loop.md` — pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/agentlenspro-ops-lessons-deploy-and-install.md` — pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/agentlenspro-ops-lessons-store-durability-and-memory.md` — pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/agentlenspro-ops-lessons-testing-and-process-hygiene.md` — pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/agentlenspro-ops-lessons.md` — pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/cache-risk-command-detection.md` — high-entropy secret — demote to LOCAL scope
- `.claude/project/memory/github-outbound-identity-and-mention-guards.md` — machine-host — demote to LOCAL scope
- `.claude/project/memory/memory-scope-leak-detector-false-positives.md` — pii:us_passport — demote to LOCAL scope


^ATOM-4WD9-HJ3R [desc: "the pii:us_ssn hits on the five ops-lessons pages are the pages' own split-lineage digest, not a social-security number", keywords: split-lineage_digest_matches_us_ssn pii_us_ssn_is_a_false_positive split_lineage_frontmatter_value machine_generated_digest_is_not_pii do_not_demote_on_a_us_ssn_hit check_the_matched_run_before_demoting ops_lessons_pages_flagged_for_us_ssn why_did_pii_us_ssn_fire_on_these_pages verify_the_us_ssn_shape_collision the_same_digest_on_five_pages machine-host_no_longer_fires_on_the_testing_page, type: reference, ocd: 2026-10-21, lmd: 2026-10-21]
Verdict (verified 2026-10-21): FALSE POSITIVE — every `pii:us_ssn` hit on the five
`agentlenspro-ops-lessons*` pages is the SAME nine-digit run, `266022327`, which is the
leading digits of the page's own `split-lineage:` frontmatter digest
(`266022327e5e4d3796245d2d1a921c06`) — a 32-hex value the corpus writes on every page it
splits. It is a machine-generated digest, not a social-security number, and it names no
person, machine, path or account. All five pages stay in PROJECT scope.

The `machine-host` label that ALSO fired on
`agentlenspro-ops-lessons-testing-and-process-hygiene.md` in the 2026-10-08 run no longer
fires: that page's only `.local` is the escaped `\.local` inside the grep pattern its own
lesson quotes, and a backslash before the dot leaves the ssh/hostname rules nothing to
match.


^ATOM-9TB2-LK6V [desc: "the machine-host hit on the github-outbound page is two GitHub handles stored as one recall keyword, not an ssh target", keywords: machine-host_hit_on_the_github_outbound_page github_handle_read_as_an_ssh_target recall_keyword_looks_like_a_host at-mention_keyword_trips_the_ssh_user-host_rule do_not_demote_on_a_machine-host_hit check_the_match_inside_the_atom_keywords two_github_handles_stored_as_one_keyword the_handles_are_documentation_not_an_ssh_target verdict_verified_2026-10-21, type: reference, ocd: 2026-10-21, lmd: 2026-10-21]
Verdict (verified 2026-10-21): FALSE POSITIVE — the `machine-host` hit on
`github-outbound-identity-and-mention-guards.md` is the `private-path.ssh-user-host` rule
reading the two GitHub handles the page stores inside a single recall keyword. The page
documents the 2026-08-02 incident in which agents wrote bare `@handle` strings into public
issue bodies and paged two real strangers, and it keeps that incident in a keyword so the
fact stays findable; the `user@host` shape of those two handles is exactly what the ssh
rule convicts.

It is not an ssh target, and it carries no machine, path, host or credential. The two
handles are already published in this PROJECT page, so a "demote to LOCAL" verdict would
move a page the corpus already shares without making it cleaner. The page stays in PROJECT
scope.


^ATOM-3NQ7-VW4C [desc: "the cache-risk high-entropy hit and this page's own pii:us_passport hit are both false positives and both pages stay in PROJECT scope", keywords: cache-risk_command_detection_high-entropy_false_positive high_entropy_secret_verdict_2026-09-23 self_referential_pii_us_passport_hit settings.local.json_flagged governance_id_flagged_as_passport do_not_demote_the_cache-risk_page left_in_project_scope_verified_false_positive both_remaining_classes_stay_in_project_scope the_two_verdicts_still_true_at_the_2026-10-21_rerun, type: reference, ocd: 2026-10-21, lmd: 2026-10-21]
The two remaining classes are FALSE POSITIVES — verified 2026-09-23 and still true at the
2026-10-21 re-run — so both pages stay in PROJECT scope:

- `.claude/project/memory/cache-risk-command-detection.md` — high-entropy secret — demote to LOCAL scope. Verdict (verified 2026-09-23): FALSE POSITIVE — every run of 16+ characters that is not plain lowercase snake_case/path is a code identifier (e.g. `UNCLASSIFIED_cache_break`, `MEMORY_FILE_CHANGED`, `firstDivergentBlock`, `src/cacheBreakTimeline.ts`); no hex/base64 run; the detector's buffer does not record the matched substring. Left in PROJECT scope. [^2]
- `.claude/project/memory/memory-scope-leak-detector-false-positives.md` — pii:us_passport — demote to LOCAL scope (this page's own worked examples, `settings.local.json` and `G20260731`, trip the detector — a textbook self-referential false positive; the machine-host class no longer fires on this page — re-verified 2026-10-21) [^1] [^2]


## See also

- [[agentlens-burn-token-model]]
- [[agentlenspro-ops-lessons-testing-and-process-hygiene]]
- [[cumulative-vs-per-turn-fields]]
- [[github-outbound-identity-and-mention-guards]]


## Superseded


^ATOM-K3M7-Q8V2 [desc: "the detector's current dated live-findings list as of 2026-10-08 — machine-host no longer fires on the false-positives page; pii:us_passport remains", keywords: current_live_memory-scope-leak_findings_list which_pages_are_flagged_today is_my_page_in_the_current_leak_candidate_list todays_demote-to-local_list re-run_the_detector_to_clear_a_stale_finding current_false-positive_candidates_as_of_date what_pages_does_the_detector_currently_flag live_list_of_pii_and_machine-host_hits up_to_date_memory-scope-leak_report does_the_live_list_still_name_this_page machine-host_dropped_from_false-positives_page detector_findings_as_of_2026-10-08, ocd: 2026-10-08, lmd: 2026-10-21, claude_mem_hash: cd0c96b7547ca86b, claude_mem_ref: memory-scope-leak-proposed.md, status: superseded, superseded-by: ATOM-7KQ3-P2XM]
As of 2026-10-08 the detector's live finding list (re-run each pass; check the
buffer note `memory-scope-leak-proposed.md` for the current state) named:

- `.claude/project/memory/agentlenspro-ops-lessons-concurrency-and-event-loop.md` — pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/agentlenspro-ops-lessons-deploy-and-install.md` — pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/agentlenspro-ops-lessons-store-durability-and-memory.md` — pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/agentlenspro-ops-lessons-testing-and-process-hygiene.md` — machine-host, pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/agentlenspro-ops-lessons.md` — pii:us_ssn — demote to LOCAL scope



^ATOM-NKLC-HTFZ [desc: "the 2026-10-08 findings list's second half — the cache-risk false-positive verdict, this page's own self-referential pii:us_passport hit, and the resolution note", keywords: current_live_memory-scope-leak_findings_list which_pages_are_flagged_today is_my_page_in_the_current_leak_candidate_list todays_demote-to-local_list re-run_the_detector_to_clear_a_stale_finding current_false-positive_candidates_as_of_date what_pages_does_the_detector_currently_flag live_list_of_pii_and_machine-host_hits up_to_date_memory-scope-leak_report does_the_live_list_still_name_this_page machine-host_dropped_from_false-positives_page detector_findings_as_of_2026-10-08, ocd: 2026-10-08, lmd: 2026-10-21, status: superseded, superseded-by: ATOM-7KQ3-P2XM]

- `.claude/project/memory/cache-risk-command-detection.md` — high-entropy secret — demote to LOCAL scope. Verdict (verified 2026-09-23): FALSE POSITIVE — every run of 16+ characters that is not plain lowercase snake_case/path is a code identifier (e.g. `UNCLASSIFIED_cache_break`, `MEMORY_FILE_CHANGED`, `firstDivergentBlock`, `src/cacheBreakTimeline.ts`); no hex/base64 run; the detector's buffer does not record the matched substring. Left in PROJECT scope. [^2]
- `.claude/project/memory/memory-scope-leak-detector-false-positives.md` — pii:us_passport — demote to LOCAL scope (this page's own worked examples, `settings.local.json` and `G20260731`, trip the detector — a textbook self-referential false positive; the machine-host class no longer fires on this page as of the 2026-10-08 re-run) [^1] [^2]

_Surfaced by the `memory-scope-leak` detector. Resolve by moving the private fact to the LOCAL scope (the harness `# Memory` dir), or by rewriting the PROJECT page to be portable (no usernames/paths/hosts/secrets). Re-run clears this once the leak is gone._




^ATOM-GO1L-5NSH [desc: "the detector's current dated live-findings list, updated to add cache-risk-command-detection.md (high-entropy secret)", keywords: current_live_memory-scope-leak_findings_list which_pages_are_flagged_today is_my_page_in_the_current_leak_candidate_list todays_demote-to-local_list re-run_the_detector_to_clear_a_stale_finding current_false-positive_candidates_as_of_date what_pages_does_the_detector_currently_flag live_list_of_pii_and_machine-host_hits up_to_date_memory-scope-leak_report does_the_live_list_still_name_this_page cache-risk-command-detection_flagged_high-entropy_secret, ocd: 2026-09-23, lmd: 2026-09-23, claude_mem_hash: cd0c96b7547ca86b, claude_mem_ref: memory-scope-leak-proposed.md, status: superseded, superseded-by: ATOM-K3M7-Q8V2]
As of 2026-09-23 the detector's live finding list (re-run each pass; check the
buffer note `memory-scope-leak-proposed.md` for the current state) named:

- `.claude/project/memory/agentlenspro-ops-lessons-concurrency-and-event-loop.md` — pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/agentlenspro-ops-lessons-deploy-and-install.md` — pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/agentlenspro-ops-lessons-store-durability-and-memory.md` — pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/agentlenspro-ops-lessons-testing-and-process-hygiene.md` — machine-host, pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/agentlenspro-ops-lessons.md` — pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/cache-risk-command-detection.md` — high-entropy secret — demote to LOCAL scope. Verdict (verified 2026-09-23): FALSE POSITIVE — every run of 16+ characters that is not plain lowercase snake_case/path is a code identifier (e.g. `UNCLASSIFIED_cache_break`, `MEMORY_FILE_CHANGED`, `firstDivergentBlock`, `src/cacheBreakTimeline.ts`); no hex/base64 run; the detector's buffer does not record the matched substring. Left in PROJECT scope.
- `.claude/project/memory/memory-scope-leak-detector-false-positives.md` — machine-host, pii:us_passport — demote to LOCAL scope (this page's own worked examples, `settings.local.json` and `G20260731`, trip the detector — a textbook self-referential false positive) [^1] [^2]




^ATOM-HFTI-GH1P [desc: "the detector's current dated live-findings list — which PROJECT pages are flagged right now and why, re-run each pass", keywords: current_live_memory-scope-leak_findings_list which_pages_are_flagged_today is_my_page_in_the_current_leak_candidate_list todays_demote-to-local_list re-run_the_detector_to_clear_a_stale_finding current_false-positive_candidates_as_of_date what_pages_does_the_detector_currently_flag live_list_of_pii_and_machine-host_hits up_to_date_memory-scope-leak_report does_the_live_list_still_name_this_page, ocd: 2026-09-10, lmd: 2026-09-10, status: superseded, superseded-by: ATOM-GO1L-5NSH]

As of 2026-09-10 the detector's live finding list (re-run each pass; check the
buffer note `memory-scope-leak-proposed.md` for the current state) named:

- `.claude/project/memory/agentlenspro-ops-lessons-concurrency-and-event-loop.md` — pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/agentlenspro-ops-lessons-deploy-and-install.md` — pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/agentlenspro-ops-lessons-store-durability-and-memory.md` — pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/agentlenspro-ops-lessons-testing-and-process-hygiene.md` — machine-host, pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/agentlenspro-ops-lessons.md` — pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/memory-scope-leak-detector-false-positives.md` — machine-host, pii:us_passport — demote to LOCAL scope (this page's own worked examples, `settings.local.json` and `G20260731`, trip the detector — a textbook self-referential false positive)

_Surfaced by the `memory-scope-leak` detector. Resolve by moving the private fact to the LOCAL scope (the harness `# Memory` dir), or by rewriting the PROJECT page to be portable (no usernames/paths/hosts/secrets). Re-run clears this once the leak is gone._

## Notes and lessons learned

[^1]: [id: ATOM-EKU8-MW1I, status: superseded, superseded-by: ATOM-O1A4-0A2I, keywords: "high_entropy_secret_false_positive snake_case_keyword_trips_entropy_heuristic verify_before_demoting_cache-risk-command-detection grep_for_hex_base64_before_acting entropy_detector_false_alarm recall_keywords_look_like_secrets cache-risk-command-detection_false_positive check_page_before_demoting_to_local entropy_shape_collision memory-scope-leak_verdict_verification", ocd: 2026-09-23, lmd: 2026-09-23] DO NOT demote a PROJECT page on a high-entropy-secret hit without checking it, BECAUSE long snake_case keyword runs (recall keywords) trip the entropy-shape heuristic just like a real secret would. DO grep the page for an actual hex/base64 run first (`grep -E '\b[0-9a-f]{24,}\b|\b[A-Za-z0-9+/]{30,}={0,2}'`) before acting on the finding.
[^2]: [id: ATOM-O1A4-0A2I, status: valid, supersedes: ATOM-EKU8-MW1I, keywords: "high_entropy_secret_false_positive verify_before_demoting_a_project_page detector_does_not_record_matched_token short_or_separated_tokens_escape_narrow_regex cache-risk-command-detection_flagged_high-entropy_secret memory-scope-leak_detector_verdict snake_case_recall_keywords_trip_entropy_heuristic aws_key_style_token_is_short mixed_case_or_hyphen_split_secret_escapes_regex judge_each_16plus_char_run_before_demoting", ocd: 2026-09-23, lmd: 2026-09-23] DO NOT treat a narrow hex/base64 regex as proof a high-entropy-secret hit is false, BECAUSE the detector does not record which substring matched and real tokens can be short (AWS AKIA… = 20 chars), mixed-case, or split by `-`/`.`/`_` separators. DO list every run of 16+ characters that is not plain lowercase snake_case or a path — `grep -n -o -E '[A-Za-z0-9_+/=.-]{16,}' <page> | grep -v -E ':[a-z0-9_./-]+$'` — and judge each one: a code identifier (camelCase name, CONSTANT, file path) is not a secret. SUPERSEDED BODY: DO NOT demote a PROJECT page on a high-entropy-secret hit without checking it, BECAUSE long snake_case keyword runs (recall keywords) trip the entropy-shape heuristic just like a real secret would. DO grep the page for an actual hex/base64 run first (`grep -E '\b[0-9a-f]{24,}\b|\b[A-Za-z0-9+/]{30,}={0,2}'`) before acting on the finding.
