---
trdd-id: 1ZH1D5EG
title: Signed viewer-role assertion — MAESTRO-only settings panel for the embedded dashboard (AgentlensPro#4)
column: complete
created: 2026-07-17T06:58:07+0200
updated: 2026-08-02T14:25:00+0200
current-owner: main
task-type: feature
severity: minor
scope: project
npt: []
eht: []
labels: [ai-maestro, dashboard, embed, auth]
implementation-commits: []
test-requirements: [unit, typecheck, lint]
---

# Signed viewer-role assertion (owner directive relayed via AgentlensPro#4)

## ⏵ STATE — 2026-07-17 07:20 — SHIPPED + LIVE-PROVEN (all 4 phases)

Mid-implementation the ai-maestro Claude posted the FULL spec (#4 comment 2) with a runnable
test vector and 11 questions — three deltas adopted over the original design below: `v:1`
contract version (unknown → reject), **invalid ≠ restricted** (an unverifiable header 403s the
WHOLE request — §B5: garbage falling back to standalone would BE the attack), and a
wider-than-0600 key file refuses boot. `GET /api/embed-status` added (their Q9 falsifiability
ask). The #4 §B4 cross-repo test vector is pinned byte-for-byte in embedAuth.test.ts.

Gate: 1352/0 passing, tsc ×2 0, lint 0 errors, mirrors OK. Deploy law honored (esbuild OK,
symbol greps in both bundles, server pid 7868). LIVE-verified 9/9 against the running server
with REAL signed assertions from the actual key file: standalone/user/maestro embed-status,
garbage→403, user POST→403, user GET /api/hook-config→403, meta injected only for user,
standalone hook-config read still 200 (kill-switch path untouched), key auto-created 0600.
Commits: ef9b2b6 (phase 1), 1247924 (phase 2), 63e9ed1 (phase 3), 553e258 (phase 4).
All 11 #4 questions answered on the issue. RELEASED in v2.10.0 (tag → OIDC publish, latest).

CONSUMER CLOSED THE LOOP (2026-07-17 09:30, #4 comment 5000179099): the ai-maestro Claude
implemented its signer (their TRDD-YY6M8Z16, commit f7104bc9), reproduced the 7/7 interop
table against THIS machine's live 2.10.0 with the real embed-key, and pinned the §B4 vector
byte-for-byte in ai-maestro CI — drift now fails tests on BOTH repos. Remaining: (a) the
OWNER's visual browser check (governance password never passes through a model — theirs or
ours); (b) basePath (TRDD-KDGJ0R38, backburner) — they retire their CSP rewrite when it ships.
Gate: human review.

## Owner directive (verbatim, via the ai-maestro Claude, 2026-07-17)

"restrict the settings changes (the right column panel on AgentlensPro dashboard) only to
MAESTRO USER. normal USERS cannot even open it, let alone change its settings."

## Ground truth (verified against code before designing)

- The "right column panel" is `ConfigPanel` (media/src/App.tsx:91) — Settings: IngestionToggles,
  McpToggle, Alerts, Automation — opened by the gear button via the `configOpen` signal.
- Mutating surface: 11 POST routes on standalone/server.ts (import, hook-events, hook-config,
  agent-gate, bodies/export, bodies/purge, clear, write-prompts-file, branch-dump,
  instructions/apply, /action).
- `/api/hook-events` (hook capture ingest) and the CLI hit :3000 DIRECTLY without the header →
  no-header = standalone = unchanged, so local ingestion is untouched by construction.
- `getHtml()` (standalone/server.ts:1970) builds the document as a template string → meta
  injection is a parameter, not a rewrite.
- DATA_DIR = `~/.agentlens` (server.ts:87) — the key file lives beside hook-config.json.

## The locked contract (co-designed on #4; ai-maestro adapts to this exact shape)

- Header: `X-Agentlens-Viewer: <b64url(payload)>.<b64url(HMAC-SHA256(b64url(payload), key))>`
  — the signature is over the base64url-ENCODED payload string (JWT-style; kills JSON
  canonicalization ambiguity in their pseudo-spec).
- Payload: `{"role":"maestro"|"user","iat":<unix_ms>,"exp":<unix_ms>,"nonce":"<random>"}`.
  `nonce` accepted but not replay-tracked (same-host threat model, short exp); `iat` unchecked.
- Key: 32 random bytes, lowercase hex, `~/.agentlens/embed-key`, mode 0600, created by the
  server at boot if absent. ai-maestro reads the same file as the same user.
- Semantics (fail-restricted, NEVER fail-open):
  - header ABSENT → `standalone` — today's behavior, full access (solo users, hooks, CLI).
  - valid signature + unexpired + role `maestro` → `maestro` — full access.
  - ANY other present header (valid `user`, bad sig, expired, malformed) → `restricted`.
- `restricted` ⇒ server: only GET/HEAD/OPTIONS pass; every other method → 403 JSON naming
  this contract. ONE blanket gate before route dispatch — not 11 per-route special cases
  (altitude: the panel is hidden AND its endpoints are dead, the second half being the point).
- `restricted` ⇒ HTML: `<meta name="agentlens-viewer" content="restricted">` injected; the
  webview hides the gear button, never renders ConfigPanel, and drops the Import tab (its
  only action is a gated POST).

## Deliberately out (recorded so they aren't re-proposed blindly)

- `hide-sidebar` param — the role covers the directive (settings chrome); the left sidebar is
  read-only navigation. If ai-maestro still wants it for LAYOUT, that is a separate named need.
- Replay/nonce store — same-host capture is outside the threat model at 60s exp.
- basePath — separate follow-up (TRDD-KDGJ0R38, backburner), the clean end-state that removes
  their CSP rewrite.

## Phases (≤5 files each; TDD)

1. Verifier core: NEW `src/embedAuth.ts` (`ensureEmbedKey`, `resolveViewerRole` — pure), NEW
   `src/test/embedAuth.test.ts` (~10 tests incl. every fail-restricted branch + key 0600).
2. Server wiring: `standalone/server.ts` — boot key, per-request role, blanket method gate,
   meta injection via getHtml(role).
3. Webview: `media/src/state.ts` (viewerRestricted signal), `media/src/dashboard.tsx` (meta
   read at boot), `media/src/App.tsx` (hide gear/ConfigPanel/Import tab).
4. Contract pins in `src/test/cliContract.aimaestro.test.ts` + README + CHANGELOG + gate +
   deploy law + LIVE verify (curl with real signed assertions against the running server) +
   reply on #4.

## Approval log
- 2026-08-02 — AI review PASSED (ai_review backlog audit): implementation verified present in the code first-hand, not from prose. Column ai_review → human_review; the remaining gate is the human. Evidence: reports/ai-review-audit/20260802_113252+0200-batchC-security-release.md
- 2026-08-02 — HUMAN gate closed by USER delegation ("evaluate the whole status of the project and decide yourself. just base all decisions on verified facts.", 2026-08-02); the AI audit line above is the verified basis; release-via none/absent → terminal. Column human_review → complete.
