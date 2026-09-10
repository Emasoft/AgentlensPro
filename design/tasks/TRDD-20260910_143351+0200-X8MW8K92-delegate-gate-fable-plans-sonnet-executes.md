---
trdd-id: X8MW8K92
title: A PreToolUse delegate gate so a Fable main session cannot edit — it plans, Sonnet workers execute
column: dev
created: 2026-09-10T14:33:51+0200
updated: 2026-09-10T14:39:16+0200
current-owner: main
task-type: infra
min-approval-requirement: none
priority: high
blocked-by: []
npt: []
eht: []
implementation-commits: []
project-id: agentlenspro
scope: project
labels: [delegation, hooks, token-economy, fable]
related: [DRH4ZRGB, JELDR3KC, GOD0108C]
---

# A PreToolUse delegate gate so a Fable main session cannot edit — it plans, Sonnet workers execute

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-10T14:39:16+0200

Owner order 2026-09-10 ("Fable is used ONLY to analyze and plan; execution is delegated to Sonnet
subagents"), issued after a day of Fable turns that solved no open issue. Enforcement, not prose:
`agentlenspro delegate-gate`, a SYNC PreToolUse hook on `^(Edit|Write|NotebookEdit|MultiEdit|Bash)$`.
Implementation dispatched to a lean-worker against the spec
`docs_dev/20260910_143500+0200-spec-delegate-gate.md` (gitignored; its normative content is the
§Behaviour below). NEXT ACTION: the parent reviews the worker's diff and commits (git stays exempt);
then a SONNET worker runs `node esbuild.js`, `agentlenspro --install-hooks` and the smoke test in
§Acceptance row 4 (the parent may not — rule 5 classifies `agentlenspro --install-*` as write-shaped);
then `column: testing`. A second, standalone gate exists — see §Conflict; this card cannot reach
`complete` until that gate is unregistered. Companion prose: the USER rule
`~/.claude/rules/fable-plans-sonnet-executes.md` (outside the repo).

## Behaviour

1. `AGENTLENS_DELEGATE_GATE=off` → allow, one stderr line (logged off switch, like the burn gate).
2. The MODEL decides for EVERY call — there is no path exemption, because a `fork` subagent
   inherits the parent's Fable model and its transcript also lives under `/subagents/`; exempting
   that path would let a Fable fork-as-worker edit at Fable prices. Which transcript: when the hook
   input carries a non-empty `agent_id`, the call comes from a subagent and the hook input's
   `transcript_path` is the PARENT's — read `<transcript_path sans .jsonl>/subagents/agent-<agent_id>.jsonl`
   instead (measured live 2026-09-10 by the ai-maestro-janitor session; its own gate denied three
   Sonnet workers by checking the parent path); if that file is absent → allow with a stderr note.
3. Any of the LAST FIVE `assistant` entries' `message.model` in the transcript tail decides (a
   harness utility call stamped `"model":"sonnet"` can land last in a Fable transcript): none
   matching `/fable|mythos/i` → allow. Unreadable → allow with a stderr note (fail-open, never a
   false deny).
4. Fable + Edit/Write/NotebookEdit/MultiEdit: allow only under `/tmp`, `/private/tmp`,
   `<cwd>/reports/`, `<cwd>/reports_dev/`, `<cwd>/*_dev/`; else DENY.
5. Fable + Bash: DENY iff `commandWriteReason` (the review gate's own classifier) reports a write
   and the command is not `git …`/`gh …` (git tracking and issues stay in the main context).
6. Deny reason tells the agent exactly how to delegate: `lean-worker`, absolute paths, exact
   old/new or the `fastedit` command, the one check; locate with `tldr`.

## Acceptance

- [ ] `src/test/delegateGate.test.ts` — real tmp transcripts, no mocks — covers: Fable+Edit in repo
      → deny; parent transcript_path + `agent_id` whose subagent file is Sonnet → allow; same but
      the subagent file is Fable (a fork-as-worker) → deny; `agent_id` with no subagent file →
      allow with stderr; main transcript whose last entry is a `"model":"sonnet"` utility call
      after a Fable entry → deny; Sonnet main → allow; Fable Write under /tmp and
      under `reports_dev/` → allow; Fable Bash `git commit` and `gh issue comment` → allow; Fable
      Bash `sed -i` on a repo file and a `>` redirect into the repo → deny; read-only Bash → allow;
      env off → allow; missing transcript → allow with stderr. All green under
      `pnpm run compile-tests && npx mocha out/test/test/delegateGate.test.js`.
- [ ] `pnpm run check-types` and `pnpm run lint` exit 0; `node esbuild.js` exit 0 and the deny
      reason's first words are grep-able in `standalone/cli.js`.
- [ ] `agentlenspro --install-hooks` registers the matcher in `~/.claude/settings.json` through
      `safeConfigEdit` beside the burn gate, idempotently (a second run changes nothing), and
      `--uninstall-hooks` removes exactly it.
- [ ] Live: a Sonnet worker pipes this payload (with a two-line synthetic transcript whose
      assistant entry is `"model":"claude-fable-5-1"`, never the live session's path) into
      `agentlenspro delegate-gate`: `{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"<repo>/src/x.ts"},"transcript_path":"<tmp>/main.jsonl","cwd":"<repo>"}`
      → the deny JSON is printed; the same payload plus `"agent_id":"abc"` and
      `<tmp>/subagents/agent-abc.jsonl` whose model is `claude-sonnet-5` → nothing printed.
- [ ] The standalone python gate is no longer registered in `~/.claude/settings.json`
      (`grep -c fable_delegation_gate` → 0; the peer session's action per §Conflict).

## Conflict — a second implementation already existed

`~/.claude/hooks/fable_delegation_gate.py` (written 2026-09-10 14:35 by the ai-maestro-janitor
session, registered in `~/.claude/settings.json` on `Edit|Write|MultiEdit|NotebookEdit`)
implements the same order with different rules: gates `opus` too; denies `git commit/merge/rebase/push`
to the orchestrator; exempts `/design/`, `/memory/`, `/.claude/plans/`; off switch is a file
(`fable_delegation_gate.off`). It is DISABLED by that file since 14:34, after it denied three
Sonnet workers (it read the model from the parent's `transcript_path`). Agreed between the two
sessions 2026-09-10: agentlenspro owns the one gate; the peer unregisters the python hook the
moment `agentlenspro --install-hooks` has registered this one, leaving the file as reference.
Until then the python gate stays disabled. With both registered, deny would win on every
disagreement (no commits, no card or memory edits, opus gated) — none of which this card orders.

## Approval log

- 2026-09-10T18:54:37+0200 — OPEN (owner decision): gate `opus` too? The order names Fable, so the gate matches /fable|mythos/i only; the peer's python gate also gated opus. Not decided silently — owner's word.
