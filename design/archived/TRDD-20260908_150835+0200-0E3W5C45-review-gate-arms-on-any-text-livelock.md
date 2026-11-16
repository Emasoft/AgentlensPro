---
trdd-id: 0E3W5C45
title: The review gate arms on any text block so idle and heartbeat turns livelock it
column: complete
created: 2026-09-08T15:08:35+0200
updated: 2026-11-16T23:02:48+0100
current-owner: main-session
task-type: bugfix
min-approval-requirement: none
priority: high
labels: [review-gate, token-burn, hooks]
implementation-commits: [b7a99cab, 3eb7683f, 9ee081c5, 31912fc4]
release-via: none
status: archived
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-16T23:02:48+0100
---

# The review gate arms on any text block so idle and heartbeat turns livelock it

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-08 20:12

**20:12 — TO `human_review`.** Six review forks in this window over four commits (`b7a99cab`,
`3eb7683f`, `9ee081c5`, `31912fc4`); the sixth found nothing that releases a write — one
mislabelled reason (`find . -exec xargs rm` would report `via xargs`, not `via find -exec`, and
still arm) and a nonsense-shell null (`find . -exec {} \;`), both traced by that fork; the first measured the same, the
second's settle reached node with `\;` mangled to a bare `;` and so reproduced nothing; left as is. What remains is the owner's: (1) apply the `PROPOSAL:` rule
amendment (last acceptance row); (2) accept or reject the cooperative-marker trade for prose
proposals; (3) TRDD-P46MEOXA for the `DELEGATION.md` identity hits. Not done and stated so: the
per-trigger mutation sweep; a `runMainGate`-level cwd test. NEXT ACTION on resume: none until the
owner rules; a fresh idle-turn livelock would be the only reason to reopen.

**20:03 — THIRD REVIEW ROUND + RECORD CORRECTED.** Commit `3eb7683f` carried the follow-up fixes,
and its message and the 15:50 paragraph here described them wrongly (fourth review fork); the
accurate record: two pre-existing FAIL-OPEN shapes (a shell keyword in command position —
`do|then|else|elif|{|}`, then `if|while|until|!` — released the `git commit` behind it; `xargs -0
rm` took `-0` as the command), two WRONG REASON STRINGS that still armed (a heredoc commit with a
bare `>` in its body would report a redirect — traced by the round-2 review, not run; the segment
pass now runs first; `echo x >| src/a` reported `redirect into |`, measured — `>|` is glued), and one defect the `>|` fix itself INTRODUCED and the
review caught before commit (a quoted or escaped `>` glued a real pipe, so `echo "a>"| tee x`
swallowed `tee`; glue now needs an unquoted `>`). The message's "a build chain passed with zero
tests run" is FALSE: the chain file printed `chain_exit=1` and the `ReferenceError` in full; only
the task-level exit was 0 because a trailing `echo` follows the chain. The true gotcha:
`npx mocha --no-config <files>` drops ALL of `.mocharc.cjs` (`ui: tdd`, `require:
src/test/setup.js`, `spec`, `timeout`, `color`), and without `--no-config` the config's `spec:`
key would pull the whole suite in (per the file's keys; not re-measured); the exact line that runs the two suites alone is
`npx mocha --no-config --ui tdd --require src/test/setup.js out/test/test/reviewGate.test.js
out/test/test/reviewGateTriggers.test.js` (57 passing at 15:50). The third fork (over those fixes)
found one more fail-open, fixed in the commit after `3eb7683f`: xargs options with a SEPARATE value
(`xargs -n 1 rm`, `-P 4`) released — the value is skipped only for xargs's value-taking options
(`-n -P -L -I -E -d -s -a`), never generically, because `sudo -n` takes none and a generic skip eats
the command (`sudo -n git status` is a PASS row for exactly that); its out-of-scope note
(`find … -exec rm {} \;` released) is taken too, and `find -delete` with it (my addition, not the
fork's): `rm via find -exec (targets unknown)`, `find -delete`. **Fourth review (over that
commit, `9ee081c5`):** only the FIRST `-exec` was classified and its command skipped the wrapper
walk — `find . -exec ls {} \; -exec rm {} \;` and `find . -exec sudo rm {} \;` released; every
`-exec` now goes through the shared `classifyCommand` walk (commit after `9ee081c5`). Still
unmodelled, fail-open, by design: another wrapper's separate option value (`sudo -u x cmd`, `nice
-n 10 cmd`), xargs long options (`--max-args 1`), a redirect glued to a word (`cmd>file`; `cat
"$F">|out`, whose quoted word the redirect pass skips), a script's own writes. `pnpm run
check-identities` runs in the build chain from this round on — RED only on `DELEGATION.md`
(TRDD-P46MEOXA), measured 20:07. **Build-chain lesson (same review):** `set -e` inside a brace
group exits the whole shell, so a red step leaves the capture file WITHOUT its trailing
`chain_exit=` line — an absent line is not green; use a subshell `( set -e; … )` so the outer echo
runs. And a bundle marker must be a LITERAL in the source: `via find -exec` is assembled from a
template and grepping it reported 0 on a correct bundle.
Review item NOT taken, deferred: a `runMainGate`-level test that the hook `cwd` reaches the scan —
`reviewGate.test.ts` has no transcript fixture at all (grep 2026-09-08: zero `runMainGate` /
`transcript_path` hits), so it is a new fixture, not a one-liner.

**15:39 — IMPLEMENTED AND DEPLOYED.** `src/cli/reviewGateTriggers.ts` (new) + `reviewGate.ts` rewired
+ both test suites green; `node esbuild.js` exit 0; `standalone/cli.js` (15:38) carries
`commandWriteReason`; the LIVE Stop hook then blocked a turn with *"ran a write-shaped command:
redirect into $S/gate-identities.txt"* — the cause-naming message, from the new bundle, failing
closed on a `$VAR` target exactly as designed. The exact-text review's findings were all applied:
newline / `(` / backtick are command boundaries, escaped chars are quoted, `sh -c`/`eval` recurse,
verb sets are exported and looped in tests, `git pull/clean/switch` + `gh checkout/upload` added,
`work` object replaces the `cause ?? 'edit'` default; its settling command prints `git commit | git
commit | null`. **OPEN:** (1) the owner applies the `PROPOSAL:` rule amendment (below); (2) the
per-trigger comment-out mutation sweep was NOT run — the tables assert both directions with exact
reasons, which is the same evidence, but say "not run" rather than "verified"; (3) `pnpm run
check-identities` is RED on `DELEGATION.md:17-20` (home paths) — pre-existing, not this change, needs
its own card; (4) the peer session's "sentinel did not release ×5" claim is unverified.

Carded on the owner's directive of 2026-09-08 15:0x: *"the adversarial review hook should launch the
fork agent only when in the turn under review there are actual code/architecture/.md suggestions or
proposals, or true write/commit operation."* Nothing implemented yet.

**15:30 — option A is the decision (owner offered A/B, default A, no objection).** The EXACT-TEXT
proposal is written out in full at the session scratchpad
`…/31029f8b-…/scratchpad/trdd-0e3w5c45-proposal.md` (new `src/cli/reviewGateTriggers.ts`, the
`reviewGate.ts` hunks, both test files, the card rows, the rule amendment) and is under its ONE review
fork. **NEXT ACTION: read that file, apply the review's findings, implement, deploy, commit.** Facts
settled since 15:08, each verified: (1) `/opt/homebrew/lib/node_modules/agentlenspro` is a SYMLINK to
this repo, so `node esbuild.js` IS the deploy — the "global install, not a link" premise in the
Acceptance below was wrong; (2) `/reports/`, `*_dev/`, `.janitor/` are gitignored (`git check-ignore`),
the exemption premise; (3) the settling fixture is real: 41 distinct main-conversation Bash commands
from this session, 10 heartbeat fires of `…/dispatcher-stub.py 2>&1` — the classifier arms on exactly
6 (4× `git commit`, `rm .git/index.lock`, one `cat > "$F"` heredoc), every heartbeat passes; (4) a peer
session (agents-discipline project) reported the same livelock, plus "the sentinel did not release, 5
attempts" (UNVERIFIED here) and "the directive never mentions the sentinel" (TRUE — the proposal adds
it). Round-2 accepted in full: literal-target exemption, fail closed; command-position matching; drop
`python -c`/`node -e`; the `/distill` collision → the rule amendment exempts the marker line; fenced
code alone does NOT arm (the harness style fences every command and error dump, so a fence rule
re-creates the livelock one notch down).

**Round-1 review verdict (accepted):** a regex cannot detect a PROSE proposal, and prose is the common
case — zero of this session's proposals carried a fence, diff or marker. So "proposal text" is
detectable only (A) cooperatively, by a mandated `PROPOSAL:` line the propose-then-review rule would
require, or (B) semantically, by an out-of-band `llm-ext` classification in the Stop hook. Writes and
commits stay mechanical either way. **DECISION PENDING WITH THE OWNER: A (cheap, escapable by
omission) or B (enforcing, adds latency + a dependency to every Stop).** Rule 2 must also widen to
`tee`/`cp`/`mv`/`python -c`/`node -e`/heredocs and exempt `/dev/null`, `/tmp`, `/private/tmp`,
`reports/`, `reports_dev/`, `docs_dev/` targets. Diff-hunk detection dropped (`---` false-positives
on rules and frontmatter).

## Symptom

Measured 2026-09-08 in the owner's own session, post-compaction: ~40 consecutive turns blocked by
`agentlenspro review-gate` (Stop hook) and 5 review forks spawned to release it, with zero edits and
zero commits in the whole span. Three of the blocked turns were `[janitor-heartbeat]` cron fires whose
only output was the mandated `janitor heartbeat` line. Each blocked turn re-invokes the agent and
re-reads a ~1M-token context.

## Cause — ✓ VERIFIED against the deployed bundle (v2.33.2 — this repo's `standalone/cli.js`, reached through the `/opt/homebrew` symlink) in an earlier window of the same session; record: `reports/review-forks/20260908_125938+0200-trdd-4bzpaqwm-three-fork-verdicts.md` Verdict 3

`scanMainTranscriptLines` sets `lastWork` on **every** non-sidechain assistant `text` block that is not
the `REVIEW-GATE: NO REVIEW POSSIBLE` sentinel, and `lastFork` on an `Agent` tool_use with
`subagent_type: "fork"`. `decideMainGate` blocks iff `lastFork < lastWork`. Consequences:

1. A turn whose only content is status text (`Holding.`, `janitor heartbeat`, a verdict relay) arms
   the gate exactly like a proposal does.
2. The reply to a block is itself text, so it re-arms; the only exits are a fork spawn or the
   sentinel, whose documented reasons (rate-limited, depth-limited, tool denied) do not cover
   "nothing to review". Livelock.
3. `MAIN_BLOCK_REASON` still says *"this turn edited or committed"* — the trigger set before the
   2026-09-07 "a proposal is work" change — so the message misdescribes what armed it.

## Directive (owner, 2026-09-08)

Arm only when the turn under review contains (a) an actual code / architecture / `.md` suggestion or
proposal, or (b) a true write or commit operation. Status text, acknowledgements and heartbeat output
must not arm it.

## Acceptance

- [x] A turn whose assistant output is text with no `PROPOSAL` line, and whose tool_uses are none or
      read-only, does NOT block (`reviewGate.test.ts` first test; 41-command real fixture).
- [x] A `[janitor-heartbeat]` turn (Bash of the dispatcher stub + `janitor heartbeat`) does NOT block
      (fixture from this session's own JSONL, 10 fires; live observation under the new bundle pending).
- [x] An `Edit` / `Write` / `NotebookEdit` outside /tmp, reports/ and *_dev/ blocks until a fork follows.
- [x] A write-shaped Bash command blocks until a fork follows — git commit/push/pull/mv/rm/checkout/…,
      gh mutating verbs, sed -i, package add/remove, redirect/tee/cp/mv/rm into a non-ephemeral or
      undecidable target (`reviewGateTriggers.test.ts`; live: the `$S/…` block at 15:38).
- [x] A text block with a line starting `PROPOSAL` blocks; a fenced code block alone does NOT (the
      harness style fences every command and error dump — a fence rule re-creates the livelock).
- [x] The block message names the actual arming cause (`mainBlockReason`; live-observed 15:38).
- [x] Mutation sweep: disable each trigger in turn, the matching test goes red — RUN 2026-10-05 (sweep report m1 to m8 and m11 to m14): all 12 trigger mutations went red, m7 (read-only Bash does not arm) only in the supervisor suite. m9 (message names the cause) red; m10 (message text with a detail) stayed green and is carried by TRDD-GI1LC8FX. The ARM/PASS
      tables assert both directions with the exact reason string, and every verb-set member is looped.
- [x] Deployed: `node esbuild.js` exit 0; `/opt/homebrew/lib/node_modules/agentlenspro` is a symlink to
      this repo, so `standalone/cli.js` IS the running bundle (`grep -c commandWriteReason` = 4).
- [x] SubagentStop parity: the same classifier decides `didWork` (prose false, marked true, Bash write
      true, Write into /tmp false).
- [x] Owner applies the rule amendment: in `~/.claude/rules/propose-then-review-then-implement.md`
      under "The shape → 1. Propose": *Begin the proposal with a line `PROPOSAL: <one-sentence
      rationale>`, literally, even under /distill (the marker line is exempt from compression). The
      gate arms on that line and on nothing else in prose; an unmarked proposal is unreviewed by omission.*

## Not in scope

An allowlist keyed on the janitor stub's path (brittle; the livelock is not heartbeat-specific).
Judging fork QUALITY (the gate counts spawns, not reviews — separate defect, uncarded).

## Notes and lessons learned

- The sentinel's code check (`isNoReviewSentinel`) accepts any reason ≥3 chars; only the directive
  prose reserves it for cannot-spawn. Prose-only restrictions are not enforcement.

## Review 2026-10-05 (in the owner's stead)

- Verdict: accepted, pending the bundle rebuild. Reviewer reports: docs_dev/20261005_024627+0200-review-0E3W5C45.md and docs_dev/20261005_025411+0200-sweep-0E3W5C45.md (gitignored).
- The rule question this card waited on is ALREADY ANSWERED by the owner's own rule text: ~/.claude/rules/turn-protocol-and-review.md says a proposal "must begin with a line that is exactly `PROPOSAL FOR ACTION - PLEASE REVIEW`" and that "the gate only fires on this exact marker, so an unmarked proposal goes unreviewed by its author's omission". That is option A of this card with a different marker wording than the `PROPOSAL:` its last box names; the code comment cites the owner order of 2026-09-15. Nothing here is left for the owner to decide; the box is stale, not open.
- The mutation sweep the unticked box asked for was RUN on 2026-10-05: 14 rules mutated one at a time, 13 went red on an assertion, 1 stayed green. Tree restored after each (working-tree checksum equal before and after; checked again by the main agent, who also re-ran the three suites: reviewGateTriggers 41, reviewGate 76, reviewSupervisor 30 passing).
- The one green mutation: mainBlockReason with a non-empty detail can name the wrong cause (ARM_CAUSE_TEXT[cause] replaced by ARM_CAUSE_TEXT.edit leaves every test green). Also weak: "a read-only Bash command does not arm" is caught only by a reviewSupervisor test, not by the gate's own tests. Both are carried by the new card minted in step 1 (TRDD-GI1LC8FX). They touch the box "The block message names the actual arming cause", which holds for the no-detail branch only.
- Not in effect on this machine until the bundle is rebuilt: the bundle of 2026-10-01 does contain the new marker text, but it is older than the source and was not compared with it. Links: none.
- CORRECTION 2026-10-05, after adversarial review of the entries above. (1) "Not in effect on this machine until the bundle is rebuilt" is unverified and probably wrong. Read by the main agent: the `agentlenspro` command resolves to this repo's standalone/cli.js, built 2026-10-01 18:31; the four fix commits naming this card (b7a99cab, 3eb7683f, 9ee081c5, 31912fc4) are dated 2026-09-08; the bundle contains the string `PROPOSAL FOR ACTION - PLEASE REVIEW` once. From those dates it is an INFERENCE, not a measurement, that this card's change is in the running bundle; the check this card's own Deployed box names (`grep -c commandWriteReason`) was not re-run. If the inference holds, nothing on this card waits for a deploy and `deploy` is not its true column. That column question is OPEN and is not decided in this entry. (2) The sweep box is ticked while its text still reads NOT RUN, and the entry above reports that one of 14 mutations stayed green. Whether the box is met depends on whether that green mutation is one of the triggers the box names; the sweep report was not re-read after the session was cleared. OPEN, same follow-up. (3) "the new card minted in step 1" in the entry above means TRDD-GI1LC8FX. (4) `implementation-commits` is still empty on this card.
- COLUMN SETTLED 2026-10-05: back in `human_review`; the earlier `deploy` and its "column → deploy" Approval-log line are withdrawn. Read by the main agent: (a) the sweep report docs_dev/20261005_025411+0200-sweep-0E3W5C45.md - 14 mutations; the 12 that mutate a trigger (m1 to m8, m11 to m14) all went red, m7 only in reviewSupervisor; m9 red; m10 green, and m10 is message text with a detail, not a trigger. So the sweep box is met as written, with the m7 weakness, and the cause box has a test gap in its detail branch; both gaps are carried by TRDD-GI1LC8FX. (b) `grep -c commandWriteReason standalone/cli.js` gives 5 today (the Deployed box recorded 4) on the bundle built 2026-10-01 18:31, and the `agentlenspro` command resolves to that file, so by this card's own Deployed check the change is in the running bundle and nothing here waits for a deploy. (c) The heartbeat box's "live observation under the new bundle pending": in this session three heartbeat turns ended with no Stop block. What keeps this card out of `complete`: the last box, "Owner applies the rule amendment", is the owner's act. The owner's rule file ~/.claude/rules/turn-protocol-and-review.md does say a proposal "must begin with a line that is exactly `PROPOSAL FOR ACTION - PLEASE REVIEW`", but the box names a different file and an older marker, so whether that satisfies the box is for the owner to confirm or reword. Also for whoever closes it: decide whether TRDD-GI1LC8FX is this card's EHT (it carries gaps on two of its ticked boxes); it is not registered as one now. `implementation-commits` is filled with the four fix commits of 2026-09-08; the docs-only commits naming this card are left out. The STATE head of this card was not rewritten.
- Status 2026-10-05: the STATE head (2026-09-08) still gives the right column. Its line "Not done and stated so: the per-trigger mutation sweep" is superseded: the sweep was run on 2026-10-05 (see the entry above). Correction to that entry: "three heartbeat turns" - the session's own summary counts four plain ones.
- 2026-11-16 23:02 REVIEW IN THE OWNER'S STEAD (owner order 2026-11-16, verbatim: "review in my stead. decide yourself."): ACCEPTED; the last box is ticked as MET IN ANOTHER FORM, not as written. Facts read today: the file the box names, ~/.claude/rules/propose-then-review-then-implement.md, does not exist; its successor ~/.claude/rules/turn-protocol-and-review.md says a proposal must begin with the exact line PROPOSAL FOR ACTION - PLEASE REVIEW and that the gate fires only on that marker (3 occurrences, line 28). So the owner did apply a marker rule, with a different marker text than the box's PROPOSAL: wording. The four fix commits are ancestors of HEAD; unit test files today: reviewGateTriggers 78, reviewGate 201, reviewSupervisor 38 passing. The two test gaps stay on TRDD-GI1LC8FX. TRDD-P46MEOXA (identity hits) is complete.

## Approval log

- 2026-10-05T02:55:42+0200 — column → deploy by main-agent@agentlenspro. reviewed in the owner's stead 2026-10-05: mutation sweep run, 13 of 14 rules protected; the rule question is answered by the owner's rule file; takes effect on a bundle rebuild
- 2026-10-05T03:21:47+0200 — column → human_review. returned by the main agent - nothing on this card waits for a deploy; the last box is the owner's act.
- 2026-11-16T23:02:48+0100 — COMPLETE by main-agent@agentlenspro. reviewed in the owner's stead per the 2026-11-16 order; last box met in another form (the owner's rule file carries a marker rule); three test files re-run today.
