import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { buildLoadedVersionsReport, scanPluginCache, compareVersions } from '../loadedPluginVersions'

// ── Which plugin version has each session LOADED? (AgentlensPro#5) ─────────────────────────────
// Fixtures go to a real transcript tree + a real fake plugin cache, because every rule this module
// lives by is about the on-disk record shapes Claude Code actually writes.

let root: string
let cacheRoot: string

const SLUG = 'project-slug'

function writeTranscript(name: string, records: Array<Record<string, unknown>>): void {
  const dir = path.join(root, SLUG)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), records.map(r => JSON.stringify(r)).join('\n') + '\n')
}

/** A skill-load attachment exactly as Claude Code writes it. */
const load = (
  session: string,
  ts: string,
  plugin: string,
  version: string,
  skill = 'some-skill',
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: 'attachment',
  timestamp: ts,
  sessionId: session,
  cwd: '/Users/x/Code/Proj',
  version: '2.1.216',
  attachment: {
    type: 'invoked_skills',
    skills: [{
      name: `${plugin}:${skill}`,
      path: `plugin:${plugin}:${skill}`,
      content: `Base directory for this skill: /Users/x/.claude/plugins/cache/ai-maestro-plugins/${plugin}/${version}/skills/${skill}\n\n# ${skill}\n`,
    }],
  },
  ...extra,
})

const reload = (session: string, ts: string): Record<string, unknown> => ({
  type: 'user',
  timestamp: ts,
  sessionId: session,
  message: { content: '<command-name>/reload-plugins</command-name>\n<command-args></command-args>' },
})

function writeCache(plugin: string, versions: string[], junk: string[] = []): void {
  for (const v of versions) fs.mkdirSync(path.join(cacheRoot, 'ai-maestro-plugins', plugin, v), { recursive: true })
  for (const j of junk) fs.writeFileSync(path.join(cacheRoot, 'ai-maestro-plugins', plugin, j), 'x')
}

suite('loadedPluginVersions — per-session loaded plugin version (AgentlensPro#5)', () => {
  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-lpv-'))
    cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-cache-'))
    fs.mkdirSync(path.join(cacheRoot, 'ai-maestro-plugins'), { recursive: true })
  })
  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(cacheRoot, { recursive: true, force: true })
  })

  test('reads the loaded version out of a skill-load attachment', () => {
    writeCache('ai-maestro-janitor', ['0.55.0'])
    writeTranscript('s1.jsonl', [load('s1', '2026-07-21T10:00:00.000Z', 'ai-maestro-janitor', '0.55.0')])
    const r = buildLoadedVersionsReport({ dirs: [root], cacheRoot })
    assert.strictEqual(r.rows.length, 1)
    assert.strictEqual(r.rows[0].session, 's1')
    assert.strictEqual(r.rows[0].plugin, 'ai-maestro-janitor')
    assert.strictEqual(r.rows[0].loadedVersion, '0.55.0')
    assert.strictEqual(r.rows[0].project, '/Users/x/Code/Proj')
    assert.strictEqual(r.rows[0].ccVersion, '2.1.216')
    assert.strictEqual(r.rows[0].stale, false)
  })

  // THE load-bearing rule. A compaction replays earlier skill invocations as FRESH attachment
  // records carrying their ORIGINAL (older) content, so the latest-timestamp record is routinely an
  // OLD version. Measured on 40 real transcripts: 18 of 19 multi-version sessions are non-monotone
  // in time. Taking max-by-version is what makes the answer right.
  test('takes the MAX version, not the latest-timestamp one (compaction replays old content)', () => {
    writeCache('ai-maestro-janitor', ['0.56.0'])
    writeTranscript('s1.jsonl', [
      load('s1', '2026-07-21T10:00:00.000Z', 'ai-maestro-janitor', '0.55.0'),
      load('s1', '2026-07-21T11:00:00.000Z', 'ai-maestro-janitor', '0.56.0'),
      // the replay: newest timestamp, oldest content
      load('s1', '2026-07-21T12:00:00.000Z', 'ai-maestro-janitor', '0.55.0'),
    ])
    const r = buildLoadedVersionsReport({ dirs: [root], cacheRoot })
    assert.strictEqual(r.rows[0].loadedVersion, '0.56.0', 'latest-by-timestamp would wrongly say 0.55.0')
    assert.deepStrictEqual(r.rows[0].versionsSeen, ['0.55.0', '0.56.0'])
    assert.strictEqual(r.rows[0].observations, 3)
  })

  test('flags a session running behind the cache as stale', () => {
    writeCache('ai-maestro-janitor', ['0.55.0', '0.59.0'])
    writeTranscript('s1.jsonl', [load('s1', '2026-07-21T10:00:00.000Z', 'ai-maestro-janitor', '0.55.0')])
    const r = buildLoadedVersionsReport({ dirs: [root], cacheRoot })
    assert.strictEqual(r.rows[0].stale, true)
    assert.strictEqual(r.rows[0].newestCached, '0.59.0')
    assert.strictEqual(r.stale, 1)
  })

  // The honest gap: after a reload we cannot see the new version until a skill from that plugin is
  // invoked again. Reporting `true` there would be a fabricated verdict, so it degrades to unknown.
  test("a reload AFTER the last observation degrades to stale:'unknown', never a false stale", () => {
    writeCache('ai-maestro-janitor', ['0.55.0', '0.59.0'])
    writeTranscript('s1.jsonl', [
      load('s1', '2026-07-21T10:00:00.000Z', 'ai-maestro-janitor', '0.55.0'),
      reload('s1', '2026-07-21T10:30:00.000Z'),
    ])
    const r = buildLoadedVersionsReport({ dirs: [root], cacheRoot })
    assert.strictEqual(r.rows[0].stale, 'unknown')
    assert.strictEqual(r.rows[0].lastReloadTs, Date.parse('2026-07-21T10:30:00.000Z'))
    assert.strictEqual(r.unknown, 1)
    assert.strictEqual(r.stale, 0, 'an unknown must not be counted as a confirmed stale')
  })

  test('a reload BEFORE the last observation leaves the verdict confirmed', () => {
    writeCache('ai-maestro-janitor', ['0.55.0', '0.59.0'])
    writeTranscript('s1.jsonl', [
      reload('s1', '2026-07-21T09:00:00.000Z'),
      load('s1', '2026-07-21T10:00:00.000Z', 'ai-maestro-janitor', '0.55.0'),
    ])
    const r = buildLoadedVersionsReport({ dirs: [root], cacheRoot })
    assert.strictEqual(r.rows[0].stale, true)
  })

  // A versioned path in assistant prose or a Bash argument means the model TOUCHED that path —
  // often deliberately reading an OLD cached version. Only the harness-emitted attachment proves a
  // load. On a 40-file sample those decoys outnumber the real signal ~2:1.
  test('ignores versioned plugin paths outside a skill-load attachment', () => {
    writeCache('ai-maestro-janitor', ['0.59.0'])
    writeTranscript('s1.jsonl', [
      {
        type: 'assistant',
        timestamp: '2026-07-21T10:00:00.000Z',
        sessionId: 's1',
        message: {
          content: [
            { type: 'text', text: 'Base directory for this skill: /Users/x/.claude/plugins/cache/ai-maestro-plugins/ai-maestro-janitor/0.59.0/skills/s' },
            { type: 'tool_use', name: 'Bash', input: { command: 'cat /Users/x/.claude/plugins/cache/ai-maestro-plugins/ai-maestro-janitor/0.59.0/scripts/x.py' } },
          ],
        },
      },
      // an attachment for a DIFFERENT, older version is the only real evidence
      load('s1', '2026-07-21T10:05:00.000Z', 'ai-maestro-janitor', '0.41.0'),
    ])
    const r = buildLoadedVersionsReport({ dirs: [root], cacheRoot })
    assert.strictEqual(r.rows.length, 1)
    assert.strictEqual(r.rows[0].loadedVersion, '0.41.0', 'prose and Bash paths must not raise the verdict')
    assert.strictEqual(r.rows[0].stale, true)
  })

  test('a session with no skill load is counted as a blind spot, not reported as current', () => {
    writeCache('ai-maestro-janitor', ['0.59.0'])
    writeTranscript('s1.jsonl', [load('s1', '2026-07-21T10:00:00.000Z', 'ai-maestro-janitor', '0.59.0')])
    writeTranscript('s2.jsonl', [{ type: 'user', timestamp: '2026-07-21T10:00:00.000Z', sessionId: 's2', message: { content: 'hello' } }])
    const r = buildLoadedVersionsReport({ dirs: [root], cacheRoot })
    assert.strictEqual(r.sessionsScanned, 2)
    assert.strictEqual(r.sessionsWithSkillEvidence, 1)
    assert.strictEqual(r.rows.length, 1, 's2 is absent from rows — absence is not a clean bill of health')
  })

  test('plugin filter narrows both the rows and the newestCached map', () => {
    writeCache('ai-maestro-janitor', ['0.59.0'])
    writeCache('dev-browser', ['1.2.0'])
    writeTranscript('s1.jsonl', [
      load('s1', '2026-07-21T10:00:00.000Z', 'ai-maestro-janitor', '0.59.0'),
      load('s1', '2026-07-21T10:01:00.000Z', 'dev-browser', '1.2.0'),
    ])
    const all = buildLoadedVersionsReport({ dirs: [root], cacheRoot })
    assert.strictEqual(all.rows.length, 2)
    const one = buildLoadedVersionsReport({ dirs: [root], cacheRoot, plugin: 'dev-browser' })
    assert.strictEqual(one.rows.length, 1)
    assert.strictEqual(one.rows[0].plugin, 'dev-browser')
    assert.deepStrictEqual(Object.keys(one.newestCached), ['ai-maestro-plugins/dev-browser'])
  })

  test('staleOnly drops the up-to-date rows but keeps unknown ones', () => {
    writeCache('ai-maestro-janitor', ['0.55.0', '0.59.0'])
    writeTranscript('s1.jsonl', [load('s1', '2026-07-21T10:00:00.000Z', 'ai-maestro-janitor', '0.59.0')])
    writeTranscript('s2.jsonl', [load('s2', '2026-07-21T10:00:00.000Z', 'ai-maestro-janitor', '0.55.0')])
    writeTranscript('s3.jsonl', [
      load('s3', '2026-07-21T10:00:00.000Z', 'ai-maestro-janitor', '0.55.0'),
      reload('s3', '2026-07-21T10:30:00.000Z'),
    ])
    const r = buildLoadedVersionsReport({ dirs: [root], cacheRoot, staleOnly: true })
    assert.deepStrictEqual(r.rows.map(x => x.session).sort(), ['s2', 's3'])
  })

  test('activeMinutes scopes to recently-touched transcripts', () => {
    writeCache('ai-maestro-janitor', ['0.59.0'])
    writeTranscript('s1.jsonl', [load('s1', '2026-07-21T10:00:00.000Z', 'ai-maestro-janitor', '0.55.0')])
    const old = path.join(root, SLUG, 's1.jsonl')
    const longAgo = new Date(Date.now() - 24 * 3_600_000)
    fs.utimesSync(old, longAgo, longAgo)
    assert.strictEqual(buildLoadedVersionsReport({ dirs: [root], cacheRoot }).rows.length, 1)
    assert.strictEqual(buildLoadedVersionsReport({ dirs: [root], cacheRoot, activeMinutes: 60 }).rows.length, 0)
  })

  // Found on the first live run: the CLI's lean shaping clipped versionsSeen to 3 entries, so a row
  // read `loadedVersion: 0.55.0` with a versionsSeen that did not contain 0.55.0 — a correct verdict
  // that looked like a bug. The count makes the clip visible instead of the answer doubtful.
  test('versionsSeenCount survives a truncated versionsSeen', () => {
    writeCache('ai-maestro-janitor', ['0.59.0'])
    writeTranscript('s1.jsonl', ['0.41.0', '0.47.0', '0.48.1', '0.52.0', '0.55.0'].map((v, i) =>
      load('s1', `2026-07-21T10:0${i}:00.000Z`, 'ai-maestro-janitor', v)))
    const r = buildLoadedVersionsReport({ dirs: [root], cacheRoot })
    assert.strictEqual(r.rows[0].versionsSeenCount, 5)
    assert.strictEqual(r.rows[0].loadedVersion, '0.55.0')
    assert.strictEqual(r.rows[0].versionsSeenCount, r.rows[0].versionsSeen.length, 'equal before any shaping')
  })

  test('sorts ghosts first, and is stable when transcripts share an mtime', () => {
    writeCache('ai-maestro-janitor', ['0.55.0', '0.59.0'])
    writeTranscript('a-current.jsonl', [load('a-current', '2026-07-21T10:00:00.000Z', 'ai-maestro-janitor', '0.59.0')])
    writeTranscript('b-unknown.jsonl', [
      load('b-unknown', '2026-07-21T10:00:00.000Z', 'ai-maestro-janitor', '0.55.0'),
      reload('b-unknown', '2026-07-21T10:30:00.000Z'),
    ])
    writeTranscript('c-stale.jsonl', [load('c-stale', '2026-07-21T10:00:00.000Z', 'ai-maestro-janitor', '0.55.0')])
    // Same mtime to the millisecond — the busy-machine case that made mtime-only ordering flap.
    const when = new Date(1_784_000_000_000)
    for (const f of ['a-current', 'b-unknown', 'c-stale']) fs.utimesSync(path.join(root, SLUG, `${f}.jsonl`), when, when)
    const r = buildLoadedVersionsReport({ dirs: [root], cacheRoot })
    assert.deepStrictEqual(r.rows.map(x => x.session), ['c-stale', 'b-unknown', 'a-current'])
    assert.deepStrictEqual(buildLoadedVersionsReport({ dirs: [root], cacheRoot }).rows.map(x => x.session),
      ['c-stale', 'b-unknown', 'a-current'], 'a second run must return the same order')
  })

  test('scanPluginCache picks the newest version and skips non-version entries', () => {
    writeCache('ai-maestro-janitor', ['0.9.0', '0.10.0', '0.58.1'], ['tsconfig.test.json', 'walkthrough'])
    const cache = scanPluginCache(cacheRoot)
    assert.strictEqual(cache['ai-maestro-plugins/ai-maestro-janitor'], '0.58.1')
  })

  test('compareVersions orders numerically, not lexically', () => {
    assert.ok(compareVersions('0.9.0', '0.10.0') < 0, '0.9.0 < 0.10.0 — a string compare gets this backwards')
    assert.ok(compareVersions('2.161.0', '2.9.0') > 0)
    assert.strictEqual(compareVersions('1.2.3', '1.2.3'), 0)
  })
})
