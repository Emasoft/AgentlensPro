# agentlenspro-review-mod

Phase 1 scaffold for TRDD-KZCSO0R2 — a Claude Code plugin (mod) whose hooks module detects an unreviewed interrupted turn and injects a review demand into the next prompt. It does not yet enforce the review.

## What it does

The Stop settings hook (`agentlenspro review-gate` in `~/.claude/settings.json`) fires only when Claude finishes responding normally. When the user interrupts (Esc/Ctrl-C), the turn ends with `isAborted` and NO Stop event — so a turn that made write-shaped changes with no credited REVIEW fork ends unreviewed. This mod covers that interrupted turn:

- **`classic.UserPromptSubmit`, `classic.PreToolUse`, `classic.SessionStart`** — remember the main conversation `transcript_path` and `cwd` from the settings-hook payload (the `turn.complete` event carries no transcript path and `$.session` exposes none). They always pass the event on.
- **`turn.complete`** — skips subagent turns. A turn that is not aborted is passed untouched (the second net is off). For an aborted turn with no remembered path it shows a status line (cannot scan) and passes. Otherwise it runs the shared scanner via `agentlenspro review-gate --json-verdict --transcript <path> --cwd <cwd> --ignore-interrupt-floor`, stores a pending demand in `$.state`, shows a status line, and attempts `$.prompt.submit` to restart the demand as a new turn; that call is refused after an Esc until the user next types, and it may reject while the turn still waits on the hook that calls it, so in practice the demand arrives with the user's next prompt. A scanner failure (cannot start, non-zero exit, unparseable output, unreadable transcript, or an `agentlenspro` build too old to know `--ignore-interrupt-floor`) shows a status line and queues nothing; a later clean scan clears that status line. The non-aborted second-net scan exists in the code but is disabled (`SECOND_NET_ENABLED = false`).
- **`prompt.submit`** — if a pending demand exists, injects it as Claude-read context (a plain string entry) into the turn about to start, then clears the pending flag. The demand is shown once.

Handlers fail open (never wedge the session). The mod never registers `classic.Stop` with a block result — no double-blocking, no 9-block cap fight. The mod covers interrupted turns only: the second net for a normal turn end (for example a failed Stop hook) exists in the code but is off (`SECOND_NET_ENABLED = false`), so a failed Stop hook is NOT covered.

## Design report

`reports_dev/mods-review-gate/20261111_design.md` (sections Q1-Q4 and implementation plan steps 3-4; gitignored, local only).

## Deployment

Dev loop first:

```bash
claude --plugin-dir ./agentlenspro-review-mod --debug   # run from the repository root
```

Then install via local marketplace. The settings hooks STAY REGISTERED — Phase 1 changes no `settings.json` entries, so there is no enforcement window: if the mod fails to load, the Stop gate is unchanged.

## Open items

- **Exact `$.prompt.submit` refusal shape unverified** — the live docs (v2.1.304+) only say "refused"; after an Esc it is refused until the user next types. When it is refused NOTHING retries: `turn.complete` does not fire again for that turn, and the only delivery path is the `prompt.submit` hook injecting the pending demand into the next prompt the user sends. Four measurements need a real user Esc: (1) the refusal shape; (2) transcript lag on the aborted scan; (3) Esc at a permission prompt (a bare `tool_use` that never ran arms the scan); (4) a prompt typed right after Esc.
- **Transcript lag at `turn.complete` unmeasured** — the transcript is written asynchronously, so the non-aborted second net stays disabled until a probe shows the lag causes zero false demands (the same lag may hide writes from the interrupted-turn scan, see below).
- **Subagent `classic.PreToolUse` payload unverified** — whether its `transcript_path` is the main or the subagent transcript is unknown; events with `agent_id` set are not remembered.
- **CC >= 2.1.287 requirement** — mods need Claude Code >= 2.1.287 (Desktop >= 2.1.286) for any of this; the Esc-window refusal semantics are v2.1.304+. On older CC the mod is not the enforcing layer and the settings hooks carry everything — same as today.
- **The demand is shown once and is lost if ignored** — `prompt.submit` clears the pending demand when it injects it; nothing re-demands it afterwards. Making it persist until a credited REVIEW fork is seen is the next step.
- **No survival across a session exit; module reload resets state** — the pending demand lives in per-session `$.state`, and `scanFailureShown` and the atoms reset on module reload. Behaviour on `/clear` is unmeasured.
- **Transcript lag can also hide writes on the interrupted-turn scan** — a write not yet on disk at `turn.complete` is missed, so the aborted scan can under-demand (not only the disabled second net can over-demand).
- **Esc at a tool permission prompt may demand a review for a write that never ran** — unmeasured.
- **A heartbeat or other automatic prompt may consume the demand** — the next `prompt.submit` takes it, whoever typed it.
- **A scan-failure status line stays** until the next aborted turn scans clean.
- **A second pending demand overwrites the first** — only one demand is kept.
- **Unmeasured: does awaiting `$.prompt.submit` inside the `turn.complete` hook always reject?** It may reject while the turn still waits on the hook that calls it.

## Tests

None shipped. `claude plugin test` has no real process: every `$.process.run` needs a stub, so a test of the aborted-turn path would have to mock the `agentlenspro` CLI, which this project does not do. Verify live instead (see Deployment).
