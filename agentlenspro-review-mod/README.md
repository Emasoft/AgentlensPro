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
   turn. **VERDICT: PASS** → the model is not re-prompted.
5. Every report (PASS and BLOCK), the token usage and cost of the review calls, and any review failure are
   shown to the **user only**, in colour: the mod writes them to a temp file,
   `<cwd>/.claude/tmp/agentlenspro-review-mod/<session_id>.txt` (cwd and session id from the Stop payload),
   before the other Stop hooks run, and the plugin's Stop command hook `hooks/show.py` prints that file as a
   `systemMessage` (drawn as `Stop says: ...`, never sent to the model) and deletes it. The folder holds temp
   files only: a `*` `.gitignore` keeps it out of git status, and every run deletes any file there older than
   120 seconds (a leftover of a crashed session). A report past the 10,000-character hook limit is cut at a line
   and ends with `(truncated)`; nothing of it is kept. If the file cannot be written (no cwd in the payload, a
   refused write), the rows go to the transcript log, plain.

An **interrupted turn** (Esc) fires no Stop. `turn.complete` with `isAborted` schedules the same review from
a timer; the report is shown at once, injected into the next prompt, and the next Stop blocks if a BLOCK was
not addressed.

## Limits

- At most 2 blocking review rounds per turn; changes made after the second round are deferred (as a debt,
  below) to the next stop, never dropped.
- A review that cannot run (scanner failure, unreadable transcript, fork failure, an exception) BLOCKS the
  stop and is retried at the next stop, up to the round cap. Past the cap nothing is dropped: the unreviewed
  work is kept as a debt and the NEXT stop must review it (even if that turn changed nothing), logged as
  `REVIEW DEFERRED`. The same holds for an interrupted turn whose review could not run.
- The review fork has no tools: it judges what the conversation and the diff show it.
- Cost: one fork per changing turn, three for a proposal, each re-reading the whole conversation from the
  prompt cache (at a 400k context, about 40k input-equivalent tokens per fork) plus its answer.
- The fork repeats the main thread's last request, which does not contain the final answer; the final
  answer reaches the review only through the Stop payload's optional `last_assistant_message`.

## Requirements

- The `agentlenspro` CLI on PATH, with `work` and `proposal` in `review-gate --json-verdict`
  (AgentlensPro TRDD-KZCSO0R2). An older CLI is refused on the status line rather than reviewing less.
- `python3` on PATH for the Stop command hook `hooks/show.py` (standard library only).
- When this mod is installed, remove the settings hooks `agentlenspro review-gate` (Stop, SubagentStop) and
  `agentlenspro review-supervisor`: they ask the model to spawn review forks, which this mod replaces.

## Install

```bash
claude plugin install agentlenspro-review-mod@emasoft-plugins
```
