import * as assert from 'assert'
import * as path from 'path'
import { pickMountFsType, classifyWorktree } from '../environment/filesystem'

const MOUNT_OUTPUT = [
  '/dev/disk1 on / (apfs, local, journaled)',
  '/dev/disk2 on /Users (hfs, local, journaled, noexec)',
].join('\n')

suite('environment/filesystem — pure helpers (TRDD-HUWJVQJA)', () => {
  test('pickMountFsType picks the only matching mountpoint (root) when no longer prefix exists', () => {
    // '/tmp/foo' is only a prefix of '/' — the '/Users' line must not match.
    assert.strictEqual(pickMountFsType(MOUNT_OUTPUT, '/tmp/foo'), 'apfs')
  })

  test('pickMountFsType prefers the LONGEST matching mountpoint over a shorter one', () => {
    // '/Users/x/proj' matches both '/' and '/Users' — the longer wins (hfs, not apfs).
    assert.strictEqual(pickMountFsType(MOUNT_OUTPUT, '/Users/x/proj'), 'hfs')
  })

  test('pickMountFsType does not match a sibling path with the same string prefix', () => {
    // '/Users2/foo' shares the string prefix '/Users' but is not a path-segment child of it —
    // must fall back to the root mount, not false-positive on the substring.
    assert.strictEqual(pickMountFsType(MOUNT_OUTPUT, '/Users2/foo'), 'apfs')
  })

  test('pickMountFsType returns unknown when no mountpoint is a prefix of the target', () => {
    const noRootOutput = '/dev/disk2 on /Users (hfs, local)'
    assert.strictEqual(pickMountFsType(noRootOutput, '/opt/foo'), 'unknown')
  })

  test('pickMountFsType returns unknown for empty mount output', () => {
    assert.strictEqual(pickMountFsType('', '/anything'), 'unknown')
  })

  test('classifyWorktree returns main when gitDir and commonDir resolve equal', () => {
    assert.strictEqual(classifyWorktree('/repo/.git', '/repo/.git'), 'main')
  })

  test('classifyWorktree returns linked when gitDir and commonDir resolve different', () => {
    assert.strictEqual(
      classifyWorktree('/repo/.git/worktrees/feat', '/repo/.git'),
      'linked',
    )
  })

  test('classifyWorktree resolves relative paths before comparing (relative == absolute of same dir)', () => {
    const absolute = path.resolve('.git')
    assert.strictEqual(classifyWorktree('.git', absolute), 'main')
  })
})
