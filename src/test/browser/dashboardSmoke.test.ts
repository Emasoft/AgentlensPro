/// <reference lib="dom" />
// P9 — dashboard browser smoke suite (real server + real Chrome, no mocks).
//
// Boots the REAL built standalone/server.js on EPHEMERAL ports with an isolated
// HOME + DATA_DIR (never the resident ~/.agentlens instance on 4318/3000/4316),
// seeds three Claude Code sessions through the REAL log-ingest path (JSONL
// transcripts in the isolated HOME, same line shapes the logReader unit tests
// pin), then drives the served dashboard with puppeteer-core against a locally
// installed Chrome/Chromium.
//
// Gated behind AGENTLENSPRO_BROWSER_TESTS=1 so the default `npx mocha` run is
// unaffected; skips honestly when no Chrome binary can be resolved (CHROME_PATH
// env or the standard macOS/Linux install locations).
//
// Every page and process opened here is closed in a finally/teardown — the
// suite must leave zero orphan Chrome or server processes behind.
import * as assert from 'assert'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import type { AddressInfo } from 'net'
// puppeteer-core ≥24 is ESM-only: this suite compiles to CommonJS (tsconfig.test.json,
// module Node16), so the runtime module is loaded with a real dynamic import() in
// suiteSetup and the types come in through a resolution-mode type-only import.
import type { Browser, Page } from 'puppeteer-core' with { 'resolution-mode': 'import' }

const ENABLED = process.env['AGENTLENSPRO_BROWSER_TESTS'] === '1'

// out/test/test/browser/*.js → repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const SERVER_JS = path.join(REPO_ROOT, 'standalone', 'server.js')
// Screenshots land in the gitignored reports/ tree (never committed — see .gitignore /reports/).
const SCREENSHOT_DIR = path.join(REPO_ROOT, 'reports', 'screenshots')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── Chrome/Chromium resolution ────────────────────────────────────────────────
// puppeteer-core ships no browser: resolve a local executable from CHROME_PATH
// or the standard install locations. Returning null → the suite skips honestly.
function resolveChrome(): string | null {
  const envPath = process.env['CHROME_PATH']
  if (envPath && fs.existsSync(envPath)) return envPath
  const candidates = [
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}

// ── Tiny HTTP client (same pattern as serverEndpoints.test.ts) ────────────────
interface HttpResult { status: number; text: string; json: unknown }
function httpReq(port: number, method: string, urlPath: string, body?: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const req = http.request(
      {
        host: '127.0.0.1', port, method, path: urlPath,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8')
          let json: unknown = null
          if (text) { try { json = JSON.parse(text) } catch { json = null } }
          resolve({ status: res.statusCode ?? 0, text, json })
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

// 4318 is the CANONICAL OTLP port: a server booted there considers itself the
// machine-wide instance (pidfile + global config writes). The harness must never
// look canonical, so re-roll the one poisoned value the OS could hand us.
async function ephemeralPort(): Promise<number> {
  for (;;) {
    const p = await freePort()
    if (p !== 4318) return p
  }
}

// ── Claude JSONL fixtures (real transcript line shapes) ───────────────────────
// The same minimal-but-real row shapes the logReader unit tests pin (user text
// row, assistant rows with model + usage, tool_use/tool_result pair). Written
// into the isolated HOME's ~/.claude/projects/ BEFORE the server boots so the
// first log scan ingests them through the production path — no mocked internals.
// `title`/`entrypoint` (optional) emit the ai-title record + top-level entrypoint field so the
// card-enrichment path (TRDD-B22NYTOY P4) is exercised end-to-end: the session row must headline
// the TITLE (the prompt moves to the tooltip), and the Transcript header must badge the entrypoint.
interface FixtureSession { sessionId: string; prompt: string; model: string; title?: string; entrypoint?: string }

const FIXTURES: FixtureSession[] = [
  { sessionId: `p9-smoke-alpha-${process.pid}`, prompt: 'P9 fixture alpha — browser smoke seed', model: 'claude-opus-4-8' },
  { sessionId: `p9-smoke-beta-${process.pid}`, prompt: 'P9 fixture beta — dashboard render check', model: 'claude-sonnet-5' },
  { sessionId: `p9-smoke-gamma-${process.pid}`, prompt: 'P9 fixture gamma — session list card', model: 'claude-sonnet-5' },
  { sessionId: `p9-smoke-delta-${process.pid}`, prompt: 'P9 fixture delta — transcript narrative seed', model: 'claude-sonnet-5', title: 'p9-delta-titled-session', entrypoint: 'cli' },
]

function claudeSessionJsonl(fx: FixtureSession, cwd: string, baseMs: number, tokens: number): string {
  const ts = (offsetMs: number): string => new Date(baseMs + offsetMs).toISOString()
  const usage = (n: number) => ({
    input_tokens: n, output_tokens: Math.round(n / 2),
    cache_read_input_tokens: n * 4, cache_creation_input_tokens: n,
  })
  const rows: unknown[] = [
    // entrypoint rides as a top-level field on ordinary records (first wins in the parser).
    { type: 'user', timestamp: ts(0), sessionId: fx.sessionId, cwd, message: { content: fx.prompt }, ...(fx.entrypoint ? { entrypoint: fx.entrypoint } : {}) },
    ...(fx.title ? [{ type: 'ai-title', timestamp: ts(500), sessionId: fx.sessionId, aiTitle: fx.title }] : []),
    {
      type: 'assistant', timestamp: ts(1_500), sessionId: fx.sessionId, cwd,
      message: {
        id: `msg-${fx.sessionId}-1`, model: fx.model, usage: usage(tokens),
        content: [{ type: 'text', text: 'Looking into it.' }],
      },
    },
    {
      type: 'assistant', timestamp: ts(2_500), sessionId: fx.sessionId, cwd,
      message: {
        id: `msg-${fx.sessionId}-2`, model: fx.model, usage: usage(tokens + 40),
        content: [{ type: 'tool_use', id: `tu-${fx.sessionId}-1`, name: 'Read', input: { file_path: path.join(cwd, 'README.md') } }],
      },
    },
    {
      type: 'user', timestamp: ts(3_000), sessionId: fx.sessionId, cwd,
      message: { content: [{ type: 'tool_result', tool_use_id: `tu-${fx.sessionId}-1`, content: 'file body' }] },
    },
    {
      type: 'assistant', timestamp: ts(4_200), sessionId: fx.sessionId, cwd,
      message: {
        id: `msg-${fx.sessionId}-3`, model: fx.model, usage: usage(tokens + 80),
        content: [{ type: 'text', text: 'Done — summary written.' }],
      },
    },
  ]
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

// Tab ids ↔ the content-root element each tab mounts (media/src/App.tsx TABS +
// the per-tab root ids in media/src/tabs/*.tsx).
const TAB_CONTENT: Array<{ id: string; contentSel: string }> = [
  { id: 'sessions', contentSel: '#sessions-content' },
  { id: 'context', contentSel: '#summary-context-content' },
  { id: 'cache', contentSel: '#summary-cache-content' },
  { id: 'history', contentSel: '#summary-history-content' },
  { id: 'analytics', contentSel: '#analytics-content' },
  { id: 'patterns', contentSel: '#patterns-content' },
  { id: 'export', contentSel: '#export-content' },
  { id: 'import', contentSel: '#import-content' },
]

;(ENABLED ? suite : suite.skip)('dashboard browser smoke (real server + real Chrome)', () => {
  let child: ChildProcess | undefined
  let browser: Browser | undefined
  const openPages: Page[] = []
  let uiPort = 0
  let tmpDir = ''
  let logBuf = ''
  const shotStamp = new Date().toISOString().replace(/[:.]/g, '-')

  function attachErrorCollector(page: Page): string[] {
    const errors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`) })
    page.on('pageerror', (err) => errors.push(`pageerror: ${String(err)}`))
    return errors
  }

  async function newPage(theme: 'light' | 'dark'): Promise<{ page: Page; errors: string[] }> {
    assert.ok(browser, 'browser must be launched')
    const page = await browser.newPage()
    openPages.push(page)
    const errors = attachErrorCollector(page)
    await page.setViewport({ width: 1400, height: 900 })
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }])
    await page.goto(`http://127.0.0.1:${uiPort}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    // The app is mounted once the tab bar exists.
    await page.waitForSelector('button.tab[data-tab="sessions"]', { timeout: 20_000 })
    return { page, errors }
  }

  async function hookConfig(): Promise<{ captureEnabled: boolean; gateEnabled: boolean; gateMode: string; advisorEnabled: boolean }> {
    const r = await httpReq(uiPort, 'GET', '/api/hook-config')
    assert.strictEqual(r.status, 200)
    return (r.json as { config: { captureEnabled: boolean; gateEnabled: boolean; gateMode: string; advisorEnabled: boolean } }).config
  }

  suiteSetup(async function () {
    this.timeout(120_000)

    const chromePath = resolveChrome()
    if (!chromePath) {
      // Honest skip: the suite needs a real local Chrome/Chromium. Point CHROME_PATH at one to run it.
      // eslint-disable-next-line no-console
      console.log('[browser-smoke] SKIPPED — no Chrome/Chromium executable found (set CHROME_PATH or install Google Chrome/Chromium)')
      this.skip()
      return
    }

    // ── Isolated server workspace: temp HOME (log scan sees ONLY our fixtures),
    // temp DATA_DIR, ephemeral ports (non-4318 OTLP ⇒ non-canonical ⇒ no pidfile,
    // no global config writes — the resident real-data server is never touched).
    const [otlp, ui, mcp] = [await ephemeralPort(), await ephemeralPort(), await ephemeralPort()]
    uiPort = ui
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-browser-'))
    const home = path.join(tmpDir, 'home')
    const data = path.join(tmpDir, 'data')
    const claudeProjects = path.join(home, '.claude', 'projects', 'p9-smoke-project')
    const workspace = path.join(tmpDir, 'workspace')
    fs.mkdirSync(claudeProjects, { recursive: true })
    fs.mkdirSync(data, { recursive: true })
    fs.mkdirSync(workspace, { recursive: true })

    // Seed the fixture transcripts BEFORE boot so the first poll scan ingests them.
    const now = Date.now()
    FIXTURES.forEach((fx, i) => {
      const baseMs = now - (i + 1) * 60_000  // one/two/three minutes ago — inside every time preset
      fs.writeFileSync(path.join(claudeProjects, `${fx.sessionId}.jsonl`), claudeSessionJsonl(fx, workspace, baseMs, 100 + i * 50))
    })

    const env = { ...process.env } as NodeJS.ProcessEnv
    // Kill inherited overrides that would point the log scan at REAL machine data.
    delete env['AGENTLENS_GATE']
    delete env['AGENTLENS_GATE_MODE']
    delete env['XDG_CONFIG_HOME']
    delete env['CODEX_HOME']
    Object.assign(env, {
      HOME: home,
      // Explicit override (comma-list of Claude config dirs) beats any inherited value.
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      DATA_DIR: data,
      OTLP_PORT: String(otlp),
      UI_PORT: String(ui),
      MCP_PORT: String(mcp),
      BIND_HOST: '127.0.0.1',
      AGENTLENS_NO_TELEMETRY_CONFIG: '1',
      AGENTLENS_OPEN_BROWSER: '0',
    })

    assert.ok(fs.existsSync(SERVER_JS), `standalone/server.js missing — run \`node esbuild.js\` first (${SERVER_JS})`)
    child = spawn(process.execPath, [SERVER_JS], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.on('data', (d: Buffer) => { logBuf += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { logBuf += d.toString() })

    // Wait for the HTTP surface, then for the log scan to surface ALL fixture cards
    // (poll cadence is 5s — the summary is the same payload the dashboard renders).
    const deadline = Date.now() + 60_000
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited early (code=${child.exitCode})\n${logBuf.slice(-2000)}`)
      try {
        const r = await httpReq(ui, 'GET', '/api/server-stats')
        if (r.status === 200) break
      } catch { /* not listening yet */ }
      if (Date.now() > deadline) throw new Error(`server not ready within 60s\n${logBuf.slice(-2000)}`)
      await sleep(250)
    }
    for (;;) {
      const r = await httpReq(ui, 'GET', '/api/summary')
      const sessions = ((r.json as { sessions?: Array<{ sessionId?: string }> })?.sessions) ?? []
      const ids = new Set(sessions.map((s) => s.sessionId))
      if (FIXTURES.every((f) => ids.has(f.sessionId))) break
      if (Date.now() > deadline) {
        throw new Error(`fixture sessions not ingested within 60s (have: ${[...ids].join(', ')})\n${logBuf.slice(-2000)}`)
      }
      await sleep(500)
    }

    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
    const { default: puppeteer } = await import('puppeteer-core')
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,  // HARD requirement: never open a visible window in tests
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    })
  })

  suiteTeardown(async function () {
    this.timeout(30_000)
    // Zero-orphan contract: close every page, then the browser, then the server —
    // each step guarded so one failure never leaks the rest.
    try {
      await Promise.all(openPages.map((p) => p.close().catch(() => { /* already closed */ })))
    } finally {
      try {
        if (browser) {
          const proc = browser.process()
          await browser.close()
          // Belt + braces: if Chromium ignored close(), kill it outright.
          if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
        }
      } finally {
        try {
          if (child && child.exitCode === null && child.signalCode === null) {
            const closed = new Promise<void>((res) => child?.on('close', () => res()))
            child.kill('SIGTERM')
            const graceful = await Promise.race([closed.then(() => true), sleep(5_000).then(() => false)])
            if (!graceful) { child.kill('SIGKILL'); await closed }
          }
          if (child) {
            assert.ok(child.exitCode !== null || child.signalCode !== null, 'server child must have exited')
          }
        } finally {
          try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
        }
      }
    }
  })

  // One full render pass per theme: load, mount, walk EVERY main tab, verify the
  // session list carries exactly one card per fixture, screenshot, and require
  // zero console errors across the whole pass. The app ships a fixed dark
  // variable shim (no data-theme machinery), so the light/dark contract here is
  // "renders cleanly under both emulated prefers-color-scheme values".
  for (const theme of ['dark', 'light'] as const) {
    test(`${theme} theme — dashboard loads, every main tab renders, one card per fixture session, zero console errors`, async function () {
      this.timeout(90_000)
      const { page, errors } = await newPage(theme)

      // Every main tab mounts its content root when activated.
      for (const t of TAB_CONTENT) {
        await page.click(`button.tab[data-tab="${t.id}"]`)
        await page.waitForSelector(t.contentSel, { timeout: 15_000 })
      }

      // Back to Sessions: exactly ONE row per fixture session (no dupes, no merges).
      await page.click('button.tab[data-tab="sessions"]')
      await page.waitForSelector('#sessions-content table tbody tr', { timeout: 15_000 })
      const rowCount = await page.$$eval('#sessions-content table > tbody > tr', (rows) => rows.length)
      assert.strictEqual(rowCount, FIXTURES.length, `expected ${FIXTURES.length} session rows, got ${rowCount}`)
      for (const fx of FIXTURES) {
        // A titled fixture headlines its ai-title (the prompt moves to the tooltip attribute,
        // which textContent does not include) — so the visible needle is title ?? prompt.
        const needle = fx.title ?? fx.prompt
        const occurrences = await page.evaluate((n: string) => {
          const el = document.querySelector('#sessions-content')
          const text = el && el.textContent ? el.textContent : ''
          return text.split(n).length - 1
        }, needle)
        assert.strictEqual(occurrences, 1, `headline "${needle}" must appear exactly once in the session list, found ${occurrences}`)
      }

      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `p9-dashboard-${theme}-${shotStamp}.png`) as `${string}.png` })
      assert.deepStrictEqual(errors, [], `zero console errors expected (${theme}):\n${errors.join('\n')}`)
      await page.close()
    })
  }

  // Transcript sub-tab (TRDD-B22NYTOY): expand the TITLED fixture session and open its Transcript.
  // The view fetches /api/conversation/:id, whose builder re-parses the fixture .jsonl from the
  // isolated HOME — so this exercises parser → endpoint → dashboard end-to-end. Verified content:
  // the verbatim user prompt (open text block), the assistant reply, a collapsed tool row, and the
  // entrypoint badge from the card-enrichment signals. One pass per theme, screenshot each.
  for (const theme of ['dark', 'light'] as const) {
    test(`${theme} theme — Transcript sub-tab renders the conversation narrative`, async function () {
      this.timeout(90_000)
      const fx = FIXTURES.find((f) => f.title)!
      const { page, errors } = await newPage(theme)

      // Expand the titled fixture's row (click the row whose headline carries the title).
      await page.click('button.tab[data-tab="sessions"]')
      await page.waitForSelector('#sessions-content table tbody tr', { timeout: 15_000 })
      const clicked = await page.evaluate((needle: string) => {
        const rows = Array.from(document.querySelectorAll('#sessions-content table tbody tr'))
        const row = rows.find((r) => (r.textContent ?? '').includes(needle)) as HTMLElement | undefined
        if (row) { row.click(); return true }
        return false
      }, fx.title!)
      assert.ok(clicked, `session row headlined "${fx.title}" must exist`)

      // The detail nav mounts with the Transcript button; click it by its label text.
      // Poll from the TEST side (each page.evaluate is a fresh renderer task): headless Chrome
      // parks an idle page — in-page rAF-polled waitForFunction generates no renderer activity, so
      // both Preact's deferred effects AND fetch-response delivery can stall ~25s (measured; the
      // server answered external curl in 0.03s at 0% CPU throughout — purely a renderer stall).
      const pollFor = async (fn: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> => {
        const t0 = Date.now()
        while (!(await fn())) {
          if (Date.now() - t0 > timeoutMs) assert.fail(`timed out waiting for ${what}`)
          await sleep(500)
        }
      }
      await pollFor(() => page.evaluate(() =>
        Array.from(document.querySelectorAll('button')).some((b) => (b.textContent ?? '').trim() === 'Transcript')), 'Transcript nav button')
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === 'Transcript') as HTMLElement
        btn.click()
      })

      // Wait on the LAST turn's text — the prompt alone false-passes (the SessionDetail header
      // above the nav shows userRequest regardless of which section is active).
      await pollFor(() => page.evaluate(() => (document.body.textContent ?? '').includes('Done — summary written.')), 'transcript turns')
      const bodyText = await page.evaluate(() => document.body.textContent ?? '')
      assert.ok(bodyText.includes(fx.prompt), 'verbatim user prompt must render as an open text block')
      assert.ok(bodyText.includes('→ Read'), 'collapsed tool-use row must render')
      // Badge check by EXACT span text — a bare substring test ("cli") would false-pass on "click".
      const badge = await page.evaluate((ep: string) =>
        Array.from(document.querySelectorAll('span')).some((s) => (s.textContent ?? '').trim() === ep), fx.entrypoint!)
      assert.ok(badge, `entrypoint badge "${fx.entrypoint}" must render in the transcript header`)

      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `p9-transcript-${theme}-${shotStamp}.png`) as `${string}.png` })
      assert.deepStrictEqual(errors, [], `zero console errors expected (${theme} transcript):\n${errors.join('\n')}`)
      await page.close()
    })
  }

  test('hook-switches card round-trips against /api/hook-config (UI flip ⇒ server state ⇒ UI label)', async function () {
    this.timeout(90_000)
    const { page, errors } = await newPage('dark')

    // Fresh DATA_DIR ⇒ the server reports the compiled defaults before any flip.
    assert.strictEqual((await hookConfig()).captureEnabled, true, 'precondition: captureEnabled defaults to true')

    // The hook-switches card lives in the Settings side panel (gear button).
    await page.click('button[title="Settings — Alerts & Automation"]')
    await page.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll('strong'))
      return cards.some((s) => (s.textContent ?? '').trim() === 'Hook switches')
    }, { timeout: 15_000 })
    await sleep(400) // let the slide-in transition land before clicking inside the panel

    // Locate the "Lifecycle capture" toggle by its row label — never by index, so
    // reordering the card can't silently flip the wrong switch.
    const clickCaptureToggle = async (): Promise<void> => {
      const flipped = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('label.toggle-switch'))
        for (const label of rows) {
          const row = label.parentElement
          if (row && (row.textContent ?? '').includes('Lifecycle capture')) {
            const input = label.querySelector('input[type="checkbox"]') as HTMLInputElement | null
            if (input) { input.click(); return true }
          }
        }
        return false
      })
      assert.ok(flipped, 'Lifecycle capture toggle must exist in the Hook switches card')
    }
    const captureLabel = (): Promise<string> => page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('label.toggle-switch'))
      for (const label of rows) {
        const row = label.parentElement
        if (row && (row.textContent ?? '').includes('Lifecycle capture')) {
          const el = label.querySelector('.toggle-label')
          return el && el.textContent ? el.textContent.trim() : ''
        }
      }
      return ''
    })

    // OFF: the UI POST must land on the server, and the card re-renders from the
    // server's response body (the card never updates optimistically).
    await clickCaptureToggle()
    const offDeadline = Date.now() + 10_000
    while ((await hookConfig()).captureEnabled !== false) {
      if (Date.now() > offDeadline) assert.fail('server /api/hook-config never reported captureEnabled=false after the UI flip')
      await sleep(200)
    }
    const labelOff = Date.now() + 5_000
    while ((await captureLabel()) !== 'Off') {
      if (Date.now() > labelOff) assert.fail(`UI label must show "Off" after the server confirmed the flip (got "${await captureLabel()}")`)
      await sleep(100)
    }
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `p9-hook-switches-${shotStamp}.png`) as `${string}.png` })

    // Back ON: full round-trip restores the default.
    await clickCaptureToggle()
    const onDeadline = Date.now() + 10_000
    while ((await hookConfig()).captureEnabled !== true) {
      if (Date.now() > onDeadline) assert.fail('server /api/hook-config never reported captureEnabled=true after the second UI flip')
      await sleep(200)
    }
    const labelOn = Date.now() + 5_000
    while ((await captureLabel()) !== 'On') {
      if (Date.now() > labelOn) assert.fail(`UI label must show "On" after the restore flip (got "${await captureLabel()}")`)
      await sleep(100)
    }

    assert.deepStrictEqual(errors, [], `zero console errors expected during the hook round-trip:\n${errors.join('\n')}`)
    await page.close()
  })
})
