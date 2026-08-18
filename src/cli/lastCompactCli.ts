// src/cli/lastCompactCli.ts — `agentlenspro last-compact`: how long ago did THIS project compact?
//
// The answer is a DELTA, because that is the form the decision needs: a compaction rewrites the
// whole prefix at the write rate, so what a caller acts on is "how long ago", not a wall-clock
// stamp it would have to subtract itself. stdout is the delta alone; everything describing WHICH
// compaction (trigger, session, project) goes to stderr, so a pipe stays parse-safe — same split
// as `cache-expired`.
//
// Reads the hook-event store straight off disk (no server), because a compaction is exactly the
// kind of event someone asks about while the machine is wedged.
//
// AUTO COUNTS. An auto-compact and a typed /compact cost the identical full rewrite, so the default
// answers for either and NAMES which one it found; `--trigger manual|auto` narrows it when the
// distinction matters.

import * as fs from 'fs'
import * as path from 'path'
import { dataDir } from '../dataDir'
import { findLastCompact, DEFAULT_COMPACT_WINDOW_DAYS, type CompactTrigger } from '../lastCompact'
import { EXIT, UsageError } from './cliErrors'
import { assertKnownFlags } from './argHelpers'

export const LAST_COMPACT_USAGE = `agentlenspro last-compact [flags]

How long ago did THIS project's conversation compact? Prints the age of the most recent compaction
— a manual /compact or an auto-compact, whichever is newer.

Sourced from the PreCompact lifecycle hook (the compaction itself, with its trigger), read straight
off disk — so it answers with the server down.

flags:
  --seconds            print the age as a bare integer number of seconds (for arithmetic)
  --project DIR        scope to DIR instead of the current directory ('' = any project)
  --session ID         restrict to one session id
  --trigger manual|auto  only that kind (default: either, and the answer says which)
  --window-days N      how far back to look (default ${DEFAULT_COMPACT_WINDOW_DAYS}, the store's retention horizon)
  --json               the full record: timestamps, trigger, session, cwd, completion + duration

exit:
  0 = answered, stdout is the delta · 2 = no compaction on record (stdout EMPTY) · 64 = bad flags

  A never-compacted project exits 2 and prints NOTHING — "no compaction" must never arrive as
  "0s ago", which is the opposite claim.

  age=$(agentlenspro last-compact --seconds) && [ "$age" -lt 300 ] && echo "compacted just now"`

const KNOWN = new Set(['--seconds', '--project', '--session', '--trigger', '--window-days', '--json', '--help', '-h'])
const VALUED = new Set(['--project', '--session', '--trigger', '--window-days'])

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  if (i < 0) return undefined
  const v = argv[i + 1]
  // A missing value must not silently swallow the next flag: `--trigger --json` is a typo, not a
  // trigger named "--json". An empty string IS meaningful for --project ("any project"), so it is
  // accepted — only a flag-shaped or absent value is refused.
  if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} needs a value`)
  return v
}

export function runLastCompactCli(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(LAST_COMPACT_USAGE)
    return EXIT.OK
  }
  assertKnownFlags(argv, KNOWN, VALUED, 'agentlenspro last-compact --help')

  const asJson = argv.includes('--json')
  const asSeconds = argv.includes('--seconds')
  const triggerRaw = flagValue(argv, '--trigger')
  if (triggerRaw !== undefined && triggerRaw !== 'manual' && triggerRaw !== 'auto') {
    throw new UsageError(`--trigger expects manual|auto, got "${triggerRaw}"`)
  }
  const windowRaw = flagValue(argv, '--window-days')
  let windowDays: number | undefined
  if (windowRaw !== undefined) {
    windowDays = Number(windowRaw)
    if (!Number.isFinite(windowDays) || windowDays <= 0) {
      throw new UsageError(`--window-days expects a positive number of days, got "${windowRaw}"`)
    }
  }

  // `--project ''` is the documented any-project opt-out; absent means "the project I am in".
  const projectRaw = flagValue(argv, '--project')
  let project: string | null
  if (projectRaw === '') {
    project = null
  } else {
    const given = projectRaw ?? process.cwd()
    // Resolved through realpath so a relative path, a trailing slash or a symlinked checkout all
    // match the absolute cwd Claude Code stamps into the payload.
    try { project = fs.realpathSync(path.resolve(given)) } catch {
      console.error(`no such project directory: ${given}`)
      return EXIT.USAGE
    }
  }

  const result = findLastCompact({
    dir: path.join(dataDir(), 'hook-events'),
    project,
    session: flagValue(argv, '--session') ?? null,
    trigger: (triggerRaw as CompactTrigger | undefined) ?? null,
    windowDays,
  })

  if (!result.found) {
    // EX_UNKNOWN with stdout untouched. A caller doing `age=$(... --seconds)` gets an EMPTY string
    // and a non-zero status, never a number it would compare as "recent".
    console.error(`cannot answer: ${result.reason}`)
    return EXIT.UNKNOWN
  }

  if (asJson) {
    console.log(JSON.stringify({ ...result, project }, null, 2))
    return EXIT.OK
  }

  // WHICH compaction, on stderr — a caller that named no project still has to be able to see the
  // one it got, and the trigger is half the meaning of the number.
  const where = result.cwd ? ` in ${result.cwd}` : ''
  const took = result.durationMs === null
    ? ' (no completion recorded — still compacting, or the PostCompact was lost)'
    : ` (took ${Math.round(result.durationMs / 1000)}s)`
  console.error(
    `${result.trigger} compact at ${result.atIso}${where}` +
    `${result.sessionId ? `, session ${result.sessionId.slice(0, 8)}` : ''}${took}`,
  )
  console.log(asSeconds ? String(result.ageSeconds) : result.ageHuman)
  return EXIT.OK
}
