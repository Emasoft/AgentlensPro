import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { installSkill, installAgents, skillFiles, skillTreeHash, AGENT_NAMES, SKILL_NAMES } from '../cli/hookInstall'

// A skill's payload — templates, scripts, references — is what makes it useful, so the installer
// must copy the whole DIRECTORY. These tests exist because the previous installer copied only
// SKILL.md: a skill documenting `templates/foo.js` would install a file that referenced a file
// the user did not have, and setup's drift check (hashing SKILL.md alone) would report it current
// forever while the payload rotted.

const repoRoot = path.resolve(__dirname, '..', '..', '..')

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

suite('shipped skill payloads install whole, agents ride along', () => {
  test('installSkill copies every file in the skill tree, not just SKILL.md', () => {
    const dir = tmp('al-skill-')
    try {
      const outcome = installSkill({ repoRoot, skillsDir: dir, name: 'agentlenspro-scan-and-fix', log: () => {} })
      assert.strictEqual(outcome, 'installed')
      const shipped = skillFiles(path.join(repoRoot, 'skills', 'agentlenspro-scan-and-fix'))
      assert.ok(shipped.length > 1, `the fixture skill must ship a payload beyond SKILL.md (got ${shipped.length})`)
      for (const rel of shipped) {
        assert.ok(fs.existsSync(path.join(dir, 'agentlenspro-scan-and-fix', rel)), `missing installed file: ${rel}`)
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  test('a second install is a no-op, and a payload edit is detected as drift — not just a SKILL.md edit', () => {
    const dir = tmp('al-skill-')
    try {
      installSkill({ repoRoot, skillsDir: dir, name: 'agentlenspro-scan-and-fix', log: () => {} })
      assert.strictEqual(installSkill({ repoRoot, skillsDir: dir, name: 'agentlenspro-scan-and-fix', log: () => {} }), 'current')

      // Corrupt a NON-SKILL.md file: the exact case the old SKILL.md-only check was blind to.
      const shipped = skillFiles(path.join(repoRoot, 'skills', 'agentlenspro-scan-and-fix'))
      const payload = shipped.find(r => r !== 'SKILL.md')
      assert.ok(payload, 'skill must ship a non-SKILL.md file for this test to mean anything')
      const victim = path.join(dir, 'agentlenspro-scan-and-fix', payload as string)
      fs.writeFileSync(victim, 'tampered\n')

      const srcHash = skillTreeHash(path.join(repoRoot, 'skills', 'agentlenspro-scan-and-fix'))
      assert.notStrictEqual(skillTreeHash(path.join(dir, 'agentlenspro-scan-and-fix')), srcHash,
        'tree hash must see payload drift')
      assert.strictEqual(installSkill({ repoRoot, skillsDir: dir, name: 'agentlenspro-scan-and-fix', log: () => {} }), 'updated')
      assert.strictEqual(skillTreeHash(path.join(dir, 'agentlenspro-scan-and-fix')), srcHash, 'repair must restore the tree')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  test('an unshipped file at the destination is reported but NEVER deleted', () => {
    const dir = tmp('al-skill-')
    try {
      installSkill({ repoRoot, skillsDir: dir, name: 'agentlenspro-scan-and-fix', log: () => {} })
      const mine = path.join(dir, 'agentlenspro-scan-and-fix', 'my-own-note.md')
      fs.writeFileSync(mine, 'user content\n')
      const lines: string[] = []
      installSkill({ repoRoot, skillsDir: dir, name: 'agentlenspro-scan-and-fix', log: (l) => lines.push(l) })
      assert.ok(fs.existsSync(mine), 'the installer must not delete a file it did not ship')
      assert.ok(lines.some(l => l.includes('my-own-note.md')), `the extra file must be reported; got: ${lines.join(' | ')}`)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  test('installAgents installs every shipped agent definition and is idempotent', () => {
    const dir = tmp('al-agents-')
    try {
      const first = installAgents({ repoRoot, agentsDir: dir, log: () => {} })
      assert.strictEqual(first.length, AGENT_NAMES.length)
      assert.ok(first.every(r => r.outcome === 'installed'), `all fresh: ${JSON.stringify(first)}`)
      for (const name of AGENT_NAMES) {
        assert.ok(fs.existsSync(path.join(dir, `${name}.md`)), `missing agent: ${name}`)
      }
      const second = installAgents({ repoRoot, agentsDir: dir, log: () => {} })
      assert.ok(second.every(r => r.outcome === 'current'), `second run must be a no-op: ${JSON.stringify(second)}`)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  test('every name the CLI promises to install actually exists in the package', () => {
    for (const name of SKILL_NAMES) {
      assert.ok(fs.existsSync(path.join(repoRoot, 'skills', name, 'SKILL.md')), `SKILL_NAMES lists a skill the package does not ship: ${name}`)
    }
    for (const name of AGENT_NAMES) {
      assert.ok(fs.existsSync(path.join(repoRoot, 'agents', `${name}.md`)), `AGENT_NAMES lists an agent the package does not ship: ${name}`)
    }
  })
})
