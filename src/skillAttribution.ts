import * as fs from 'fs'
import { claudeProjectsDirs } from './logReader'
import { transcriptFiles } from './cacheRiskCommands'
import { calcTokenCostUsd } from './shared/pricing'

// Per-skill / per-plugin COST attribution, read from the Claude Code transcript (TRDD-A4BA8IU5).
//
// Claude Code stamps assistant records with `attributionSkill` and `attributionPlugin` naming the
// skill/plugin whose invocation produced that turn. Nothing in the 2.1.204-2.1.216 release notes
// mentions these fields — they were found by scanning real transcripts — and they answer the
// question this product exists for: WHICH skill or plugin is spending my money. That is not
// academic here: a janitor heartbeat loop drained three OAuth accounts, and until now no report
// could name the skill responsible.
//
// Same substrate as src/cacheRiskCommands.ts and for the same reasons: the transcript is on disk,
// exact, and retroactive over the whole history, so this needs no hook, no schema migration and no
// change to the ingest path.

/** One skill's or plugin's rolled-up footprint. */
export interface AttributionRollup {
  /** The skill id (e.g. `ai-maestro-janitor:janitor-arm`) or plugin id (`ai-maestro-janitor`). */
  name: string
  /** Distinct assistant MESSAGES attributed to it (not JSONL rows — see the dedupe note below). */
  messages: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  /** Priced per-message with that message's own model, then summed. */
  costUsd: number
  /** Models seen, most-used first. */
  models: string[]
  firstTs?: number
  lastTs?: number
}

export interface AttributionReport {
  /** Assistant messages carrying an attribution stamp (deduped by message id). */
  attributedMessages: number
  /** Of those, how many carried a `usage` block we could price. */
  pricedMessages: number
  totalCostUsd: number
  bySkill: AttributionRollup[]
  byPlugin: AttributionRollup[]
  /** Rows dropped because the same message id appeared on several JSONL rows. */
  duplicateRowsSkipped: number
  windowHours: number | null
}

interface Acc {
  messages: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  cost: number
  models: Map<string, number>
  first?: number
  last?: number
}

const newAcc = (): Acc => ({ messages: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, models: new Map() })

function finish(map: Map<string, Acc>): AttributionRollup[] {
  const out: AttributionRollup[] = []
  for (const [name, a] of map) {
    out.push({
      name,
      messages: a.messages,
      inputTokens: a.input,
      cacheReadTokens: a.cacheRead,
      cacheWriteTokens: a.cacheWrite,
      outputTokens: a.output,
      costUsd: +a.cost.toFixed(4),
      models: [...a.models.entries()].sort((x, y) => y[1] - x[1]).map(([m]) => m),
      firstTs: a.first,
      lastTs: a.last,
    })
  }
  return out.sort((x, y) => y.costUsd - x.costUsd)
}

export interface AttributionOptions {
  /** Only count messages at or after this epoch ms (also skips whole files by mtime). */
  sinceMs?: number
  /** Transcript roots; defaults to Claude Code's own project dirs. */
  dirs?: ReadonlyArray<string>
  /** Cap each rollup list (by cost, highest first). */
  topN?: number
}

/**
 * Roll up token/cost footprint per attributed skill and plugin.
 *
 * THE DEDUPE IS LOAD-BEARING. Claude Code writes ONE assistant message as MULTIPLE JSONL rows —
 * one per content block (thinking / text / each tool_use) — and repeats the FULL `usage` on every
 * row. Summing per row over-counts 2-5x, worst on exactly the tool-heavy sessions this report is
 * meant to explain (logReader.ts documents the same trap costing a 2.4-4.5x over-count on a real
 * session). So usage is counted ONCE per `message.id`, and the number of rows skipped is reported
 * rather than hidden — a silent dedupe is indistinguishable from data loss.
 */
export function buildAttributionReport(opts: AttributionOptions = {}): AttributionReport {
  const dirs = opts.dirs ?? claudeProjectsDirs()
  const bySkill = new Map<string, Acc>()
  const byPlugin = new Map<string, Acc>()
  const seen = new Set<string>()
  let attributed = 0, priced = 0, dupes = 0, total = 0

  for (const file of transcriptFiles(dirs)) {
    if (opts.sinceMs !== undefined) {
      try { if (fs.statSync(file).mtimeMs < opts.sinceMs) continue } catch { continue }
    }
    let text: string
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    if (!text.includes('attributionSkill') && !text.includes('attributionPlugin')) continue

    for (const line of text.split('\n')) {
      if (!line.includes('attribution')) continue
      let rec: Record<string, unknown>
      try { rec = JSON.parse(line) as Record<string, unknown> } catch { continue }
      if (rec['type'] !== 'assistant') continue
      const skill = typeof rec['attributionSkill'] === 'string' ? rec['attributionSkill'] : undefined
      const plugin = typeof rec['attributionPlugin'] === 'string' ? rec['attributionPlugin'] : undefined
      if (!skill && !plugin) continue

      const ts = typeof rec['timestamp'] === 'string' ? Date.parse(rec['timestamp']) : NaN
      if (opts.sinceMs !== undefined && (!Number.isFinite(ts) || ts < opts.sinceMs)) continue

      const msg = rec['message'] as Record<string, unknown> | undefined
      const id = typeof msg?.['id'] === 'string' ? msg['id'] as string : undefined
      if (id) {
        if (seen.has(id)) { dupes++; continue }
        seen.add(id)
      }
      attributed++

      const usage = msg?.['usage'] as Record<string, unknown> | undefined
      const model = typeof msg?.['model'] === 'string' ? msg['model'] as string : ''
      const num = (k: string): number => {
        const v = usage?.[k]
        return typeof v === 'number' && Number.isFinite(v) ? v : 0
      }
      const input = num('input_tokens')
      const cacheRead = num('cache_read_input_tokens')
      const cacheWrite = num('cache_creation_input_tokens')
      const output = num('output_tokens')
      // A record with no usage block is still an attributed message — it is counted, just not
      // priced — so `attributedMessages` never silently shrinks to only the priceable ones.
      const cost = usage ? calcTokenCostUsd(input, cacheRead, cacheWrite, output, model) : 0
      if (usage) { priced++; total += cost }

      for (const [key, map] of [[skill, bySkill], [plugin, byPlugin]] as Array<[string | undefined, Map<string, Acc>]>) {
        if (!key) continue
        let a = map.get(key)
        if (!a) { a = newAcc(); map.set(key, a) }
        a.messages++
        a.input += input; a.cacheRead += cacheRead; a.cacheWrite += cacheWrite; a.output += output
        a.cost += cost
        if (model) a.models.set(model, (a.models.get(model) ?? 0) + 1)
        if (Number.isFinite(ts)) {
          if (a.first === undefined || ts < a.first) a.first = ts
          if (a.last === undefined || ts > a.last) a.last = ts
        }
      }
    }
  }

  const cap = opts.topN !== undefined ? Math.max(1, opts.topN) : undefined
  const skills = finish(bySkill)
  const plugins = finish(byPlugin)
  return {
    attributedMessages: attributed,
    pricedMessages: priced,
    totalCostUsd: +total.toFixed(4),
    bySkill: cap ? skills.slice(0, cap) : skills,
    byPlugin: cap ? plugins.slice(0, cap) : plugins,
    duplicateRowsSkipped: dupes,
    windowHours: null,
  }
}
