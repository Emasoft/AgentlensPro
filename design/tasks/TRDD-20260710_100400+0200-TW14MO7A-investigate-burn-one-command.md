---
trdd-id: TW14MO7A
title: investigate_burn — ONE-command window-burn investigation with a cause taxonomy
column: complete
created: 2026-07-10T10:04:00+0200
updated: 2026-07-10T10:35:00+0200
implementation-commits: [117bed2]
last-test-result: pass
last-test-at: 2026-07-10T10:30:00+0200
current-owner: agentlens-session
task-type: feature
release-via: none
priority: 1
effort: L
labels: [diagnostics, mcp, cli, burn, forensics]
parent-trdd: null
test-requirements: [unit, typecheck, lint]
relevant-rules: []
---

# investigate_burn — one command, culprits identified

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-10

**COMPLETE — shipped + verified live 2026-07-10 (commit 117bed2, local-only).**
All 5 plan phases done. Acceptance PASSED: ONE live `agentlens-cli investigate_burn
--windowHours 6` over today's real corpus reproduced the entire manual investigation —
PREMIUM_MODEL_FANOUT 73.4M equiv/44% (1479 fable-5 calls, peak 864/30min, est $775),
FORK_STORM 26.6M/16% (76 full-prefix writes, 65 fully cold, one shared inherited
transcript), IDLE_FLEET_KEEPWARM 15.2M/9% — culprits named, ranked, evidenced, in one
digest line. 11 real-fs detector tests (suite 522 passing, Node 20); tsc/lint clean.
Implementation note: the source briefly contained raw NUL bytes (a \\u0000 escape in a
Write decoded to real NULs; grep called the file binary) — replaced the NUL-joined
attribution key with a '\\n' join; paths cannot contain newlines.

**Plan:**
1. `src/burnInvestigator.ts` (NEW): single-pass bounded scan of the OTEL bodies corpus for a
   time window → totals, attribution, ranked cause findings, one-paragraph verdict.
2. Register MCP tool `investigate_burn` in `src/mcpServer.ts` (auto-exposes in the CLI).
3. Real-fs tests with a synthetic bodies corpus per detector.
4. Gates, rebuild, restart server, run the ONE command against today's real corpus — it must
   reproduce today's manual 15-command findings (fork storm, fable fan-out, idle fleet).
5. Commit; CHANGELOG under 0.9.0 (unreleased).

## Context (why — the 2026-07-10 incident)

A 5h window drained twice and forced an account rotation. Root-causing it took ~15 manual CLI
calls + 6 ad-hoc python scans, and the first attribution (CLAUDE.md size) was WRONG — the real
causes were only visible after per-call cache_creation/cache_read analysis and content
fingerprinting. The user's directive: the CLI must answer "what burned my window and who did
it" in ONE command, by itself, with the culprits named and evidence attached; deeper drilling
stays available via the existing 32 tools + SQL.

## The cause taxonomy (measured patterns from the incident)

| code | pattern | signature |
|---|---|---|
| FORK_STORM | multi-agent fan-out forking a fat parent into a cold cache | cluster of cache_creation spikes >100k with cache_read≈0, request bodies sharing one first-message fingerprint (same inherited transcript) |
| SUBAGENT_BOOT_TAX | many fresh agents each paying the claudeMd+tools boot cost | cc-spike cluster with DISTINCT fingerprints, each cc ≈ boot size |
| PREMIUM_MODEL_FANOUT | fan-out burst running on a top-price model | ≥50 calls/30min on the priciest tier, mostly subagent-shaped (no Environment block) |
| FAT_SESSION_REWRITES | one big session repeatedly rewriting its whole prefix | recurring cc>100k spikes, same workspace, spread over hours (compaction / model switch / TTL gap) |
| IDLE_FLEET_KEEPWARM | background sessions kept warm by heartbeats | per-workspace: ≥2h span, ≥12 calls, cc share <2%, median gap 3-10min |
| IMAGE_BLOB_RESIDENT | image blobs resident in context, re-sent every turn | long base64 runs recurring across ≥3 requests of one fingerprint family |
| RATE_LIMIT_COLD_RESUME | fan-out resumed right after a limit stall into an expired cache | cc-spike cluster starting ≤15min after a StopFailure hook event / a ≥5min global gap |

Honesty invariants (same discipline as buildTokensByCause): report coverage (files scanned vs
present, caps hit), keep an explicit unattributed bucket, label every finding's evidence as
measured vs inferred, and NEVER present the verdict without its numbers.

## Design

- `investigateBurn(opts)` in `src/burnInvestigator.ts` — pure scan over
  `~/.agentlens/otel-bodies` (requests + responses by mtime window, default 5h, file cap) +
  optional `~/.agentlens/hook-events` correlation. No pairing dependency: responses give exact
  billed usage (cc/cr/out per call); requests give attribution (model at head; workspace via
  chunked deep search for 'Primary working directory: '; first-message fingerprint hash for
  fork-family grouping; base64-run sampling for image residency). Cluster + detect + rank.
- Output: `{ window, coverage, totals (byHour, byModel, $), attribution, findings[], verdict }`
  — findings ranked by input-equivalent tokens (cc×1.25 + cr×0.1), each with evidence numbers
  and confidence; verdict is 2-4 sentences naming the culprits with shares.
- MCP tool `investigate_burn` (args: windowHours, sinceIso/untilIso, maxFiles) → CLI gets it
  for free from tools/list: `agentlens-cli investigate_burn --windowHours 5`.

## Verification

- Unit tests: synthetic corpus per detector (fork storm, boot tax, keepwarm cadence, premium
  burst, image residency, rate-limit correlation) + coverage honesty (cap hit → complete:false).
- Live: one command over today's corpus reproduces the incident findings.
- `pnpm run check-types`, lint, `test:unit` under Node 20.
