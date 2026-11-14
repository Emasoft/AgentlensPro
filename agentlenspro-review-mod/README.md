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
   turn. **VERDICT: PASS** → the stop goes through, and the report is injected into the model's context with
   the next prompt (typed, sent by a mod, or a hand-back; janitor prompts included), raw and once, with a head
   asking the model to apply each finding or say why it rejects it.
5. The user sees every report too (PASS and BLOCK), plus the token usage and cost of the review calls and any
   review failure. The **usage table is shown to the user only** and never reaches the model. The user's copy is
   in colour: the mod writes it to a temp file,
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

## Subagents (0.6.0)

At every **SubagentStop** of a typed subagent (`general-purpose`, a plugin agent, an Agent-tool `fork`):

1. The mod reads that agent's own messages (`$.session.messages({ agentId })`; the final message from the event,
   or from the agent's `SubagentHandback` call when the event carries none) and asks the same scanner what the
   turn did, on a non-sidechain copy of those messages written next to the display file (and deleted by
   `hooks/show.py`).
2. It runs the same REVIEW (and, when the agent's last message carries the proposal line, the MEASUREMENT) with
   `$.model.complete` on `sonnet`, over those messages (the first prompt plus the newest, about 60,000 characters)
   and the git context. Not `$.model.fork`: a fork repeats the main thread's request.
3. A report with any finding blocks that subagent once: it continues and reads the report as `Stop hook feedback`.
   An agent that ended with a `SubagentHandback` call (the usual end of an interactive background agent) is not
   blocked: Claude Code discards a SubagentStop block after a turn that ended on a tool result (measured on
   2.1.325), so its findings reach the parent only, and the report header says so. A clean PASS does not block.
   A harness failure never blocks the subagent.
4. Every report, and a note for every subagent stop the harness did not review, is injected into the parent's
   next prompt, tagged `subagent <type> <id>`. The usage table is shown to the user only.
5. The coloured copy is written to `<cwd>/.claude/tmp/agentlenspro-review-mod/<session_id>__<agent_id>.txt`, and
   `hooks/show.py`, registered on SubagentStop too, prints it in that subagent's view (`/tasks`, then the agent)
   and deletes it.

No review of a review: four guards, each enough on its own. (a) A stop with no agent id, with `agent_type` `""`
(every `$.model.fork`, the mod's own main-review forks included, and internal agents) or of a janitor agent passes
untouched. (b) While a subagent review is calling the model, every SubagentStop passes untouched. (c) A last message
that opens with a review or measure report heading or with `VERDICT:`, or an agent whose first prompt is
`ROLE: REVIEW` or `ROLE: MEASURE`, is not reviewed. (d) At most 2 reviews per agent turn, and at most 2 subagent
reviews in flight at once. A typed subagent passed through by (b) or (d) is not reviewed; the parent is told.

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
- Subagent cost: one uncached `sonnet` completion per reviewed subagent turn (three with a proposal), each about
  the agent's messages (up to ~60,000 characters) plus the git context (up to 40,000 characters) plus its answer
  (up to 4,000 tokens), times the fan-out, plus one extra subagent turn per block. The usage table prices it as
  `rate unknown for sonnet`, because the completion result does not name the model the alias resolved to.
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
