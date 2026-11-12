---
trdd-id: KZCSO0R2
title: Convert review-gate enforcement to mods so an interrupt can never skip the adversarial review
column: todo
status: tasked
created: 2026-11-11T16:24:22+0100
updated: 2026-11-12T13:48:15+0100
implementation-commits: [42b140f5, 43baaf9b, dd79f249, bcf2b35b]
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-11T16:24:22+0100
---

# Convert review-gate enforcement to mods so an interrupt can never skip the adversarial review

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-11-12

- Committed: 42b140f5 (--json-verdict), 43baaf9b (--transcript branch, reviewed accept-with-conditions), dd79f249 (mod scaffold; it scans nothing, because turn.complete carries no transcript path).
- Scanner change is now committed as bcf2b35b (src/cli/reviewGate.ts, src/test/reviewGate.test.ts: `--ignore-interrupt-floor`, `--cwd`, `scan.readable`, `options.ignoreInterruptFloor`, exit 2 on malformed command line; reviewGate mocha 202 passing). Still uncommitted at the time of writing: the mod files (register.js, README.md, plugin.json, types/index.d.ts) and this card. The mod takes transcript_path and cwd from classic.* payloads and scans aborted turns only.
- DECISIONS 2026-11-12 (user said: "decide yourself. just base your decisions on verified facts."): D1 transcript path and cwd come from classic.* event payloads; a temp file of $.session.messages() or a stdin message mode was rejected, both need a second scanner input format. D2 scanner opt-in --ignore-interrupt-floor, because the interrupt floor makes an interrupted turn scan as demands false. D3 cwd passed with --cwd. D4 the non-aborted second net stays in the code, disabled, until transcript lag is measured. D5 standalone/cli.js is gitignored local deploy state and must be rebuilt with node esbuild.js after each scanner change.
- NEXT ACTION: commit the mod change (scanner already committed as bcf2b35b); then make a pending demand persist until a credited REVIEW fork is seen (today it is shown once); then measure with the mods probe tool: transcript lag at turn.complete, whether classic.* events fire with the expected fields, and the context injection.
- OPEN MEASUREMENTS: subagent classic.PreToolUse payload; whether awaiting `$.prompt.submit` inside the `turn.complete` hook always rejects; four measurements that need a real user Esc: (1) the `$.prompt.submit` refusal shape; (2) transcript lag on the aborted scan; (3) Esc at a permission prompt (a bare tool_use that never ran arms the scan); (4) a prompt typed right after Esc.
- The mod is NOT installed and must stay uninstalled until the probe measurements are done.

## Approval log

- 2026-11-11T16:24:22+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-11T18:37:38+0100 — column → todo by user. design complete (reports_dev/mods-review-gate/20261111_design.md); starting Phase 0 --json-verdict flag
