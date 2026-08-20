// Regenerates mcptools-expected.json from the COMPILED TS mcpServer.js — the parity oracle for the
// MCP tool SHAPERS in mcp_tools.rs (TRDD-DMWOBWFH P4x.2).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-mcptools-expected.mjs
//
// The shapers are PURE, so they are driven directly rather than through a live MCP server — a much
// tighter test, and the reason handleGetCallContext is exported.
//
// Discriminators:
//  - the no-body path is an HONEST message carrying back the caller's own ids, with undefined ids
//    OMITTED (never null) — it is not an error and not a spinner (TRDD-ICHAVFCS §6).
//  - the block projection DROPS tokenSource and imposes its OWN key order; passing the context's
//    blocks through unchanged would ship a different wire shape.
//  - totalTokens sums the CONTEXT's own per-block estimates, not a recount.
import { createRequire } from 'module'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
const require = createRequire(import.meta.url)
const { handleGetCallContext, handleGetContextComposition, handleGetContextHistory, handleGetConversation, handleGetWindowBudget, handleGetLifecycleEvents } = require('../../../../../out/test/mcpServer.js')
const { handleGetAccountStatus, windowFillPct } = require('../../../../../out/test/mcpServer.js')
const { describePlan, describeAccountMode } = require('../../../../../out/test/accountStateTimeline.js')
const { loadBurnConfig, gatherConsumptionEvents, computeBurnStatus } = require('../../../../../out/test/burnMonitor.js')
const { buildCallContextFromJson } = require('../../../../../out/test/rawBodyContext.js')
const { buildContextComposition } = require('../../../../../out/test/contextComposition.js')
const { buildContextHistory } = require('../../../../../out/test/contextHistory.js')
const { buildConversation } = require('../../../../../out/test/conversation.js')
process.env.CLAUDE_CONFIG_DIR = new URL('./claude-home', import.meta.url).pathname
const dir = new URL('.', import.meta.url).pathname

const body = {
  model: 'claude-opus-5',
  metadata: { user_id: JSON.stringify({ session_id: 'tool-sess', account_uuid: 'tool-acct' }) },
  system: 'a system prompt',
  tools: [{ name: 'Bash', description: 'run' }],
  messages: [
    { role: 'user', content: [
      { type: 'text', text: 'do it' },
      { type: 'image', source: { media_type: 'image/png', data: 'QUJD'.repeat(8) } },
    ] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
  ],
}
const ctx = buildCallContextFromJson(body, {})
// A resolved context also carries requestId; mimic that without importing resolveCallContext.
const resolved = { ...ctx, requestId: 'req-1' }
const noModel = buildCallContextFromJson({ ...body, model: undefined }, {})

const cases = [
  { name: 'null-context-with-both-ids', ctx: null, args: { sessionId: 's1', requestId: 'r1', spanId: 'sp1' } },
  { name: 'null-context-with-no-ids', ctx: null, args: { sessionId: 's1' } },
  { name: 'full-context', ctx: resolved, args: { sessionId: 's1', requestId: 'req-1' } },
  { name: 'context-without-requestId-or-model', ctx: noModel, args: { sessionId: 's1' } },
]
// ── P4x.2b: composition / history / conversation, over the committed transcripts ──────────────
// Each shaper is fed the SAME engine output the Rust side will get, so the test isolates the
// SHAPER — the engines are already covered by their own parity suites.
//
// Discriminators:
//  - composition `turnCount` is the UNFILTERED total even when `turn` selects one turn; recomputing
//    it after the filter would report 1 for every drill.
//  - the conversation RANGE is clamped to from+CAP-1 even when turnTo asks for more, so a caller
//    cannot widen the window by asking.
//  - history's block drill spreads the block VERBATIM (keeping tokenSource) while the step-level
//    projection DROPS it — same data, two deliberately different shapes.
//  - the whole-session history diff collapses to COUNTS; the id lists live only in the drill.
const composition = await buildContextComposition('comp-own')
const history = await buildContextHistory('hist-main')
const conversation = await buildConversation('conv-main')
if (!composition || !history || !conversation) throw new Error('fixture transcripts did not reconstruct — is CLAUDE_CONFIG_DIR right?')

const compCases = [
  { name: 'whole', comp: composition, args: { sessionId: 'comp-own' } },
  { name: 'one-turn-keeps-unfiltered-turnCount', comp: composition, args: { sessionId: 'comp-own', turn: 2 } },
  { name: 'missing-turn', comp: composition, args: { sessionId: 'comp-own', turn: 999 } },
  { name: 'null', comp: null, args: { sessionId: 'ghost' } },
]
const histCases = [
  { name: 'whole', hist: history, cardModel: 'claude-opus-5', args: { sessionId: 'hist-main' } },
  { name: 'whole-no-card-model', hist: history, cardModel: undefined, args: { sessionId: 'hist-main' } },
  { name: 'one-step', hist: history, cardModel: 'claude-opus-5', args: { sessionId: 'hist-main', turn: 1 } },
  { name: 'one-block-verbatim', hist: history, cardModel: 'claude-opus-5', args: { sessionId: 'hist-main', turn: 1, blockId: 'userMsg:user' } },
  { name: 'missing-block', hist: history, cardModel: 'claude-opus-5', args: { sessionId: 'hist-main', turn: 1, blockId: 'nope:nope' } },
  { name: 'missing-step', hist: history, cardModel: 'claude-opus-5', args: { sessionId: 'hist-main', turn: 999 } },
  { name: 'null', hist: null, cardModel: undefined, args: { sessionId: 'ghost' } },
]
const convCases = [
  { name: 'whole', conv: conversation, args: { sessionId: 'conv-main' } },
  { name: 'one-turn-verbatim', conv: conversation, args: { sessionId: 'conv-main', turn: 2 } },
  { name: 'missing-turn', conv: conversation, args: { sessionId: 'conv-main', turn: 999 } },
  { name: 'range', conv: conversation, args: { sessionId: 'conv-main', turnFrom: 1, turnTo: 3 } },
  { name: 'range-clamped-to-cap', conv: conversation, args: { sessionId: 'conv-main', turnFrom: 1, turnTo: 9999 } },
  { name: 'range-from-only', conv: conversation, args: { sessionId: 'conv-main', turnFrom: 2 } },
  { name: 'null', conv: null, args: { sessionId: 'ghost' } },
]

// ── P4x.2c: get_window_budget, over a REAL computeBurnStatus (not a hand-built stub) ───────────
// Driving the shaper off a stub would let a divergence in what the engine actually emits pass
// unnoticed; the whole point of the shaper test is that it re-projects the engine's OWN output.
//
// Discriminators:
//  - `machineWide` is the POOLED window, deliberately kept alongside the per-account ones.
//  - the accountId filter is TRUTHY-checked, so `''` means unfiltered, not "match the empty id".
//  - the empty-result `message` is SPREAD LAST (it appends) and appears ONLY when an accountId was
//    asked for — an unfiltered call with no windows gets `accounts: []` and no message.
// Reuse the BURN MONITOR's own fixture rather than inventing sessions here: it already carries the
// per-call `timeline` api_request entries the consumption stream is actually built from (card
// totals alone yield ZERO events and a silently empty budget), and it spans three account buckets
// — acct-1111, acct-2222, and the null/unknown one — which is what makes the label branches
// distinguishable. One burn fixture, not two that drift.
const bmCases = JSON.parse(readFileSync(join(dir, 'burnmonitor-cases.json'), 'utf8'))
const burnCfg = loadBurnConfig(bmCases.statusEnv, '/nonexistent-home')
const burnEvents = gatherConsumptionEvents(bmCases.sessions, bmCases.statusline, bmCases.now, bmCases.ttlCtx)
const burnStatus = computeBurnStatus(burnEvents, bmCases.sessions, burnCfg, bmCases.now, bmCases.ttlCtx)
// The CURRENT account is acct-1111, so ITS window labels to the identity while acct-2222 — rotated
// away — can only resolve to its short id, and the null bucket takes the current label (the LOOSE
// `accountUuid == null` arm). A single-account fixture would let all three look alike.
// No address here on purpose: `email` is null so the label falls to `displayName`, exercising the
// SECOND arm of accountLabelFor's `||` chain and keeping an address-shaped literal out of a
// tracked file (the identity guard is shape-based, and a fixture is not worth arguing with it).
const acct = { source: 'claude.json', accountUuid: 'acct-1111', label: 'Display A', email: null, organizationName: 'Org A', organizationUuid: null, displayName: 'Display A', planType: 'max', billingType: 'stripe_subscription', hasExtraUsageEnabled: false, organizationRateLimitTier: null, userRateLimitTier: null, rateLimitTier: null }
// ── P4x.2c: get_account_status ────────────────────────────────────────────────────────────────
// Driven over the SAME real burn status as get_window_budget, so `window` and `usageWindows` are
// computed from data an engine actually produced.
//
// Discriminators:
//  - `usageWindows` prefers Claude Code's OWN rate_limits when present; the Rust core has none
//    (statusline reader NOT PORTED), so the cc-rate-limits case is generated here to pin the shape
//    for when it lands, and the calibrated/none cases are what ship today.
//  - `calibrated-exceeded` is a DISTINCT source from `calibrated`: a passed capacity yields a null
//    pct, and bare `calibrated` + null is indistinguishable from "no data".
//  - the `note` names THREE different causes of a missing percentage apart, and is OMITTED on the
//    happy path (undefined, never null, never '').
//  - windowFillPct is COST-first: raw tokens overstate the fill (~96% of volume is cache reads at
//    0.1x), which is how a 7d window once read 171.51% by tokens and 64.49% by cost.
const acctNoId = { ...acct, accountUuid: null, source: 'claude.json' }
const acctUnresolved = { ...acct, source: 'none' }
const ttlSub = { auth: 'subscription', force5m: false, enable1h: false }
const asCases = [
  { name: 'resolved-account-with-a-window', account: acct, burn: burnStatus, ttl: ttlSub, rl: null },
  { name: 'no-ttl-context-falls-to-billingType', account: acct, burn: burnStatus, ttl: null, rl: null },
  { name: 'unresolved-identity', account: acctUnresolved, burn: burnStatus, ttl: ttlSub, rl: null },
  { name: 'no-account-id-names-that-cause', account: acctNoId, burn: burnStatus, ttl: ttlSub, rl: null },
  { name: 'account-with-no-consumption', account: { ...acct, accountUuid: 'acct-ghost' }, burn: burnStatus, ttl: ttlSub, rl: null },
  { name: 'no-burn-monitor', account: acct, burn: null, ttl: ttlSub, rl: null },
  { name: 'cc-rate-limits-win-over-calibrated', account: acct, burn: burnStatus, ttl: ttlSub, rl: { fiveHourUtilization: 41.5, sevenDayUtilization: null } },
  { name: 'cc-rate-limits-all-null-is-not-preferred', account: acct, burn: burnStatus, ttl: ttlSub, rl: { fiveHourUtilization: null, sevenDayUtilization: null } },
  { name: 'null-account-entirely', account: null, burn: burnStatus, ttl: ttlSub, rl: null },
]
// describePlan / describeAccountMode / windowFillPct get their own table — they are shared with the
// account-state sampler, so one implementation must serve both.
const planCases = [
  ['max', 'default_claude_max_5x'], ['max', null], ['pro', 'anything'], ['team', null], ['enterprise', null],
  ['free', null], [null, 'default_claude_max_20x'], [null, null], ['', 'tier_5x'], ['some_future_plan', 'tier_5x'],
  ['MAX', 'DEFAULT_CLAUDE_MAX_5X'], [null, 'no_multiplier_here'],
]
const modeCases = ['subscription', 'usage-credits', 'api-key', 'unknown', null]
const fillCases = [
  { pctConsumed: 80, pctConsumedCost: 40, capacityExceeded: false },
  { pctConsumed: 80, pctConsumedCost: null, capacityExceeded: false },
  { pctConsumed: 171.51, pctConsumedCost: 64.49, capacityExceeded: false },
  { pctConsumed: 80, pctConsumedCost: 40, capacityExceeded: true },
  { pctConsumed: null, pctConsumedCost: null, capacityExceeded: false },
]

// ── P4x.2c: get_lifecycle_events — the note is the whole reason this has a shaper at all ──────
// Both branches are generated so the note TEXT stays byte-identical across the two engines; the
// happy path proves the key is OMITTED (not null, not '').
const lcEvents = [{ ts: 1, ev: 'SessionStart', kind: 'session_start', session: 'lc-1' }]
const lcCases = [
  { name: 'store-missing-carries-the-note', dir: '/nope/hook-events', dirExists: false, events: lcEvents },
  { name: 'store-present-omits-the-note', dir: '/data/hook-events', dirExists: true, events: lcEvents },
  { name: 'store-present-but-quiet', dir: '/data/hook-events', dirExists: true, events: [] },
]
const wbCases = [
  { name: 'all-accounts', args: {} },
  { name: 'filtered-to-current', args: { accountId: 'acct-1111' } },
  { name: 'filtered-to-rotated-away', args: { accountId: 'acct-2222' } },
  { name: 'filtered-to-unknown-appends-message', args: { accountId: 'acct-ghost' } },
  { name: 'empty-accountId-is-unfiltered', args: { accountId: '' } },
]

const J = (v) => JSON.parse(JSON.stringify(v ?? null))
writeFileSync(join(dir, 'mcptools-expected.json'), JSON.stringify({
  // The Rust test drives the SHAPER over this exact status — `computeBurnStatus` parity is already
  // proven by burnmonitor_parity, so recomputing it there would test the engine twice and the
  // shaper not at all.
  windowBudget: { account: J(acct), status: J(burnStatus) },
  wbCases: J(wbCases),
  wbResults: wbCases.map(c => J(handleGetWindowBudget(burnStatus, acct, c.args))),
  lcCases: J(lcCases),
  lcResults: lcCases.map(c => J(handleGetLifecycleEvents(c.dir, c.dirExists, c.events))),
  asCases: J(asCases),
  asResults: asCases.map(c => J(handleGetAccountStatus(c.account, c.burn, c.ttl, c.rl))),
  planCases: J(planCases),
  planResults: planCases.map(([p, t]) => describePlan(p, t)),
  modeCases: J(modeCases),
  modeResults: modeCases.map(m => describeAccountMode(m)),
  fillCases: J(fillCases),
  fillResults: fillCases.map(w => J(windowFillPct(w))),
  cases: J(cases),
  results: cases.map(c => J(handleGetCallContext(c.ctx, c.args))),
  compCases: J(compCases),
  compResults: compCases.map(c => J(handleGetContextComposition(c.comp, c.args))),
  histCases: J(histCases),
  histResults: histCases.map(c => J(handleGetContextHistory(c.hist, c.cardModel ? { model: c.cardModel } : undefined, c.args))),
  convCases: J(convCases),
  convResults: convCases.map(c => J(handleGetConversation(c.conv, c.args))),
}, null, 1))
console.log(`mcptools-expected.json: ${cases.length} callcontext + ${compCases.length} composition + ${histCases.length} history + ${convCases.length} conversation cases`)
