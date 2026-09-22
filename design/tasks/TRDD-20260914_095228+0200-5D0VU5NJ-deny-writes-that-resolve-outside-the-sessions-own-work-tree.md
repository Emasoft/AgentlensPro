---
trdd-id: 5D0VU5NJ
title: Deny writes that resolve outside the sessions own work tree
column: todo
created: 2026-09-14T09:52:28+0200
updated: 2026-09-14T09:52:52+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: feature
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-14T09:52:28+0200
priority: high
---

# Deny writes that resolve outside the sessions own work tree

## Approval log

- 2026-09-14T09:52:28+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Why

On 2026-09-14 a worker of this session ran `git checkout --` twice inside `~/ai-maestro`, supplying `git_safety_guard.py`'s own one-time code, and destroyed a peer session's uncommitted edits (report: `reports/review-loop-gate/20260914_085400+0200-incident-worker-reverted-peer-edits.md`). A review window controls WHEN an agent may write, not WHERE. This card is the WHERE.

## Why separate

Why it is separate from TRDD-40M4UPK3 (stage 1a). The MEASURE and ADVERSARIAL reports of 2026-09-14 both concluded that a general location allow-list needs a shell-semantics model — quoting, expansion, effective directory, per-verb target schemas — that cannot be made sound inside the gate, and that every fail-closed clause of it wedges legitimate work (the deploy commands, `gh` filing, the canonical report prologue, curl POSTs). A previous worker spent 426k tokens on a smaller version of it and did not finish. Stage 1a therefore ships the LOOP plus the literal-path integrity guards it needs; this card ships the scope rule on its own, with its own tests. It does NOT block the stage-1a deploy: outside a window every gated write is already denied, which is what the incident worker lacked. This card cites TRDD-40M4UPK3.

## Scope

1. `WRITE_VERB_SCHEMAS`, a typed table `Record<verb, {kind:'paths', extract} | {kind:'none'}>` shared by the classifier and the target extractor, so classification and targets have one source. `kind:'none'` (gh, curl/wget/httpie, package managers, `agentlenspro setup|--install-*`, the deploy verbs, `trddgrep index-verify --repair`, `eval`) means "window only, no location check". A coverage test asserts every classifier fixture resolves to a table entry.
2. Shell resolution: quoting rules (nothing expands inside single quotes); expansion of `~`, `$HOME`, `$CLAUDE_PROJECT_DIR`, `$TMPDIR` only; left-to-right `VAR=value` tracking within one command, so the canonical agent-reports prologue keeps working, or an explicit decision that it does not; `$(date +FMT)` with FMT free of `/`; an effective-directory model (literal absolute `cd`/`pushd`, `popd`, `git -C`, `env -C`, `tar -C`, `pnpm --dir`, `npm --prefix`, `make -C`, `cargo --manifest-path`), with a relative or non-literal `cd`, a subshell or `eval` before a write denying.
3. The allow-list itself: the own work tree — anchored on `$CLAUDE_PROJECT_DIR`'s tree, NOT the hook `cwd`, plus an isolation worktree created for this agent; nested `.claude/worktrees/*` are separate trees (measured); `reports/`, `*_dev/`, `~/.claude/plans/`, the scratchpad, `/tmp` outside git trees, `$TMPDIR`; the narrowed memory/design roots of the janitor DATA dir and `~/.claude/projects/<slug>/`; the janitor memory mirror. Own-tree membership by nearest `.git` ancestor compared by `(dev, ino)`, resolving `.git` files by parsing `gitdir:`/`commondir` — never by spawning git.
4. Git: `-C`/`--git-dir`/`--work-tree`/`core.worktree`/`GIT_*` must resolve into the own tree; path-argument writers (`worktree add`, `clone`, `init`, `archive -o`, `bundle create`, `format-patch -o`) are location-checked; `find -exec git` and `xargs git` deny; `git commit` in the own repo inside a window stays allowed (pin with a test).
5. Discarding verbs denied to every agent even in the own tree: `checkout` except `checkout -b|-B <name> [<start-point>]` with no `--`; `restore` only with `--staged`/`-S` and no `-W`; `reset --hard|--merge|--keep`; `stash` except `list|show`; `clean` except `-n`; `switch -f|--force|--discard-changes`; `merge|rebase|cherry-pick|revert|am --abort`; `git rm -f`; `gc --prune=now`; `reflog expire`.
6. Runners and `kind:'none'` verbs: their effective directory and any `--dir`/`--prefix`/`-C`/`--manifest-path` must resolve inside the own tree or a never-gated root. Cross-repo builds are the incident class.
7. `find -exec <cmd>` classifies the executed command (so `find … -exec jq …` is not a write); `-delete` always is.
8. Decide and state: whether `~/.claude/rules/`, `skills/`, `agents/`, `commands/` and `~/.claude/CLAUDE.md` are writable inside a window (they are in `defaultWatchedSet`) or owner-only. The plan requires a worker to update `~/.claude/rules/propose-then-review-then-implement.md`, so owner-only makes that task "hand the owner the text".

## Acceptance

Every rule has a test that fails on the broken behaviour; mutation-check the cross-repo `git checkout` denial and the own-tree commit allowance; the full suite shows no new failures; a live check that a worker cannot write into another repository.

## Does not block

This card does NOT block the stage-1a deploy (TRDD-40M4UPK3): outside a review window every gated write is already denied, which is the exact protection the incident worker lacked. Incident report: reports/review-loop-gate/20260914_085400+0200-incident-worker-reverted-peer-edits.md.
