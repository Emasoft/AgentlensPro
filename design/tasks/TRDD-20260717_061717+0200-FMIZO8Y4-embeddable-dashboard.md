---
trdd-id: FMIZO8Y4
title: Embeddable dashboard — loopback-only frame-ancestors contract + embed/deep-link params for the ai-maestro UI
column: complete
created: 2026-07-17T06:17:17+0200
updated: 2026-08-02T14:25:00+0200
current-owner: main
task-type: feature
severity: minor
scope: project
npt: []
eht: []
labels: [ai-maestro, dashboard, embed, integration]
implementation-commits: []
test-requirements: [unit, typecheck, lint]
---

# Embeddable dashboard (USER directive 2026-07-17: "prepare the dashboard to be loaded directly into ai-maestro as an iframe or something better")

## ⏵ STATE — 2026-07-17 06:32 — SHIPPED + LIVE-PROVEN

All phases done. Gate: tsc ×2 0, lint 0 errors, check-mirrors OK, 6/6 new parser tests; deploy
law honored (esbuild OK; `frame-ancestors` grep 1 hit in standalone/server.js, parser 3 hits in
media/dashboard.js; server pid 20191). LIVE iframe proof (screenshot
`reports/screenshots/20260717_062800+0200-embed-iframe-cache-tab.png`): a host page on
loopback :23001 framed the dashboard with `?embed=1&tab=cache` — first paint landed on the
Cache tab, the sidebar toggle was hidden, and live data rendered inside the frame (13,315
sessions; same-origin /api, zero CORS setup). `curl -sI` shows the CSP header. One accepted
consequence recorded: with the toggle hidden, the inline sidebar stays at its default (open) —
static, informative; a hide-sidebar param can be added later against a named ai-maestro need.
Contract posted on AgentlensPro#3. Gate: human review.

## Original design — 2026-07-17 06:17

## Ground truth (verified against code before designing)

- An iframe from `http://localhost:23000` (ai-maestro) ALREADY loads `http://localhost:3000` —
  the server sends NO X-Frame-Options / CSP frame-ancestors (permission-by-omission, fragile).
- The F6BM1BDI origin hardening does NOT block embedding: the iframe document is :3000, so its
  own `/api/*` fetches are SAME-origin inside the frame. Nothing to relax.
- The dashboard has no query-param handling at all (`activeTab` signal defaults to 'sessions';
  `normalizeTabId` is an identity passthrough — validation must be real in the new parser).
- No theme mechanism exists in the webview (no data-theme / prefers-color-scheme) → a `theme`
  param has nothing to wire; DROPPED (lazy-cat), noted here so it isn't re-proposed blindly.

## Design — iframe made CONTRACT-grade (the honest "something better")

A reverse-proxy mount or module federation would live on the ai-maestro side (their lane; noted
in the contract post). The AgentlensPro-side deliverable is an embed CONTRACT:

1. **Explicit loopback-only framing** — the dashboard HTML response gains
   `Content-Security-Policy: frame-ancestors 'self' http://localhost:* http://127.0.0.1:*
   https://localhost:* https://127.0.0.1:*`. One header, two effects: ai-maestro's embedding is
   GUARANTEED (a future hardening pass can no longer silently break it — the contract is now
   explicit), and remote-page framing of the local dashboard (drive-by clickjack of localhost:3000)
   is CLOSED — the framing counterpart of the F6BM1BDI read hardening, reactive to this feature.
2. **Deep-link + embed params**, parsed by a runtime-neutral pure function
   `parseEmbedParams(search, validTabs)` in NEW `src/shared/embedParams.ts` (mocha-testable;
   media imports it — check-no-mirrors clean):
   - `?tab=<id>` → initial tab, validated against the REAL tab ids (sessions, context, cache,
     history, analytics, patterns, export, import); invalid/absent → default.
   - `?embed=1` (also true/yes) → `document.body.classList.add('embedded')`; CSS hides the
     sidebar-toggle button (VS-Code-era chrome, meaningless inside ai-maestro). Tabs, gear,
     bell, help stay — an embedded observability panel keeps its own navigation.
   Wired in `media/src/dashboard.tsx` BEFORE render (TABS exported from App.tsx for the id list).
3. **The contract documented** — README "Embedding the dashboard" section + posted on
   AgentlensPro#3 so the ai-maestro Claude consumes a named surface, per the reshape-fails-CI
   discipline of that thread. postMessage APIs (height/nav sync) deliberately OUT of v1 —
   nothing consumes them yet; add on request against a named need.

## Phases (≤5 files each; TDD)

1. Parser + tests + wiring: NEW `src/shared/embedParams.ts`, NEW `src/test/embedParams.test.ts`,
   `media/src/App.tsx` (export TABS), `media/src/dashboard.tsx` (parse + apply),
   `media/src/styles/base.css` (embedded chrome rule).
2. Header + docs: `standalone/server.ts` (frame-ancestors on the HTML route), `README.md`,
   `CHANGELOG.md`, this TRDD.
3. Gate (tsc ×2, lint, mirrors, suite) + deploy law + LIVE verify: `curl -sI` shows the CSP
   header; a real iframe page served from a second loopback port loads the dashboard with
   `?embed=1&tab=cache` (chrome-devtools screenshot); then post the contract on #3.

## Approval log
- 2026-08-02 — AI review PASSED (ai_review backlog audit): implementation verified present in the code first-hand, not from prose. Column ai_review → human_review; the remaining gate is the human. Evidence: reports/ai-review-audit/20260802_113252+0200-batchC-security-release.md
- 2026-08-02 — HUMAN gate closed by USER delegation ("evaluate the whole status of the project and decide yourself. just base all decisions on verified facts.", 2026-08-02); the AI audit line above is the verified basis; release-via none/absent → terminal. Column human_review → complete.
