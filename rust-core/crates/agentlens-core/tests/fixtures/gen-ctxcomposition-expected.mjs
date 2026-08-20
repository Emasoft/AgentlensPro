// Regenerates ctxcomposition-expected.json (and the .jsonl transcripts it reads) from the COMPILED
// TS contextComposition.js — the parity oracle for context_composition.rs (freeze row 32).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-ctxcomposition-expected.mjs
//
// Both engines read the SAME committed transcripts under fixtures/claude-home/projects/, pointed
// at by CLAUDE_CONFIG_DIR — the one override both `claudeProjectsDirs()` implementations honour
// identically (comma-split, trim, drop empties, append `projects` unless already suffixed).
//
// Discriminators, and the porting mistake each catches:
//  - assistant DEDUP: a re-emitted message.id must NOT advance the turn counter, but an entry with
//    NO id always does. Getting this wrong shifts every attachment to the wrong turn.
//  - `hookName ? … : undefined` is TRUTHY, so an EMPTY hookName yields "hook: unknown", not "hook: ".
//  - `joinedText(addedBlocks) || joinedText(addedNames)` is `||`: empty blocks fall through to names.
//  - the file-name chain is NULLISH (`??`), so an empty-string displayPath is USED, not skipped.
//  - a 0-byte attachment is dropped entirely, even when its type is known.
//  - the TOP_SOURCES fold emits ONE "+N more sources" bucket with NO excerpt key.
//  - excerpt is capped by UTF-16 units (`.slice`) while the budget spends UTF-8 bytes.
import { createRequire } from 'module'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
const require = createRequire(import.meta.url)
const dir = new URL('.', import.meta.url).pathname
const home = join(dir, 'claude-home')
const projects = join(home, 'projects', 'proj-a')
mkdirSync(projects, { recursive: true })
// Must be set BEFORE the module resolves any session file — claudeProjectsDirs() reads it per call.
process.env.CLAUDE_CONFIG_DIR = home
const { buildContextComposition, classifyAttachment, findSessionFile, listSessionFileIds } =
  require('../../../../../out/test/contextComposition.js')

const L = (o) => JSON.stringify(o)
const asst = (id) => L(id === undefined ? { type: 'assistant', message: {} } : { type: 'assistant', message: { id } })
const att = (a) => L({ type: 'attachment', attachment: a })

// A transcript exercising turn attribution, dedup, and most of the taxonomy.
const own = [
  att({ type: 'skill_listing', content: 'skill catalog text' }),        // turn 1 (before any assistant)
  asst('m1'),
  asst('m1'),                                                            // DEDUP — must not advance
  att({ type: 'hook_additional_context', hookName: 'PreToolUse', content: 'hook body' }),
  att({ type: 'hook_success', hookName: '', stdout: 'out', stderr: 'err' }),   // empty hookName → "unknown"
  att({ type: 'hook_success', hookName: 'PreToolUse', content: 'more hook body' }), // SAME label → accumulates
  '',                                                                    // blank line, skipped
  'not json at all',                                                     // unparseable, skipped
  att({ type: 'deferred_tools_delta', addedLines: ['tool a', 'tool b'] }),
  att({ type: 'agent_listing_delta', addedLines: ['agent x'] }),
  att({ type: 'mcp_instructions_delta', addedBlocks: [], addedNames: ['srv-1', 'srv-2'] }), // || fallthrough
  att({ type: 'file', displayPath: '/a/b/report.md', content: 'file contents é multi-byte' }),
  att({ type: 'file', filename: '/x/y/fallback.txt', text: 'via filename' }),
  att({ type: 'file', path: '/p/q/third.txt', content: 'via path' }),
  att({ type: 'file', displayPath: '', content: 'empty displayPath is USED (nullish, not falsy)' }),
  att({ type: 'file', displayPath: '/z/empty.txt' }),                    // 0 bytes → DROPPED
  att({ type: 'task_reminder', content: 'remember the thing' }),
  att({ type: 'invoked_skills', content: 'skill a' }),
  att({ type: 'skill', content: 'skill b' }),
  att({ type: 'totally_unknown_kind', content: 'ignored' }),             // → null
  att({ type: 'hook_success', hookName: 'PostToolUse' }),                // 0 bytes → DROPPED
  asst(undefined),                                                       // NO id → always advances
  att({ type: 'task_reminder', content: 'turn 3 reminder' }),
]
writeFileSync(join(projects, 'comp-own.jsonl'), own.join('\n') + '\n')

// A parent transcript, for the fork fallback.
writeFileSync(join(projects, 'comp-parent.jsonl'),
  [asst('p1'), att({ type: 'task_reminder', content: 'parent reminder' })].join('\n') + '\n')

// 30 distinct sources in ONE turn → the TOP_SOURCES(24) fold to "+6 more sources".
const many = []
for (let i = 0; i < 30; i++) {
  // Descending sizes so the ranking is unambiguous and the fold takes a known tail.
  many.push(att({ type: 'file', displayPath: `/m/f${String(i).padStart(2, '0')}.txt`, content: 'x'.repeat(300 - i * 5) }))
}
writeFileSync(join(projects, 'comp-many.jsonl'), many.join('\n') + '\n')

const classifyCases = [
  { type: 'hook_additional_context', hookName: 'H', content: 'c' },
  { type: 'hook_success', hookName: '', stdout: 's' },
  { type: 'hook_success', hookName: 'H' },                      // 0 bytes → null
  { type: 'hook_non_blocking_error', response: 'r' },           // no hookName → "unknown"
  { type: 'async_hook_response', stderr: 'e' },
  { type: 'skill_listing', content: 'sk' },
  { type: 'skill_listing' },                                     // 0 bytes, but NOT null (no guard)
  { type: 'deferred_tools_delta', addedLines: 'a single string' },
  { type: 'deferred_tools_delta', addedLines: [1, 'two', null] }, // non-strings ignored
  { type: 'agent_listing_delta', addedLines: [] },
  { type: 'mcp_instructions_delta', addedBlocks: ['b'], addedNames: ['n'] },
  { type: 'mcp_instructions_delta', addedNames: ['only-names'] },
  { type: 'file', displayPath: '/a/b/c.txt', content: 'x' },
  { type: 'file', displayPath: 'C:\\win\\path.txt', content: 'x' },  // Windows separator
  { type: 'file', content: 'no name at all' },                        // → basename('file')
  { type: 'edited_text_file', filename: 'e.txt', text: 't' },
  { type: 'compact_file_reference', path: 'c.txt', content: 'c' },
  { type: 'task_reminder', content: 'tr' },
  { type: 'invoked_skills', content: 'is' },
  { type: 'skill', content: 's' },
  { type: 'nope' },
  { type: null },
  {},
]

const compCases = [
  { sessionId: 'comp-own', parent: undefined },
  { sessionId: 'comp-many', parent: undefined },
  { sessionId: 'comp-fork', parent: 'comp-parent' },      // no own log → reconstructedFrom parent
  { sessionId: 'comp-known-parent', parent: 'no-such-parent' },  // honest EMPTY, still tagged
  { sessionId: 'comp-orphan', parent: undefined },        // → null
  { sessionId: 'comp-parent', parent: 'comp-own' },       // own log WINS over the parent
]

const J = (v) => JSON.parse(JSON.stringify(v ?? null))
writeFileSync(join(dir, 'ctxcomposition-expected.json'), JSON.stringify({
  classifyCases: J(classifyCases),
  classified: classifyCases.map(c => J(classifyAttachment(c))),
  compCases: J(compCases),
  comps: await Promise.all(compCases.map(c => buildContextComposition(c.sessionId, c.parent).then(J))),
  // findSessionFile returns an absolute path; only its PRESENCE is compared, never the path text
  // (writing it would bake this machine's home directory into a committed fixture).
  found: ['comp-own', 'comp-parent', 'comp-many', 'nope'].map(id => findSessionFile(id) !== null),
  sessionFileIds: [...listSessionFileIds()].sort(),
}, null, 1))
console.log(`ctxcomposition-expected.json: ${classifyCases.length} classify + ${compCases.length} composition cases`)
