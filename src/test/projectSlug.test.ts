import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { projectSlugOf, resolveProjectSlugs, SLUG_MAX_LEN } from '../projectSlug'

// The shape is not invented: a real Claude Code 2.1.224 session was run from a 237-character path,
// and the directory it created under ~/.claude/projects was 207 characters — the naive slug's first
// 200 characters, then '-', then a 6-character hash ('4gwysy'). The hash is not reproducible from
// the path (md5/sha1/sha256/sha512, hex or base36, from either end, over the path or the slug: no
// match), which is exactly why resolution reads the directory instead of computing the name.
const LONG_PATH = '/private/tmp/slugtest-' + 'x'.repeat(60) + '/' + 'y'.repeat(60) + '/' + 'z'.repeat(60) + '/' + 'w'.repeat(40)
const REAL_DIR_NAME = projectSlugOf(LONG_PATH).slice(0, SLUG_MAX_LEN) + '-4gwysy'

function withRoot(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-slug-'))
  try { fn(root) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

suite('projectSlug — one definition of how Claude Code names a project directory', () => {
  test('a short path derives exactly, and an already-derived slug passes through unchanged', () => {
    assert.strictEqual(projectSlugOf('/Users/me/Code/AgentlensPro'), '-Users-me-Code-AgentlensPro')
    assert.strictEqual(projectSlugOf('-Users-me-Code-AgentlensPro'), '-Users-me-Code-AgentlensPro')
    assert.strictEqual(projectSlugOf('  '), '')
  })

  test('a short slug resolves without touching the disk at all', () => {
    // The roots given do not exist; a short path must never depend on reading them.
    assert.deepStrictEqual(
      resolveProjectSlugs('/Users/me/Code/AgentlensPro', ['/nonexistent-root-a', '/nonexistent-root-b']),
      ['-Users-me-Code-AgentlensPro'],
    )
  })

  test('an over-long path resolves to the truncated-and-hashed directory that really exists', () => {
    withRoot(root => {
      fs.mkdirSync(path.join(root, REAL_DIR_NAME))
      const naive = projectSlugOf(LONG_PATH)
      assert.ok(naive.length > SLUG_MAX_LEN, `fixture drift: naive slug is only ${naive.length} chars`)
      assert.notStrictEqual(REAL_DIR_NAME, naive, 'the real name must differ from the naive one, or this proves nothing')
      // Falsified against the pre-fix code, which returned the 245-char naive slug — a directory
      // that cannot exist, so every caller scanned nothing and reported an empty result as fact.
      assert.deepStrictEqual(resolveProjectSlugs(LONG_PATH, [root]), [REAL_DIR_NAME])
    })
  })

  test('an over-long path with no directory yet falls back to the naive slug, never to nothing', () => {
    withRoot(root => {
      const got = resolveProjectSlugs(LONG_PATH, [root])
      assert.deepStrictEqual(got, [projectSlugOf(LONG_PATH)])
      assert.ok(got[0] && got[0].length > 0, 'an empty result would make the caller scan every project')
    })
  })

  test('a naive slug of EXACTLY the boundary is still checked against disk', () => {
    withRoot(root => {
      // Claude Code's behaviour at exactly SLUG_MAX_LEN was not observed — only that 245 truncates.
      // So the boundary test is `< SLUG_MAX_LEN` and not `<=`: at exactly 200 the name may already
      // have been truncated-and-hashed, and skipping the disk read would resolve to a directory that
      // does not exist. Falsified by changing that one comparison to `<=`.
      const bare = '/' + 'a'.repeat(SLUG_MAX_LEN - 1)
      const naive = projectSlugOf(bare)
      assert.strictEqual(naive.length, SLUG_MAX_LEN)
      const hashed = naive + '-qqqqqq'
      fs.mkdirSync(path.join(root, hashed))
      assert.deepStrictEqual(resolveProjectSlugs(bare, [root]), [hashed])
    })
  })

  test('two projects sharing their first 200 characters both come back — the path cannot break that tie', () => {
    withRoot(root => {
      const head = projectSlugOf(LONG_PATH).slice(0, SLUG_MAX_LEN)
      fs.mkdirSync(path.join(root, head + '-aaaaaa'))
      fs.mkdirSync(path.join(root, head + '-bbbbbb'))
      const got = resolveProjectSlugs(LONG_PATH, [root])
      assert.deepStrictEqual(got.slice().sort(), [head + '-aaaaaa', head + '-bbbbbb'])
    })
  })

  test('a directory that merely shares the prefix without the separator is NOT a match', () => {
    withRoot(root => {
      // head + more path characters is a DIFFERENT project whose slug was not truncated here;
      // matching it would silently attribute another project's transcripts to this one.
      const head = projectSlugOf(LONG_PATH).slice(0, SLUG_MAX_LEN)
      fs.mkdirSync(path.join(root, head + 'zzzzzz'))
      assert.deepStrictEqual(resolveProjectSlugs(LONG_PATH, [root]), [projectSlugOf(LONG_PATH)])
    })
  })
})
