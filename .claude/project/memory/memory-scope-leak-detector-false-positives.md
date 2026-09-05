---
name: memory-scope-leak-detector-false-positives
description: "janitor flags a PROJECT memory page as leaking machine-private data / memory-scope-leak detector false positive / should I demote this page to LOCAL scope / .local suffix flagged as machine-host / pii us_passport id shape collision / can I trust the memory-scope-leak detector's verdict / a page with settings.local.json in its text got flagged / a governance id like G20260731 got flagged as a us passport / do I need to move this wiki page out of PROJECT scope / is this memory-scope-leak hit real or a shape match / how do I verify a memory-scope-leak candidate before acting / demoting a correctly-PROJECT page destroys shared knowledge / what counts as machine-private data in a wiki page / why did pii:us_ssn fire on this page / detector says demote to LOCAL but the page looks fine"
ocd: 2026-09-05
lmd: 2026-09-05
publish-globally: false
metadata:
  node_type: memory
  type: project
  tier: component
---

# memory-scope-leak-detector-false-positives


^ATOM-136O-9PIH [desc: "verify a memory-scope-leak hit before acting — .local suffix and pii id-shape collisions are common false positives", keywords: memory_scope_leak_false_positive pii_us_passport_shape_collision machine-host_dot_local_suffix demote_to_local_scope should_I_approve_this_leak_candidate verify_before_demoting_a_project_page settings.local.json_flagged governance_id_flagged_as_passport shape_match_not_meaning_match do_not_delete_knowledge_on_a_false_positive janitor_surfaces_never_edits memory-scope-leak_detector_verdict, ocd: 2026-09-05, lmd: 2026-09-05]

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

As of 2026-09-05 the detector's live finding list (re-run each pass; check the
buffer note `memory-scope-leak-proposed.md` for the current state) named:

- `.claude/project/memory/agentlenspro-ops-lessons-concurrency-and-event-loop.md` — pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/agentlenspro-ops-lessons-deploy-and-install.md` — pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/agentlenspro-ops-lessons-store-durability-and-memory.md` — pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/agentlenspro-ops-lessons-testing-and-process-hygiene.md` — machine-host, pii:us_ssn — demote to LOCAL scope
- `.claude/project/memory/agentlenspro-ops-lessons.md` — pii:us_ssn — demote to LOCAL scope

_Surfaced by the `memory-scope-leak` detector. Resolve by moving the private fact to the LOCAL scope (the harness `# Memory` dir), or by rewriting the PROJECT page to be portable (no usernames/paths/hosts/secrets). Re-run clears this once the leak is gone._


## See also

- [[agentlens-burn-token-model]]
- [[agentlenspro-ops-lessons-testing-and-process-hygiene]]
- [[cumulative-vs-per-turn-fields]]

## Notes and lessons learned
