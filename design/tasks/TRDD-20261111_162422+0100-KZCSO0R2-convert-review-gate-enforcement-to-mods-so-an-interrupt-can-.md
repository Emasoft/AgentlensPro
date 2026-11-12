---
trdd-id: KZCSO0R2
title: Convert review-gate enforcement to mods so an interrupt can never skip the adversarial review
column: dev
status: tasked
created: 2026-11-11T16:24:22+0100
updated: 2026-11-12T14:04:08+0100
implementation-commits: [42b140f5, 43baaf9b, dd79f249, bcf2b35b, b6440a9f]
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-11T16:24:22+0100
---

# Convert review-gate enforcement to mods so an interrupt can never skip the adversarial review

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-11-12

- Committed: 42b140f5 (--json-verdict), 43baaf9b (--transcript branch, reviewed accept-with-conditions), dd79f249 (mod scaffold; it scans nothing, because turn.complete carries no transcript path), bcf2b35b (scanner options: --ignore-interrupt-floor, --cwd, scan.readable, options.ignoreInterruptFloor, exit 2 on malformed command line), b6440a9f (mod reads transcript path and cwd from classic.* payloads, scans aborted turns). Nothing of this card is uncommitted except the 2026-11-12 safe-fixes pass.
- Corrections to commit messages (cannot be amended): bcf2b35b says the serverEndpoints "capture OFF" failure is tracked by TRDD-4LR2GTV2; that card does not name the test, and the failure is real, reproduces alone, is UNTRACKED and out of this card scope. The new reviewGate suite has 12 tests; its interrupted-write fixtures are a bare tool_use with no tool_result. b6440a9f subject says "for real" but the mod has never handled an aborted turn.
- PROBE 2026-11-12 (Claude Code 2.1.322, no aborted turn measured; full table reports_dev/mods-review-gate/20261112_135949+0100-probe-measurements.md):
  - M1 the real mod loads; passing a bare `$` to own helpers is accepted.
  - M2 `on()` with a non-literal event name refuses the whole module; names must be string literals.
  - M3 classic.SessionStart/UserPromptSubmit/Stop/SubagentStop carry transcript_path and cwd; agent_id undefined on main (D1 holds).
  - M4 classic.PreToolUse payload is the tool input plus tool and tool_use_id; no transcript_path, cwd or agent_id; its handler was removed.
  - M5 classic.UserPromptSubmit fires for a mod-submitted prompt and a subagent hand-back; a cron-started turn unmeasured.
  - M6 `$.process.run` result keys exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated; the real review-gate CLI ran from the mod, exit 0, verdict field names right.
  - M7 (no positive control, indicated not settled) the turn final answer was NOT found on disk at turn.complete in 5 of 5 turns (file 48 lines, CLI scanned 50): a scan at turn.complete can miss the tail.
  - M8 `await $.prompt.submit` in turn.complete on a NON-aborted turn resolved within 6 s and started a new turn; aborted case unmeasured.
  - M9 a mod-submitted prompt passes through the prompt.submit hook: a demand would be delivered twice in one turn.
  - M10 a plain-string context entry reaches the model; e.context is undefined on input.
  - M11 typed, mod-submitted and subagent hand-back prompts all fire prompt.submit and would consume a show-once demand.
  - M12 turn.complete keys answer, durationMs, isAborted, turnId, reason, usage (+agentId on a subagent turn); reason value not recorded.
  - M13 classic.Stop fires before turn.complete.
- DECISIONS 2026-11-12 (user said: "decide yourself. just base your decisions on verified facts."): D1 transcript path and cwd come from classic.* event payloads; a temp file of $.session.messages() or a stdin message mode was rejected, both need a second scanner input format. D2 scanner opt-in --ignore-interrupt-floor, because the interrupt floor makes an interrupted turn scan as demands false. D3 cwd passed with --cwd. D4 the non-aborted second net stays in the code, disabled, until transcript lag is measured. D5 standalone/cli.js is gitignored local deploy state and must be rebuilt with node esbuild.js after each scanner change.
- D6 (2026-11-12): no change to the aborted-turn path (scan timing, `$.prompt.submit`, persistence) until an aborted turn has been measured; the probe tool runs Claude in tmux with `--setting-sources project`, so an Esc can be sent with `tmux send-keys Escape` without the user.
- D7 (2026-11-12): before the persistence increment, decide the scanner contract: the verdict must report review credit for the scanned turn, not only `demands`.
- NEXT ACTION: (1) Esc probe in tmux: cases Edit-then-sleep + Esc; Esc at a permission prompt; Esc then an immediate prompt; with a positive control for the transcript-lag needle (previous turn answer checked at each turn.complete and prompt.submit), recording `turn.complete.reason` and `prompt.submit.origin`. (2) Decide scan timing and the fate of `$.prompt.submit` from those rows only. (3) scanner tests with a tool_result; docstring of parseVerdictArgs ("strict" overstates: an unknown flag is ignored); `verdict()` classification as a pure tested function.
- STILL UNMEASURED: everything about an aborted turn ($.prompt.submit refused or not, lag on its tail, Esc at a permission prompt, a prompt typed right after Esc); a cron-started turn; whether a hooks module may import a sibling file; the values of turn.complete.reason and prompt.submit.origin.
- Keep: the mod is NOT installed and must stay uninstalled (it has only been loaded in the throwaway probe session; its aborted-turn path has never run).

## Approval log

- 2026-11-11T16:24:22+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-11T18:37:38+0100 — column → todo by user. design complete (reports_dev/mods-review-gate/20261111_design.md); starting Phase 0 --json-verdict flag
