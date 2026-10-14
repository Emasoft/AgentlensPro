---
trdd-id: YL3EWT6N
title: agentlenspro detects and reinstalls missing or outdated hooks skills agents and rules in user scope
column: dev
status: tasked
created: 2026-10-14T16:43:38+0200
updated: 2026-10-14T23:26:49+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-14T16:43:38+0200
implementation-commits: [ab5b1274, 87440d7e, d73b20cc, a065129a, 1069f1c8, 857cc34a, 765c44f2, 403b1137, ae4979be, 6a31062d, f6504dee, 42017224]
---

# agentlenspro detects and reinstalls missing or outdated hooks skills agents and rules in user scope

## Approval log

- 2026-10-14T16:43:38+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Owner request

2026-10-14, owner verbatim: "will agentlenspro install the updated hooks if they are missing or outdated? you should add a semver version number to the skills and the agents too, and even to the rules, just to be sure agentlenspro will detect their absence or their outdated version and automatically install or reinstall them into claude user scope when the cli is executed or the server is started." Also: "note that agentlenspro is not a plugin, but a tool."

## Plan (revision 2, two review rounds)

1. DONE ab5b1274 — drift checks read INSTALLED_EVENTS (supervisor/delegate events were missing; a missing UserPromptSubmit key was never repaired). CHANGELOG at release: the review-supervisor's UserPromptSubmit registration is now restored when missing.
2. IN DEV — skill extra-file drift loop: compare only the shipped relative-path set (evidence docs_dev/20261014_155914+0200-install-selfheal-map.md).
3. TODO — ensureInstalled on server start/restart and daemon start (ensureServer, serverControl.ts:292), same .autosetup.lock (skip+log if held), skipped when Claude Code is absent, honours AGENTLENS_NO_AUTOSETUP / kill-switch / disable; revive unchanged. Tests must fail before the change: server start restores a missing skill; AGENTLENS_NO_AUTOSETUP blocks it; held lock skips with a log line.
4. BLOCKED on owner decisions — edit protection by known shipped hashes (components.lock.json backfilled from every release tag; build fails if the current hash is missing); unknown hash left in place with a warning on implicit triggers; only the explicit setup verb (not first-run auto-setup) backs up and overwrites; known-newer hash follows the downgrade decision.
5. BLOCKED — versions: skills metadata.version, agents version: frontmatter; guard against the previous release tag (CI must fetch tags; a tag-push run compares with the previous tag); any file change in a skill tree requires its SKILL.md bump.
6. BLOCKED — downgrade policy (owner). 7. TODO — warnings to <dataDir>/autosetup.log, stderr only on exit 0, buffered until exit (no mechanism exists yet).
Owner decisions pending (asked 2026-10-14, no answer yet): (a) agent names keep vs agentlens-* prefix vs stop shipping the generic workers; (b) commit or revert the uncommitted hookInstall.ts AGENT_NAMES hunk; (c) downgrades; (d) dev loop when running from a git checkout; plus whether to ship the review-gate part of turn-protocol-and-review.md as a versioned rule. Review evidence: docs_dev/*measure-versioned-selfheal.md, docs_dev/*measure-selfheal-rev2.md.
Additions from the card review: (5a) before stamping all 6 agents, live-check that an agent carrying a version: key still appears in the Agent tool listing and spawns; (3a) item 3 must name its 'Claude Code absent' criterion — no helper exists today (MEASURE rev2 step 4); proposed: skip when neither ~/.claude exists nor `claude` resolves on PATH. Related: the review-display mod (TRDD-QQ2XIIZ6) would ship as one more versioned component of this feature.
Follow-up from the review of 87440d7e (pre-existing, not caused by it): installSkill copies onto the destination path, so a symlink or dangling symlink there makes the repair write THROUGH it (outside the skill dir) or fail on every launch, and a directory where a shipped file belongs fails with EISDIR every launch. Fix: unlink (or rename aside) the destination before copying. Separate increment.
Review of a065129a: (i) the full suite is RED at HEAD — two cliDispatch tests fail on the old code too: an exit-2 refusal's stderr begins with the launch auto-setup's 'agentlenspro:' line instead of JSON (plan item 7), and `heartbeat-cost` creates ~/.agentlens and ~/.claude under HOME before failing fast (the launch first-run setup runs before a fail-fast verb). Both block TRDD-CS2W7E77's 'two consecutive full-suite runs' release gate. (ii) setupVerb flaked once under load (memory-check SKIP vs PASS), passed on two re-runs.
Review of a065129a: when the Dockerfile is repaired (it still runs the retired standalone/server.js), set ENV AGENTLENS_NO_AUTOSETUP=1 — a container that mounts ~/.claude read-write would otherwise install skills/agents/hooks into the host's ~/.claude; claudeCodePresent cannot tell a mounted ~/.claude from a real install.
Review of a065129a (minor, open): `server --flag start` and a bare `server` (if it means start) skip the check because argv is read positionally; a drift the repair can never fix repeats one repair attempt and one stderr line per launchd restart — a same-drift back-off would be cheap.
Correction to the review-of-a065129a line (i): that heartbeat-cost creates ~/.agentlens and ~/.claude BECAUSE the launch first-run setup runs before a fail-fast verb is INFERRED (the worker observed only that both were created).
Open (? INFERRED, not read): whether launchd's daemon start --supervise re-runs the install check per alcore child crash or only per supervisor start. Residual from 1069f1c8 (? INFERRED, not measured): while the check runs synchronously under --supervise, the supervisor does not drain the child's piped stderr; a child writing more than ~64 KB of stderr in that window would block.
Found while testing 1069f1c8 (pre-existing on a065129a): cliUsageContract fails its after-all isolation guard — `help <unknown>` falls through to a path that starts a test alcore on the suite temp root, which is left running. Another red-suite item for the CS2W7E77 gate.
From the review of 1069f1c8, resolved by 3c: the check runs only after the verb RESOLVES, so every throw before that skips it — ensureServer refusals (kill-switch/port, no alcore binary, spawn failure, exited during startup, start did not answer) and runSupervise's NO_REVIVE brake `process.exit(75)` at entry; nothing was started on any of them, so skipping is correct. No process.exit on server start failure paths; they all throw. The default serverStartCheck is pinned by a test that fails with a no-op default.
Related: TRDD-22BOPTBU (setup in an isolated HOME can run a global npm rm -g agentlens-dashboard), found while measuring 3c.
Owner question (2026-10-14, measured): `batch` with a refusing member exits 2 with the successful results on stdout and several JSON objects back to back on stderr — it already breaks the single-call exit-2 contract (stdout empty, one JSON object), which SKILL.md documents for single calls only. Item 7 left batch unchanged (no regression). Should batch follow the contract (e.g. one top-level object with per-member results and errors), or is the contract single-call only by design?
Correction to 6a31062d's commit message: launch notices print AFTER the output only for a successful single tool call; on a parse/usage error thrown before the call (exit 64) or a thrown FAIL, cliMain's finally prints them BEFORE the error text that standalone/cli.ts prints.
Follow-up (review of 42017224): with the read-only hot-path verbs excluded from the self-heal, an agent loop that only ever runs cache-expired, cache-state or last-compact on a fresh machine is never set up and answers 'cannot answer' forever. Consider naming `agentlenspro setup` in that answer when nothing is installed.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-14

2026-10-14 16:50: item 1 landed (ab5b1274), item 2 in dev, item 3 next. Items 4-6 need the owner's answers to decisions (a)-(d) — do NOT start them; the frontmatter's approved/mandate covers items 1-3 only. Evidence files under docs_dev/ are gitignored local scratch: the decisive facts are restated in this card's Plan.
2026-10-14 17:35: items 1-3 landed (ab5b1274, 87440d7e + d73b20cc, a065129a); follow-up 3b (run the server-start check concurrently with the start, plus a cliMain wiring test) in dev. Items 4-6 still wait for the owner's decisions (a)-(d).
2026-10-14 17:29: items 1-3 and follow-up 3b landed (ab5b1274, 87440d7e + d73b20cc, a065129a, 1069f1c8); 3b runs the server-start check AFTER the verb (concurrent would still run its synchronous prefix first). Correction: the previous STATE line is stamped 17:35 but was written at 17:21. Items 4-6 still wait for the owner's decisions (a)-(d). Next: plan item 7 and the red-suite findings.
2026-10-14 17:36: items 1-3, 3b and 3c landed. MEASURED (3c, isolated HOME/DATA_DIR on free ports): `daemon start --supervise` restores a deleted skill 2 s after the start while the supervisor keeps running, so the check runs under launchd. Next: the red-suite findings (two cliDispatch failures, cliUsageContract stray alcore) and plan item 7. Items 4-6 still wait for the owner's decisions (a)-(d).
2026-10-14 18:10: plan item 7 landed (6a31062d): a refused single tool call leaves one JSON object on stderr, launch notices folded in as `notices`. The three pre-existing red-suite failures are fixed: A by 6a31062d, B by ae4979be (stale test), C by 403b1137 (help never runs the launch check). Review follow-ups of those three commits in dev. Items 4-6 still wait for the owner's decisions (a)-(d); one more owner question below (batch).
