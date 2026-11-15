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
   review failure. The **usage table is shown to the user only** and never reaches the model. The report is plain
   text; the token usage is one closed box in the token-reporter plugin's frame and colours, printed last. The mod
   writes the user's copy to a temp file,
   `<cwd>/.claude/tmp/agentlenspro-review-mod/<session_id>.txt` (cwd and session id from the Stop payload),
   before the other Stop hooks run, and the plugin's Stop command hook `hooks/show.py` prints that file as a
   `systemMessage` (drawn as `Stop says: ...`, never sent to the model) and deletes it. The folder holds temp
   files only: a `*` `.gitignore` keeps it out of git status, and every run deletes any file there older than
   120 seconds (a leftover of a crashed session). A message past the 10,000-character hook limit loses whole report
   lines from its end, replaced by `… report truncated`; the usage box is never cut, and nothing dropped is kept. If the file cannot be written (no cwd in the payload, a
   refused write), the rows go to the transcript log, plain.

An **interrupted turn** (Esc) fires no Stop. `turn.complete` with `isAborted` schedules the same review from
a timer. At once the user sees one summary row; the report and its usage box are held in memory and shown,
oldest first, ahead of the next main-thread Stop's own display (janitor turns included; a subagent's Stop never flushes them), and dropped at
SessionStart. The report is injected into the next prompt, and the next Stop blocks if a BLOCK was not addressed.

## Subagents (0.6.0)

Every turn of a typed subagent (`general-purpose`, a plugin agent, an Agent-tool `fork`) is reviewed once it is
done: at its **SubagentStop** when it ends with text, or at its **SubagentHandback** call when it reports with
that tool (the usual end of an interactive background agent).

1. The mod reads that agent's own messages (`$.session.messages({ agentId })`; the final message from the event,
   from the `SubagentHandback` call being made, or from the agent's last `SubagentHandback` call) and asks the
   same scanner what the turn did, on a non-sidechain copy of those messages written next to the display file
   (and deleted by `hooks/show.py`).
2. It runs the same REVIEW (and, when the agent's last message carries the proposal line, the MEASUREMENT) with
   `$.model.complete` on `claude-sonnet-5-5`, over those messages (the first prompt plus the newest, about 60,000
   characters) and the git context. Not `$.model.fork`: a fork repeats the main thread's request.
3. A report with any finding stops the agent once so it can correct itself. An agent that ends with text is
   blocked once and reads the report as `Stop hook feedback`. An agent that reports with `SubagentHandback` has
   that call refused once: it reads the report as the tool's error, fixes or rejects each finding, and calls
   `SubagentHandback` again, which goes through (a SubagentStop block would come too late for it: Claude Code
   discards a block after a turn that ended on a tool result, measured on 2.1.325). Its SubagentStop is reviewed
   again only if it did something new after the refusal, and that review is not blocking. A clean PASS does not
   block. A harness failure never blocks the subagent.
4. Every report, and a note for every subagent turn the harness did not review, is injected into the parent's
   next prompt, tagged `subagent <type> <id>`. The usage table is shown to the user only.
5. The coloured copy is written to `<cwd>/.claude/tmp/agentlenspro-review-mod/<session_id>__<agent_id>.txt`, and
   `hooks/show.py`, registered on SubagentStop too, prints it in that subagent's view (`/tasks`, then the agent)
   and deletes it. A review made at the handback is printed at the agent's SubagentStop.

No review of a review: four guards. (a) A stop with no agent id, with `agent_type` `""` (every `$.model.fork`, the
mod's own main-review forks included, and internal agents) or of a janitor agent, and a handback of a loop that
`$.agent.list()` does not name, pass untouched. (b) While any review is calling the model, a SubagentStop of a loop
that `$.agent.list()` does not name passes untouched; real agents, siblings of a fan-out included, are listed and
reviewed. (c) A last message that opens with a review or measure report heading or with `VERDICT:`, or an agent
whose first prompt is `ROLE: REVIEW` or `ROLE: MEASURE`, is not reviewed. (d) At most 2 reviews per agent turn, and
at most 2 subagent reviews in flight: the others wait their turn in arrival order, and a turn that waits more than
10 minutes is handed to the parent to review. Reviews themselves are completions, which fire no SubagentStop, so a
review cannot start another; guards (a), (b) and (c) each alone keep a main review's own fork from being reviewed,
and (d) alone bounds it to 2 reviews.
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
- Subagent cost: one uncached `claude-sonnet-5-5` completion per reviewed subagent turn (three with a proposal),
  each about the agent's messages (up to ~60,000 characters) plus the git context (up to 40,000 characters) plus
  its answer (up to 4,000 tokens), times the fan-out, plus one extra subagent turn per block or refused handback.
  The usage table prices it with the `claude-sonnet-5` rates (pricing.ts has no `claude-sonnet-5-5` row; the
  longest-prefix rule picks `claude-sonnet-5`).
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
