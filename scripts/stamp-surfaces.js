#!/usr/bin/env node
// scripts/stamp-surfaces.js: the version stamp of every shipped skill and agent file (TRDD-YL3EWT6N item 5).
//
// WHY: the CLI can tell that an installed skill or agent file is out of date only when the file
// itself says which package version wrote it. The stamp is one YAML comment line, the last line of
// the frontmatter:
//     # agentlenspro-version: X.Y.Z
// It is a comment because the frontmatter keys of a skill or an agent are read by Claude Code, and
// an unknown key there is not ours to add.
//
//   node scripts/stamp-surfaces.js --write   stamp every surface with the version of package.json
//   node scripts/stamp-surfaces.js --check   exit 1 when a surface lacks that stamp in that place
"use strict"
const fs = require("fs")
const path = require("path")

const STAMP_RE = /^# agentlenspro-version: (\S+)$/
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/** The stamp line of one version. */
function stampLine(version) {
  return `# agentlenspro-version: ${version}`
}

/** Index of the line that closes the frontmatter. Throws when the text has none. */
function frontmatterEnd(lines, label) {
  if (lines[0] !== "---") throw new Error(`${label}: line 1 is not --- (no frontmatter)`)
  const end = lines.indexOf("---", 1)
  if (end < 0) throw new Error(`${label}: the frontmatter is never closed`)
  return end
}

/** The version in the frontmatter stamp of a text, or null. A stamp-shaped body line does not count. */
function readStamp(text, label = "text") {
  const lines = text.split("\n")
  const end = frontmatterEnd(lines, label)
  let found = null
  for (let i = 1; i < end; i++) {
    const m = STAMP_RE.exec(lines[i])
    if (m) found = m[1]
  }
  return found
}

/** The text with exactly one stamp line, the last line of the frontmatter. Every other byte is kept. */
function stampText(text, version, label = "text") {
  if (!VERSION_RE.test(version)) throw new Error(`${label}: not a version: ${JSON.stringify(version)}`)
  if (text.includes("\r")) throw new Error(`${label}: carriage return found, surfaces use LF line ends`)
  const lines = text.split("\n")
  const end = frontmatterEnd(lines, label)
  const head = lines.slice(1, end).filter(l => !STAMP_RE.test(l))
  return ["---", ...head, stampLine(version), ...lines.slice(end)].join("\n")
}

/** Every shipped surface under a package root: skills/<name>/SKILL.md, then agents/<name>.md, each sorted. */
function surfaceFiles(root) {
  const out = []
  const skills = path.join(root, "skills")
  for (const name of fs.readdirSync(skills).sort()) {
    const dir = path.join(skills, name)
    if (!fs.statSync(dir).isDirectory()) continue
    const file = path.join(dir, "SKILL.md")
    if (!fs.existsSync(file)) throw new Error(`skills/${name}: no SKILL.md`)
    out.push(file)
  }
  const agents = path.join(root, "agents")
  for (const name of fs.readdirSync(agents).sort()) {
    if (name.endsWith(".md")) out.push(path.join(agents, name))
  }
  return out
}

/** Runs one mode over a package root. Returns the exit code. */
function run(argv, root) {
  const mode = argv[0]
  if (argv.length !== 1 || (mode !== "--write" && mode !== "--check")) {
    process.stderr.write("usage: node scripts/stamp-surfaces.js --write | --check\n")
    return 64
  }
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version
  const files = surfaceFiles(root)
  if (files.length === 0) throw new Error("no surface found under skills/ or agents/")
  let stale = 0
  for (const file of files) {
    const rel = path.relative(root, file)
    const text = fs.readFileSync(file, "utf8")
    const want = stampText(text, version, rel)
    if (want === text) continue
    stale++
    if (mode === "--write") {
      fs.writeFileSync(file, want)
      console.log(`stamped ${rel}`)
    } else {
      console.log(`STALE ${rel}: stamp ${readStamp(text, rel) ?? "absent"}, expected ${version} as the last frontmatter line`)
    }
  }
  if (mode === "--check" && stale > 0) {
    console.log(`check-stamps: ${stale} of ${files.length} surfaces are not stamped ${version}. Run: node scripts/stamp-surfaces.js --write`)
    return 1
  }
  const written = mode === "--write" ? ` (${stale} written)` : ""
  console.log(`check-stamps: OK, ${files.length} surfaces stamped ${version}${written}`)
  return 0
}

if (require.main === module) process.exit(run(process.argv.slice(2), path.join(__dirname, "..")))

module.exports = { STAMP_RE, stampLine, readStamp, stampText, surfaceFiles, run }
