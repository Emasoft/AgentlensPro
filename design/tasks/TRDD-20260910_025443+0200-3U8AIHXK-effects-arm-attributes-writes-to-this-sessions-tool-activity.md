---
trdd-id: 3U8AIHXK
title: The effects arm must attribute a write to this session's own tool activity before arming
column: testing
created: 2026-09-10T02:54:43+0200
updated: 2026-09-24T08:56:40+0200
current-owner: main
task-type: bugfix
priority: critical
severity: high
min-approval-requirement: none
project-id: agentlenspro
scope: project
labels: [review-gate, hooks, token-burn]
related: [9FG0LSPG, 0E3W5C45, 2CYTNLY1]
blocked-by: []
npt: []
eht: []
implementation-commits: [3f498995]
---

# The effects arm must attribute a write to this session's own tool activity before arming

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-10 03:42

Filed as TRDD-9FG0LSPG's EHT on four cross-session reports from peer session tldr-code-5c. The
proposal was reviewed by an adversarial fork at filing (02:5x); six findings, all applied (the
start-side slack and the hooks/state exclusion were also questioned and KEPT: harmless, one
line): (1) the zero-length interval for a review fork keyed on its prompt was a new release
path (a fork spawned with the ONE-turn line pasted, then used as a worker) — dropped, a fork
closes like any spawn; (2) the background-job id must be keyed by TOOL, or a foreground Read
quoting `agentId:` pins an interval open forever — this session's own probe would have done it;
(3) detached jobs (`nohup … &`, `setsid`, `disown`, `detach-run.py`) outlive their result — a
fail-closed text heuristic keeps their interval open; (4) a tool_result whose tool_use fell
before the window opens an interval at the window's start; (5) tests for each; (6) three card
facts narrowed. IMPLEMENTATION delegated to one worker against the reviewed spec at 03:06;
nothing under `src/` is committed yet (03:16). Four spec amendments went to the worker from
three further review rounds: (a) close a job only on an `attachment` or string-content `user`
entry, never `queue-operation` (written on enqueue AND dequeue); (b) an unknown-tool result
(tool_use before the window) tries BOTH anchored launch shapes; `rm -rf` of the scratch outDir
before tsc; (c) `DETACHED_JOB` also matches a mid-line `&` after whitespace or `)`; (d) test
strength: (iii) asserts Infinity after the queue line alone, a Bash result with both Agent
strings closes, a two-interval fixture, a write older than `t` inside an interval is not listed,
`t = now − 2500`. §Design and §Acceptance below carry all four amendments (03:16). Source diff
read first-hand after 03:06 and matched the spec (placeholder comments sent back and restored).
WORKER DONE 03:23 (`reports/review-gate/20260910_032324+0200-attribution-worker.md`, gitignored):
107 passing; mutation of `freshness` to `ms > sinceMs` failed exactly the 4 attribution
"does not" cases and was restored. Self-reported deviation: ONE `python3 -c` literal substitution
(a fixture command `./long.sh &` matched `DETACHED_JOB` by accident → `python3 long_task.py`)
instead of the Edit tool. Test delta vs the reviewed diff read first-hand at 03:25: (iii) split
into Infinity-after-queue-op then closed-by-string-user; Bash result with both Agent strings
closes; e2e helper `writeActivityTranscript` (fork WITH an id, closed by its own result, then a
Bash pair) + cases (A) inside → block naming `tracked.txt`, (C) outside → release; two-interval
and older-than-`t` effects cases; `home` passed. The pre-existing e2e block case ("no tool_use in
the transcript") was passing only because its `forkBlock` fixture carries no `id` (an interval
that can never close covered the write — a shape no real transcript produces). A rename was
proposed and REJECTED by review (it would have recorded a fixture defect as behaviour); instead
the case became (B), the RELEASE twin of (A): an id'd fork closed by its own result, nothing else
ran, the write releases — `forkLines` now feeds both e2e release cases. Recompiled 03:30: 107
passing. Mutation MEASURED on the compiled scratch copy (source untouched): `freshness` reduced to
`ms > sinceMs` → 96 passing, 5 failing — (B), (C) and the three effects "does not" cases, nothing
else. COMMITTED 3f498995 (the four src/test files) and DEPLOYED 03:32: `node esbuild.js` exit 0,
`ATTRIBUTION_SLACK_MS` ×2 in `standalone/cli.js`; VERIFIED 03:34 that the Stop hook command is
`agentlenspro review-gate` and `command -v agentlenspro` resolves through `/opt/homebrew/bin` to
THIS checkout's `standalone/cli.js` (npm link, not a published install); 03:37: all 57 dirs on
this shell's PATH swept (explicit `:` split — zsh does not word-split `$PATH`), exactly ONE
`agentlenspro`-named entry exists as of 03:37, that link. The hook's own PATH is Claude Code's
process env and was not read, so a dir outside this shell's PATH (or one populated later) is the
only unexcluded shadow; if the chain holds, EVERY Stop since 03:32 has already run the new bundle
— the Stop-side proof is 9FG0LSPG's release half (a Stop that passes after a KNOWN non-session
write). 03:39: the real compiled `unreviewedEffects` run with `activity` undefined (= the OLD
any-writer rule) since the code commit 03:32:04 lists exactly `["HEAD"]`, `truncated: false` —
nothing dirty or watched is newer except my own commits, so no non-session write has landed
since the bundle. WHEN that half can be observed: `sinceMs` is the last fork's timestamp and
every fork-ended turn puts an earlier write below it at the next Stop, so the release half shows
only at the Stop of a turn with NO fork after the write — a heartbeat turn whose stub spawned no
background agent (a memory-chore spawn is an interval open until ITS notification lands, however
long that takes) — AND only once every
earlier background fork/agent's `<task-id>` notification has been DELIVERED to the transcript (a
write in the gap between a fork's spawn and its notification sits inside `end = Infinity`, so that
Stop BLOCKS and is not a pin-open bug), AND the write did not land during the stub itself (the
named residual). Peer tldr-code-5c told 03:32. A post-commit
review found two stale test comments (a "1.5s margin" left at 2.5 s; a "Positional" label for
the recency gate) — fixed in the docs commit 24323387.
LIVE: this session's Stop was blocked by the effects arm on the worker's own edit of
`src/cli/reviewGate.ts` with no tool_use in the main transcript — under the PRE-3U8AIHXK bundle,
whose any-writer rule cannot tell a worker from a peer; under the new bundle the same block must
survive because the worker is a background Agent whose interval stays open until its
notification (re-prove: 9FG0LSPG's live rows, both halves). Deferred, NOT forgotten — it is the
last step of NEXT ACTION: the security-guidance 2.0.8 plugin reload (a reload at this context
would `/clear` and drop agent types; write the handoff first).
Column `testing` from 03:34 (code committed, built, deployed; only the live rows open).
NEXT ACTION: the live two-half proof on 9FG0LSPG (block half: a background worker's write before
its notification; release half: a Stop that passes after a KNOWN non-session write in a tool
gap) → the peer's one-day row → `ai_review` → reload plugins (handoff first).

## Why

The gate deployed in 208994b8 arms on any path in the repo or the watched config set whose mtime
is newer than the last review fork — whoever wrote it. That was the point (a worker's or a
script's write never shows in the parent transcript), but "newer than the fork" says nothing
about WHO wrote, and the watched roots are machine-global. Peer session tldr-code-5c, whose turns
run only the janitor dispatcher stub (read-only), was blocked four times in one day, each release
costing a full inherited-context fork that reviewed nothing that session did:

1. 2026-09-09 16:50 — `~/.claude/hooks/state/checkout-otp-ledger.log` + `checkout-otp.json`:
   the checkout guard's own ledger, written for a `git checkout --` in a THIRD session.
2. 2026-09-09 21:06 — `~/.claude/plugins/cache/claude-plugins-official/security-guidance/2.0.8/hooks/hooks.json`:
   a plugin version landing in the cache (the whole version dir at mtime 21:01, next to its 2.0.7
   sibling).
3. 2026-09-10 01:2x — `~/.claude/agents/haephestos-creation-helper.md` (`isSystemAgent: true`,
   `temporary: true`): regenerated by the AI Maestro server.
4. 2026-09-10 01:3x — the same two guard files as (1), for a `git worktree remove` elsewhere.

The same class, unreported so far: the janitor rewrites this repo's `CLAUDE.md` index and
`.claude/project/memory/*` (both perpetually dirty in-repo files), and `~/.claude/rules` is synced
by the janitor — every session in this cwd would arm once per rewrite. Machine-wide, that is one
spurious fork per non-session writer per session.

Per-writer exclusions do not scale (the list above grew by one per report); scoping to "paths this
session's tools named" reopens the delegation hole 9FG0LSPG closed. What discriminates is WHEN:
this session's own writes — foreground tools, workers, scripts, background jobs — can only land
while one of its tools is running. Measured on this session's JSONL (2026-09-10): every
`tool_use` block carries an `id` and its entry a timestamp; its `tool_result` (a `user` entry,
array content, `tool_use_id`) answers it; a background Bash result reads `Command running in
background with ID: <id>` and a background Agent result carries `agentId: <id>`; the job's exit
is recorded as an `attachment` / `queue-operation` entry and delivered as a string-content
`user` entry, both containing `<task-id><id></task-id>`; the one sampled fork tool_use carries
the gate's ONE-turn line in its prompt (85 transcript lines contain the phrase; the 37 Stop-hook
feedback lines are among them because `MAIN_BLOCK_DEMAND` embeds it — read from the source, not
measured per line).

## Design — the effects walk keeps `sinceMs` and gains an attribution predicate

- `scanMainTranscriptLines` additionally returns `activity: Activity[]` (`{ start, end }` in
  epoch ms; `end = Infinity` while open — fail closed): one interval per non-sidechain `tool_use`,
  opened at its entry's timestamp (0 when absent — covers everything). Closed by: the matching
  `tool_result` (that entry's timestamp) for a foreground tool; the FIRST later `attachment` or
  string-content `user` entry whose raw line contains
  `<task-id><id></task-id>` for a background Bash/Agent — the id parsed from the tool_result
  text and keyed by TOOL (Bash: a result STARTING `Command running in background with ID:`;
  Agent: a result carrying `Async agent launched successfully` and `agentId:`), so a foreground
  Read or Bash whose output quotes such a line closes at its own result instead of pinning an
  interval open forever (review finding 2). A review fork closes like any other spawn — its
  result or its notification; the zero-length interval first proposed for it was REJECTED in
  review (finding 1: a fork spawned with the ONE-turn line pasted, then used as a worker, would
  write unattributed). A Bash command that detaches its work (`nohup`, `setsid`, `disown`,
  `detach-run.py`, a mid-line `&` after whitespace or `)` — `( … ) & echo started` included — or
  a trailing `&`, even unspaced `cmd&`; `&&` and `&>` are excluded by the lookahead, `>&` by the
  lookbehind) never closes: fail-closed text heuristic (finding 3). A tool_result whose tool_use
  fell before the window opened spans `[window start, result]` — unless its text is itself
  launch-shaped (the anchored Bash launch line or the Agent launched-text pair, both tried for an
  unknown tool), in which case it stays open until its notification (finding 4 + the spec
  review). Only an
  `attachment` entry or a string-content `user` entry closes a job — never a `queue-operation`
  line (the harness writes one on enqueue AND dequeue) and never an array-content `user` entry
  (a tool_result, which may QUOTE a notification).
- `unreviewedEffects(cwd, sinceMs, { activity })`: a path is reported iff mtime > `sinceMs` AND
  (`activity` is undefined OR some interval contains the mtime within ±1000 ms). Applied at all
  four sites: in-repo file mtime, a deletion's nearest-ancestor mtime, `HEAD`'s reflog/`%ct`
  second, and the watched walk. `truncated` still arms unconditionally. `activity: []` (no tool
  ran in the window) reports nothing but `truncated`.
- `~/.claude/hooks/state/` is excluded from the watched walk: hook RUNTIME state (the guard's
  23.8 MB append-only ledger), not config. The plugin cache and `~/.claude/agents` stay watched —
  their non-session writers land in gaps, which the predicate already releases.
- Residuals, named: a non-session write landing INSIDE one of this session's intervals (a
  20-minute background build, or a review fork's 1–3 minute run, is that long a window) still
  arms once; a detached job the heuristic does not name (a script that daemonizes itself) writes
  unattributed after its result — fail OPEN, bounded to that shape; the heuristic reads the
  command TEXT, so a foreground Bash quoting a bare `&` or one of the four keywords in an argument
  (`git commit -m "a & b"`, an `echo`, a grep pattern, `--nohup-style`, a path `./nohup` — the
  keywords are `\b`-bounded, not whole-token) pins its interval open for the rest of the window —
  fail CLOSED, any-writer behaviour restored until the window rolls past it; a background job whose
  tool_use, result AND notification all fall outside the 4 MB window (older than the window and
  still running) is unattributed — fail OPEN, needs a transcript longer than the window during
  one job; a `tool_use` entry with no timestamp opens an interval at 0 (arms on everything after
  it — fail closed); a FOREGROUND Agent whose result echoes another job's launch text verbatim
  (`Async agent launched successfully` + `agentId:`) is keyed on that id and, if that job already
  reported, never closes — fail CLOSED, arms on every later write until the window rolls; a
  symlinked `hooks/state` under a watched root is walked (the exclusion is by path, fail closed);
  a human pasting a notification's `<task-id>…</task-id>` text into the prompt closes that job's
  interval at paste time — fail OPEN, needs a verbatim paste; intervals are clipped by nothing,
  so a tool that started before the last fork and reported after it still covers the post-fork
  span.
- Unchanged: `sinceMs` = last-fork timestamp (the fail-closed lower bound), the positional exit,
  every text arm, the block message.

## Acceptance

- [x] `src/test/reviewGate.test.ts`: scanner — a foreground Bash use/result pair yields one closed
      interval; a background Bash (result text `Command running in background with ID: x`) stays
      open (`Infinity`) until an `attachment` line carrying `<task-id>x</task-id>` closes it at
      that line's timestamp; an array-content user entry quoting `<task-id>x</task-id>` does NOT
      close it; a foreground Bash whose result text is `agentId: zzz` and a Read whose result
      quotes `Command running in background with ID: q9` each close at their own result; a
      review fork (prompt containing the ONE-turn line) sets `lastFork` and stays open until its
      result; a Bash result carrying both Agent launch strings closes at its result; after a
      `queue-operation` line quoting `<task-id>x</task-id>` the interval is still open, and a
      string-content user entry quoting it then closes; a tool_result with an unknown
      `tool_use_id` yields `[window start, result]`, or stays open when its text is
      launch-shaped; `nohup ./x.sh &`, `./x.sh &` and `( sleep 5; touch x ) & echo started`
      stay open after their result while `a && b`, a `curl` query string with `&` and `cmd 2>&1`
      close; a tool_use with no result stays open; `applyEffects` returns the same `activity`
      array.
- [x] `src/test/reviewGateEffects.test.ts` (`t = now − 2500`): a file with mtime inside an
      interval is listed, one outside every interval is not, one inside the second of two
      intervals is listed, one OLDER than `t` inside an interval is not; `activity: []` lists
      nothing; `HEAD` and a deletion each listed only under a covering interval; `truncated`
      still reports with `activity: []` (a guard — the walk sets it before the predicate is
      consulted, so it cannot fail on this code); with `home` passed, a file under a watched
      `hooks/state/` is not listed while a sibling under `hooks/` is.
- [x] `runMainGate` end to end, every fork an id'd tool_use closed by its own result: (A) a Bash
      tool_use/tool_result pair spanning the write blocks and names `tracked.txt`; (B) the fork
      alone, nothing else ran, releases; (C) a Bash pair that ENDED before the write releases.
      Mutation check: with `freshness` reduced to `ms > sinceMs` (B) and (C) fail.
- [x] `pnpm run check-types`, `npx eslint src/cli/reviewGate.ts src/cli/reviewGateEffects.ts
      src/test/reviewGate.test.ts src/test/reviewGateEffects.test.ts --quiet`, `check-mirrors`,
      `check-identities` all exit 0; every pre-existing review-gate test still passing (107,
      run by this session 03:25 and 03:30, not only by the worker).
- [x] `node esbuild.js` exit 0 (03:32); `ATTRIBUTION_SLACK_MS` ×2 in `standalone/cli.js`; peer
      session tldr-code-5c told the bundle changed (03:32, message names the commit and the four
      reported shapes).
- [ ] Live: tldr-code-5c reports no effects block on a write it did not make for one day
      (2026-09-10 → 2026-09-11), or reports the next one with its path.

## Not in scope

- Attributing a write to a specific descendant (which worker) — the interval says "ours".
- Notification pairing for a FOREGROUND Agent spawn — its tool_result already closes it.
- The 9FG0LSPG revert recipe must add this card's commit once it lands (noted there).

## Notes and lessons learned

- (none yet)

## Recorded limitation — cross-session arms on the shared watched set (2026-09-10)

Two sessions overlapping on one machine cross-arm on the shared watched set (~/.claude/rules,
agents, hooks, settings, plugin-cache hooks.json): a peer session's write inside this session's
tool-activity interval is reported as this session's effect, so this session's fork is handed a
change it did not author while the author's own Stop already reviewed it, if the author's Stop
preceded ours (not established). The interval rule is
a could-this-session-have-caused-it heuristic; mtime carries no authorship, so only authorship
evidence could narrow it and none exists. Fail-closed is correct here (TRDD-9FG0LSPG): a rule
or agent file the session must now obey is worth a read whoever wrote it. Reported 2026-09-10 by
two peer sessions (ai-maestro-janitor, agents-discipline): one agent file flagged 4 times across
peer rewrites — verified by neither this session nor a read of their transcripts.

## Correction 2026-09-24

Commit 5d418b93's message says the cross-arming report was "verified by neither" without naming who; the card's own wording is "verified by neither this session nor a read of their transcripts" — the commit message drops the specific scope. Also: the second reporting session named in the staged edit (agents-discipline) has no evidence of verification in this session's transcript. Recorded per RULE 1 board-triage worker instruction; git history is not rewritten.
