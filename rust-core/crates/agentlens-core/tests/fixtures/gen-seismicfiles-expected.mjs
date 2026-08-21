// Regenerates seismicfiles-expected.json from the COMPILED src/burnSeismic.ts — the parity oracle
// for `resolveSeismicFiles` (TRDD-DMWOBWFH P4x.2s). Also (re)writes the small fixture tree it scans.
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-seismicfiles-expected.mjs
//
// MTIME ORACLE: selection is an mtime window against wall-clock now and the result is SORTED by
// mtime, so git (which drops mtimes) would otherwise decide both which files are selected and in
// what order. The generator stamps each file at a fixed offset from now and publishes the offsets;
// the Rust test re-stamps before scanning.
//
// PATH REDACTION: the result is a list of ABSOLUTE paths. The fixture root is replaced by the token
// `<FIXTURES>` and rewritten by the test — otherwise the oracle embeds a home path and the identity
// gate refuses the commit the moment it is staged.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TREE = path.join(HERE, 'seismicfiles')
const NOW = Date.now()

const { resolveSeismicFiles } = await import(path.join(HERE, '../../../../../out/test/burnSeismic.js'))

// Two bases, because Claude Code can carry more than one projects root and the fleet scan must
// cover all of them. Slugs are what `projectSlugOf` produces for `/w/one` and `/w/two`.
// hours BEFORE now.
const OFFSETS = {
  'base1/-w-one/aaaaaaaa-1111-2222-3333-444444444444.jsonl': 1,
  'base1/-w-one/bbbbbbbb-1111-2222-3333-444444444444.jsonl': 3,
  // NOT uuid-shaped: excluded from a fleet scan unless includeSubagents, which is the only thing
  // that distinguishes a spawner's transcript from a stray file at this level.
  'base1/-w-one/notauuid.jsonl': 2,
  'base1/-w-one/subagents/agent-cccccccc.jsonl': 4,
  'base1/-w-two/dddddddd-1111-2222-3333-444444444444.jsonl': 5,
  'base2/-w-one/eeeeeeee-1111-2222-3333-444444444444.jsonl': 6,
  // Far outside every window used below — the only file the mtime floor should ever exclude.
  'base2/-w-one/ffffffff-1111-2222-3333-444444444444.jsonl': 400,
  // Not a transcript at all.
  'base1/-w-one/notes.txt': 1,
}

for (const [rel, hours] of Object.entries(OFFSETS)) {
  const p = path.join(TREE, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, '{"type":"assistant"}\n')
  const t = (NOW - hours * 3_600_000) / 1000
  fs.utimesSync(p, t, t)
}

const DIRS = [path.join(TREE, 'base1'), path.join(TREE, 'base2')]
const redact = (v) => JSON.parse(JSON.stringify(v).split(TREE).join('<FIXTURES>'))

const cases = {}
const run = (name, opts) => {
  cases[name] = { opts, out: redact(resolveSeismicFiles({ ...opts, projectsDirs: DIRS })) }
}

const SINCE_24H = NOW - 24 * 3_600_000

run('fleet_default', { scope: 'fleet', sinceMs: SINCE_24H })
run('fleet_with_subagents', { scope: 'fleet', sinceMs: SINCE_24H, includeSubagents: true })
// The cap keeps the MOST RECENT files, which is the whole reason the sort precedes the slice.
run('fleet_capped', { scope: 'fleet', sinceMs: SINCE_24H, maxFiles: 2 })
run('fleet_cap_zero', { scope: 'fleet', sinceMs: SINCE_24H, maxFiles: 0 })
// A window narrower than the mtime SLACK still admits everything inside slack+window: the slack is
// an hour, so a 0-hour window still reaches files touched within the last hour.
run('fleet_narrow_window', { scope: 'fleet', sinceMs: NOW })
run('fleet_wide_window', { scope: 'fleet', sinceMs: NOW - 500 * 3_600_000 })
run('workspace_one', { scope: 'workspace', workspace: '/w/one', sinceMs: SINCE_24H })
run('workspace_one_subagents', { scope: 'workspace', workspace: '/w/one', sinceMs: SINCE_24H, includeSubagents: true })
run('workspace_two', { scope: 'workspace', workspace: '/w/two', sinceMs: SINCE_24H })
run('workspace_unknown', { scope: 'workspace', workspace: '/w/nope', sinceMs: SINCE_24H })
run('workspace_missing_arg', { scope: 'workspace', sinceMs: SINCE_24H })
// A slug passed directly (no separator) is used as-is rather than being slugified again.
run('workspace_as_slug', { scope: 'workspace', workspace: '-w-one', sinceMs: SINCE_24H })
run('session_exact', { scope: 'session', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', sinceMs: SINCE_24H })
// A PREFIX — how every other surface here refers to a session.
run('session_prefix', { scope: 'session', sessionId: 'aaaaaaaa', sinceMs: SINCE_24H })
// The session scope ignores the mtime window: an explicitly named session is wanted however old.
run('session_old_file', { scope: 'session', sessionId: 'ffffffff', sinceMs: NOW })
run('session_missing_arg', { scope: 'session', sinceMs: SINCE_24H })
run('session_unknown', { scope: 'session', sessionId: 'zzzzzzzz', sinceMs: SINCE_24H })

const out = { now: NOW, offsets: OFFSETS, cases }
fs.writeFileSync(path.join(HERE, 'seismicfiles-expected.json'), JSON.stringify(out, null, 2) + '\n')
console.log('wrote seismicfiles-expected.json')
for (const [k, v] of Object.entries(cases)) {
  console.log(` ${k}: ${v.out.length} file(s)`)
}
