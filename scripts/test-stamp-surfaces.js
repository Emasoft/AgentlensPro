#!/usr/bin/env node
// The case matrix of scripts/stamp-surfaces.js (TRDD-YL3EWT6N item 5). check-guards runs it.
"use strict"
const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { readStamp, stampText, surfaceFiles, run } = require("./stamp-surfaces.js")

let count = 0
function t(name, fn) {
  fn()
  count++
  console.log(`ok ${count} - ${name}`)
}

const STAMP = "# agentlenspro-version: 1.2.3"
const BASE = "---\nname: x\ndescription: d\n---\n\nbody\n---\nmore\n"
const STAMPED = `---\nname: x\ndescription: d\n${STAMP}\n---\n\nbody\n---\nmore\n`

t("an unstamped text gets the stamp as the last frontmatter line", () => {
  assert.strictEqual(stampText(BASE, "1.2.3"), STAMPED)
})
t("stamping a stamped text changes nothing", () => {
  assert.strictEqual(stampText(STAMPED, "1.2.3"), STAMPED)
})
t("an older stamp is replaced wherever it sat", () => {
  const old = "---\nname: x\n# agentlenspro-version: 1.0.0\ndescription: d\n---\n\nbody\n---\nmore\n"
  assert.strictEqual(stampText(old, "1.2.3"), STAMPED)
})
t("two stamps collapse to one", () => {
  const two = `---\n${STAMP}\nname: x\ndescription: d\n# agentlenspro-version: 0.9.0\n---\n\nbody\n---\nmore\n`
  assert.strictEqual(stampText(two, "1.2.3"), STAMPED)
})
t("a stamp-shaped line in the body is kept and is not read as the stamp", () => {
  const text = "---\nname: x\n---\n# agentlenspro-version: 0.0.1\n"
  assert.strictEqual(readStamp(text), null)
  assert.strictEqual(stampText(text, "1.2.3"), `---\nname: x\n${STAMP}\n---\n# agentlenspro-version: 0.0.1\n`)
})
t("readStamp reads the frontmatter stamp", () => {
  assert.strictEqual(readStamp(STAMPED), "1.2.3")
  assert.strictEqual(readStamp(BASE), null)
})
t("a text with no frontmatter is refused", () => {
  assert.throws(() => stampText("name: x\n", "1.2.3"), /no frontmatter/)
})
t("an unclosed frontmatter is refused", () => {
  assert.throws(() => stampText("---\nname: x\n", "1.2.3"), /never closed/)
})
t("a carriage return is refused", () => {
  assert.throws(() => stampText("---\r\nname: x\r\n---\r\n", "1.2.3"), /carriage return/)
})
t("a value that is not a version is refused", () => {
  assert.throws(() => stampText(BASE, "latest"), /not a version/)
})
t("on a tree: check fails unstamped and writes nothing, write stamps, check passes, a version bump fails check again", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-surfaces-"))
  try {
    const skill = path.join(root, "skills", "s1", "SKILL.md")
    const agent = path.join(root, "agents", "a1.md")
    const notes = path.join(root, "skills", "s1", "notes.md")
    const pkg = path.join(root, "package.json")
    fs.mkdirSync(path.join(root, "skills", "s1"), { recursive: true })
    fs.mkdirSync(path.join(root, "agents"))
    fs.writeFileSync(pkg, JSON.stringify({ name: "agentlenspro", version: "1.2.3" }))
    fs.writeFileSync(skill, BASE)
    fs.writeFileSync(notes, "not a surface\n")
    fs.writeFileSync(agent, BASE)
    fs.writeFileSync(path.join(root, "agents", "ignored.txt"), "not a surface\n")
    fs.writeFileSync(path.join(root, "skills", "loose-file"), "not a folder\n")
    assert.deepStrictEqual(surfaceFiles(root), [skill, agent])
    assert.strictEqual(run(["--check"], root), 1)
    assert.strictEqual(fs.readFileSync(agent, "utf8"), BASE)
    assert.strictEqual(fs.readFileSync(skill, "utf8"), BASE)
    assert.strictEqual(run(["--write"], root), 0)
    assert.strictEqual(fs.readFileSync(agent, "utf8"), STAMPED)
    assert.strictEqual(fs.readFileSync(skill, "utf8"), STAMPED)
    assert.strictEqual(fs.readFileSync(notes, "utf8"), "not a surface\n")
    assert.strictEqual(run(["--check"], root), 0)
    fs.writeFileSync(pkg, JSON.stringify({ name: "agentlenspro", version: "1.2.4" }))
    assert.strictEqual(run(["--check"], root), 1)
    assert.strictEqual(run([], root), 64)
    assert.strictEqual(run(["--write", "--check"], root), 64)
    fs.mkdirSync(path.join(root, "skills", "s2"))
    assert.throws(() => run(["--check"], root), /no SKILL.md/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
console.log(`test-stamp-surfaces: ${count} cases passed`)
