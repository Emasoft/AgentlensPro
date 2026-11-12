# agentlenspro-review-mod

Phase 1 scaffold for TRDD-KZCSO0R2 — a Claude Code plugin (mod) whose hooks module closes the review-gate interrupt gap.

## What it does

The Stop settings hook (`agentlenspro review-gate` in `~/.claude/settings.json`) fires only when Claude finishes responding normally. When the user interrupts (Esc/Ctrl-C), the turn ends with `isAborted` and NO Stop event — so a turn that made write-shaped changes with no credited REVIEW fork ends unreviewed. This mod is the **second net**:

- **`turn.complete`** — if `e.isAborted` is true (or a non-aborted second-net scan still demands a review), runs the shared scanner via `agentlenspro review-gate --json-verdict`, stores a pending demand in `$.state`, shows a status line, and attempts `$.prompt.submit` to restart the demand as a new turn.
- **`prompt.submit`** — if a pending demand exists, injects it as Claude-read context into the turn about to start, then clears the pending flag.
- **`classic.SessionStart`** — no-op reload hook for the post-`/clear` path (design Q4).

Every handler is wrapped in try/catch so a failure fails open (never wedges the session). The mod never registers `classic.Stop` with a block result — no double-blocking, no 9-block cap fight.

## Design report

`/Volumes/EmaUITEK4TBSSD/Code/AgentlensPro/reports_dev/mods-review-gate/20261111_design.md` (sections Q1-Q4 and implementation plan steps 3-4).

## Deployment

Dev loop first:

```bash
claude --plugin-dir /Volumes/EmaUITEK4TBSSD/Code/AgentlensPro/agentlenspro-review-mod --debug
```

Then install via local marketplace. The settings hooks STAY REGISTERED — Phase 1 changes no `settings.json` entries, so there is no enforcement window: if the mod fails to load, the Stop gate is unchanged.

## Open items

- **Exact `$.prompt.submit` refusal shape unverified** — the live docs (v2.1.304+) only say "refused"; the mod catches the refusal and retries from the next `turn.complete`/`prompt.submit`, but the exact error shape must be probed live (design step 6).
- **Exact `--json-verdict` CLI args to reconcile with Phase 0** — the flag is being built in parallel; the mod assumes `agentlenspro review-gate --json-verdict --transcript <path> --turn-id <id>` printing `{ demands, reasons, scan }` JSON (exit 0 always). Argument names must be reconciled with the Phase 0 implementation.
- **CC >= 2.1.287 requirement** — mods need Claude Code >= 2.1.287 (Desktop >= 2.1.286) for any of this; the Esc-window refusal semantics are v2.1.304+. On older CC the mod is not the enforcing layer and the settings hooks carry everything — same as today.
