// The disk monitor's folder walker (src/cli/diskWalk.ts, TRDD-HTARKH87), on real temp trees.
//
// What is pinned: the with/without-symlink totals differ by exactly the targets, a link loop terminates,
// a hardlink is counted once, and a walk cut mid-way and resumed (even through a JSON round-trip of its
// state) ends with the same totals as one uninterrupted walk — the property that lets ~ and ~/Code finish
// over many runs.

import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { runSegment, startWalk, type WalkState } from "../cli/diskWalk"

const FAR = Date.now() + 3_600_000

function tmp(): { dir: string; cleanup: () => void } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "al-diskwalk-")))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

function walk(root: string): WalkState {
  const s = startWalk(root, Date.now())
  if ("error" in s) throw new Error(s.error)
  assert.strictEqual(runSegment(s, FAR), true)
  return s
}

function write(p: string, bytes: number): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, Buffer.alloc(bytes, 1))
}

suite("diskWalk — sizes with and without symlinks", () => {
  test("follow totals = plain + each distinct outside target once (loops, repeated links, inside links, hardlinks)", () => {
    const { dir, cleanup } = tmp()
    try {
      const root = path.join(dir, "root")
      const out = path.join(dir, "out")
      write(path.join(root, "a.txt"), 1000)
      write(path.join(root, "real", "f.bin"), 4000)
      write(path.join(root, "h1"), 700)
      fs.linkSync(path.join(root, "h1"), path.join(root, "h2")) // (d) a hardlinked pair inside the root
      write(path.join(out, "o1.bin"), 2000)
      write(path.join(out, "sub", "o2.bin"), 3000)
      write(path.join(out, "hl1"), 500)
      fs.linkSync(path.join(out, "hl1"), path.join(out, "hl2")) // a hardlinked pair inside the outside target
      for (const sparse of [path.join(root, "sparse.img"), path.join(out, "sparse.img")]) { fs.writeFileSync(sparse, ""); fs.truncateSync(sparse, 64 * 1024 * 1024) } // sparse: apparent >> allocated, so apparent alone can exceed the disk
      fs.symlinkSync(out, path.join(root, "l1")) // (b) two links to the same outside dir
      fs.symlinkSync(out, path.join(root, "l2"))
      fs.symlinkSync(path.join(out, "sub"), path.join(root, "l3")) // a link into a tree another link already follows, in either order
      fs.symlinkSync(path.join(root, "real"), path.join(root, "inside")) // (c) a link to a dir inside the root
      fs.symlinkSync(root, path.join(root, "loop")) // (a) loops: to the root, to an ancestor of the dir it sits in, and out of the target back in
      fs.symlinkSync(path.join(root, "real"), path.join(root, "real", "up"))
      fs.symlinkSync(root, path.join(out, "back"))
      fs.symlinkSync(dir, path.join(root, "anc")) // a link to a dir that CONTAINS the root: following it would count the root again
      const plain = walk(root).totals
      const follow = plain.apparentFollow
      const outside = walk(out).totals // the outside dir walked as a root: exactly what following it must add, once
      assert.strictEqual(follow, plain.apparent + outside.apparent, "outside dir counted exactly once on top of the plain totals")
      assert.ok(follow <= plain.apparent + outside.apparent, "never above plain + the distinct outside targets")
      assert.strictEqual(plain.allocatedFollow, plain.allocated + outside.allocated, "same on the allocated (on-disk) view, the one that is compared with the volume size")
      assert.ok(plain.apparentFollow > plain.apparent, "something outside was followed")
    } finally { cleanup() }
  })

  test("a link to a file outside the root adds it once, a link to a file inside adds nothing", () => {
    const { dir, cleanup } = tmp()
    try {
      const root = path.join(dir, "root")
      write(path.join(root, "a.txt"), 1000)
      write(path.join(dir, "far.bin"), 6000)
      fs.symlinkSync(path.join(root, "a.txt"), path.join(root, "inside-link"))
      fs.symlinkSync(path.join(dir, "far.bin"), path.join(root, "far1"))
      fs.symlinkSync(path.join(dir, "far.bin"), path.join(root, "far2"))
      const t = walk(root).totals
      assert.strictEqual(t.apparentFollow - t.apparent, 6000)
    } finally { cleanup() }
  })

  test("the followed set survives a JSON round-trip and a link to an already-followed target adds nothing after the resume", () => {
    const { dir, cleanup } = tmp()
    try {
      const root = path.join(dir, "root")
      const out = path.join(dir, "out")
      write(path.join(out, "o.bin"), 2500)
      for (let i = 0; i < 4; i++) write(path.join(root, `d${i}`, "f.bin"), 100)
      fs.symlinkSync(out, path.join(root, "d0", "l1"))
      fs.symlinkSync(out, path.join(root, "d3", "l2"))
      const whole = walk(root).totals
      const s = startWalk(root, Date.now())
      if ("error" in s) throw new Error(s.error)
      let guard = 0
      while (s.followed.length === 0 && guard++ < 10) runSegment(s, FAR, 1)
      assert.strictEqual(s.followed.length, 1, "the first link taken on is recorded")
      const revived: WalkState = JSON.parse(JSON.stringify(s))
      assert.strictEqual(runSegment(revived, FAR), true)
      assert.deepStrictEqual(revived.totals, whole, "resumed walk equals the uninterrupted one: the second link was not followed again")
      assert.strictEqual(revived.followed.length, 1)
    } finally { cleanup() }
  })
  test("a hardlinked file is counted once", () => {
    const { dir, cleanup } = tmp()
    try {
      write(path.join(dir, "h1"), 700)
      const one = walk(dir).totals
      fs.linkSync(path.join(dir, "h1"), path.join(dir, "h2"))
      const two = walk(dir).totals
      assert.strictEqual(two.apparent - one.apparent, 0)
      assert.strictEqual(two.files, one.files)
    } finally { cleanup() }
  })

  test("a missing root is an error string, never a zero-size result", () => {
    const s = startWalk(path.join(os.tmpdir(), "al-diskwalk-does-not-exist"), Date.now())
    assert.ok("error" in s && /ENOENT/.test(s.error))
  })
})

suite("diskWalk — resumable", () => {
  test("a walk cut after N directories and resumed through a JSON round-trip equals an uninterrupted walk", () => {
    const { dir, cleanup } = tmp()
    try {
      for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) write(path.join(dir, `d${i}`, `e${j}`, "f.bin"), 100 * (i + 1) + j)
      const whole = walk(dir).totals
      const s = startWalk(dir, Date.now())
      if ("error" in s) throw new Error(s.error)
      assert.strictEqual(runSegment(s, FAR, 4), false, "cut after 4 directories")
      assert.ok(s.pending.length > 0 && s.totals.files > 0, "partial progress and a stack left to resume")
      const revived: WalkState = JSON.parse(JSON.stringify(s))
      assert.strictEqual(runSegment(revived, FAR), true)
      assert.deepStrictEqual(revived.totals, whole)
    } finally { cleanup() }
  })
})
