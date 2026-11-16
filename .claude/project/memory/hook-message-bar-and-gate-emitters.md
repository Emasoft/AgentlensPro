---
name: hook-message-bar-and-gate-emitters
description: "what may a hook say to a model / removed a hook advisory but it still fires / why does the fan-out warning not fire / hook noise policy / agent context injection rules / model-facing text bar own project actionable significant / FAN_OUT_COLD_START removed / THRASH_UNATTRIBUTED removed / detection surfaced nowhere / explaining is not interrupting / buildAdvisory vs evaluateAgentGate twin emitters / changed buildAdvisory but the warning persists / PostToolUse advisory and PreToolUse warn / gate code emitted twice / claimed the data is still visible somewhere / removed a consumer and said nothing was lost"
ocd: 2026-08-07
lmd: 2026-10-14
metadata:
  node_type: memory
  type: project
  tier: component
publish-globally: false
---

# What a hook may say to a model, and the two gate emitters

^ATOM-2IIQ-XI6J [desc:"The bar every model-facing hook message must clear: own-project, actionable now, significant — anything else belongs in the CLI/dashboard, not an interruption", keywords: what_may_a_hook_say_to_an_agent advisory_got_removed why_doesn't_the_fan-out_warning_fire hook_noise_policy agent_context_injection_rules model-facing_text_bar, type: project, ocd: 2026-08-07, lmd: 2026-09-23]

Ratified 2026-08-07 after an audit of what the gate hooks actually injected. Text AgentlensPro puts
in front of a MODEL must clear all three:

1. **OWN PROJECT** — never another project's session id, path, or agent types. Scoping matches the
   caller's own SESSION first and its cwd second: a worktree-isolated subagent runs in a different
   directory by design, so cwd alone silenced the advisory for exactly the fan-out shape most
   likely to be expensive. It fails QUIET — an unidentifiable caller gets silence, because an
   unprovable match must not become a claim.
2. **ACTIONABLE NOW** — the caller can change what it is about to do. "Go run investigate_burn
   later" is a CLI answer, not an interruption.
3. **SIGNIFICANT** — a real anomaly, not the expected cost of normal work. [^1]

^ATOM-3LUC-AX9I [desc: "Failing the hook-message bar removed two advisories whose detection now surfaces nowhere; never add hook text without asking the three questions first", keywords: FAN_OUT_COLD_START_removed THRASH_UNATTRIBUTED_removed detection_surfaced_nowhere giving_it_a_home_is_open_work do_not_add_a_hook_message_to_explain explaining_is_not_interrupting ask_three_questions_before_hook_text foreign_identities_stripped_from_denies hook_noise_removed_from_stall_messages thrash_suspects_identity_stripped, type: project, ocd: 2026-09-23, lmd: 2026-09-23]

Failing that bar cost two advisories outright (`FAN_OUT_COLD_START`, whose own text ended "No
action needed"; `THRASH_UNATTRIBUTED`, about writes provably attributable to nobody) and stripped
foreign identities from the denies, the stall messages, and the thrash suspects. Nothing left the
DETECTION — but be exact about what that does and does not mean, because the comfortable version of
this sentence was wrong: `thrash.unattributed` and `coldStartSessions` had NO consumer outside the
gate, so they are still computed and now surfaced NOWHERE. Giving them a home is open work.[^1]

**DO NOT** add a hook message because it explains a real finding, BECAUSE each of the removed ones
was added exactly that way — to help a HUMAN reading a debug session — and explaining is not
interrupting; the reader in production is a busy agent that cannot act on it. **DO** ask the three
questions above before adding any hook text, and put anything that fails them behind an explicit
request instead.

^ATOM-OLKB-N7AV [desc:"Every gate code has TWO model-facing emitters — buildAdvisory (PostToolUse) and evaluateAgentGate (PreToolUse warn) — so changing one leaves the other firing", keywords: removed_the_advisory_but_it_still_fires gate_code_emitted_twice PostToolUse_advisory_and_PreToolUse_warn_twin changed_buildAdvisory_but_the_warning_persists, type: project, ocd: 2026-08-07, lmd: 2026-08-07]

`src/agentGate.ts` reaches a model through two independent paths that share the same code names:

- `buildAdvisory(state)` → PostToolUse → `hookSpecificOutput.additionalContext`
- `evaluateAgentGate(...)` → PreToolUse → `systemMessage` (warn) / `permissionDecisionReason` (deny)

`THRASH_UNATTRIBUTED` and `FANOUT_HEADSUP` each existed in BOTH. Removing one branch leaves the
other emitting the identical message, and the tests for the two live in different suites, so a
green run proves nothing about the twin.

**DO NOT** treat a gate code as fixed after editing `buildAdvisory`, BECAUSE the PreToolUse twin is
a separate branch a hundred lines away that no failing test will point you to. **DO**
`grep -n "'<CODE>'" src/agentGate.ts` and expect TWO hits before believing a change is complete —
and remember the deny path renders through a third field again.

## Governed by

- [[agentlenspro-ops-lessons-testing-and-process-hygiene]] — the testing and process-hygiene overview this page details.

## Notes and lessons learned

[^1]: [id:ATOM-GERK-9WB1, status:valid, supersedes:ATOM-2IIQ-XI6J, desc:"The 'nothing was lost, it is still available over there' clause is a claim about a CONSUMER — grep for one before writing it", keywords:"claimed_the_data_is_still_visible_somewhere removed_a_consumer_and_said_nothing_was_lost nothing_was_lost_claim_unverified detection_still_runs_but_is_surfaced_nowhere", ocd:2026-08-07, lmd:2026-08-07] DO NOT write "the detection still reaches X" when removing the thing that displayed it, BECAUSE that sentence is a claim about a CONSUMER, not about the detector, and it is the single most comforting thing to assert and the least likely to have been checked — here the retired `thrash.unattributed` / `coldStartSessions` had NO consumer outside the file being edited, so removing the advisories left them computed and surfaced nowhere, and the false reassurance was copied verbatim into the code comment, the CHANGELOG, the commit message and this page before a review caught it. DO run the grep for a reader of the field FIRST (`grep -rn "<field>" src/ standalone/ media/ | grep -v <the file you are editing>`), and if it comes back empty, say so: "computed, currently surfaced nowhere — giving it a home is open work." SUPERSEDED BODY: Ratified 2026-08-07 after an audit of what the gate hooks actually injected. Text AgentlensPro puts in front of a MODEL must clear all three: 1. **OWN PROJECT** — scoped to the caller's own cwd. Never another project's session id, path, or agent types. Scoping is exact-cwd and fails QUIET: an unidentifiable caller gets silence, because an unprovable match must not become a claim. 2. **ACTIONABLE NOW** — the caller can change what it is about to do. "Go run investigate_burn later" is a CLI answer, not an interruption. 3. **SIGNIFICANT** — a real anomaly, not the expected cost of normal work. Failing that bar cost two advisories outright (`FAN_OUT_COLD_START`, whose own text ended "No action needed"; `THRASH_UNATTRIBUTED`, about writes provably attributable to nobody) and stripped foreign identities from the denies, the stall messages, and the thrash suspects. Nothing left the PRODUCT — every detection still reaches the dashboard, `--risk`, `investigate_burn` and the skill. **DO NOT** add a hook message because it explains a real finding, BECAUSE each of the removed ones was added exactly that way — to help a HUMAN reading a debug session — and explaining is not interrupting; the reader in production is a busy agent that cannot act on it. **DO** ask the three questions above before adding any hook text, and put anything that fails them behind an explicit request instead.
