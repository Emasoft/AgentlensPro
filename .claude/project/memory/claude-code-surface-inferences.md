---
name: claude-code-surface-inferences
description: "the model id says claude-opus-5 not claude-opus-5[1m] / no context-1m beta so it must be 200k / derived the project dir name but it does not exist / 0 rows and everything excluded as another project / context reported 5x too full / which Claude Code surface can actually answer this"
ocd: 2026-08-07
lmd: 2026-08-07
metadata:
  node_type: memory
  type: project
  tier: aspect
---

# claude-code-surface-inferences


^ATOM-MKIA-FKLD [desc:"The betas list proves a 1M window; its ABSENCE proves nothing — fable reached 645k tokens with no beta", keywords: context_window_size 1m_context context-1m_beta claude-opus-5_not_1m contextPct_too_high windowSizeFor model_id_has_no_1m_tag CLAUDE_CODE_DISABLE_1M_CONTEXT, type: project, ocd: 2026-08-07, lmd: 2026-08-07]

**A request's window size can only be proven UPWARD, from `betas`.** The `[1m]` a user selects
never reaches the wire: every captured body says `claude-opus-5`, never `claude-opus-5[1m]`. Claude
Code strips the tag and carries the opt-in as the `context-1m-2025-08-07` beta instead, so the model
id alone cannot tell a 1M session from a 200k one.

Presence of `context-1m-*` is proof of 1M. **Absence is not proof of 200k**, and the symmetric
inference is measurably false: across one machine's spool all 180 `claude-opus-5` requests carried
the beta while 137 `claude-fable-5` requests carried none — and fable still reached 645,803 input
tokens in a single call. The beta gates 1M for some models and not others.

Consequence: `CLAUDE_CODE_DISABLE_1M_CONTEXT` is real (present in the 2.1.224 binary) but is NOT
detectable from a body — under it Claude Code simply omits the beta, which is indistinguishable
from a model that never needed one. Fall back to `shared/pricing.ts` `contextWindowTokens`, which is
the model's capability, and never to a private regex — see [[agentlens-burn-token-model]] for what
the window then costs.


^ATOM-JZM2-3CTM [desc:"A project slug past 200 chars is truncated and hashed, so deriving the directory name silently finds nothing", keywords: project_directory_name project_slug claude_projects_dir derived_dir_does_not_exist excluded_as_belonging_to_another_project 0_rows long_path --project_resolves_to_nothing, type: project, ocd: 2026-08-07, lmd: 2026-08-07]

**A project's log-directory name is only derivable while it is short.** Claude Code replaces every
non-alphanumeric character with `-`, and — measured against 2.1.224 by running a real session from a
237-character path — **truncates a slug past 200 characters to exactly 200 and appends `-` plus a
6-character hash** (observed: a 245-char slug became a 207-char directory ending `-4gwysy`, whose
first 200 characters were the naive slug's).

The hash is not reproducible: it matched none of md5/sha1/sha256/sha512 over the path or the slug,
in hex or base36, from either end. So an over-long path must be resolved by reading what is on disk
(`src/projectSlug.ts`), never by computing a name.

The failure is silent and self-congratulatory, which is why it survived: `get_cache_event_log`
compares its derived slug against REAL directory names, so from such a path it returned 0 rows and
"1283 call(s) excluded as belonging to another project" — labelling the exclusion "the scoping
boundary working as intended". Any view that derives a directory name and finds nothing should
suspect this before believing the machine was quiet.

## Notes and lessons learned
