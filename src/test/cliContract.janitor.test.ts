// CLI contract lock for the ai-maestro-janitor consumer (AgentlensPro issue #2).
//
// The janitor's parsers (ai-maestro-janitor scripts/lib/agentlens_probe.py + heartbeat_cadence.py)
// read a NARROW slice of three tools' JSON as fail-open enrichment. A silent rename/reshape of any
// pinned path below would make that enrichment quietly stop working with no error on either side.
// This suite IS the stability contract: it pins the exact field paths the janitor consumes, built
// by the REAL payload builders (no mocks). If a change makes this suite fail, either restore the
// field or post a heads-up on AgentlensPro issue #2 BEFORE shipping, so the janitor's parser moves
// in lockstep.
//
// Pinned contract (verbatim from the issue):
//   get_account_status → cacheTtl.minutes                                (integer)
//   get_burn_status    → global.costPerHour, activeSessions,
//                        topSessions[].workspace, topSessions[].sessionId
//   investigate_burn   → findings[].cause, findings[].shareOfWindow,
//                        findings[].confidence, attribution[].workspace
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { handleGetAccountStatus, labelBurnStatusAccounts } from '../mcpServer'
import { computeBurnStatus, DEFAULT_THRESHOLDS, type ConsumptionEvent, type BurnConfig } from '../burnMonitor'
import { investigateBurn } from '../burnInvestigator'
import type { AccountInfo } from '../accountInfo'
import type { TtlContext } from '../shared/cacheTtl'

const NOW = 1_700_000_000_000
const cfg: BurnConfig = {
  window5hTokens: null, window7dTokens: null, window5hCostUsd: null, window7dCostUsd: null,
  capacitySource: 'none', observed: {}, notify: false, thresholds: { ...DEFAULT_THRESHOLDS },
}
const account: AccountInfo = {
  accountUuid: 'acct-A', email: 'dev@example.com', organizationName: 'Acme', organizationUuid: 'org-1',
  billingType: 'stripe_subscription', hasExtraUsageEnabled: true,
  organizationRateLimitTier: 'tier-4', userRateLimitTier: 'tier-2', displayName: 'Dev',
  planType: 'max', rateLimitTier: 'default_claude_max_20x', label: 'dev@example.com', source: 'claude.json',
}
const ttlCtx: TtlContext = { auth: 'subscription', force5m: false, enable1h: false }
// One session active in the last 5 min so topSessions is non-empty, with workspace attribution.
const EVENTS: ConsumptionEvent[] = [
  { ts: NOW - 1000, sessionId: 'sess-hot', accountUuid: 'acct-A', costUsd: 3, tokens: 3000, workspace: '/tmp/ws', source: 'statusline' },
]

suite('CLI contract lock — ai-maestro-janitor consumed field paths (AgentlensPro#2)', () => {
  test('get_account_status serves cacheTtl.minutes as an integer', () => {
    const burn = computeBurnStatus(EVENTS, [], cfg, NOW)
    const res = handleGetAccountStatus(account, burn, ttlCtx) as { cacheTtl: { minutes: number } }
    assert.strictEqual(typeof res.cacheTtl?.minutes, 'number',
      'CONTRACT BREAK: get_account_status.cacheTtl.minutes is consumed by the janitor TTL-aware heartbeat — post on AgentlensPro#2 before renaming')
    assert.ok(Number.isInteger(res.cacheTtl.minutes))
  })

  test('get_burn_status serves global.costPerHour, activeSessions, topSessions[].{workspace,sessionId}', () => {
    // The CLI-served shape is labelBurnStatusAccounts(computeBurnStatus(...)) — test the composition.
    const res = labelBurnStatusAccounts(computeBurnStatus(EVENTS, [], cfg, NOW), account)
    assert.strictEqual(typeof res.global?.costPerHour, 'number',
      'CONTRACT BREAK: get_burn_status.global.costPerHour is consumed by the janitor burn probe — post on AgentlensPro#2 before renaming')
    assert.strictEqual(typeof res.activeSessions, 'number',
      'CONTRACT BREAK: get_burn_status.activeSessions is consumed by the janitor burn probe')
    assert.ok(res.topSessions.length > 0, 'fixture must produce a hot session')
    assert.strictEqual(typeof res.topSessions[0].sessionId, 'string',
      'CONTRACT BREAK: get_burn_status.topSessions[].sessionId is consumed by the janitor culprit naming')
    assert.strictEqual(typeof res.topSessions[0].workspace, 'string',
      'CONTRACT BREAK: get_burn_status.topSessions[].workspace is consumed by the janitor culprit naming')
  })

  test('investigate_burn serves findings[].{cause,shareOfWindow,confidence} and attribution[].workspace', function () {
    this.timeout(20_000)
    // Minimal real-corpus FORK_STORM trigger (same synthetic shape as burnInvestigator.test.ts):
    // 5 cold full-prefix writes + 5 big requests sharing one inherited transcript.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `al-contract-${process.pid}-`))
    const dir = path.join(root, 'otel-bodies')
    fs.mkdirSync(dir, { recursive: true })
    try {
      const t0 = NOW - 30 * 60_000
      for (let i = 0; i < 5; i++) {
        const rp = path.join(dir, `r${i}.response.json`)
        fs.writeFileSync(rp, JSON.stringify({ body: {
          model: 'claude-opus-4-8',
          usage: { cache_creation_input_tokens: 500_000, cache_read_input_tokens: 0, output_tokens: 100, input_tokens: 5 },
        } }))
        fs.utimesSync(rp, (t0 + i * 60_000) / 1000, (t0 + i * 60_000) / 1000)
        const qp = path.join(dir, `q${i}.request.json`)
        fs.writeFileSync(qp, JSON.stringify({ body: {
          model: 'claude-opus-4-8',
          system: '# Environment\n - Primary working directory: /tmp/contract-ws\n',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'SHARED-PARENT-TRANSCRIPT'.padEnd(3000, 'x') }] }],
        } }) + ' '.repeat(1_200_000))
        fs.utimesSync(qp, (t0 + i * 60_000) / 1000, (t0 + i * 60_000) / 1000)
      }
      const r = investigateBurn({ bodiesDir: dir, hookEventsDir: path.join(root, 'hooks'), untilMs: NOW })
      assert.ok(r.findings.length > 0, `fixture must produce a finding (got none; verdict: ${r.verdict})`)
      const f = r.findings[0]
      assert.strictEqual(typeof f.cause, 'string',
        'CONTRACT BREAK: investigate_burn.findings[].cause is consumed by the janitor cause parser — post on AgentlensPro#2 before renaming')
      assert.strictEqual(typeof f.shareOfWindow, 'number',
        'CONTRACT BREAK: investigate_burn.findings[].shareOfWindow is consumed by the janitor cause parser')
      assert.ok(f.shareOfWindow >= 0 && f.shareOfWindow <= 1, 'shareOfWindow stays in [0,1] per the contract')
      assert.ok(['high', 'medium', 'low'].includes(f.confidence),
        'CONTRACT BREAK: investigate_burn.findings[].confidence is a high/medium/low string per the contract')
      assert.ok(r.attribution.length > 0, 'fixture must produce attribution rows')
      assert.strictEqual(typeof r.attribution[0].workspace, 'string',
        'CONTRACT BREAK: investigate_burn.attribution[].workspace is consumed by the janitor culprit naming')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
