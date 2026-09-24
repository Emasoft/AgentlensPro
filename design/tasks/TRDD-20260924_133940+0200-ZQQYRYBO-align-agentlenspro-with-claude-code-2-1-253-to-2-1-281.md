---
trdd-id: ZQQYRYBO
title: Align AgentlensPro with Claude Code 2.1.253 to 2.1.281
column: dev
created: 2026-09-24T13:39:40+0200
updated: 2026-09-24T19:28:22+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: refactor
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-24T13:39:40+0200
implementation-commits: [92d8b369, b30b80d7, 33189cdf, fc89382b, 0972f2e7, 76c3b859, ef1577b6, e48e49c6, 97cb873d, f101fe50, 5b272f77, 079f7839, 802531dd, bb53a24c]
---

# Align AgentlensPro with Claude Code 2.1.253 to 2.1.281

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-24

Owner directive verbatim: "examine in depth all the following changes made to
claude code in the recent versions and correct the codebase accordingly, also
using the new functionalities to improve the project" (the owner pasted the
CC 2.1.246-2.1.281 changelog with it).

Reports (this plan was merged from these five, all in
`reports/cc-alignment/`, dated 2026-09-24):
- `reports/cc-alignment/20260924_131722+0200-models-pricing.md`
- `reports/cc-alignment/20260924_132520+0200-cache-causes.md`
- `reports/cc-alignment/20260924_132352+0200-telemetry-ingest.md`
- `reports/cc-alignment/20260924_132930+0200-hooks-transcripts.md`
- `reports/cc-alignment/20260924_133105+0200-shipped-surface.md`
- `reports/cc-alignment/20260924_133225+0200-2.1.253-281-plan.md` (the plan itself)

Progress so far: I1+I2 (pricing) landed in commit b30b80d7; I4 (Monitor) is committed (92d8b369).
The rest not started.

Out of scope here, owned elsewhere: the spool removal is TRDD-Z53IJFE9 and is
excluded here; the 13 uncommitted hook and memory files waiting for the owner
are also excluded.
2026-09-24: I12a's exact path is unmeasured - index.jsonl carries request_id, message_id, message_uuid, request_file, response_file and no request_body_id; follow-up = pair from index rows + count exact vs fallback.
2026-09-24: I6a follow-up = take the Fable model from the session's current model (real /effort lines rarely carry one: 1 of 2), grade /upgrade and /extra-usage ambiguous not dropped, add both-sides threshold tests.
2026-09-24: I15 open question awaiting the owner (unverified: one event sums every hook; one SubagentStart dispatch = one spawn).
2026-09-24 board-review correction: I9, I6/I6a, I12a and I15 are landed with a named open defect each, not fully done — I9 and I15 checkboxes unchecked above to reflect this; I6/I12a were never checked (I6 checkbox stays unchecked, I12a is a sub-part of still-unchecked I12).
I9 open defect: the dashboard Traces totals count a repeated system prompt 4x in a long session; fix tracked as I9b, under revision. Root: compaction markers were sampled over 300 transcripts — compact_boundary appears in 12 files, isCompactSummary in 9, type:"summary" in 0 — and the A-to-B-to-A miscount plus a calibration flip were both introduced by I9 itself.
I6a open defect: the Fable 5.1 gate reads the model from the command line, which rarely carries one (1 of 2 /effort lines, 2 of 14 /model lines carry a model — n is small, do not generalize from it); command-line entries DO reliably carry a version (56 of 57).
I12a open defect: the exact-pairing branch (request_body_id) is probably dead code in practice — tracked as its own card, TRDD-RZMLO09L.
I15 open defect: two printed claims in its output are unverified (one event sums every hook; one SubagentStart dispatch = one spawn) — owner decision pending, see Q-list above.
Message correction (2026-09-24): commit 5b272f77's "1,999 of 1,999" mixed start and complete events together — the count is unreliable as a total; the num_hooks=3 conclusion it supported still holds.
Message correction (2026-09-24): commit bb53a24c's "shared build directory" cause is "most likely", not established as fact.
Message correction (2026-09-24): commit 802531dd's "the heuristic CLAUDE.md records" may in fact be a different code path — not verified as stated.
Correction to the I9 main-tree check (2026-09-24): "no raw body capture exists" was wrong. ~/.agentlens/otel-bodies holds roughly 23k live files, so ctxmap cross-checks against raw request/response bodies are possible after all.

## Increments

- [x] I1 — CORRECTION — Add pricing for Opus 5.5, Opus 5.5 fast and Mythos 5.1 (MP F1 F4 F7 F8)
- [x] I2 — CORRECTION — Billable weight uses each model's real cache-read and cache-write rates (MP F2)
- [ ] I3 — CORRECTION — Subagent review gate never fires: sidechain skip (HT-1)
- [x] I4 — CORRECTION — Monitor `persistent` removed in 2.1.271: fix the diagnostics skill (SS F1)
- [ ] I5 — CORRECTION — `setup` overwrites the user's own `lean-worker` (SS F3)
- [ ] I6 — CORRECTION — Cache causes and remediations gated on Claude Code version: effort, /login, MCP/plugins, idle TTL, subagent TTL (CC F1 F2 F3 T1, TTL prior; MP F5)
- [x] I7 — CORRECTION — Cache timeline: `thinking.display`, `DEFERRED_BUILTINS`, effort text, git anchor (CC D1 B1, HT 8, SS F4, MP F6)
- [ ] I8 — CORRECTION — "Possibly the CC bug fixed in 2.1.X" note on causes from old versions (CC F4)
- [ ] I9 — SILENT-MISS — Context classifier: `instructions` and `prompt_snapshot` attachments (HT-2)
- [x] I10 — SILENT-MISS — Read the harness's own miss cause from the status line (CC E1, TI 1.4)
- [x] I11 — SILENT-MISS — Show resume staleness from SessionStart and the new SubagentStop fields (HT-5)
- [ ] I12 — SILENT-MISS — Pair each request with its response via `request_body_id`/`index.jsonl`; bound the index's growth (TI 1.1 1.2) — BLOCKED-ON-CAPTURE
- [ ] I13 — DOC — CLAUDE.md doctrine sweep, `cache-ttl-model.md`, cache-guard and visualize skills, `micro-worker.md` (MP F8 F9, CC DOC-STALE, HT-2, SS F2)
- [x] I14 — IMPROVE — `omitClaudeMd` on `agentlens-tldr-worker` and `micro-worker` (SS O1)
- [ ] I15 — IMPROVE — Verb showing what each hook injects into context (TI 1.3)
- [x] I16 — IMPROVE — Split the 97 KB diagnostics SKILL.md into a short body plus references (SS O2)
- [ ] I17 — IMPROVE — Harness `thinking_drop` attachment as a reported cause (HT-4)
- [ ] I18 — IMPROVE — Background-agent totals from `queued_command` usage (HT-6)
- [x] I19 — IMPROVE — Remediation for many subagents on Opus names `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` (SS O3)
- [ ] I20 — IMPROVE — SubagentStop matcher to skip the ~81% of spawns with an empty agent type (HT-7)
- [ ] I21 — IMPROVE — Cost by skill, plugin and MCP server in window rollups (TI 1.6)
- [ ] I22 — IMPROVE — `claude plugin eval` suite for the shipped skills (SS O4)
2026-09-24: I14 — kept omitClaudeMd on micro-worker only; removed from agentlens-tldr-worker (it edits arbitrary-project code, so dropping CLAUDE.md would silently strip that project's conventions). Ships to users only via setup/installAgents, which today overwrites a user's own lean-worker (I5 / Q3) — release after Q3 is resolved.
2026-09-24: I6 — I6a done (partial); I6b/I6c still in progress.

## Owner questions

- **Q1 — burn currency:** `equivOf` weights reads at 0.1x on every model (MP F3). Should it be scaled per model by read rate over input rate (the smallest change), or switched to USD via `calcTokenCostUsd`? Its documentation calls it "the window-drain currency".
- **Q2 — review gate:** turning the subagent review gate back on (I3) makes every worker that writes spawn a review fork again. That is cost it has not paid since 2026-09-07. Confirm.
- **Q3 — `lean-worker`:** rename the shipped one to `agentlens-lean-worker`, or skip if the installed file differs?
- **Q4 — `security-guidance`:** it self-reported $112.98 of spend today (TI 1.5).
  - First settle whether that spend is also counted as some session's `api_request` rows.
  - Then decide whether to show it, and whether the plugin stays on.
- **Q5 — `setup` on this machine:**
  - It installs the model-switch hooks that are missing here (HT-3), which needs a session restart.
  - Run it only after I5, or it overwrites your 8 KB `lean-worker`.
  - Also remove the orphaned Stop hook `pending-prompt.txt` (HT-8), which `setup` does not own.
- **Q6 — repository attribution:** `OTEL_METRICS_INCLUDE_REPOSITORY=1` puts the repo URL on every event (TI 1.7 / SS O6). The value stays local. Wait until the spool removal has changed `telemetryConfig.ts`, because it touches the same file.

## Notes and lessons learned

## Approval log

- 2026-09-24T13:39:40+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Advisor verdict

Advisor verdict — 2026-09-24 (reports/cc-alignment/20260924_134351+0200-advisor-verdict.md), summarising sections 1 and 3:
I6: read the CC version only from the bounded billing block, the transcript record, or the status-line version column, reusing compare_versions — never the timeline's unbounded AgentMeta regex, which would one day self-match a fixture quoting cc_version=.
/login: certainty that the account actually changed is not decidable in the risk scanner (transcript-only); at >=2.1.273 report it ambiguous, full stop — do not attempt the account-registry join.
I8: the context flag ({resumed|fork|teammate|subagent}) has no verified body source beyond cc_is_subagent — ship it optional, and word the note conditionally when the source can't be verified.
I7: gate EFFORT_PARAM_CHANGED by model and version instead of re-ranking it after the other causes — its branch-order position is deliberate and must stay; the messages[0] git-anchor fix is settled and needs no further capture.
I12: split into (a) registry pairing on request_body_id, unblocked now, and (b) store-side pairing via a persisted byte offset into index.jsonl, never truncated — (b) also waits on spool steps B and D landing in chores.rs/pass.rs.
W-cache1 runs after W-cache2 because both regenerate the same timeline parity fixtures; running them in parallel would overwrite each other's output.
Q3 recommendation: rename the shipped worker to agentlens-lean-worker rather than adding a second, drift-prone skip-if-different code path.
