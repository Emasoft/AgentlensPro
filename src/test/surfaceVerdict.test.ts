// TRDD-YL3EWT6N item 4: the version-aware overwrite of installed skills and agents, with a backup.
// Everything runs on REAL files in scratch folders under os.tmpdir(); every install call passes its own scratch
// skillsDir / agentsDir / repoRoot / backupRoot, so nothing here can touch the real home or the real data dir.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { detectDrift } from '../cli/autoSetup'
import { AGENT_NAMES, announceKeptSurfaces, installAgents, installSkill, installSkills, KeptSurface, skillFiles, SKILL_NAME, SKILL_NAMES } from '../cli/hookInstall'
import { REPAIR_STEPS, resolveCtx } from '../cli/setup'
import { compareStampVersions, readSurfaceStamp, surfaceVerdict } from '../cli/surfaceStamp'

// The writer of the stamps, loaded from its own file so the reader is tested against the real writer, not a copy of it.
const { stampText } = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'stamp-surfaces.js')) as {
  stampText: (text: string, version: string, label?: string) => string
}

const quiet = (): void => { /* quiet */ }
const scratch: string[] = []

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

teardown(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** A surface file: frontmatter plus a body, stamped with `version` when given. */
function surface(version: string | null, body: string): string {
  const base = `---\nname: fixture\ndescription: fixture\n---\n${body}\n`
  return version === null ? base : stampText(base, version)
}

const SKILL_PAYLOAD = { 'templates/a.txt': 'shipped a\n', 'templates/b.txt': 'shipped b\n' }

/** A package root holding every shipped agent and every shipped skill. `checkout` adds the src folder that marks a git checkout. */
function makeRoot(shippedVersion: string | null, checkout: boolean): string {
  const root = tmp('al-verdict-root-')
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true })
  for (const name of AGENT_NAMES) fs.writeFileSync(path.join(root, 'agents', `${name}.md`), surface(shippedVersion, `shipped ${name}`))
  // Every shipped skill, so a setup step that insists on a complete package can run against the fixture.
  for (const name of SKILL_NAMES) {
    const skillDir = path.join(root, 'skills', name)
    fs.mkdirSync(path.join(skillDir, 'templates'), { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), surface(shippedVersion, 'shipped skill'))
    for (const [rel, text] of Object.entries(SKILL_PAYLOAD)) fs.writeFileSync(path.join(skillDir, rel), text)
  }
  if (checkout) fs.mkdirSync(path.join(root, 'src'))
  return root
}

/** The files one backup run holds, relative to its single run folder; [] when no backup was made. */
function backedUp(backupRoot: string): string[] {
  if (!fs.existsSync(backupRoot)) return []
  const runs = fs.readdirSync(backupRoot)
  assert.strictEqual(runs.length, 1, `one backup folder per process run, got ${runs.join(', ')}`)
  return skillFiles(path.join(backupRoot, runs[0]))
}

function backupRun(backupRoot: string): string {
  return path.join(backupRoot, fs.readdirSync(backupRoot)[0])
}

suite('item 4: the stamp reader and the version order', () => {
  test('the stamp written by scripts/stamp-surfaces.js is read back, and a text with no frontmatter reads null', () => {
    assert.strictEqual(readSurfaceStamp(surface('2.34.0', 'b')), '2.34.0')
    assert.strictEqual(readSurfaceStamp(surface('2.34.0-rc.1', 'b')), '2.34.0-rc.1')
    assert.strictEqual(readSurfaceStamp('no frontmatter here\n'), null)
    assert.strictEqual(readSurfaceStamp(''), null)
    assert.strictEqual(readSurfaceStamp('---\nname: x\nno closing line\n'), null)
    // A stamp-shaped line in the BODY does not count, and a CRLF copy is unreadable, never a throw.
    assert.strictEqual(readSurfaceStamp('---\nname: x\n---\n# agentlenspro-version: 9.9.9\n'), null)
    assert.strictEqual(readSurfaceStamp(surface('2.34.0', 'b').replace(/\n/g, '\r\n')), null)
  })

  test('versions compare numerically and a prerelease orders below its release', () => {
    assert.ok(compareStampVersions('2.9.0', '2.10.0') < 0)
    assert.ok(compareStampVersions('3.0.0', '2.99.99') > 0)
    assert.strictEqual(compareStampVersions('2.34.0', '2.34.0'), 0)
    assert.ok(compareStampVersions('2.34.0-rc.1', '2.34.0') < 0, 'the rule loadedPluginVersions.compareVersions gets wrong')
    assert.ok(compareStampVersions('2.34.0', '2.34.0-rc.1') > 0)
    assert.ok(compareStampVersions('2.34.0-rc.1', '2.33.9') > 0)
    assert.ok(compareStampVersions('2.34.0-rc.2', '2.34.0-rc.10') < 0, 'numeric identifiers compare as numbers')
    assert.ok(compareStampVersions('2.34.0-alpha', '2.34.0-rc.1') < 0)
    assert.throws(() => compareStampVersions('2.34', '2.34.0'), /not a stamp version/)
  })
})

suite('item 4: the verdict table, in order', () => {
  const v = (installed: string | null, shipped: string, sameContent: boolean, checkout = false) =>
    surfaceVerdict({ installed, shipped, sameContent, checkout })

  test('the seven rows', () => {
    assert.strictEqual(v(null, surface('2.0.0', 'a'), false), 'install', 'installed copy absent')
    assert.strictEqual(v(surface('1.0.0', 'a'), surface('2.0.0', 'a'), true), 'current', 'same content wins over any stamp')
    assert.strictEqual(v(surface('9.0.0', 'x'), surface(null, 'a'), false), 'overwrite', 'shipped file with no stamp: the rule of before the stamps')
    assert.strictEqual(v(surface(null, 'x'), surface('2.0.0', 'a'), false), 'overwrite', 'installed copy with no stamp')
    assert.strictEqual(v('not even frontmatter', surface('2.0.0', 'a'), false), 'overwrite', 'installed copy unreadable')
    assert.strictEqual(v(surface('1.9.0', 'x'), surface('2.0.0', 'a'), false), 'overwrite', 'installed stamp older')
    assert.strictEqual(v(surface('2.1.0', 'x'), surface('2.0.0', 'a'), false), 'keep-newer', 'installed stamp newer')
    assert.strictEqual(v(surface('2.0.0', 'x'), surface('2.0.0', 'a'), false, true), 'overwrite', 'same stamp, different content, git checkout')
    assert.strictEqual(v(surface('2.0.0', 'x'), surface('2.0.0', 'a'), false, false), 'keep-edited', 'same stamp, different content, release')
  })

  test('a stamp that is not a version counts as no stamp, and a prerelease installed over its release is older', () => {
    assert.strictEqual(v('---\nname: x\n# agentlenspro-version: banana\n---\n', surface('2.0.0', 'a'), false), 'overwrite')
    assert.strictEqual(v(surface('2.0.0-rc.1', 'x'), surface('2.0.0', 'a'), false), 'overwrite')
    assert.strictEqual(v(surface('2.0.0', 'x'), surface('2.0.0-rc.1', 'a'), false), 'keep-newer')
  })
})

suite('item 4: installAgents', () => {
  test('an unstamped differing copy is replaced and the backup holds the old bytes', () => {
    const root = makeRoot('2.0.0', false)
    const agentsDir = tmp('al-verdict-agents-')
    const backupRoot = path.join(tmp('al-verdict-bak-'), 'surface-backups')
    const old = surface(null, 'hand written')
    fs.writeFileSync(path.join(agentsDir, 'lean-worker.md'), old)
    const results = installAgents({ repoRoot: root, agentsDir, backupRoot, log: quiet })
    assert.strictEqual(results.find(r => r.name === 'lean-worker')?.outcome, 'updated')
    assert.strictEqual(fs.readFileSync(path.join(agentsDir, 'lean-worker.md'), 'utf8'), surface('2.0.0', 'shipped lean-worker'))
    assert.deepStrictEqual(backedUp(backupRoot), ['agents/lean-worker.md'], 'only the replaced file is backed up; the 8 fresh installs are not')
    assert.strictEqual(fs.readFileSync(path.join(backupRun(backupRoot), 'agents', 'lean-worker.md'), 'utf8'), old)
    assert.ok(new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-${process.pid}$`).test(path.basename(backupRun(backupRoot))), 'run folder is <UTC time>-<pid>')
  })

  test('a copy stamped newer is kept, outcome kept-newer, and no backup is made', () => {
    const root = makeRoot('2.0.0', false)
    const agentsDir = tmp('al-verdict-agents-')
    const backupRoot = path.join(tmp('al-verdict-bak-'), 'surface-backups')
    const newer = surface('3.0.0', 'from the future')
    fs.writeFileSync(path.join(agentsDir, 'lean-worker.md'), newer)
    const results = installAgents({ repoRoot: root, agentsDir, backupRoot, log: quiet })
    assert.strictEqual(results.find(r => r.name === 'lean-worker')?.outcome, 'kept-newer')
    assert.strictEqual(fs.readFileSync(path.join(agentsDir, 'lean-worker.md'), 'utf8'), newer)
    assert.deepStrictEqual(backedUp(backupRoot), [])
  })

  test('a same-stamp edit is kept in a release and replaced, with a backup, in a checkout', () => {
    const edited = surface('2.0.0', 'my edit')
    for (const checkout of [false, true]) {
      const root = makeRoot('2.0.0', checkout)
      const agentsDir = tmp('al-verdict-agents-')
      const backupRoot = path.join(tmp('al-verdict-bak-'), 'surface-backups')
      fs.writeFileSync(path.join(agentsDir, 'lean-worker.md'), edited)
      const outcome = installAgents({ repoRoot: root, agentsDir, backupRoot, log: quiet }).find(r => r.name === 'lean-worker')?.outcome
      if (checkout) {
        assert.strictEqual(outcome, 'updated')
        assert.strictEqual(fs.readFileSync(path.join(agentsDir, 'lean-worker.md'), 'utf8'), surface('2.0.0', 'shipped lean-worker'))
        assert.strictEqual(fs.readFileSync(path.join(backupRun(backupRoot), 'agents', 'lean-worker.md'), 'utf8'), edited)
      } else {
        assert.strictEqual(outcome, 'kept-edited')
        assert.strictEqual(fs.readFileSync(path.join(agentsDir, 'lean-worker.md'), 'utf8'), edited)
        assert.deepStrictEqual(backedUp(backupRoot), [])
      }
    }
  })

  test('an absent agent is installed with no backup folder made', () => {
    const root = makeRoot('2.0.0', false)
    const agentsDir = tmp('al-verdict-agents-')
    const backupRoot = path.join(tmp('al-verdict-bak-'), 'surface-backups')
    const results = installAgents({ repoRoot: root, agentsDir, backupRoot, log: quiet })
    assert.ok(results.every(r => r.outcome === 'installed'), JSON.stringify(results))
    assert.ok(!fs.existsSync(backupRoot), 'nothing was replaced, so no backup folder')
  })

  test('replacing a file with no backupRoot throws and leaves the file as it was', () => {
    const root = makeRoot('2.0.0', false)
    const agentsDir = tmp('al-verdict-agents-')
    const old = surface(null, 'hand written')
    fs.writeFileSync(path.join(agentsDir, 'lean-worker.md'), old)
    assert.throws(() => installAgents({ repoRoot: root, agentsDir, log: quiet }), /no backupRoot/)
    assert.strictEqual(fs.readFileSync(path.join(agentsDir, 'lean-worker.md'), 'utf8'), old)
  })
})

suite('item 4: installSkill', () => {
  function installedTree(skillsDir: string, version: string | null): string {
    const dir = path.join(skillsDir, SKILL_NAME)
    fs.mkdirSync(path.join(dir, 'templates'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), surface(version, 'old skill'))
    fs.writeFileSync(path.join(dir, 'templates', 'a.txt'), 'old a\n')
    fs.writeFileSync(path.join(dir, 'templates', 'b.txt'), SKILL_PAYLOAD['templates/b.txt'])
    fs.writeFileSync(path.join(dir, 'my-note.md'), 'user note\n')
    return dir
  }

  test('an older-stamp tree is replaced, the backup holds only the replaced files, an unshipped extra stays', () => {
    const root = makeRoot('2.0.0', false)
    const skillsDir = tmp('al-verdict-skills-')
    const backupRoot = path.join(tmp('al-verdict-bak-'), 'surface-backups')
    const dir = installedTree(skillsDir, '1.0.0')
    assert.strictEqual(installSkill({ repoRoot: root, skillsDir, backupRoot, log: quiet }), 'updated')
    assert.strictEqual(fs.readFileSync(path.join(dir, 'templates', 'a.txt'), 'utf8'), SKILL_PAYLOAD['templates/a.txt'])
    assert.strictEqual(fs.readFileSync(path.join(dir, 'my-note.md'), 'utf8'), 'user note\n', 'an unshipped file is never touched')
    assert.deepStrictEqual(backedUp(backupRoot), [`skills/${SKILL_NAME}/SKILL.md`, `skills/${SKILL_NAME}/templates/a.txt`])
    assert.strictEqual(fs.readFileSync(path.join(backupRun(backupRoot), 'skills', SKILL_NAME, 'templates', 'a.txt'), 'utf8'), 'old a\n')
  })

  test('a partial tree with no SKILL.md is installed over and its differing files are backed up', () => {
    const root = makeRoot('2.0.0', false)
    const skillsDir = tmp('al-verdict-skills-')
    const backupRoot = path.join(tmp('al-verdict-bak-'), 'surface-backups')
    const dir = path.join(skillsDir, SKILL_NAME)
    fs.mkdirSync(path.join(dir, 'templates'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'templates', 'a.txt'), 'partial a\n')
    assert.strictEqual(installSkill({ repoRoot: root, skillsDir, backupRoot, log: quiet }), 'installed')
    assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')) && fs.existsSync(path.join(dir, 'templates', 'b.txt')))
    assert.deepStrictEqual(backedUp(backupRoot), [`skills/${SKILL_NAME}/templates/a.txt`])
    assert.strictEqual(fs.readFileSync(path.join(backupRun(backupRoot), 'skills', SKILL_NAME, 'templates', 'a.txt'), 'utf8'), 'partial a\n')
  })

  test('a newer-stamp tree is kept untouched, and a same-stamp edit is kept in a release and replaced in a checkout', () => {
    const skillsDir = tmp('al-verdict-skills-')
    const backupRoot = path.join(tmp('al-verdict-bak-'), 'surface-backups')
    const dir = installedTree(skillsDir, '3.0.0')
    assert.strictEqual(installSkill({ repoRoot: makeRoot('2.0.0', false), skillsDir, backupRoot, log: quiet }), 'kept-newer')
    assert.strictEqual(fs.readFileSync(path.join(dir, 'templates', 'a.txt'), 'utf8'), 'old a\n')
    assert.deepStrictEqual(backedUp(backupRoot), [])

    fs.writeFileSync(path.join(dir, 'SKILL.md'), surface('2.0.0', 'old skill'))
    assert.strictEqual(installSkill({ repoRoot: makeRoot('2.0.0', false), skillsDir, backupRoot, log: quiet }), 'kept-edited')
    assert.strictEqual(fs.readFileSync(path.join(dir, 'templates', 'a.txt'), 'utf8'), 'old a\n')
    assert.deepStrictEqual(backedUp(backupRoot), [])

    assert.strictEqual(installSkill({ repoRoot: makeRoot('2.0.0', true), skillsDir, backupRoot, log: quiet }), 'updated')
    assert.strictEqual(fs.readFileSync(path.join(dir, 'templates', 'a.txt'), 'utf8'), SKILL_PAYLOAD['templates/a.txt'])
    assert.ok(backedUp(backupRoot).includes(`skills/${SKILL_NAME}/templates/a.txt`))
  })

  test('replacing a skill file with no backupRoot throws before any file of the tree is written', () => {
    const root = makeRoot('2.0.0', false)
    const skillsDir = tmp('al-verdict-skills-')
    const dir = installedTree(skillsDir, '1.0.0')
    assert.throws(() => installSkill({ repoRoot: root, skillsDir, log: quiet }), /no backupRoot/)
    assert.strictEqual(fs.readFileSync(path.join(dir, 'templates', 'a.txt'), 'utf8'), 'old a\n')
    assert.strictEqual(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), surface('1.0.0', 'old skill'))
  })
})

suite('item 4: detectDrift and the kept notice', () => {
  function ctxFor(root: string): { home: string; agentsDir: string; dataDir: string; ctx: ReturnType<typeof resolveCtx> } {
    const home = tmp('al-verdict-home-')
    const dataDir = path.join(home, '.agentlens')
    fs.mkdirSync(dataDir, { recursive: true })
    const agentsDir = path.join(home, '.claude', 'agents')
    const ctx = resolveCtx({
      home, dataDir, settingsPath: path.join(home, '.claude', 'settings.json'), skillsDir: path.join(home, '.claude', 'skills'), agentsDir,
      repoRoot: root, pathEnv: process.env.PATH ?? '', otlpPort: 4318, uiPort: 3000, mcpPort: 4316, log: quiet,
      telemetryProbe: { managedSettingsPaths: [path.join(home, 'managed', 'managed-settings.json')], processEnv: {} },
    })
    return { home, agentsDir, dataDir, ctx }
  }

  test('a newer-stamped agent is no drift and is listed as kept; an older-stamped one is drift', () => {
    const root = makeRoot('2.0.0', false)
    const { agentsDir, dataDir, ctx } = ctxFor(root)
    installAgents({ repoRoot: root, agentsDir, backupRoot: path.join(dataDir, 'surface-backups'), log: quiet })
    fs.writeFileSync(path.join(agentsDir, 'lean-worker.md'), surface('3.0.0', 'from the future'))
    const kept = detectDrift(ctx)
    assert.ok(!kept.drifts.some(d => d.piece === 'agents'), JSON.stringify(kept.drifts))
    assert.deepStrictEqual(kept.kept.map(k => [k.kind, k.name, k.verdict, k.installedStamp, k.shippedStamp]),
      [['agent', 'lean-worker', 'keep-newer', '3.0.0', '2.0.0']])
    fs.writeFileSync(path.join(agentsDir, 'lean-worker.md'), surface('1.0.0', 'from the past'))
    const stale = detectDrift(ctx)
    assert.ok(stale.drifts.some(d => d.piece === 'agents' && d.reason === 'lean-worker stale'), JSON.stringify(stale.drifts))
    assert.deepStrictEqual(stale.kept, [])
  })

  test('the setup skill step passes on a kept skill and a kept agent, names them, writes nothing and makes no backup', async () => {
    const root = makeRoot('2.0.0', false)
    const { agentsDir, dataDir, ctx } = ctxFor(root)
    const backupRoot = path.join(dataDir, 'surface-backups')
    installSkills({ repoRoot: root, skillsDir: ctx.skillsDir, backupRoot, log: quiet })
    installAgents({ repoRoot: root, agentsDir, backupRoot, log: quiet })
    const newerAgent = surface('3.0.0', 'from the future')
    const newerSkill = surface('3.0.0', 'old skill')
    fs.writeFileSync(path.join(agentsDir, 'lean-worker.md'), newerAgent)
    fs.writeFileSync(path.join(ctx.skillsDir, SKILL_NAME, 'SKILL.md'), newerSkill)
    const { result, acted } = await REPAIR_STEPS.skill.run(ctx)
    assert.strictEqual(result.verify, 'PASS', JSON.stringify(result))
    assert.strictEqual(acted, false)
    assert.match(result.found, new RegExp(`kept: ${SKILL_NAME}: newer than shipped`))
    assert.match(result.detail ?? '', new RegExp(`skill ${SKILL_NAME} \\(installed 3\\.0\\.0 is newer than shipped 2\\.0\\.0\\)`))
    assert.match(result.detail ?? '', /agent lean-worker \(newer than shipped\)/)
    assert.strictEqual(fs.readFileSync(path.join(agentsDir, 'lean-worker.md'), 'utf8'), newerAgent)
    assert.strictEqual(fs.readFileSync(path.join(ctx.skillsDir, SKILL_NAME, 'SKILL.md'), 'utf8'), newerSkill)
    assert.ok(!fs.existsSync(backupRoot), 'a kept surface is not written, so nothing is backed up')
  })

  const keptAgent = (shippedStamp: string): KeptSurface => ({
    kind: 'agent', name: 'lean-worker', verdict: 'keep-newer', installedStamp: '3.0.0', shippedStamp, path: '/scratch/lean-worker.md',
  })

  test('the kept notice is written once per kind, name, installed stamp and shipped stamp', () => {
    const dataDir = tmp('al-verdict-data-')
    const said: string[] = []
    announceKeptSurfaces(dataDir, [keptAgent('2.0.0')], l => said.push(l))
    announceKeptSurfaces(dataDir, [keptAgent('2.0.0')], l => said.push(l))
    assert.strictEqual(said.length, 1, said.join(' | '))
    assert.match(said[0], /agent lean-worker: the installed copy is version 3\.0\.0, newer than the shipped 2\.0\.0, left in place/)
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'surface-kept.json'), 'utf8')).length, 1)
    announceKeptSurfaces(dataDir, [keptAgent('2.1.0')], l => said.push(l))
    assert.strictEqual(said.length, 2, 'a new shipped stamp is a new key')
    const edited: KeptSurface = { ...keptAgent('3.0.0'), verdict: 'keep-edited' }
    announceKeptSurfaces(dataDir, [edited], l => said.push(l))
    assert.match(said[2], /differs from the shipped file of the same version \(3\.0\.0\), left in place; to restore it delete \/scratch\/lean-worker\.md and run agentlenspro setup/)
    assert.deepStrictEqual(fs.readdirSync(dataDir), ['surface-kept.json'], 'no temporary file is left behind')
  })

  test('a failed write only makes the notice repeat and never throws', () => {
    const dir = tmp('al-verdict-data-')
    const blocker = path.join(dir, 'a-file')
    fs.writeFileSync(blocker, 'x')
    const unwritable = path.join(blocker, 'data')   // a directory cannot be made under a regular file
    const said: string[] = []
    announceKeptSurfaces(unwritable, [keptAgent('2.0.0')], l => said.push(l))
    announceKeptSurfaces(unwritable, [keptAgent('2.0.0')], l => said.push(l))
    assert.strictEqual(said.length, 2)
  })
})
