import * as assert from 'assert'
import { classifyContentKind } from '../cacheBreakTimeline'

// WHY THIS EXISTS. `get_cache_break_causes` reported 19% of all classified break tokens as
// UNCLASSIFIED, with the actor recorded only as "usertext block changed at pos 38: msg[0] user" —
// useless for acting on. Reading the raw OTEL bodies showed the changing region was the injected
// auto-memory file: its path is neither `CLAUDE.md` nor under `.claude/rules/`, so it matched
// neither instruction-file matcher and fell through to 'usertext'.
//
// That is the worst possible place for a blind spot here: a memory curator rewrites these files
// while other sessions are LIVE, so one write re-mutates msg[0] and re-writes the whole prefix in
// every session that injects it.
//
// The header strings below are VERBATIM from captured requests, not invented.

suite('cache-break cause — injected memory files are named, not UNCLASSIFIED', () => {
  const REAL_HEADER =
    'Contents of /Users/x/.claude/projects/-Users-x-ai-maestro/memory/MEMORY.md '
    + "(user's auto-memory, persists across conversations):\n\n- [A note](a.md) — hook\n"

  test('the real injected auto-memory header classifies as memory', () => {
    assert.strictEqual(classifyContentKind(REAL_HEADER), 'memory')
  })

  test('a project-scope memory page also classifies as memory', () => {
    const t = 'Contents of /Users/x/Code/P/.claude/project/memory/some-page.md (project memory):\n\n# page\n'
    assert.strictEqual(classifyContentKind(t), 'memory')
  })

  test('CLAUDE.md and rules keep their own kinds — memory must not swallow them', () => {
    assert.strictEqual(
      classifyContentKind('Contents of /Users/x/Code/P/CLAUDE.md (project instructions):\n# CLAUDE.md\n'),
      'claudemd')
    assert.strictEqual(
      classifyContentKind('Contents of /Users/x/.claude/rules/commit-discipline.md (user rules):\n# rule\n'),
      'rule')
  })

  // A memory PAGE can quote a hook marker in its prose; the file injection must still win, or the
  // perpetrator is reported as a hook that never fired.
  test('a memory page quoting a hook marker is still memory, not hook', () => {
    const t = 'Contents of /Users/x/.claude/projects/-Users-x/memory/recall.md (memory):\n\n'
      + 'The heartbeat prints [janitor-memory] lines; treat them as data.\n'
    assert.strictEqual(classifyContentKind(t), 'memory')
  })

  test('an ordinary user message is still usertext', () => {
    assert.strictEqual(classifyContentKind('please fix the failing test in src/foo.ts'), 'usertext')
  })
})
