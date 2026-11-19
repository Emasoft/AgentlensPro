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
   lines from its end, replaced by `… report truncated`; the usage box is never cut, and nothing dropped is kept.
   When the message opens with held interrupted-turn boxes (below), those are cut first, whole usage boxes before
   report lines, so this turn's verdict, findings and usage box come first (0.7.13). This Stop's own file, when it
   is older than 120 seconds as the hook runs, is not shown: one line says it was dropped and why. If the file cannot be written (no cwd in the payload, a
   refused write), the rows go to the transcript log, plain.
   The usage box has a header (title | model) and two sections, `turn under review:` (the turn being reviewed, with `(main)` or `(subagent <type>)` and `· N calls` when it made several) and `review turn:` (the sum of every model call this Stop made: measure-plan, measure-judge, review and retries). A section is its heading, a `cache r/w` bar (full inner width; green = cache read, red = cache create, 100% = cache read + cache create; uncached input and output are not in it), `in <n> · out <n> · cache read <n> · cache create <n>`, and the cost of that one turn; there is no session total, and a call with no reply is one line (`1 call no reply (aborted), not billed`) with no bar. The per-call breakdown goes to the plain debug log line. The turn-under-review section is on by default; set the plugin option `show_reviewed_turn` to false (`/config`) to leave it out. Its usage is summed from the `turn.step` requests the turn made (one record per request). The usage has no 5m/1h split of the cache writes, so a write the API did not split is priced by inference: for a main turn (Stop, or an interrupted turn) at the cache TTL that `agentlenspro cache-state --json` reports for the main conversation (`1h` or `5m`) when it answers for this session with a snapshot no older than the turn's first request, else at the 1-hour rate; for a subagent turn (SubagentStop, which never asks) and every call the mod itself makes at the 5-minute rate (measured in this project on 2026-11-15: the 53 review-fork transcripts carrying the mod's harness markers wrote 24,962,065 cache tokens, all at the 5-minute rate, 0 at 1h). A main turn's section starts with a row such as `cache warm · ttl 1h · last miss messages_rewritten 2h ago`, or `cache state unknown` when the command exits 2, fails, or answers stale or for another session (never a guessed `cold`). The box is about 80 columns wide on ordinary totals and widens with larger totals rather than truncating a number. When colour is off, the bar stays readable: hit cells keep `█` and miss cells become `░` (for example `██░░░░░░ 28% hit`), and no escape code is printed; `░` (U+2591) has East Asian Width N (narrow), where `…` (U+2026) has A (ambiguous). Colour is judged off by `NO_COLOR` set non-empty, `FORCE_COLOR=0` or `false`, `TERM=dumb`, or `CLAUDE_CODE_ENTRYPOINT=claude-vscode` (that value is unverified: it has not been read from a real VS Code session); any other `FORCE_COLOR` value forces colour on, and with no signal at all colour stays on.

An **interrupted turn** (Esc) fires no Stop. `turn.complete` with `isAborted` schedules the same review from
a timer. When that review ends the user sees ONE row. It is the turn that was interrupted, not the review, and the
row says what the review did, with the verdict before the cost:

- `review-mod: review of the interrupted turn finished: PASS · cost … · report and usage box after the next completed reply`:
  the review ran to its end and found no blocker.
- `review-mod: review of the interrupted turn finished: BLOCK (the agent gets the findings with the next prompt) · cost … · …`:
  the review ran to its end and found blockers.
- `review-mod: REVIEW DEFERRED, the review of the interrupted turn did not finish (reason in the row above) · cost … · usage box after the next completed reply`:
  the review made model calls and produced no report; the work is reviewed at the next stop.

The report and its usage box are held in session state (`$.state`, key `heldInterrupted`) and shown, oldest first,
each under the heading `interrupted turn HH:MM`, ahead of the next main-thread Stop's own display (janitor turns
included; a subagent's Stop never flushes them). The mod no longer drops them at a compaction between the review
and that Stop (0.7.12), and by the mods documentation the session state outlasts a compaction and a reload of the
mod. `/clear`, `/resume` and `/branch` do drop them: they leave the conversation the box belongs to and, by the
mods documentation, the engine resets the session state there. One row then says how many
went: `review-mod: N held interrupted-turn report(s) dropped, not shown: /clear left the conversation they belonged to …`.
When a box could not be held, the row says `NOT held for the next reply (<reason>)` instead of promising it. The
report is injected into the next prompt, and the next Stop blocks if a BLOCK was not addressed.

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
3. A report with a BLOCKER or SHOULD-FIX holds the agent once so it can correct itself; a report with NITs only goes to the parent and does not hold it. An agent that ends with text is
   held once and reads the report as `Stop hook feedback`. An agent that reports with `SubagentHandback` has
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
  `REVIEW DEFERRED`. The same holds for an interrupted turn whose review could not run. Since 0.7.13 the model is
  told too, in one line at its next prompt, with the reason. A deferred proposal is not measured later: when the
  deferred turn had a proposal, or the mod could not tell, that line asks for the proposal again in the next reply,
  where the stop measures it.
- The held report and usage box of an interrupted turn are shown only by a later main-thread Stop of the same
  conversation. `/clear`, `/resume` and `/branch` drop them: by the mods documentation the engine resets the session
  state there (the copy for the model, `pendingReview`, goes with the same reset), and the mod empties the value
  itself. The row that says so is counted in a module variable; after a reload of the mod, `session.start` counts
  the held boxes again from the session state (0.7.13), so the row is missing only when that read fails (the status
  line then says so). When the held boxes cannot be read or cleared at the command, a row says they may be dropped.
  A session that ends before its next Stop never shows the box. A review still running when one of those commands
  is given holds its box in the conversation that follows. As of 0.7.13 all of this rests on the tests of the mod
  and on the mods documentation: no live session has yet run an Esc, a compaction and a Stop, or a `/clear` with a
  box held.
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

## Changes

### 0.7.13

- **A held interrupted-turn box no longer cuts the report of the turn that shows it** (TRDD-IT5KUORN). Over the
  10,000-character hook limit, `hooks/show.py` kept the last usage box and cut the lines before it from their end,
  which is where this turn's own report sits, so a held box could remove this turn's verdict and findings (probe of
  2026-11-18). The mod now writes a separator line (U+001E, never printed) after the held boxes, and `show.py` cuts
  the held part first: the held usage boxes, newest first, then the held report lines, marked
  `… held interrupted-turn report truncated: this turn's report comes first …`. What the user sees: the current
  turn's verdict, its findings and its usage box come first; an old box is shortened or left out. Its verdict and
  cost stay in the row printed when its review ended.
- **A held interrupted-turn report is no longer dropped with no line** (TRDD-0IFG1B11). (a) After a reload of the
  mod, `session.start` counts the held boxes again from the session state, so a later `/clear`, `/resume` or
  `/branch` still prints `review-mod: N held interrupted-turn report(s) dropped, not shown: …`. (c) When the held
  boxes cannot be read or cleared at one of those commands, a row (no longer a status line only) says
  `… may be dropped, not shown: … could not be read or cleared (<reason>); any still held is shown at the next Stop`.
  (e) A display file older than 120 seconds when the Stop hook runs is not shown as this Stop's; one line says
  `review-mod: a review display N s old was dropped, not shown: past the 120 s limit …`.
- **The row of a reviewed interrupted turn** (TRDD-M62ZBT7E): shipped in 0.7.12, no code change in 0.7.13.
  `review of the interrupted turn finished: PASS` (or `BLOCK`) means the review of the turn the user cut short ran
  to its end, with its verdict before its cost; `REVIEW DEFERRED, the review of the interrupted turn did not finish`
  means it produced no report and the work is reviewed at the next stop.
- **A deferred review is told to the model** (TRDD-ASXUW08U). Up to 0.7.12 a review deferred by the round cap, or
  one that could not run, left the model with nothing, and a proposer waited for a review and a measurement that
  did not come (2026-11-17: two review BLOCKs of one turn raised the round count to 2, and the next two Stops of
  that turn were deferred). The next prompt now carries one line for the model,
  `[agentlenspro-review-mod] REVIEW DEFERRED: the harness deferred its review of your earlier turn (<reason>); …`, given
  once per deferral. A deferred proposal is still not measured later; when the turn had a proposal (or the mod
  could not tell), the same line says so and asks for the proposal again in the next reply, where it is measured.
- Tests: `tests/held-interrupted.test.ts` (4 new), `tests/deferred-review.test.ts` (new), both run by
  `claude plugin test`, sharing `tests/rig.ts`; `tests/test_show.py` (new, `python3 -I tests/test_show.py`) for
  `hooks/show.py`.

### 0.7.12

- **The report and usage box of a reviewed interrupted turn are no longer dropped by the mod at a compaction**
  (TRDD-ISEF8YO7). They were kept in a module variable that every `classic.SessionStart` emptied, and that event
  also fires after a compaction, so a box held before a compaction was dropped and no later Stop showed it (the new
  test fails on 0.7.11 for this reason). A live case of 2026-11-17 fits this; its cause is not established, because
  a reload of the mod at the compaction would have emptied the variable too. They are now session state (`$.state`,
  key `heldInterrupted`), which by the mods documentation a compaction and a reload of the mod leave in place.
  `/clear`, `/resume` and `/branch` drop them, and one row says how many went. This is shown by the test of the
  mod, not yet by a live session.
- **The row of an interrupted turn says what the review did** (TRDD-M62ZBT7E). The old row,
  `review-mod: interrupted review $… · box after next reply`, read as a review that was itself interrupted. It is
  the TURN that was interrupted. The row now reads `review of the interrupted turn finished: PASS` or `… BLOCK`
  when the review ran to its end, with the verdict before the cost, and `REVIEW DEFERRED, the review of the
  interrupted turn did not finish` when it made model calls and produced no report. "After the next completed
  reply" means the display of the next main-thread Stop.
- New test `tests/held-interrupted.test.ts` (run with `claude plugin test`).
