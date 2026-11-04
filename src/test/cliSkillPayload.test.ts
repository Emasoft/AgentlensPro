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

  test("every shipped agent is listed, named after its file, has no sibling name in its body, preloads no skills, and the six workers share one Tools section", () => {
    const agentsDir = path.join(repoRoot, "agents")
    const agentFiles = fs.readdirSync(agentsDir).filter(file => file.endsWith(".md"))

    // WHY a line-anchored split and not `content.split("---")`: the delimiter must be a line of
    // its own, or a `---` inside the BODY (a horizontal rule, a nested YAML block) shifts every
    // index and the checks below would run against a reassembled string instead of the body.
    // The body is then simply everything after the closing delimiter — no reassembly.
    const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

    for (const file of agentFiles) {
      const filenameName = path.basename(file, ".md")
      assert.ok(AGENT_NAMES.includes(filenameName), "agent file is not installed: " + file)

      const content = fs.readFileSync(path.join(agentsDir, file), "utf8")
      const match = FRONTMATTER.exec(content)
      assert.ok(match, "missing or unterminated frontmatter: " + file)
      const frontmatter = match[1]
      const body = content.slice(match[0].length)

      const nameLine = frontmatter.split("\n").find(line => line.startsWith("name: "))
      assert.ok(nameLine, "frontmatter has no name: key: " + file)
      assert.strictEqual(nameLine.slice("name: ".length).trim(), filenameName, "frontmatter name must match filename: " + file)

      // WHY: the workers carry their command reference inline; a skills: preload injects whole SKILL.md files at every spawn.
      assert.ok(!frontmatter.split("\n").some(line => line.startsWith("skills:")), "agent frontmatter must not preload skills: " + file)

      // The `description:` is deliberately NOT checked for sibling names: it is the field the
      // parent model reads to CHOOSE a worker, and "Identical shape to lean-worker…" is exactly
      // the routing hint it needs. The BODY is where a sibling name is a defect (a worker's own
      // example telling the model to dispatch a different worker), and that is what is checked.
      // The match is WORD-BOUNDED, not a plain substring: a bare `body.includes(name)` would also
      // fire on a DIFFERENT agent whose name merely CONTAINS this one (`cheap-worker` inside a
      // future `cheap-worker-2`), turning a real agent into a false positive the day the fleet
      // grows. The class is [A-Za-z0-9_-] on both sides, so `cheap-worker` does not match inside
      // `cheap-worker-2`, and a name never matches inside a longer hyphenated token.
      // An optional plural `s` is allowed, because fan-out examples say `eight X-workers` — the form a sibling mention most often takes.
      for (const otherName of AGENT_NAMES) {
        if (otherName !== filenameName) {
          const sibling = new RegExp(`(?<![A-Za-z0-9_-])${otherName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?(?![A-Za-z0-9_-])`)
          assert.ok(!sibling.test(body), file + " body refers to a different worker name: " + otherName)
        }
      }
    }

    // WHY compared byte-for-byte: the six workers carry the same inline command reference in place of
    // a skills: preload, so a copy edited in one file only would silently drift from the other five.
    // The section runs from its heading to the next `## ` heading, the first `<example>` line, or EOF.
    const TOOLS_HEADING = "## Tools — the commands you use (no skill is preloaded)"
    const toolsSection = (worker: string): string => {
      const lines = fs.readFileSync(path.join(agentsDir, worker + ".md"), "utf8").split(/\r?\n/)
      const start = lines.indexOf(TOOLS_HEADING)
      assert.ok(start >= 0, worker + " has no Tools section")
      let end = lines.findIndex((line, i) => i > start && (line.startsWith("## ") || line.startsWith("<example>")))
      if (end < 0) end = lines.length
      return lines.slice(start, end).join("\n").trimEnd()
    }
    const reference = toolsSection("cheap-worker")
    for (const worker of ["fast-worker", "lean-worker", "micro-worker", "sonnet-worker", "smart-worker"]) {
      assert.strictEqual(toolsSection(worker), reference, worker + " Tools section differs from cheap-worker")
    }
  })

})
