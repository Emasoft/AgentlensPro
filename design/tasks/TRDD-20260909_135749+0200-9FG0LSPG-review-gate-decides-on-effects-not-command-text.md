---
trdd-id: 9FG0LSPG
title: The review gate must decide on effects newer than the last fork, not on command text
column: dev
created: 2026-09-09T13:57:49+0200
updated: 2026-09-09T14:32:07+0200
current-owner: main
task-type: bugfix
priority: critical
severity: high
min-approval-requirement: none
project-id: agentlenspro
scope: project
labels: [review-gate, hooks, token-burn, subagents]
related: [0E3W5C45, 9J0515I4, 00G5G94L, 0D6QK5CW]
blocked-by: []
npt: []
eht: []
implementation-commits: []
---

# The review gate must decide on effects newer than the last fork, not on command text

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-09 14:32

Design reviewed by an adversarial fork 2026-09-09. A first, stored-fingerprint variant (snapshot
refreshed at every released Stop, text arms vetoed by an unchanged tree) was REJECTED by that
review and is not to be revived: a cross-Stop refresh invariant has silent-release holes (a
worker write landing between Stops, a missing snapshot after `/clear`, a hook timeout mid-walk),
and the veto releases exactly the targets it was designed for — an empty diff proves nothing about
where `$X` pointed. The STATELESS, ADDITIVE variant in §Design is IMPLEMENTED (uncommitted at
14:17): `src/cli/reviewGateTriggers.ts` (redirect words stripped, literal-/tmp `$$`/`$RANDOM`,
positional `$VAR` resolution), `src/cli/reviewGateEffects.ts` (new), `src/cli/reviewGate.ts`
(`lastForkTs`, `applyEffects`, `'unreviewed change'`, four stderr lines, case-folded fork check,
directive sentence). Coordinator read every diff first-hand except the e2e test's two import
lines (covered by tsc). check-types, eslint, check-mirrors all 0; check-identities 0 on the
STAGED set (the new files included); 89 mocha tests passing across the three files (63 + 6 + 20),
the two end-to-end `runMainGate` cases included; the mutation check (fold dropped → "expected a
block, got release") was run and restored at 14:23. Adversarial reviews 14:27 and 14:31 accepted
the diffs; their comment and card findings are applied.
NEXT ACTION: commit by name (this card + six code/test files), then `node esbuild.js` and the live
`agentlenspro review-gate --directive` check ON THE OWNER'S GO — the bundle deploy re-defines the
enforcement gate and releases arms that fire today. After the deploy: one real edit-then-Stop
must block, and `unreviewedEffects` must be present in `standalone/cli.js` (a failed esbuild
leaves the stale bundle in place).

## Why

Read in full 2026-09-09: `src/cli/reviewGate.ts`, `reviewGateTriggers.ts`, `reviewSupervisor.ts`,
`killSwitch.ts`. Eight defects, ✓ VERIFIED from source except where marked:

1. **Wrong unit.** Bash is classified by command TEXT. It fails closed on any `$VAR`/`$$`/glob
   target (three false arms in one session, each costing a review fork) and fails open on a
   script's own writes, `chmod`, `git config`/`branch -D`/`tag`, `curl -o`, `tar -x`, `codesign`,
   `agentlenspro server restart`, `>&file`. The file's own comment names the upgrade and does not
   do it.
2. **Delegation hole (TRDD-9J0515I4).** A worker's Edit is invisible to the parent (an `Agent`
   tool_use is not work) AND released unreviewed at SubagentStop, because a worker without the
   Agent tool cannot spawn a reviewer. Edits made through such workers are never reviewed, and
   the delegation rule makes that a routine path.
3. **Fork-as-worker double hole.** A non-review `fork` spawn sets `lastFork` (releases the parent)
   and is exempt at SubagentStop (`REVIEWER_AGENT_TYPES`, keyed on `agent_type === 'fork'` per
   the source comment — not measured this session). A write made inside a fork is reviewed
   nowhere. The gate counts spawns, not reviews.
4. **Silent allows.** Missing or unreadable transcript, unparsable payload, unknown event → allow
   with no stderr line — the failure the file's own comments say a safety gate must not have.
5. **Redirect words count as package arguments.** Peer session tldr-code-5c reported
   (2026-09-09 13:55) that `cargo install --list` armed as `cargo install <pkg>`, then hit the
   burn-gate deadlock (0D6QK5CW) and left through the no-review hatch. Source (`:104`, `:129`)
   proves that reason needs a second word not starting with `-`, and `shellWords` keeps
   `2>/dev/null` / `2>&1` as words — so the command carried a second non-dash word; a redirect
   or fd-dup word is the likely one (INFERRED; the peer did not quote the command).
6. **Two sources of truth.** `reviewSupervisor.ts` scans with the pre-0E3W5C45 work definition
   (Edit/Write + a `git commit` regex): it warns on turns the gate released and is silent on
   `sed -i` and `git push`.
7. **Dead code.** Breaker counters, `opts`, `AGENTLENS_REVIEW_FORK_MAX`, `enforceOn`/`maxDemands`,
   tmpdir state files kept "for observability" and never cleaned.
8. Minor: the block message says "this turn" over a 4 MB positional window; the `stop_hook_active`
   interface comment contradicts `runMainGate`; the fork type is compared case-sensitively in one
   scanner and folded in the other; the sentinel accepts any ≥3-character reason.

## Design — stateless and additive; nothing is released except two decidable literal-/tmp shapes

- **T** = the transcript `timestamp` (ISO; present on the fork entry sampled from this session's
  JSONL) of the last fork entry in the scanned window; the window's first entry if no fork; an
  absent field → window start (fail closed).
- **UNREVIEWED** = in-repo dirty + untracked paths (`git -C cwd status --porcelain=v1 -z
  --untracked-files=all`, .gitignore respected, minus the build outputs `standalone/*.js`,
  `media/*.js|css`, `out/` — a watch rebuild is not work) with mtime > T, plus a deleted tracked
  path whose nearest existing ancestor (cwd included) has mtime > T — a deletion has no mtime of
  its own, and "always" would re-arm every Stop until it is committed, a livelock the first
  review caught — ∪ files of the watched set with mtime > T (an mtime walk, no hashing) — ∪
  `HEAD` when it moved after T, read from the reflog so a backward move by a worker counts
  (`%ct` alone would miss it; the mechanism, its epoch-shape guard and the whole-second `+1 s`
  tolerance live in `reviewGateEffects.ts` and its tests). Residuals, accepted: without a reflog
  a backward move is missed; a same-second race arms one spurious fork rather than missing one.
  A `HEAD` move the transcript never armed on (a worker's or another session's commit) arms
  once — that is the design, not a residual.
- Non-empty → block positioned at `lastFork + 1`, the message naming at most 8 paths. A fork
  spawned after the write releases; a write landing after the fork (a worker, a script, a
  fork-as-worker, a background job) blocks until the next fork. This covers 9J0515I4 and defect 3
  from the parent side for writes landing in the repo or the watched set (a worker writing to
  another repo or an unwatched file stays invisible) — without state, a refresh invariant, or a
  shared-data-dir problem.
- **Watched set:** `~/.claude/CLAUDE.md`, `~/.claude/settings*.json`, `~/.claude/keybindings.json`,
  `~/.claude/{rules,skills,agents,hooks,commands}/**`, `<cwd>/.claude/settings*.json`,
  `<cwd>/.mcp.json`, `~/.codex/config.toml`, `~/.zshrc`, `~/.zprofile`,
  `~/Library/LaunchAgents/*.plist`, plugin-cache `*/*/*/hooks/hooks.json` (bounded readdir),
  the LOCAL memory and design dirs of the project slug. A symlinked DIRECT child of a watched
  root is followed one level (measured 2026-09-09: 23 symlinked entries sit directly under
  `~/.claude/skills`, alongside 464 real subdirectories, so an unfollowed link would blind the
  walk to those skills);
  deeper symlinks are not, and a link whose real path is an ancestor of cwd, home or a watched
  root is skipped (it would walk the whole tree into `truncated` and arm on every Stop).
  NOT walked: the rest of `~/.claude/projects/<slug>/` (transcripts churn every turn),
  `~/.claude/plugins/data/**` (janitor state), memgrep sidecars. A walk over the cap sets
  `truncated`, which ARMS visibly.
- **Text classifier keeps every arm it has today** (`git push`, `gh …`, `npm publish`,
  `agentlenspro setup`, `memgrep -mem-`, `rm`, `stash` — none leave a reliable tree trace, none
  are vetoed)
  and gains two DECIDABLE exemptions plus one fix: (i) a literal `/tmp/` or `/private/tmp/`
  prefix whose only expansions are `$$`/`$RANDOM` is ephemeral (digits cannot contain `/`);
  (ii) a same-command literal `VAR=path` assignment resolves a later target that is exactly
  `$VAR`/`${VAR}` — any non-literal reassignment makes VAR undecidable and arms; (iii) redirect
  words and their spaced targets are stripped from a segment before classification (the redirect
  pass owns them).
- Known evasions, stated in the source: `touch -t` and `GIT_COMMITTER_DATE` backdate an mtime or
  a commit. Two sessions in one cwd block each other for the other's edits — accepted and named.

## Acceptance

- [x] Triggers tests (`src/test/reviewGateTriggers.test.ts`, 6 suites passing 2026-09-09):
      `cargo install --list 2>/dev/null` PASS; `echo hi > /tmp/x-$$.txt` PASS;
      `S=/tmp/a && echo x > "$S"` PASS; `S=$(mktemp); echo x > "$S"` ARM;
      `S=/tmp/a; S=$X; echo x > "$S"` ARM; `echo x > /tmp/../etc/$$` ARM; positional:
      `S=/tmp/b tee "$S"` ARM and `echo x > "$S"; S=/tmp/a` ARM; every pre-existing row unchanged.
- [x] Effects tests on a REAL tmp git repo (`src/test/reviewGateEffects.test.ts`, 20 passing):
      edit after T listed; edit before T not; ignored path not; commit after T → `HEAD`; checkout
      to an OLDER commit after T → `HEAD` (the reflog read); watched file after T listed, before T
      not; build output excluded; a deleted tracked file listed iff its nearest existing ancestor
      (cwd included) has mtime > T — both halves; a removed directory climbs to cwd; `maxEntries`
      overflow → `truncated`; a depth-0 symlink followed, a depth-1 one not, a link resolving to
      an ancestor of a root refused, a dangling link never throws; `reflogEpochMs`: epoch shape →
      ms, `HEAD@{0}` → null, empty → null; non-git cwd → watched set only. The whole-second `+1 s`
      tolerance is exercised only indirectly (the two HEAD tests keep a 1.5 s margin).
- [x] Gate test (`src/test/reviewGate.test.ts`, suite "runMainGate end to end": a real tmp repo,
      HOME pinned to it so the default watched set resolves to nothing): a file written after the
      last fork, with no tool_use in the transcript, blocks through the real `runMainGate` and the
      reason names `tracked.txt`; a fork newer than the write releases. Mutation check run
      2026-09-09 14:23: with the `applyEffects` fold dropped the block case fails ("expected a
      block, got release"); fold restored, 63 passing.
- [x] `rust-core/target/` is in `.gitignore`; `.claude/worktrees/` is excluded on this machine
      only, via the local `.git/info/exclude` (on a fresh clone each worktree should appear as one
      untracked entry and release after one fork — INFERRED, not measured). `git status --porcelain=v1 -z --untracked-files=all` on this repo measured
      at 13 bytes in 0.01 s (2026-09-09). The whole `unreviewedEffects` call on this repo, real
      watched set included, measured 177 ms with 3,118 files under `~/.claude/skills` (2026-09-09).
- [x] `pnpm run check-types`, `npx eslint <the six files> --quiet`, `check-mirrors` all exit 0;
      `check-identities` exit 0 on the staged set, the two new files included (2026-09-09); 89
      mocha tests passing (63 + 6 + 20) on the final run after the gate test landed.
- [ ] `node esbuild.js` exits 0 — the bundle deploy, on the owner's go.
- [ ] Live: `agentlenspro review-gate --directive` prints the effects rule (bundle deployed).
- [x] Every silent-allow path in `runReviewGate`/`runMainGate` writes one stderr line: missing
      transcript, unreadable tail, unparsable payload, unknown `hook_event_name`.

## Not in scope

- The burn-gate `COLD_RESUME_FANOUT` fork exemption — TRDD-0D6QK5CW, own card, both cores.
- Phase 2: delete the dead breakers and env knob; `scanSupervision` reuses `toolUseWork` /
  `textArms`; case-fold both fork checks; fix the stale comment — to be filed as this card's EHT.

## Notes and lessons learned

- (none yet)
