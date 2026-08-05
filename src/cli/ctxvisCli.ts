// src/cli/ctxvisCli.ts — `agentlenspro ctxvis`: what a spawned agent puts in its context, how that
// changed on its SECOND turn, and whether the change broke the prompt-cache prefix.
//
// The analysis lives in src/ctxVisual.ts; this file is argument handling, orchestration and output.
//
// WHY --measured TAKES A PER-AGENT NONCE. The obvious design is one nonce for the whole run. It does
// not work: with four agents spawned under one marker, every agent's turn 1 has the same message
// count, so there is no turn ordering at all and selectTurns can only report the ambiguity. One
// nonce per agent keeps each agent's turn sequence independent, which is why the flag pairs them:
// `--measured <agent>=<nonce>`. The separator is `=` and not `:` because plugin-namespaced agent
// names already contain a colon (`ai-maestro-janitor:janitor-repair-agent`).

import * as fs from 'fs'
import * as path from 'path'
import { resolveDataDir } from '../dataDir'
import { resolveBodiesReadScope } from '../captureConfig'
import {
  resolveAnthropicAuth, countTokensExact, countConcurrency, API_VERSION, type CountableRequest,
} from '../exactTokens'
import { openCountCache } from '../countCache'
import { loadAndAnalyze, exactifyReport, checkFreshness, type CtxReport } from './ctxmapCli'
import {
  selectTurns, listRequestCaptures, divergence, measureCommonPrefix, cacheVerdict, assertNonce,
  loadBaselines, saveBaselines, validateBaselines, BASE_AGENTS,
  type CapturedTurn, type CacheVerdict, type EnvFingerprint, type BaselineEntry,
} from '../ctxVisual'
import { readBody, type ResponseBody } from '../capturedBody'
import { renderCtxVisHtml, type HtmlReport } from '../ctxVisualHtml'
import { EXIT, UsageError } from './cliErrors'
import { flagValue } from './argHelpers'

export const CTXVIS_USAGE = `agentlenspro ctxvis — what an agent puts in context, and what its 2nd turn costs

  ctxvis --measured <agent>=<nonce> [--measured ...] [--subject <agent>]
                                   analyse the captures of already-spawned agent(s)
  ctxvis --estimate --subject <a>  what a run would spawn, and what it would cost
  ctxvis --reuse-last              re-render the previous run without spawning anything

  --subject <agent>   the agent under test (the others are baselines)
  --turns N           how many turns to analyse (default 2)
  --refresh-baselines re-measure the base agents even if a cached baseline looks fresh
  --refresh-counts    ignore cached count_tokens results and re-measure every element
  --stale-ok          use a baseline whose environment no longer matches (warns loudly)
  --baselines FILE    override the baseline store path
  --html FILE         write the self-contained visual report
  --out FILE          write the full text report to FILE; print only a one-line digest
  --json              machine-readable output
  --estimate          print the spawn plan and its cost, then exit (makes no API calls)

Spawning is the skill's job (/agentlenspro-visualize-context) — this command only reads what the
spawn left behind. Every number that says "measured" came from count_tokens; nothing is estimated.`

const dataDir = (): string => resolveDataDir().dir
const bodyDirs = (): string[] => resolveBodiesReadScope(dataDir(), process.env).dirs
const fmt = (n: number): string => n.toLocaleString('en-US')

/** Rough per-agent input cost of a spawn, used ONLY for the pre-flight estimate. Deliberately coarse
 *  and labelled as such — the point is to warn before a $1 spend, not to bill anyone. */
const SPAWN_ESTIMATE_TOKENS: Record<string, number> = {
  Explore: 88_000, Plan: 88_000, 'general-purpose': 182_000,
}
const DEFAULT_SPAWN_TOKENS = 95_000
/** opus-5 cache-WRITE at the 5m tier ($6.25/MTok). A fresh subagent is always 5m. */
const WRITE_5M_PER_TOKEN = 6.25 / 1_000_000

interface AgentMeasurement {
  agent: string
  isSubject: boolean
  fromBaseline: boolean
  baselineNote?: string
  turns: { file: string; total: number; report: CtxReport }[]
  verdict: CacheVerdict | null
  note?: string
}

/** Project the internal measurements onto the renderer's input shape. Kept as an explicit mapping
 *  rather than handing the renderer the internals, so a change to either side is a type error here
 *  instead of a silently blank panel in the report. */
export function toHtmlReport(ms: AgentMeasurement[], warnings: string[]): HtmlReport {
  return {
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    warnings,
    agents: ms.map(m => ({
      agent: m.agent,
      isSubject: m.isSubject,
      fromBaseline: m.fromBaseline,
      note: m.note,
      turns: m.turns.map(t => ({
        total: t.total,
        elements: t.report.elements.map(e => ({ label: e.label, tokens: e.tokens, full: e.full })),
      })),
      verdict: m.verdict && {
        kind: m.verdict.divergence.kind,
        headline: m.verdict.divergence.kind === 'break'
          ? `PREFIX BROKEN at ${m.verdict.divergence.tier}[${m.verdict.divergence.index}]`
          : m.verdict.divergence.kind === 'append'
            ? 'prefix intact — only the new tail is written'
            : 'identical requests',
        detail: m.verdict.divergence.label,
        predictedSurviving: m.verdict.predictedSurviving,
        predictedRewritten: m.verdict.predictedRewritten,
        actualCacheRead: m.verdict.actualCacheRead,
        actualCacheWrite: m.verdict.actualCacheWrite,
        actualCostUsd: m.verdict.actualCostUsd,
        agreement: m.verdict.agreement,
        agreementNote: m.verdict.agreementNote,
      },
    })),
  }
}

/** The response captured for a request, if one is on disk. Named `req_<id>.response.json` beside the
 *  request; when absent the verdict simply has no billing half and says so. */
function findResponseFor(turn: CapturedTurn): ResponseBody | null {
  const dir = path.dirname(turn.file)
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return null }
  const reqMtime = turn.mtimeMs
  let best: { body: ResponseBody; dt: number } | null = null
  for (const n of names) {
    if (!n.endsWith('.response.json')) continue
    const p = path.join(dir, n)
    let st: fs.Stats
    try { st = fs.statSync(p) } catch { continue }
    const dt = st.mtimeMs - reqMtime
    // A response necessarily lands AFTER its request. Take the nearest one after it, within a
    // generous window. This is a heuristic and is treated as one: it feeds only the "what was
    // actually billed" half, which the verdict cross-checks against the prediction rather than
    // trusting. If it picked the wrong response the disagreement is visible, not silent.
    if (dt < 0 || dt > 10 * 60_000) continue
    if (!best || dt < best.dt) {
      try { best = { body: readBody(p) as ResponseBody, dt } } catch { /* unreadable — skip */ }
    }
  }
  return best?.body ?? null
}

/** Fingerprint the environment from a freshly-measured report, so cached baselines can be checked
 *  against the world the subject was actually measured in. */
export function fingerprintFrom(report: CtxReport): EnvFingerprint {
  const sum = (pred: (label: string) => boolean): number =>
    report.elements.filter(e => pred(e.label)).reduce((a, e) => a + e.tokens, 0)
  return {
    claudeCodeVersion: null, // not present in a captured body; version drift is caught by the sizes
    projectDir: process.cwd(),
    claudeMdTokens: sum(l => l === 'file:CLAUDE.md' || l === 'file:CLAUDE.md:'),
    rulesTokens: sum(l => l.startsWith('file:') && l !== 'file:CLAUDE.md' && l !== 'file:CLAUDE.md:'),
    mcpSchemaTokens: sum(l => l.startsWith('tool:mcp__')),
    skillListingTokens: sum(l => l === 'skill-listing' || l === 'agent-listing'),
  }
}

function parseMeasured(argv: string[]): { agent: string; nonce: string }[] {
  const out: { agent: string; nonce: string }[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--measured') continue
    const v = argv[i + 1]
    // UsageError, not Error: these ARE caller mistakes, and the catch below now distinguishes them
    // from a runtime failure so only one of the two claims the command line was wrong.
    if (!v || v.startsWith('--')) throw new UsageError('--measured needs <agent>=<nonce>')
    const eq = v.lastIndexOf('=')
    if (eq <= 0 || eq === v.length - 1) {
      throw new UsageError(`--measured must be <agent>=<nonce>, got "${v}"`)
    }
    const nonce = v.slice(eq + 1)
    assertNonce(nonce) // a short marker matches unrelated captures — see assertNonce
    out.push({ agent: v.slice(0, eq), nonce })
  }
  return out
}

function renderEstimate(subject: string | undefined, storePath: string, refresh: boolean): string {
  const store = loadBaselines(storePath)
  const verdicts = validateBaselines(store, {
    // With no fresh capture yet we cannot detect DRIFT, only ABSENCE. Say exactly that rather than
    // implying the cached baselines have been checked.
    claudeCodeVersion: null, projectDir: null,
    claudeMdTokens: NaN, rulesTokens: NaN, mcpSchemaTokens: NaN, skillListingTokens: NaN,
  })
  const need = verdicts.filter(v => refresh || v.state === 'missing').map(v => v.agent)
  const toSpawn = [...(subject ? [subject] : []), ...need]
  const tokens = toSpawn.reduce((a, n) => a + (SPAWN_ESTIMATE_TOKENS[n] ?? DEFAULT_SPAWN_TOKENS), 0)
  const usd = tokens * WRITE_5M_PER_TOKEN

  const lines = ['ctxvis — spawn plan', '']
  if (subject) lines.push(`  subject    ${subject}  (always spawned — a new agent has no captures to read)`)
  for (const v of verdicts) {
    const mark = need.includes(v.agent) ? 'SPAWN' : 'cached'
    lines.push(`  baseline   ${v.agent.padEnd(18)} ${mark}`)
  }
  lines.push('')
  lines.push(`  ${toSpawn.length} spawn(s), ~${fmt(tokens)} input tokens, ~$${usd.toFixed(2)}`)
  lines.push('  (rough: a subagent is always the 5m cache-write tier; the report bills the real numbers)')
  if (!refresh && need.length < BASE_AGENTS.length) {
    lines.push('')
    lines.push('  Cached baselines are re-validated AFTER the subject is measured — if the environment')
    lines.push('  moved (CLAUDE.md, rules, MCP schemas, the skill listing) they are refreshed then.')
  }
  return lines.join('\n')
}

function renderReport(ms: AgentMeasurement[], warnings: string[]): string {
  const L: string[] = []
  L.push('ctxvis — agent context, turn 1 vs turn 2', '')
  for (const w of warnings) L.push(`  ! ${w}`)
  if (warnings.length) L.push('')

  for (const m of ms) {
    const tag = m.isSubject ? ' (subject)' : m.fromBaseline ? ' (cached baseline)' : ''
    L.push(`── ${m.agent}${tag} ${'─'.repeat(Math.max(0, 56 - m.agent.length - tag.length))}`)
    if (m.note) L.push(`   ${m.note}`)
    m.turns.forEach((t, i) => {
      L.push(`   turn ${i + 1}   ${fmt(t.total).padStart(9)} tokens   ${t.report.elements.length} elements` +
        (t.file ? `   ${path.basename(t.file)}` : ''))
    })
    const v = m.verdict
    if (v) {
      const d = v.divergence
      const head = d.kind === 'append'
        ? 'PREFIX INTACT — turn 1 survives byte-exact; only the new tail is written'
        : d.kind === 'identical'
          ? 'identical requests'
          : `PREFIX BROKEN at ${d.tier}[${d.index}] — everything from there is re-written`
      L.push('', `   ${head}`)
      L.push(`   ${d.label}`)
      if (v.predictedSurviving != null) {
        L.push(`   predicted   surviving ${fmt(v.predictedSurviving)}` +
          (v.predictedRewritten != null ? `   rewritten ${fmt(v.predictedRewritten)}` : ''))
      }
      if (v.actualCacheRead != null) {
        const tier = v.actual1h ? `1h ${fmt(v.actual1h)}` : v.actual5m ? `5m ${fmt(v.actual5m)}` : 'tier n/a'
        L.push(`   billed      cache_read ${fmt(v.actualCacheRead)}   write ${fmt(v.actualCacheWrite ?? 0)} (${tier})` +
          (v.actualCostUsd != null ? `   $${v.actualCostUsd.toFixed(4)}` : ''))
      }
      L.push(`   ${v.agreement === 'agree' ? '✓' : v.agreement === 'shortfall-within-tolerance' ? '✓' : '?'} ${v.agreementNote}`)
    }
    L.push('')
  }

  const subject = ms.find(m => m.isSubject)
  if (subject && ms.length > 1) {
    L.push('── comparison ' + '─'.repeat(48))
    const t1 = (m: AgentMeasurement): number => m.turns[0]?.total ?? 0
    const sorted = [...ms].sort((a, b) => t1(a) - t1(b))
    for (const m of sorted) {
      const delta = t1(m) - t1(subject)
      const rel = m.isSubject ? '' : delta > 0 ? `  +${fmt(delta)} vs subject` : `  ${fmt(delta)} vs subject`
      L.push(`   ${m.agent.padEnd(22)} ${fmt(t1(m)).padStart(9)}${rel}`)
    }
  }
  return L.join('\n')
}

export async function runCtxvisCli(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    console.log(CTXVIS_USAGE)
    return argv.length === 0 ? EXIT.USAGE : 0
  }

  // flagValue, not a local copy. The local one mapped a flag-shaped value to undefined, so
  // `--subject --json` left NO agent marked as the subject and the environment fingerprint was
  // silently taken from an arbitrary one; `--html --json` wrote no report; `--baselines --json`
  // ignored the override and wrote the baseline store to its default path. Every one of those
  // reports success. (This file was in the sweep that fixed the same helper in ctxmapCli and
  // statuslineHistoryCli and was missed — the grep listed it; only two of three were acted on.)
  const flag = (name: string, what = 'a value'): string | undefined => flagValue(argv, name, what)
  const subject = flag('--subject', 'an agent name')
  const outFile = flag('--out', 'a path')
  const asJson = argv.includes('--json')
  const refresh = argv.includes('--refresh-baselines')
  const staleOk = argv.includes('--stale-ok')
  const turnsWanted = Number(flag('--turns', 'a number')) || 2
  const storePath = flag('--baselines', 'a path') ?? path.join(dataDir(), 'ctxvis-baselines.json')
  // Read UP HERE with the others, not at the point of use. It used to be read after the credential
  // check and the whole measurement, so a bad `--html` value was refused only once the run had
  // already spent its count_tokens calls — an argument error that costs money before it is reported.
  const htmlFile = flag('--html', 'a path')
  const lastPath = path.join(dataDir(), 'ctxvis-last.json')

  const emit = (text: string, digest: string): number => {
    if (outFile) {
      fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true })
      fs.writeFileSync(outFile, text.endsWith('\n') ? text : `${text}\n`)
      console.log(`${digest} → ${outFile}`)
    } else {
      console.log(text)
    }
    return 0
  }

  try {
    if (argv.includes('--estimate')) {
      const text = renderEstimate(subject, storePath, refresh)
      return emit(text, 'spawn plan')
    }

    if (argv.includes('--reuse-last')) {
      if (!fs.existsSync(lastPath)) {
        console.error(`no previous run to reuse (${lastPath} does not exist) — run a measurement first`)
        return EXIT.USAGE
      }
      const prev = JSON.parse(fs.readFileSync(lastPath, 'utf8')) as { measurements: AgentMeasurement[]; warnings: string[] }
      const text = asJson ? JSON.stringify(prev, null, 2) : renderReport(prev.measurements, prev.warnings)
      return emit(text, `${prev.measurements.length} agent(s), from the previous run`)
    }

    const measured = parseMeasured(argv)
    if (measured.length === 0) {
      console.error('nothing to analyse: pass --measured <agent>=<nonce> (the skill does this for you)')
      return EXIT.USAGE
    }

    const auth = resolveAnthropicAuth()
    if (!auth) {
      console.error('no Anthropic credential resolved — ctxvis measures with count_tokens and will not estimate')
      return EXIT.UNKNOWN
    }
    // ONE cache for the whole run. ctxvis measures up to 8 captures (4 agents x 2 turns) whose
    // prefixes are byte-identical up to the point each agent's context diverges, so sharing the
    // handle across them is where most of the saving comes from — a per-report cache would re-ask
    // the API for prefixes the previous report had just measured.
    // --refresh-counts, NOT --refresh: ctxvis already documents --refresh-baselines, and a second
    // flag that is a prefix of it would silently do something entirely different to anyone who typed
    // the shorter form meaning the longer one.
    const cache = openCountCache({ apiVersion: API_VERSION, bypassReads: argv.includes('--refresh-counts') })
    const count = (r: CountableRequest): Promise<number> => countTokensExact(r, auth, { cache })

    const files = listRequestCaptures(bodyDirs())
    if (files.length === 0) {
      console.error(`no captured requests in: ${bodyDirs().join(', ') || '(no readable body dirs)'}`)
      return EXIT.UNKNOWN
    }

    const warnings: string[] = []
    const measurements: AgentMeasurement[] = []

    for (const { agent, nonce } of measured) {
      const sel = selectTurns(files, nonce)
      if (sel.ambiguous) {
        warnings.push(`${agent}: ${sel.ambiguous}`)
        continue
      }
      if (sel.turns.length === 0) {
        warnings.push(`${agent}: no captures carry ${nonce} in messages[0] — the spawn produced nothing to read`)
        continue
      }
      if (sel.rejected.length) {
        warnings.push(`${agent}: ignored ${sel.rejected.length} capture(s) carrying the nonce outside messages[0] (the spawning session)`)
      }

      const use = sel.turns.slice(0, turnsWanted)
      const turns: AgentMeasurement['turns'] = []
      for (const t of use) {
        const { req, report } = loadAndAnalyze(t.file)
        const ex = await exactifyReport(report, req, auth, countConcurrency(), cache)
        // ANY unmeasured element has to be surfaced, not just a total wipeout. This header promises
        // "every number that says measured came from count_tokens; nothing is estimated" — and an
        // element whose prefix could not be counted keeps its ESTIMATED value and is summed into the
        // turn total anyway. Warning only when ALL of them failed meant 10 estimated elements out of
        // 500 were presented, silently, as a measured figure. ctxmap surfaces exactly this
        // (`reportMeasurementCaveats`); the longer-lived consumer was the one without it, and these
        // numbers are what get written into the persisted baseline store.
        if (ex.failed > 0) {
          const all = report.elements.length === ex.failed
          warnings.push(`${agent}: ${all ? 'EVERY' : ex.failed} element(s) could not be measured`
            + ` (${ex.failures[0]?.error ?? 'unknown'})`
            + (all ? '' : ` — this turn's total mixes ${ex.failed} estimated element(s) into a measured figure`))
        }
        turns.push({ file: t.file, total: report.elements.reduce((a, e) => a + e.tokens, 0), report })
      }

      let verdict: CacheVerdict | null = null
      let note: string | undefined
      if (use.length >= 2) {
        const div = divergence(use[0].req, use[1].req)
        const surviving = await measureCommonPrefix(use[0].req, div, count)
        verdict = cacheVerdict(div, surviving, turns[1].total, findResponseFor(use[1])?.usage, use[1].req.model)
      } else {
        note = 'only ONE turn was captured — an agent with no tools cannot produce a second, so there is ' +
          'no prefix to compare. Re-run with an agent that can make a tool call.'
      }

      measurements.push({
        agent, isSubject: agent === subject, fromBaseline: false, turns, verdict, note,
      })
    }

    // The SAME freshness check ctxmap runs. ctxvis writes its numbers into the persisted baseline
    // store, where they become the comparison ground truth for later runs — so an undetected drift
    // here outlives the run that introduced it. Checking only in ctxmap left the longer-lived
    // consumer unguarded.
    const fresh = await checkFreshness(cache, auth)
    if (fresh.state === 'drifted') {
      cache.dropModel(fresh.model)
      console.error(`ctxvis: cached counts for ${fresh.model} disagree with a live re-measurement`
        + ' — discarded. Re-run with --refresh-counts to measure from scratch; these numbers are NOT'
        + ' being written to the baseline store.')
      return EXIT.UNKNOWN
    }
    if (fresh.state === 'unchecked') {
      warnings.push(`count cache was NOT verified this run — the freshness probe failed: ${fresh.reason}`)
    }
    // stats() is the ONLY thing that flushes the write buffer. Without it the tail of every run
    // (up to 31 rows, or everything when fewer than 32 were measured) is dropped at exit and
    // re-uploaded next time — the cache would never warm for those prefixes.
    const cs = cache.stats()
    if (cs.hits > 0 || cs.writes > 0) {
      console.error(`ctxvis: count cache — ${cs.hits} hit(s), ${cs.misses} measured live`)
    }

    if (measurements.length === 0) {
      console.error(warnings.join('\n') || 'nothing could be measured')
      return EXIT.UNKNOWN
    }

    // Validate cached baselines against the environment the subject was just measured in — free,
    // because the subject's capture IS a fresh reading of that environment.
    const subjectM = measurements.find(m => m.isSubject) ?? measurements[0]
    const env = fingerprintFrom(subjectM.turns[0].report)
    const store = loadBaselines(storePath)
    const already = new Set(measurements.map(m => m.agent))

    for (const v of validateBaselines(store, env)) {
      if (already.has(v.agent)) continue
      if (v.state === 'missing') {
        warnings.push(`${v.agent}: no baseline on record — spawn it to complete the comparison`)
        continue
      }
      if (v.state === 'stale' && !staleOk) {
        warnings.push(`${v.agent}: cached baseline is STALE (${v.reason}) — re-spawn it, or pass --stale-ok to compare anyway`)
        continue
      }
      measurements.push({
        agent: v.agent,
        isSubject: false,
        fromBaseline: true,
        baselineNote: v.state === 'stale' ? v.reason : undefined,
        turns: v.entry.turns.map(t => ({ file: '', total: t.total, report: { elements: t.elements } as unknown as CtxReport })),
        verdict: v.entry.verdict,
        note: v.state === 'stale' ? `STALE baseline used under --stale-ok: ${v.reason}` : undefined,
      })
    }

    // Persist any base agent measured fresh this run, so the next run does not re-pay for it.
    let dirty = false
    for (const m of measurements) {
      if (m.fromBaseline || !(BASE_AGENTS as readonly string[]).includes(m.agent)) continue
      const entry: BaselineEntry = {
        agent: m.agent,
        measuredAt: new Date().toISOString(),
        env,
        turns: m.turns.map(t => ({
          total: t.total,
          elements: t.report.elements.map(e => ({ label: e.label, tokens: e.tokens })),
        })),
        verdict: m.verdict,
      }
      store.entries = [...store.entries.filter(e => e.agent !== m.agent), entry]
      dirty = true
    }
    if (dirty) saveBaselines(storePath, store)

    try {
      fs.writeFileSync(lastPath, JSON.stringify({ measurements, warnings }))
    } catch { /* a missing --reuse-last cache is not worth failing the run over */ }

    if (htmlFile) {
      const html = renderCtxVisHtml(toHtmlReport(measurements, warnings))
      fs.mkdirSync(path.dirname(path.resolve(htmlFile)), { recursive: true })
      fs.writeFileSync(htmlFile, html)
      console.log(`visual report → ${htmlFile}`)
    }

    const text = asJson ? JSON.stringify({ measurements, warnings }, null, 2) : renderReport(measurements, warnings)
    const brokeCount = measurements.filter(m => m.verdict?.divergence.kind === 'break').length
    return emit(text, `${measurements.length} agent(s), ${brokeCount} with a broken prefix`)
  } catch (e) {
    console.error((e as Error).message)
    // A caller mistake is 64; anything else is a RUNTIME failure and must not claim the command line
    // was wrong. Returning USAGE for everything meant an unreadable baseline store, a corrupt
    // capture, or a failed count all told a harness "your invocation was bad" — so it would go
    // looking for its own bug and never see the real one.
    return e instanceof UsageError ? EXIT.USAGE : EXIT.ABORT
  }
}
