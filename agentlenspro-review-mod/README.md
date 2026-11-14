# agentlenspro-review-mod

A Claude Code mod that makes the adversarial review part of the harness cycle. The model is never asked to
spawn a reviewer: the mod runs the review itself at the end of every turn that changed something, and
blocks the stop when the review finds blockers.

## What it does

At every main-thread **Stop**:

1. Asks the shared scanner what the turn did:
   `agentlenspro review-gate --json-verdict --transcript <t> --cwd <c>`. It reads the verdict's `work`
   and `proposal` fields, which are reported whatever review credits the turn carries, so a fork the model
   spawned on its own cannot skip the harness review.
2. If the turn has a **proposal** (a line starting `PROPOSAL FOR ACTION - PLEASE REVIEW`), runs the
   **MEASUREMENT**: a `$.model.fork` lists the proposal's load-bearing assumptions, each with one read-only
   command; the mod runs those commands itself with `$.process.run` (argument list, no shell, a read-only
   program allowlist with write flags refused); a second fork turns the observed output into
   confirmed / refuted / unmeasurable verdicts.
3. If the turn has **work** or a proposal, runs the **REVIEW**: a `$.model.fork` over the whole
   conversation (served from the prompt cache), plus the turn's final message, the measure report and the
   `git diff HEAD` the mod reads (so a worker's writes are reviewed too).
4. **VERDICT: BLOCK** → the stop is blocked with the report; the model must address each finding in the same
   turn. **VERDICT: PASS** → the report is written to the transcript log (the user sees it; the model is
   not re-prompted).

An **interrupted turn** (Esc) fires no Stop. `turn.complete` with `isAborted` schedules the same review from
a timer; the report is shown at once, injected into the next prompt, and the next Stop blocks if a BLOCK was
not addressed.

## Limits

- At most 2 blocking review rounds per turn; after that the status line says the rest of the turn is NOT
  reviewed.
- The review runs every turn when it can, and reports when it cannot: a scanner failure, an unreadable
  transcript or a fork that fails twice does NOT block the stop (the model could not act on it). Each
  such skip is written to the transcript log as `REVIEW SKIPPED` and counted in the plugin store
  (`skipped`). The round cap counts the same way.
- The review fork has no tools: it judges what the conversation and the diff show it.
- Cost: one fork per changing turn, three for a proposal, each re-reading the whole conversation from the
  prompt cache (at a 400k context, about 40k input-equivalent tokens per fork) plus its answer.
- The fork repeats the main thread's last request, which does not contain the final answer; the final
  answer reaches the review only through the Stop payload's optional `last_assistant_message`.

## Requirements

- The `agentlenspro` CLI on PATH, with `work` and `proposal` in `review-gate --json-verdict`
  (AgentlensPro TRDD-KZCSO0R2). An older CLI is refused on the status line rather than reviewing less.
- When this mod is installed, remove the settings hooks `agentlenspro review-gate` (Stop, SubagentStop) and
  `agentlenspro review-supervisor`: they ask the model to spawn review forks, which this mod replaces.

## Install

```bash
claude plugin install agentlenspro-review-mod@emasoft-plugins
```
