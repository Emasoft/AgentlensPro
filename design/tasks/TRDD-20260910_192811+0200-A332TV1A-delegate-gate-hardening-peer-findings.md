---
trdd-id: A332TV1A
title: Harden the delegate gate against the write spellings and path tricks the interim python hook measured
column: todo
created: 2026-09-10T19:28:11+0200
updated: 2026-09-10T19:32:23+0200
current-owner: main
task-type: infra
scope: project
min-approval-requirement: none
npt: []
related: [X8MW8K92, DRH4ZRGB]
---

## Why

A peer session (`ai-maestro-0a`) measured nine gaps against the **interim python hook**
(`~/.claude/hooks/fable_delegation_gate.py` v2 of 2026-09-10 19:00) plus an adversarial
review. That hook is being superseded by the TS gate in this repo
(`src/cli/delegateGate.ts`, which reuses `commandWriteReason` from
`src/cli/reviewGateTriggers.ts` — see `TRDD-X8MW8K92`, the NPT that must land first).
**Each finding may or may not already hold against the TS gate — this is unverified.** The
peer's own report is explicit that the TS gate "must be TESTED for each row, not assumed";
the SYMPTOM of D(b) was reproduced live at 19:21 (a `/tmp`-only redirect of a
script read was denied by the python hook); the mechanism is the peer's leading hypothesis,
unconfirmed at the time of writing. Nothing here is to be accepted as true of
`delegateGate.ts` without a passing/failing test proving it.

## Findings (transcribed, formatting added, from `docs_dev/20260910_191816+0200-peer-findings-delegate-gate-hardening.md`)

**A. In-place edit spellings.** `sed --in-place[=suf]`, `sed -i''`, `perl -i -pe`,
`perl -p -i`, `perl -pie` — minimal regexes: sed `\bsed\b[^|;&\n]*\s(?:-\w*i|--in-place)`;
perl `\bperl\b[^|;&\n]*\s-(?![MIm])\w*i` (exclude `-M`/`-I`/`-m` module clusters).

**B. Write-tool verbs the delegation rule assigns to workers, currently fail-open:**
`fastedit` (anything but `--help`/`-h`/`--version`), `trddgrep fix|edit`,
`memgrep {new,update,migrate,delete,merge,split,reference}-mem-*`, `patch`, and
`git apply` (carve it out of the git/gh exemption — it is the Edit-shaped bypass). Match
without a start anchor so `uv run …`/`npx …`/`sudo|env|nice|time|nohup …` wrappers are
caught. Do NOT deny `mkdir`/`touch` (no content; `mkdir -p "$REPORT_DIR"` would be a false
deny).

**C. Allow-list normalisation.** `os.path.normpath(expanduser(path))` before any
`startswith` check (today `/x/reports/../lib/f.ts` passes); relative tokens resolved
against cwd (today `mkdir -p reports/x`, `cp a docs_dev/b` deny while
`cp /tmp/evil.ts lib` and `cp /tmp/x .` are ALLOWED because no-slash args are not path
tokens — for rm/mv/cp every non-flag argument is a path candidate); accept the exempt dir
itself (`reports`, `docs_dev`).

**D. Redirect classification.**
- (a) `>` of `>=`/`->` inside quoted strings is taken as a redirect (measured false deny on
  `awk '$1 >= "…"'`); strip quoted spans, and `(?<![<>=-])\d*(>>?)(?![\(=])`.
- (b) For a redirect only the redirect TARGET(s) are write paths — a script/arg path is a
  read (`python3 /Users/x/s.py > /tmp/out` is denied today). The symptom was reproduced
  live at 19:21 against the python hook (a `/tmp`-only redirect of a script read was
  denied); the mechanism above is the peer's leading hypothesis, unconfirmed.

**E. Subagent model resolution.** `meta.json` model values `inherit`/`default`/empty must
fall through to the jsonl, else a Fable FORK is allowed to write.

**F. Kill switch.** Deny any Fable Bash containing the off-file name, and any containing
the hook file name unless exactly `python3 <path> --self-test` — verb lists cannot protect
it.

**G. Log.** One record per line (escape `\n`/`\t` in the subject), known payload keys
(`effort`, `prompt_id`, `scratchpad_dir`) not logged as schema notes, truncate allow
subjects, rotation with the acceptance evidence copied out first (growth measured ~136 KB
per 11 min machine-wide); self-test must write to a tmp log (env override), never the live
one.

**H. Pin the documented blind spot** as an explicit allow case
(`python3 -c "open('/x/lib/f','w')"`) so it cannot change silently; per-verb self-test
cases; neuter protocol (revert one change → one named case reddens).

**I. EXPENSIVE_RE** `fable|mythos` matches the rule (Opus by discipline only).

## Acceptance

Every row is closed ONLY by a named test in `src/test/delegateGate.test.ts` proving the
finding's stated deny/allow behaviour against `delegateGate.ts` — or by a row note
"already covered by `<existing test name>`" naming that test. A finding that turns out to
already hold in the TS gate still needs a named regression test; "inspected the code and it
looks fine" does not close a row. A row may instead close with
`N/A: mechanism absent in the TS gate; TS-equivalent risk = <named>, closed by <test or card>`
when the python hook's mechanism (e.g. a standalone log file) has no TS analogue at all.

| # | Finding | Closing test (name it) | Status |
|---|---|---|---|
| 1 | A — sed/perl in-place spellings all matched | *(name test)* | open |
| 2 | B — fastedit/trddgrep/memgrep/patch/git apply fail-open, wrapper-prefixed forms caught | *(name test)* | open |
| 3 | C — allow-list normalises `..`/`~`/relative-to-cwd; accepts exempt dir itself | *(name test)* | open |
| 4 | D(a) — quoted `>=`/`->` not mistaken for redirect | *(name test)* | open |
| 5 | D(b) — only redirect TARGET is a write path; script/arg path is a read | *(name test)* | open |
| 6 | E (TS form) — a fork subagent transcript on Fable is denied; a subagent transcript with no model entries is the documented fail-open | closes by `(b2) parent transcript_path + agent_id, subagent file on Fable -> DENY (fork-as-worker)` in `src/test/delegateGate.test.ts` (fail-open side: `(b3)`/`(b5)`), or by X8MW8K92's live fork probe | open |
| 7 | F (TS form) — a Fable Bash whose write target is `~/.claude/settings.json`, the hook registration, or the gate's own kill switch is denied | *(name test)* (the TS gate has no kill switch of its own beyond `AGENTLENS_DELEGATE_GATE` env — `decideDelegateGate` reads `env.AGENTLENS_DELEGATE_GATE === 'off'`, no off-file) | open |
| 8 | G — N/A: the TS gate writes no log (stderr notes only); nothing to rotate | *(name test)* | open |
| 9 | H — documented blind spot (`python3 -c "open(...,'w')"`) pinned as an explicit allow case + neuter protocol exercised | *(name test)* | open |
| 10 | I — `EXPENSIVE_RE` matches `fable|mythos` | *(name test)* | open |
| 11 | `git apply` carved out of the git/gh exemption (subset of finding B, called out because it is easy to miss when reading the git/gh allow-list) | *(name test)* | open |

## Notes

Out of scope: nothing here changes the gate's registration or allow-list POLICY (which
paths/tools are exempt in principle) — that is `TRDD-X8MW8K92`. This card is scoped to
CORRECTNESS of the matching/classification logic against the nine measured gaps above.

Finding B changes the SHARED classifier `commandWriteReason` (`src/cli/reviewGateTriggers.ts`);
the review gate will also start arming on these verbs — test both consumers.

Start only after X8MW8K92's code commit has landed; never edit `src/cli/delegateGate.ts`
while an X8MW8K92 worker is in flight.

## Approval log
