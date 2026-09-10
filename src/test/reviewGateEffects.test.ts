import * as assert from 'assert'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { unreviewedEffects, defaultWatchedSet, reflogEpochMs } from '../cli/reviewGateEffects'
import type { Activity } from '../cli/reviewGateEffects'

// Real tmp git repos, no mocks — the review gate's whole job is reading a real filesystem and a
// real `git status`, so a fake would test nothing about the thing that actually breaks (TRDD-9FG0LSPG).

const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

suite('review-gate effects: unreviewedEffects', () => {
  let root: string
  let repo: string

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'al-effects-'))
    repo = path.join(root, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'x@example.com')
    git(repo, 'config', 'user.name', 'x')
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'v1\n')
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'init')
  })

  teardown(() => { fs.rmSync(root, { recursive: true, force: true }) })

  test('a tracked file edited with an mtime after T is listed', () => {
    const t = Date.now()
    const p = path.join(repo, 'tracked.txt')
    fs.writeFileSync(p, 'v2\n')
    const future = new Date(t + 60_000)
    fs.utimesSync(p, future, future)
    const { paths } = unreviewedEffects(repo, t, { watched: [] })
    assert.ok(paths.includes('tracked.txt'), paths.join(','))
  })

  test('a tracked file edited with an mtime before T is not listed', () => {
    const p = path.join(repo, 'tracked.txt')
    fs.writeFileSync(p, 'v2\n')
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(p, past, past)
    const t = Date.now()
    const { paths } = unreviewedEffects(repo, t, { watched: [] })
    assert.ok(!paths.includes('tracked.txt'), paths.join(','))
  })

  test('a path ignored by .gitignore is never listed, even edited after T', () => {
    const t = Date.now()
    const p = path.join(repo, 'ignored.txt')
    fs.writeFileSync(p, 'v1\n')
    const future = new Date(t + 60_000)
    fs.utimesSync(p, future, future)
    const { paths } = unreviewedEffects(repo, t, { watched: [] })
    assert.ok(!paths.includes('ignored.txt'), paths.join(','))
  })

  test('a git commit landing after T surfaces the literal path HEAD', () => {
    // git's committer time (%ct) is whole UNIX SECONDS, so T must sit at least a full second
    // before the commit or the truncated commit time can equal T without exceeding it.
    const t = Date.now() - 2500
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'v2\n')
    git(repo, 'commit', '-q', '-a', '-m', 'second')
    const { paths } = unreviewedEffects(repo, t, { watched: [] })
    assert.ok(paths.includes('HEAD'), paths.join(','))
  })

  test('a checkout to an OLDER commit performed after T surfaces HEAD (backward move)', () => {
    // %ct alone only catches a commit newer than T; a checkout to an older commit moves HEAD
    // without any commit newer than T existing, so it needs the reflog's own move timestamp.
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'v2\n')
    git(repo, 'commit', '-q', '-a', '-m', 'second')
    const first = git(repo, 'rev-list', '--max-parents=0', 'HEAD').trim()
    // git's reflog timestamp is whole UNIX SECONDS too — same 2.5s margin as the commit test above.
    const t = Date.now() - 2500
    git(repo, 'checkout', '-q', first)
    const { paths } = unreviewedEffects(repo, t, { watched: [] })
    assert.ok(paths.includes('HEAD'), paths.join(','))
  })

  test('a watched file touched after T is listed; before T it is not', () => {
    const watchedFile = path.join(root, 'watched.txt')
    fs.writeFileSync(watchedFile, 'v1\n')
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(watchedFile, past, past)
    const t1 = Date.now()
    let r = unreviewedEffects(repo, t1, { watched: [watchedFile] })
    assert.ok(!r.paths.includes(watchedFile), r.paths.join(','))

    const future = new Date(Date.now() + 60_000)
    fs.utimesSync(watchedFile, future, future)
    const t2 = Date.now()
    r = unreviewedEffects(repo, t2, { watched: [watchedFile] })
    assert.ok(r.paths.includes(watchedFile), r.paths.join(','))
  })

  test('a build-output path (standalone/*.js) modified after T is excluded', () => {
    const t = Date.now()
    fs.mkdirSync(path.join(repo, 'standalone'))
    const p = path.join(repo, 'standalone', 'x.js')
    fs.writeFileSync(p, 'bundle\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'build output tracked once')
    fs.writeFileSync(p, 'bundle v2\n')
    const future = new Date(t + 60_000)
    fs.utimesSync(p, future, future)
    const { paths } = unreviewedEffects(repo, t, { watched: [] })
    assert.ok(!paths.includes('standalone/x.js'), paths.join(','))
  })

  test('a deleted tracked file: parent dir mtime before T means NOT listed (no livelock)', () => {
    // POSIX unlink bumps the parent dir's mtime; backdating the parent past T simulates a
    // deletion a PRIOR fork already covered — it must not re-arm the gate forever.
    fs.rmSync(path.join(repo, 'tracked.txt'))
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(repo, past, past)
    const t = Date.now()
    const { paths } = unreviewedEffects(repo, t, { watched: [] })
    assert.ok(!paths.includes('tracked.txt'), paths.join(','))
  })

  test('a deleted tracked file: parent dir mtime after T means listed', () => {
    const t = Date.now()
    fs.rmSync(path.join(repo, 'tracked.txt')) // the unlink itself bumps repo/'s mtime past t
    const { paths } = unreviewedEffects(repo, t, { watched: [] })
    assert.ok(paths.includes('tracked.txt'), paths.join(','))
  })

  test('a whole tracked DIRECTORY removed: climbs to cwd when its own parent is gone too', () => {
    // `path.dirname(rel)` ('subdir') no longer exists after `rm -r` — must climb one more
    // level to `repo` (cwd) itself rather than fail-closed-keep at the missing 'subdir' level.
    fs.mkdirSync(path.join(repo, 'subdir'))
    fs.writeFileSync(path.join(repo, 'subdir', 'file.txt'), 'v1\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'add subdir')

    const past = new Date(Date.now() - 60_000)
    fs.rmSync(path.join(repo, 'subdir'), { recursive: true })
    fs.utimesSync(repo, past, past)
    const t1 = Date.now()
    let r = unreviewedEffects(repo, t1, { watched: [] })
    assert.ok(!r.paths.includes('subdir/file.txt'), r.paths.join(','))

    // Redo with the parent (repo) mtime after T instead.
    fs.mkdirSync(path.join(repo, 'subdir2'))
    fs.writeFileSync(path.join(repo, 'subdir2', 'file.txt'), 'v1\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'add subdir2')
    const t2 = Date.now()
    fs.rmSync(path.join(repo, 'subdir2'), { recursive: true }) // bumps repo/'s mtime past t2
    r = unreviewedEffects(repo, t2, { watched: [] })
    assert.ok(r.paths.includes('subdir2/file.txt'), r.paths.join(','))
  })

  test('maxEntries: 1 on a watched dir with 3 files truncates the walk', () => {
    const dir = path.join(root, 'watched-dir')
    fs.mkdirSync(dir)
    for (const name of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(dir, name), 'x\n')
    const t = Date.now()
    const { truncated } = unreviewedEffects(repo, t, { watched: [dir], maxEntries: 1 })
    assert.strictEqual(truncated, true)
  })

  test('a watched root containing a symlinked dir: a file inside it after T is listed', () => {
    const watchedDir = path.join(root, 'watched-root')
    const realDir = path.join(root, 'real-target')
    fs.mkdirSync(watchedDir)
    fs.mkdirSync(realDir)
    const target = path.join(realDir, 'inner.txt')
    fs.writeFileSync(target, 'v1\n')
    fs.symlinkSync(realDir, path.join(watchedDir, 'linked'))
    const t = Date.now()
    const future = new Date(t + 60_000)
    fs.utimesSync(target, future, future)
    const { paths } = unreviewedEffects(repo, t, { watched: [watchedDir] })
    assert.ok(paths.includes(path.join(watchedDir, 'linked', 'inner.txt')), paths.join(','))
  })

  test('a symlink two levels deep (inside a real subdir of a watched root) is NOT followed', () => {
    const watchedDir = path.join(root, 'watched-root-2')
    const realDir = path.join(root, 'real-target-2')
    fs.mkdirSync(watchedDir)
    const subDir = path.join(watchedDir, 'subdir') // real dir, direct child of the watched root
    fs.mkdirSync(subDir)
    fs.mkdirSync(realDir)
    const target = path.join(realDir, 'inner.txt')
    fs.writeFileSync(target, 'v1\n')
    fs.symlinkSync(realDir, path.join(subDir, 'linked')) // the symlink itself is at depth 1
    const t = Date.now()
    const future = new Date(t + 60_000)
    fs.utimesSync(target, future, future)
    const { paths } = unreviewedEffects(repo, t, { watched: [watchedDir] })
    assert.ok(!paths.some((p) => p.includes('inner.txt')), paths.join(','))
  })

  test('a depth-0 symlink pointing at the watched root\'s own parent is not walked', () => {
    // The watched root's parent CONTAINS the watched root itself, so following in would turn
    // the bounded one-level follow into an unbounded walk of `root` (and everything under it,
    // including `repo`) — the guard must refuse it, not just eventually hit maxEntries.
    const watchedDir = path.join(root, 'watched-root-3')
    fs.mkdirSync(watchedDir)
    fs.symlinkSync(root, path.join(watchedDir, 'linked'))
    const t = Date.now()
    const { paths, truncated } = unreviewedEffects(repo, t, { watched: [watchedDir] })
    assert.strictEqual(truncated, false)
    // 'HEAD' may legitimately appear (the setup commit can land within the same rounded-up
    // second as `t`) — irrelevant to this test, which is only about the symlink walk.
    assert.deepStrictEqual(paths.filter((p) => p !== 'HEAD'), [])
  })

  test('a dangling symlink at depth 0 in a watched root is skipped, never throws', () => {
    const watchedDir = path.join(root, 'watched-root-4')
    fs.mkdirSync(watchedDir)
    fs.symlinkSync(path.join(root, 'does-not-exist'), path.join(watchedDir, 'broken'))
    const t = Date.now()
    assert.doesNotThrow(() => unreviewedEffects(repo, t, { watched: [watchedDir] }))
    const { paths, truncated } = unreviewedEffects(repo, t, { watched: [watchedDir] })
    assert.strictEqual(truncated, false)
    assert.deepStrictEqual(paths.filter((p) => p !== 'HEAD'), [])
  })

  test('a non-git cwd yields only watched-set paths and never throws', () => {
    const notARepo = path.join(root, 'plain-dir')
    fs.mkdirSync(notARepo)
    const watchedFile = path.join(root, 'watched2.txt')
    fs.writeFileSync(watchedFile, 'v1\n')
    const t = Date.now()
    const future = new Date(t + 60_000)
    fs.utimesSync(watchedFile, future, future)
    const { paths } = unreviewedEffects(notARepo, t, { watched: [watchedFile] })
    assert.deepStrictEqual(paths, [watchedFile])
  })
})

// Attribution (TRDD-3U8AIHXK): a path only counts if its mtime falls inside one of THIS
// session's tool-activity intervals — otherwise a machine-global writer (another session's
// guard, a plugin update) re-arms an idle gate for nothing it did.
suite('unreviewedEffects — attribution (TRDD-3U8AIHXK)', () => {
  let root: string
  let repo: string

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'al-attrib-'))
    repo = path.join(root, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'x@example.com')
    git(repo, 'config', 'user.name', 'x')
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'v1\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'init')
  })

  teardown(() => { fs.rmSync(root, { recursive: true, force: true }) })

  test('a file write is listed only when it falls inside an activity interval', () => {
    const t = Date.now() - 2500
    const p = path.join(repo, 'tracked.txt')
    fs.writeFileSync(p, 'v2\n')
    const w = fs.statSync(p).mtimeMs
    const covering: Activity[] = [{ start: w - 5000, end: w + 5000 }]
    assert.ok(unreviewedEffects(repo, t, { watched: [], activity: covering }).paths.includes('tracked.txt'))
    const before: Activity[] = [{ start: w - 60000, end: w - 30000 }]
    assert.ok(!unreviewedEffects(repo, t, { watched: [], activity: before }).paths.includes('tracked.txt'))
    assert.ok(!unreviewedEffects(repo, t, { watched: [], activity: [] }).paths.includes('tracked.txt'))
  })

  test('a two-interval fixture lists the file when the SECOND interval covers it (guards `some` over `every`)', () => {
    const t = Date.now() - 2500
    const p = path.join(repo, 'tracked.txt')
    fs.writeFileSync(p, 'v2\n')
    const w = fs.statSync(p).mtimeMs
    const farPast: Activity = { start: w - 500_000, end: w - 400_000 }
    const covering: Activity = { start: w - 5000, end: w + 5000 }
    assert.ok(unreviewedEffects(repo, t, { watched: [], activity: [farPast, covering] }).paths.includes('tracked.txt'))
  })

  test('a covering interval lists the file even when its mtime is OLDER than t was captured for (guards `fresh` ignoring sinceMs)', () => {
    // `freshness` ANDs the two conditions — `ms > sinceMs` still gates a covering interval, so a
    // covering interval alone must not be enough. This pins the AND, not an OR: `t` here is set
    // AFTER the file's own mtime, so `sinceMs` alone would already exclude it.
    const p = path.join(repo, 'tracked.txt')
    fs.writeFileSync(p, 'v2\n')
    const w = fs.statSync(p).mtimeMs
    const past = new Date(w - 60_000)
    fs.utimesSync(p, past, past)
    const olderMtime = fs.statSync(p).mtimeMs
    const t = Date.now() - 2500 // AFTER olderMtime — sinceMs alone would exclude it
    const covering: Activity = { start: olderMtime - 5000, end: olderMtime + 5000 }
    assert.ok(!unreviewedEffects(repo, t, { watched: [], activity: [covering] }).paths.includes('tracked.txt'),
      'sinceMs must still gate a covering interval — fresh is an AND, not an OR')
  })

  test('HEAD is listed only when a covering interval spans the commit second', () => {
    const t = Date.now() - 2500
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'v2\n')
    git(repo, 'commit', '-q', '-a', '-m', 'second')
    const nowMs = Date.now()
    const covering: Activity[] = [{ start: nowMs - 5000, end: nowMs + 5000 }]
    assert.ok(unreviewedEffects(repo, t, { watched: [], activity: covering }).paths.includes('HEAD'))
    const before: Activity[] = [{ start: nowMs - 60000, end: nowMs - 30000 }]
    assert.ok(!unreviewedEffects(repo, t, { watched: [], activity: before }).paths.includes('HEAD'))
  })

  test('a deletion is listed only when a covering interval spans the parent dir\'s mtime', () => {
    const t = Date.now() - 2500
    fs.rmSync(path.join(repo, 'tracked.txt')) // bumps repo/'s mtime — D
    const d = fs.statSync(repo).mtimeMs
    const covering: Activity[] = [{ start: d - 5000, end: d + 5000 }]
    assert.ok(unreviewedEffects(repo, t, { watched: [], activity: covering }).paths.includes('tracked.txt'))
    const before: Activity[] = [{ start: d - 60000, end: d - 30000 }]
    assert.ok(!unreviewedEffects(repo, t, { watched: [], activity: before }).paths.includes('tracked.txt'))
  })

  test('the maxEntries guard still truncates with an empty activity set', () => {
    const dir = path.join(root, 'watched-dir')
    fs.mkdirSync(dir)
    for (const name of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(dir, name), 'x\n')
    const t = Date.now()
    const { truncated } = unreviewedEffects(repo, t, { watched: [dir], maxEntries: 1, activity: [] })
    assert.strictEqual(truncated, true)
  })

  test('~/.claude/hooks/state/ is excluded from the watched walk; ~/.claude/hooks/ itself is not', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-home-'))
    const stateDir = path.join(home, '.claude', 'hooks', 'state')
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(path.join(stateDir, 'x.log'), 'v1\n')
    fs.writeFileSync(path.join(home, '.claude', 'hooks', 'y.py'), 'v1\n')
    const t = Date.now() - 2500
    const nowMs = Date.now()
    const covering: Activity[] = [{ start: nowMs - 5000, end: nowMs + 5000 }]
    const watched = defaultWatchedSet(repo, home)
    // `home` MUST be passed explicitly: `excluded` is built from `opts.home ?? os.homedir()`, so
    // omitting it would exclude the REAL home's hooks/state/, not this tmp one, and the second
    // assertion below would pass for the wrong reason (or fail outright).
    const { paths } = unreviewedEffects(repo, t, { watched, activity: covering, home })
    assert.ok(paths.some((p) => p.endsWith('y.py')), paths.join(','))
    assert.ok(!paths.some((p) => p.includes(path.join('hooks', 'state'))), paths.join(','))
    fs.rmSync(home, { recursive: true, force: true })
  })
})

suite('review-gate effects: reflogEpochMs', () => {
  test('an epoch-shaped reflog ordinal (9+ digits) parses to milliseconds', () => {
    assert.strictEqual(reflogEpochMs('HEAD@{1788955088}'), 1788955088 * 1000)
  })

  test('the bare ordinal form HEAD@{0} is not mistaken for an epoch — returns null', () => {
    assert.strictEqual(reflogEpochMs('HEAD@{0}'), null)
  })

  test('empty input returns null', () => {
    assert.strictEqual(reflogEpochMs(''), null)
  })
})

suite('review-gate effects: defaultWatchedSet', () => {
  test('includes the fixed home- and cwd-anchored entries and the project slug dirs', () => {
    const home = '/home/x'
    const cwd = '/proj/sub'
    const out = defaultWatchedSet(cwd, home)
    assert.ok(out.includes(path.join(home, '.claude', 'CLAUDE.md')))
    assert.ok(out.includes(path.join(cwd, '.mcp.json')))
    const slug = cwd.replace(/[^A-Za-z0-9]/g, '-')
    assert.ok(out.includes(path.join(home, '.claude', 'projects', slug, 'memory')))
    assert.ok(out.includes(path.join(home, '.claude', 'projects', slug, 'design')))
  })
})
