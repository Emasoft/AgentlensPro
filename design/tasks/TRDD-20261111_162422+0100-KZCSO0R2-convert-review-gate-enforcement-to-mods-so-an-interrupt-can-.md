---
trdd-id: KZCSO0R2
title: Convert review-gate enforcement to mods so an interrupt can never skip the adversarial review
column: dev
status: tasked
created: 2026-11-11T16:24:22+0100
updated: 2026-11-12T14:37:48+0100
implementation-commits: [42b140f5, 43baaf9b, dd79f249, bcf2b35b, b6440a9f, ef178cd6]
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

- Committed: 42b140f5 (--json-verdict), 43baaf9b (--transcript branch, reviewed accept-with-conditions), dd79f249 (mod scaffold; it scans nothing, because turn.complete carries no transcript path), bcf2b35b (scanner options: --ignore-interrupt-floor, --cwd, scan.readable, options.ignoreInterruptFloor, exit 2 on malformed command line), b6440a9f (mod reads transcript path and cwd from classic.* payloads, scans aborted turns). ef178cd6 (safe fixes after the first probe).
- Corrections to commit messages (cannot be amended): bcf2b35b says the serverEndpoints "capture OFF" failure is tracked by TRDD-4LR2GTV2; that card does not name the test, and the failure is real, reproduces alone, is UNTRACKED and out of this card scope. The new reviewGate suite has 12 tests; its interrupted-write fixtures are a bare tool_use with no tool_result. b6440a9f subject says "for real" but the mod has never handled an aborted turn.
- PROBE 2026-11-12 (Claude Code 2.1.322, no aborted turn measured; full table reports_dev/mods-review-gate/20261112_135949+0100-probe-measurements.md):
  - M1 the real mod loads; passing a bare `$` to own helpers is accepted.
  - M2 `on()` with a non-literal event name refuses the whole module; names must be string literals.
  - M3 classic.SessionStart/UserPromptSubmit/Stop/SubagentStop carry transcript_path and cwd; agent_id undefined on main (D1 holds).
  - M4 classic.PreToolUse payload is the tool input plus tool and tool_use_id; no transcript_path, cwd or agent_id; its handler was removed.
  - M5 classic.UserPromptSubmit fires for a mod-submitted prompt and a subagent hand-back; a cron-started turn unmeasured.
  - M6 `$.process.run` result keys exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated; the real review-gate CLI ran from the mod, exit 0, verdict field names right.
  - RETRACTED by E8: M7 (no positive control, indicated not settled) the turn final answer was NOT found on disk at turn.complete in 5 of 5 turns (file 48 lines, CLI scanned 50): a scan at turn.complete can miss the tail.
  - M8 `await $.prompt.submit` in turn.complete on a NON-aborted turn resolved within 6 s and started a new turn; aborted case unmeasured.
  - M9 a mod-submitted prompt passes through the prompt.submit hook: a demand would be delivered twice in one turn.
  - M10 a plain-string context entry reaches the model; e.context is undefined on input.
  - M11 typed, mod-submitted and subagent hand-back prompts all fire prompt.submit and would consume a show-once demand.
  - M12 turn.complete keys answer, durationMs, isAborted, turnId, reason, usage (+agentId on a subagent turn); reason value not recorded.
  - M13 classic.Stop fires before turn.complete.
- DECISIONS 2026-11-12 (user said: "decide yourself. just base your decisions on verified facts."): D1 transcript path and cwd come from classic.* event payloads; a temp file of $.session.messages() or a stdin message mode was rejected, both need a second scanner input format. D2 scanner opt-in --ignore-interrupt-floor, because the interrupt floor makes an interrupted turn scan as demands false. D3 cwd passed with --cwd. D4 the non-aborted second net stays in the code, disabled, until transcript lag is measured. D5 standalone/cli.js is gitignored local deploy state and must be rebuilt with node esbuild.js after each scanner change.
- D6 (2026-11-12): no change to the aborted-turn path (scan timing, `$.prompt.submit`, persistence) until an aborted turn has been measured; the probe tool runs Claude in tmux with `--setting-sources project`, so an Esc can be sent with `tmux send-keys Escape` without the user.
- D7 (2026-11-12): before the persistence increment, decide the scanner contract: the verdict must report review credit for the scanned turn, not only `demands`.
- NEXT ACTION: decide P1-P5 (advisor, then a proposal with MEASURE and REVIEW forks); then implement one bounded change at a time. Leftovers of the probe, not deleted: folders escprobe.* under TMPDIR and their transcript folders under ~/.claude/projects; raw data in reports_dev/mods-review-gate/20261112_143247+0100-esc-probe-raw/.
- STILL UNMEASURED: everything about an aborted turn ($.prompt.submit refused or not, lag on its tail, Esc at a permission prompt, a prompt typed right after Esc); a cron-started turn; whether a hooks module may import a sibling file; the values of turn.complete.reason and prompt.submit.origin.
- Keep: the mod is NOT installed and must stay uninstalled (it has only been loaded in the throwaway probe session; its aborted-turn path has never run).
- 2026-11-12 Esc probe finished + review of ef178cd6 (accept with conditions). Committed: ef178cd6 (safe fixes; this line supersedes 'nothing is uncommitted except the safe-fixes pass'). The Esc probe FINISHED (report reports_dev/mods-review-gate/20261112_143247+0100-esc-probe.md); nothing is in flight. MEASURED: a Write under /tmp or /private/tmp does NOT arm the scanner (synthetic transcript: scratch path demands false, /repo path demands true), so the probe's first runs have INVALID verdict columns; the worker was re-briefed to use a dir under TMPDIR with a no-Esc control turn. Review conditions still open: (a) M1 proves only that no load-error line appeared, not that the real mod's handlers ran (atom/read/update and $.ui.status never exercised); (b) M7 tested the final answer text only, never a tool_use entry, so 'a scan at turn.complete can miss the tail' is wider than the measurement; (c) the probe loads the mod at b6440a9f, not ef178cd6; (d) README still says 'Then install via local marketplace' after 'Do NOT install' and still says four measurements need a real user Esc; (e) the prompt.submit hook catch in register.js is still silent; (f) the 'capture OFF' test failure is unattributed: only TRDD-4LR2GTV2 was checked, six other cards match the phrase and were not read; (g) lint coverage of agentlenspro-review-mod/ never shown. Also: agentlenspro-review-mod/tsconfig.json and .claude-plugin/types/ are generated by Claude Code on plugin load, untracked on purpose; the previous turn's review fork never reported (session restart).
- ESC PROBE 2026-11-12 (Claude Code 2.1.322, tmux, cwd under TMPDIR):
  - E1 aborted turn (C1, run1): turn.complete fires with isAborted true, reason "aborted"; classic.Stop does not fire.
  - E2 Esc at a permission dialog (C2) is a rejection, NOT an abort: isAborted false, reason "answer", classic.Stop did not fire either, and the mod (which acts on isAborted only) did nothing: this turn is covered by NO net today. One observation.
  - E3 the rejected, never-run Write scanned demands true (C2): the scanner arms on a tool_use whose tool_result is a user rejection.
  - E4 on disk at turn.complete of the aborted turn: completed Write tool_use and tool_result yes, in-flight Bash tool_use yes, its tool_result and the interrupt entry NO in C1 but yes in run1; all present by the next prompt.submit in both. Completeness at turn.complete is not stable.
  - E5 verdict with --ignore-interrupt-floor: demands true at turn.complete and at the next prompt.submit for the aborted turn with a completed Write (C1), and for the no-Esc control.
  - E6 `$.prompt.submit` after an abort: with no user input since, it RESOLVES at once with `{drop: "the session was stopped and nobody has sent input since"}` and starts nothing (C1); when a typed prompt came in between (run1) it stayed pending 84 s and then started a plugin-origin turn after the typed turn. It neither rejects nor throws: a caller must read the resolved value.
  - E7 the real mod at b6440a9f worked end to end in C1: status line "1 unreviewed turn — demand queued" after Esc, demand text injected into the next typed prompt (on disk and in the request). The model IGNORED it: it answered and spawned no fork. Injection is not enforcement.
  - E8 the positive control held (own and previous answers on disk at turn.complete), so probe M7 ("answer not found on disk") was a flaw of the first probe needle, not lag: M7 marked RETRACTED above.
  - E9 a write under /tmp or /private/tmp never arms the scanner (cwd held at /repo; /tmp/x and /private/tmp/x demands false; TMPDIR/x, /private/var/folders/x, /repo/src demands true; all scans readable, 2 lines).
  - E10 scan duration 0.2-3.7 s on a quiet machine, 10-34 s under load; `$.process.run` times out at 30 s.
  - E11 UNMEASURED: a prompt typed within 1 s of Esc (C3: the Esc and the first letter merged, the turn was not aborted); Esc during plain streaming text; /clear; a cron-started turn.
  - E12 the first prompt.submit of a session finds no transcript file yet (scan readable false).
- PROPOSED 2026-11-12 (from E1-E12, NOT yet decided; advisor and review first): P1 remove `$.prompt.submit` from the mod, deliver only by injection at the next prompt.submit (E6, M9). P2 trigger on 'the turn ended and no classic.Stop fired for it' instead of isAborted, so the permission-dialog rejection is covered (E2; needs a second observation and a check that classic.Stop fires on every normally ended turn). P3 scanner: a tool_use whose tool_result is a user rejection must not arm (E3), with tests that include a tool_result. P4 re-scan at the next prompt.submit, where the transcript was complete (E4). P5 enforcement: injection is ignored by the model (E7), so the owed review must be demanded by something that can block; candidates: the Stop gate reads an owed-review marker the mod writes, or the Stop gate itself looks back one turn when that turn ended without a Stop.
- PLAN 2026-11-12 (advisor consulted after the Esc probe; supersedes the order in NEXT ACTION): the mod is FROZEN (no further mod commit) until P5 is decided, because P1, P2 and P4 exist only under one of P5's branches. What the rows settle: nothing can block at abort time (E1 no Stop, E6 submit dropped, E7 injection ignored), so an interrupt can DEFER the review, never cancel it, and enforcement lands at the next turn that ends normally, in the Stop gate, not in a mod (this contradicts the card title; tell the user). Step 1 (P3, scanner only, first): a tool_use whose tool_result is a USER REJECTION must not arm; read the real rejected tool_result line in the C2 raw data before coding; a failed Bash command still arms. Step 2 (the discriminating check, read-only): on the saved C1, C2, run1 and control transcripts plus the 8 real interrupted turns, is the interrupt entry the last conversation entry of the interrupted turn and absent from normally ended turns, and does a copy cut just before the following turn start scan correctly with --ignore-interrupt-floor. If yes: the Stop gate looks back over the run of preceding turns that ended ungated (bounded; a heartbeat turn or a second Esc may sit in between), needs no mod, no marker, no session state; P2 and P4 disappear, P1 becomes deleting the mod's delivery path. If no: marker route (mod writes an owed-review marker the Stop gate reads), which inherits E4 and E10 and is a silent skip when the mod is not installed. Regression proof either way: the 7 real no-demand interrupted turns stay no-demand, and a credited review in the looked-back turn releases it. Authority: the change reverses two recorded owner rulings quoted in the --directive text ('only the turn that just ended decides', 2026-10-14; an interrupt is a floor, 2026-09-15); prrdgrep finds no PRRD rule on interrupt or review, so neither is golden; quote both and the card requirement ('it should never be skipped') in the proposal and change the --directive text in the same commit.

## Approval log

- 2026-11-11T16:24:22+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-11T18:37:38+0100 — column → todo by user. design complete (reports_dev/mods-review-gate/20261111_design.md); starting Phase 0 --json-verdict flag
