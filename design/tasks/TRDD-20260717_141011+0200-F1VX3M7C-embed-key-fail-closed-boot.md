---
trdd-id: F1VX3M7C
title: Embed-key bad/exposed at boot — fail-closed refuse-to-boot with a supervisor-terminal EX_CONFIG exit
column: dev
created: 2026-07-17T14:10:11+0200
updated: 2026-07-17T14:10:11+0200
current-owner: main
task-type: security
release-via: publish
relevant-rules: []
parent-trdd: WYC4KB50
implementation-commits: []
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-17 14:10 — STARTING

USER directive (2026-07-17, verbatim): "security is always a good thing, so go with the more
secure version." Ruling on the coherence risk I flagged: the public AgentlensPro#4 thread states
"corrupt/wider-than-0600 key ⇒ refuse to boot" (ai-maestro called it "stricter than I asked and
correct"), but the UNRELEASED 2.10.1 (WYC4KB50 finding #1) had REVERSED that to soft-fail. The
user chose the more-secure fail-closed version → **reverse #1's soft-fail back to refuse-to-boot.**

### What "more secure done right" means here (verified, not the naive revert)
- The security-load-bearing case is a **wider-than-0600 embed-key** (embedAuth.ts:66-67): a
  world/group-readable shared HMAC secret lets "any local account mint maestro assertions".
  Refuse-to-boot forces the operator to protect the secret before the server runs at all.
- `ensureEmbedKey` (src/embedAuth.ts:57) already THROWS on corrupt-hex OR wider-than-0600. The
  ONLY change is the BOOT SITE's response to that throw: soft-fail (catch → EMBED_KEY=null → run)
  → fail-closed (log + remediation + `process.exit(78)`).
- **The one landmine the naive revert reintroduces:** the CHANGELOG's "hook-revive respawned a
  crash loop". The supervisor (src/cli/serverControl.ts:241-250) respawns on ANY non-zero exit
  with geometric backoff — so refuse-to-boot alone = perpetual backed-off respawn. FIX (mandatory
  derived task): the supervisor's child-exit handler treats **`code === 78` (EX_CONFIG) as
  TERMINAL** — log the config refusal, do NOT respawn. `78` already means "a deliberate refusal,
  distinguishable from a crash" (server.ts:101, the DISABLED kill-switch uses it). This is a
  GENERAL fix: it also closes a latent bug where DISABLED-set-mid-supervision respawn-loops.
- Keep ALL 12 other WYC4KB50 hardenings (#2 win32 mode-gate — still needed so refuse-to-boot does
  not spuriously fire on Windows; #4 Vary, #5 required-arg fail-closed default, #6 centralized
  restricted-tab predicate, #9 admission-exempt registration, #11 non-object guard, #7 atomic
  write). Only #1's boot-site softening is reversed.

### Bonus consequence
Reverting makes the public #4 thread + README accurate again ⇒ the #4 §B1 heads-up (the
"refuses to boot on a bad key" correction that WYC4KB50 queued) is **NO LONGER NEEDED**.

### Phases (each: edit → full gate → commit; ≤5 files)
1. Code: standalone/server.ts (boot site → exit 78) + src/cli/serverControl.ts (code===78 terminal)
   + src/embedAuth.ts (doc comment: boot now dies fail-closed).
2. Docs: CHANGELOG.md (rewrite the 2.10.1 "no longer takes the server down" bullet → fail-closed)
   + README.md:187-193 (soft-fail wording → refuse-to-boot).
3. Tests: src/test/embedAuth.test.ts stays (ensureEmbedKey still throws); add a supervisor
   `code===78 ⇒ no respawn` test (src/test/serverControl*.test.ts or a focused unit around the
   exit handler).
4. Full gate (tsc ×2 + lint + check-mirrors + mocha) + deploy law (esbuild + server restart +
   symbol grep) + memory update (standalone-server-security-model layer 5 correction).

### NEXT ACTION
Phase 1 code edits (server.ts boot site + serverControl.ts exit handler + embedAuth.ts doc).

### Gated (do NOT do autonomously)
- Tagging v2.10.1 (triggers OIDC publish) — stays USER-gated per CLAUDE.md publishing rules.
  package.json + CHANGELOG already at 2.10.1; this TRDD amends the same unreleased version.

SUPERSEDED — do NOT carry forward: WYC4KB50 finding #1's "bad key ⇒ embed feature disabled, server
runs" boot behavior, and the queued #4 §B1 "refuses to boot" heads-up (no longer needed).

## Context

The 2.10.0 viewer-role assertion (TRDD-1ZH1D5EG, the AgentlensPro#4 contract) shipped with a
fail-fast boot: a corrupt or wider-than-0600 `~/.agentlens/embed-key` refused to boot. The xhigh
code review (WYC4KB50) softened that (finding #1) so an opt-in embed feature could not take the
whole observability product down. That softening is committed but UNRELEASED (no v2.10.1 tag).
On review of the public #4 thread the owner chose the stricter fail-closed posture. This TRDD
reverses only the boot-site softening and adds the supervisor change that prevents the reversal
from reintroducing the documented crash loop.

## Notes and lessons learned
