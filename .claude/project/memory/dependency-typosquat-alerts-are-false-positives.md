---
name: dependency-typosquat-alerts-are-false-positives
description: "janitor says preact is a typosquat of react / should I approve TRDD-3FNE8X3H / DEP-003 high typosquat proposals keep firing / gaxios ofetch color flagged as typosquats / is our dependency list compromised"
ocd: 2026-08-02
lmd: 2026-08-02
metadata:
  node_type: memory
  type: project
  tier: component
---

# dependency-typosquat-alerts-are-false-positives


^ATOM-CYOY-ETBJ [desc:"the recurring DEP-003 typosquat proposals are all false positives — do NOT approve them", keywords: janitor_typosquat_proposal_keeps_firing should_I_approve_DEP-003 preact_flagged_as_typosquat_of_react gaxios_ofetch_color_flagged is_our_dependency_compromised, ocd: 2026-08-02, lmd: 2026-08-02]

The heartbeat re-surfaces four DEP-003 "typosquat" proposals every fire (`preact`/react,
`gaxios`/axios, `ofetch`/fetch, `color`/colors). VERIFIED 2026-08-02, all four are false positives and
must NOT be approved: every name resolves on npm as a real, current, widely-used package (preact
10.29.8, gaxios 7.3.0 — Google's HTTP client, ofetch 1.5.1 — unjs, color 5.0.3), **`preact` is this
project's OWN dashboard dependency**, and every flagged lockfile lives in a gitignored `downloads_dev/`
corpus that is never installed, built, or shipped. Approving one would edit the dependency list on the
strength of a Levenshtein distance with no registry check behind it. The detector belongs to
ai-maestro-janitor, so the fix is upstream, not here. [^1]

## Notes and lessons learned

[^1]: [id:ATOM-AK4A-97CH, status:valid, desc:"an edit-distance alert is a hypothesis; the registry is the evidence", keywords:"edit_distance_is_not_evidence security_alert_with_no_registry_check detector_scans_gitignored_dirs approving_a_fix_on_a_false_positive", ocd:2026-08-02, lmd:2026-08-02] DO NOT act on a "typosquat" alert because the name is one edit from a popular package, BECAUSE edit distance alone is a hypothesis and the registry is the evidence — four such alerts here named packages that are real, current, widely used, and in one case our own dependency. DO check three things before approving any of them: does the name resolve on the registry with a plausible version and history, is the flagged manifest actually installed by this project or merely present in a gitignored working dir, and is it one of our own declared dependencies. A security fix applied to a false positive is a real change made for no reason.
