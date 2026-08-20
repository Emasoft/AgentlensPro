// Regenerates the bodyarchive fixture + bodyarchive-expected.json. The archive is WRITTEN by
// the COMPILED TS bodyArchive.js (the ONE writer implementation — the WAD format's design law)
// and READ by burn-side Rust (body_archive.rs), so the parity is cross-engine by construction:
// a TS-written volume must list, random-access and extract identically through the Rust reader.
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-bodyarchive-expected.mjs
import { createRequire } from 'module'
import { mkdirSync, writeFileSync, rmSync, appendFileSync, readFileSync, readdirSync } from 'fs'
import { join, basename } from 'path'
import { tmpdir } from 'os'
const require = createRequire(import.meta.url)
const { appendToArchive, listArchiveEntries, extractArchive } = require('../../../../../out/test/bodyArchive.js')
const dir = new URL('.', import.meta.url).pathname
const root = join(dir, 'bodyarchive-tree')
const arch = join(root, 'otel-bodies-archive')

rmSync(root, { recursive: true, force: true })
mkdirSync(arch, { recursive: true })

// Fixed capture times: two July 2026 lumps (one volume, second at offset>0) + one August lump
// (a second volume). Contents are ASCII JSON — compressible, byte-comparable.
const JULY_A = Date.UTC(2026, 6, 10, 12, 0, 0)
const JULY_B = Date.UTC(2026, 6, 20, 8, 30, 0)
const AUG_C = Date.UTC(2026, 7, 3, 9, 15, 0)
const bodies = {
  'aaaa1111.request.json': { m: JULY_A, text: JSON.stringify({ model: 'claude-fable-5', messages: [{ role: 'user', content: 'x'.repeat(600) }] }) },
  'bbbb2222.response.json': { m: JULY_B, text: JSON.stringify({ id: 'msg_b', usage: { cache_read_input_tokens: 1000 }, pad: 'y'.repeat(300) }) },
  'cccc3333.request.json': { m: AUG_C, text: JSON.stringify({ model: 'claude-opus-5', note: 'august lump', pad: 'z'.repeat(200) }) },
}
for (const [name, b] of Object.entries(bodies)) appendToArchive(arch, name, Buffer.from(b.text), b.m)
// A crash-truncated tail line on the July index — skipped by both readers, never fatal.
appendFileSync(join(arch, 'bodies-2026-07.wad.idx'), '{"n":"torn')

const J = (v) => JSON.parse(JSON.stringify(v))
const entries = listArchiveEntries(arch).map((e) => ({ ...e, volume: basename(e.volume) }))

// extractAll → the exact per-file bytes both engines must reproduce.
const destAll = join(tmpdir(), `bodyarchive-oracle-all-${process.pid}`)
rmSync(destAll, { recursive: true, force: true })
const all = extractArchive(arch, destAll)
const contents = {}
for (const f of readdirSync(destAll)) contents[f] = readFileSync(join(destAll, f), 'utf-8')

// A window that keeps ONLY the July 20 lump (the export route's e.mtimeMs >= since && <= until).
const since = JULY_B - 1000
const until = JULY_B + 1000
const destWin = join(tmpdir(), `bodyarchive-oracle-win-${process.pid}`)
rmSync(destWin, { recursive: true, force: true })
const win = extractArchive(arch, destWin, (e) => e.mtimeMs >= since && e.mtimeMs <= until)
const winNames = readdirSync(destWin).sort()
rmSync(destAll, { recursive: true, force: true })
rmSync(destWin, { recursive: true, force: true })

writeFileSync(join(dir, 'bodyarchive-expected.json'), JSON.stringify({
  entries: J(entries),
  extractAll: { files: all.files, bytes: all.bytes, contents },
  extractWindow: { files: win.files, bytes: win.bytes, names: winNames, since, until },
}, null, 1))
console.log(`bodyarchive-expected.json: ${entries.length} entries, extractAll ${all.files}/${all.bytes}B, window ${win.files}`)
