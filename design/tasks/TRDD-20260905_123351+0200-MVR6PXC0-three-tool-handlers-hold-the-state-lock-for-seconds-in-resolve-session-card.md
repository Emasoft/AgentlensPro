---
trdd-id: MVR6PXC0
title: Three MCP tool handlers hold the state lock for one to four seconds inside their per-candidate resolve_session_card closure
column: ai_review
created: 2026-09-05T12:33:51+0200
updated: 2026-09-05T21:50:15+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
created-by: QE114936
related: [QE114936, UTFVMVT8, 2R36W8Q1, RAPDS7OX]
implementation-commits: [3b9018e0]
---

# Three MCP tool handlers hold the state lock for one to four seconds inside their per-candidate resolve_session_card closure

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-05T21:50:15+0200

**IN `ai_review` — fix committed `3b9018e0`, deployed, acceptance MEASURED PASS.** The detached
remaining-31 run finished green: 31/31 `test result: ok`, 0 failed, `ui` 41/41, no `error:` line
(`reports_dev/mvr6pxc0-cargo-test-remaining-20260905_203434+0200.txt`, last write 21:28; no EXIT line
by construction — `detach-run.py` execs cargo directly — completion read from the 31st binary's
result line plus the absence of the cargo process in a `ps` snapshot). `ui.rs` was `cmp`-equal to
the 17:14 patch at commit time. Deploy 21:38: release build 3m26s → old binary MOVED to
`builds_dev/alcore.prev-20260905_213843+0200` (not rm'd) → `cp` (fresh inode, ATOM-SFLG-1NSX) →
`codesign -s - --force` → `codesign -v` OK → `--version` exit 64 (usage, the documented non-kill exit)
→ `agentlenspro server restart` → pid 574 RUNNING canonical. **Acceptance (box 2) PASS**:
`reports/mvr6pxc0/20260905_214926+0200-acceptance-24-invocations.md` — 24/24 tools EXIT=0 against
pid 574 (log offset 27264342→27275615), 49 `state lock held` lines, all <1000 ms at the four target
ranges; the ONE ≥1000 ms line in the window is 1440 ms at `ui.rs:3507`, the `burn_risk_report` call
under the guard in `check_burn_risk` — a different handler, outside every range this card names →
its own card **TRDD-RAPDS7OX**. **Two facts the review fork on `3b9018e0` surfaced, recorded here
because the earlier STATE implied otherwise:** (1) the binary deployed at 16:32 (kept as the `.prev`
copy) already contained `resolve_session_card_offlock` — the live collector ran this diff ~5 h
BEFORE the gate went green, so the 21:38 deploy is a fresh-inode rebuild of the same source, and the
"gate before deploy" ordering in the 17:16 STATE was not honoured by whoever deployed at 16:32;
(2) the only eviction path from `log_sessions` is `POST /api/clear` (`lib.rs:627`), which triggers a
full sweeper rescan from offset 0, so a card stored into the cleared map between lock 1 and lock 2 is
re-derived from the same file — bounded, no code change. Nits parked for the next substantive
`ui.rs` edit: the `"state poisoned"` label at the new `env` clone site names a lock TIMEOUT as poison
(wording only); no test exercises `_offlock` under contention — the 24-invocation window is the only
concurrency evidence. **NEXT ACTION:** AI review of the split (read-only) → `human_review` is the
USER's move.

**Previous STATE (17:16) — IN `dev` — the code is written and UNCOMMITTED in the working tree (`ui.rs` +149/−42); the full
cargo test run is the gate that has not passed.** The kraken worker spawned ~13:00 was stopped by the
orchestrator at 17:14 after 4 h with no reply to a 14:07 status ping and a transcript file untouched
since 13:50. That silence was NOT death: a subagent's transcript file does not grow while one Bash
call blocks, and `target/debug/deps` test binaries carried 16:51 mtimes — its suite was still
compiling 23 min before the stop, so the stop traded a possibly-imminent green for a fresh run.
Its final status on kill: `resolve_session_card` split into 5 shared helpers plus a new
`resolve_session_card_offlock` (the reparse runs OFF the lock, three short guards), all four closures
converted (`get_cost_by_cause`, `get_cache_risk_costs`, `get_cache_break_report`,
`check_cache_expiry`) with TRDD comments; `cargo build` 0, `cargo clippy --all-targets -D warnings` 0,
fixtures unchanged; `cargo test -p agentlens-core` had not completed under load-avg 40–160 (an earlier
run was OOM-killed, exit 137 — not a test failure). The diff is still in the working tree; a
belt-and-braces copy sits at `reports_dev/mvr6pxc0-kraken-ui-rs-20260905_1714.patch` (243 lines,
5 hunks). The split is INTENDED as behaviour-preserving (the worker's evidence: fixtures unchanged,
build and clippy 0); the full suite is the proof. **The 17:15 run ended exit 101 at binary 70/98
on `lpv_parity` — a harness portability bug unrelated to this diff (TRDD-4TOU4V8E, fixed in
`644a9113`); 3 unittest + 66 integration binaries were green and `lpv_parity` red — every one of
the 70 `Running` lines is paired 1:1 with a `test result` line (awk-checked: 70/70, none
missing, so no silent crash/OOM hides in the green set); `ui` and the 30 other names sorting
after `lpv_parity` never ran (no `[[test]]` renames, no directory-style tests, so the
`tests/*.rs` stem list IS cargo's target list).** Those 31 are now running detached (ppid 1,
immune to session events) with `--no-fail-fast` since 20:34:34 under load-avg ~200; note that
naming `--test` targets excludes the lib/bin unittests and doctests, so the eventual green is
"67 + 31 integration binaries" with the 3 unittest binaries standing on the 17:15 result and
doctests unrun by either run. **That gate is COMPOSED from three runs over three states of
`lpv_parity.rs` (old → `as_u64` form → `from_secs_f64` form) and ONE state of `ui.rs`** — 17:15
full, 20:27 and 20:41 `lpv_parity` scoped, 20:34 remaining-31 — and the composition is
legitimate only because `ui.rs` is byte-identical across all of them: the working-tree diff
`cmp`s equal to the 17:14 patch copy (`UI_RS_UNCHANGED_SINCE_1714`, 20:41), and
`git log --since='2026-09-05 17:14' -- src/ui.rs` is empty, so HEAD's `ui.rs` is unchanged too.
The file's mtime 13:12:40 is the kraken's LAST `Edit` of `ui.rs` per its own transcript: 6 Edit
calls with `file_path` ending `/src/ui.rs`, first 13:02:22, last 13:12:40 local, in exactly one
session dir (the second copy of that transcript, under the cleared session, holds 0). That it
spent 13:12 → 17:14 in build/clippy/test is the handoff's narrative (deps mtimes 16:51), not
re-read here; the mtime itself is not in tension with "kraken alive at 17:00".
`lpv_parity.rs` is linked by nothing else: `grep -rn lpv_parity tests/ src/ Cargo.toml` outside
the file itself → 0. Capture
`reports_dev/mvr6pxc0-cargo-test-remaining-20260905_203434+0200.txt` (the `_203409` file beside
it is a mis-launch: zsh passed the `--test` list as one token; ignore it). **NEXT ACTION:** poll
that capture for its `test result` lines and the absence of `error:` (no EXIT line — detached);
`--test ui` is the one that gates this diff. On green, commit `ui.rs` by name citing this card; then deploy
(release build → `bin-native/darwin-arm64/alcore` → `codesign -s - --force` → `agentlenspro server
restart`) and re-run the 24-invocation recipe from the QE114936 box-3 report for the acceptance line.
On red, read the failure in full before touching the diff.

**Previous STATE (12:58) — IN `dev`.** Analysis done, read-only (`reports/mvr6pxc0/20260905_125347+0200-lock-scope-analysis.md`,
every element ✓ VERIFIED from source): the closures hold the guard across `resolve_session_card`'s
reparse-on-demand fallback, `log_reader::reparse_session(&Env, …)`, which needs no state and does
disk I/O + JSONL parsing of a multi-MB transcript; only `put_log_session` (an IndexMap insert),
the summary lookup and `graft_otel_attribution` need the guard. A fourth site shares the shape.
The fix is UTFVMVT8's snapshot-then-work split; a worker is implementing it with build, clippy
and the full cargo test set, parity goldens required unchanged. Then: deploy (release build →
`bin-native/` → `codesign -s - --force` → `agentlenspro server restart`) and re-run the
24-invocation recipe from the QE114936 box-3 report for the acceptance line.

Found by TRDD-QE114936's acceptance box 3 (invoke every rewritten tool once while ingest is
hot: `reports/qe114936/20260905_123046+0200-box3-tool-invocations.md`). The twenty
summary-rebuild sites that card fixed are clean — no `state lock held ≥ 1000 ms` at any
`summary_now` site over 24 invocations. But three handlers still log holds of 1,037–3,948 ms,
eight lines in one window, all inside their `timeline_of` closure that calls
`resolve_session_card` per candidate:

| ms | site | tool |
|---|---|---|
| 1475 | `ui.rs:2074` | `get_cost_by_cause` |
| 1272, 1387, 1234, 2931, 3948 | `ui.rs:3220` | `get_cache_risk_costs` |
| 1037, 1274 | `ui.rs:3283` | `get_cache_break_report` |

QE114936's STATE already carried this as "the reparse in `resolve_session_card` can still block
a tokio worker thread" — a known remaining cost, not the defect that card targets. It gets its own
card because a 4 s hold under the state lock blocks every ingest and every other handler for
that long, on a server many Claude Code sessions post to concurrently (the goal: never lose
data).

**NEXT ACTION:** read `ui.rs:2074`, `:3220`, `:3283` and `resolve_session_card`; establish
whether the closure does I/O or a transcript reparse under the lock (the lock should be taken
only to snapshot the candidate list, and the per-candidate work done outside it, as
UTFVMVT8 did for the composition routes). Measure again with the same 24-invocation recipe
after the change; the box is the absence of any `≥ 1000 ms by ui.rs:<site>` line for these
three tools.

## Acceptance

- [x] The three handlers take the state lock only to snapshot, and `resolve_session_card` runs
      outside it (or is proven lock-free). (`3b9018e0`: all four `timeline_of` closures call
      `resolve_session_card_offlock`, which holds the guard for a `contains_key`, a stamp+insert and
      the OTEL graft, and releases it across `reparse_session_card(&Env, …)` — the disk read + JSONL
      parse. The single-lookup callers keep `resolve_session_card`, now composed from the same
      helpers, so the two cannot drift.)
- [x] Same 24-invocation recipe as the QE114936 box-3 report: zero `state lock held ≥ 1000 ms
      by ui.rs:{2074,3220,3283}` lines while ingest is hot.
      (`reports/mvr6pxc0/20260905_214926+0200-acceptance-24-invocations.md`, pid 574 = the
      `3b9018e0` build: 49 lock-hold lines in the window, none ≥1000 ms inside the four handlers'
      ranges; the single 1440 ms line is `check_burn_risk`'s `ui.rs:3507` → TRDD-RAPDS7OX.)
- [x] QE114936's box 3 note updated to point here (2026-09-05 18:08 — the note sits directly under
      QE114936's box 3, naming this card and the three `ui.rs` sites; earlier only its STATE block
      carried the link, which a review fork correctly refused to count as "the box-3 note").

## Notes and lessons learned

## Approval log

- 2026-09-05T21:50:15+0200 — `dev → testing → ai_review` (both exempt rows: code committed
  `3b9018e0`; the composed gate green and the box-2 recipe measured PASS on the deployed build).
  The card has no `test-requirements:` frontmatter, so per KBK9J59Y the "tests passed" judgement is
  the orchestrator's — USER may veto by demanding a single-run (non-composed) full suite including
  doctests. Review fork on `3b9018e0`: nothing blocking; its two verified findings (deploy preceded
  the gate; `POST /api/clear` is the only eviction path) are in the STATE block.
