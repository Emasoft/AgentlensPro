// src/test/ingestOptIn.test.ts — the AGENTLENS_INGEST opt-in: default-off argv, the resolver rungs,
// and the fail-soft warning. Real files in temp dirs; no mocks of the logic under test.

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { alcoreServeArgs, ingestArgs, resetIngestWarnings } from '../cli/serverControl'
import { aldigestBin, defaultRepoRoot, ingestManifestPath } from '../rustBinResolve'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-ingest-'))
const exe = (p: string): string => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 }); return p }
const file = (p: string): string => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '{}'); return p }
const valueOf = (argv: string[], flag: string): string | undefined => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }
const BASE = { OTLP_PORT: '4318', UI_PORT: '3000', MCP_PORT: '4316' }
const ALC = exe(path.join(tmp, 'alc', 'alcore')) // any resolvable alcore: the ingest branch needs one
const ON = { ...BASE, AGENTLENS_ALCORE: ALC, AGENTLENS_INGEST: 'on' }

/** Runs `fn` capturing what it writes to stderr. */
function captureStderr<T>(fn: () => T): { result: T; err: string } {
  const orig = process.stderr.write.bind(process.stderr)
  let err = ''
  process.stderr.write = ((s: string | Uint8Array) => { err += String(s); return true }) as typeof process.stderr.write
  try { return { result: fn(), err } } finally { process.stderr.write = orig }
}

suite('ingest opt-in', () => {
  setup(() => resetIngestWarnings())

  test('AGENTLENS_INGEST unset (or not exactly "on"): argv is the one without any ingest flag', () => {
    const dir = path.join(tmp, 'd1')
    const off = alcoreServeArgs({ ...BASE }, dir)
    for (const v of ['off', 'ON', '1', '']) {
      assert.deepStrictEqual(alcoreServeArgs({ ...BASE, AGENTLENS_INGEST: v, AGENTLENS_INGEST_SOURCES: 'x' }, dir), off)
    }
    assert.ok(!off.some((a) => a.startsWith('--ingest') || a === '--aldigest-bin'))
  })

  test('on: both flags carry the resolved paths, and the sources flag is passed through', () => {
    const dir = path.join(tmp, 'd2')
    const bin = exe(path.join(tmp, 'b2', 'aldigest'))
    const man = file(path.join(tmp, 'm2', 'manifest.json'))
    const env = { ...ON, AGENTLENS_ALDIGEST_BIN: bin, AGENTLENS_INGEST_MANIFEST: man }
    const a = alcoreServeArgs(env, dir)
    assert.strictEqual(valueOf(a, '--ingest-manifest'), man)
    assert.strictEqual(valueOf(a, '--aldigest-bin'), bin)
    assert.strictEqual(valueOf(a, '--ingest-sources'), undefined)
    const b = alcoreServeArgs({ ...env, AGENTLENS_INGEST_SOURCES: 'hooks, spans' }, dir)
    assert.strictEqual(valueOf(b, '--ingest-sources'), 'hooks,spans', 'items are trimmed and rejoined')
  })

  test('on but aldigest missing: unchanged argument list plus one stderr warning naming it', () => {
    const dir = path.join(tmp, 'd3')
    const man = file(path.join(tmp, 'm3', 'manifest.json'))
    const off = alcoreServeArgs({ ...BASE, AGENTLENS_ALCORE: ALC }, dir)
    const { result, err } = captureStderr(() => alcoreServeArgs({ ...ON, AGENTLENS_INGEST_MANIFEST: man, AGENTLENS_ALDIGEST_BIN: path.join(tmp, 'nope') }, dir))
    assert.deepStrictEqual(result, off)
    assert.match(err, /warning: AGENTLENS_INGEST=on.*aldigest binary/)
    assert.doesNotMatch(err, /manifest could not/)
  })

  test('on but manifest missing: unchanged argument list plus a warning naming the manifest', () => {
    const dir = path.join(tmp, 'd4')
    const bin = exe(path.join(tmp, 'b4', 'aldigest'))
    const off = alcoreServeArgs({ ...BASE, AGENTLENS_ALCORE: ALC }, dir)
    const { result, err } = captureStderr(() => alcoreServeArgs({ ...ON, AGENTLENS_ALDIGEST_BIN: bin, AGENTLENS_INGEST_MANIFEST: path.join(tmp, 'nope.json') }, dir))
    assert.deepStrictEqual(result, off)
    assert.match(err, /ingest schemas manifest/)
  })

  test('aldigestBin rungs: env override, next to alcore, repo checkout, else null', () => {
    const root = path.join(tmp, 'r5')
    assert.strictEqual(aldigestBin({}, null, null), null)
    const repoBin = exe(path.join(root, 'repo', 'rust-core', 'target', 'release', 'aldigest'))
    assert.strictEqual(aldigestBin({}, null, path.join(root, 'repo')), repoBin)
    const alcore = path.join(root, 'pkg', 'bin-native', 'linux-x64', 'alcore')
    const sibling = exe(path.join(path.dirname(alcore), 'aldigest'))
    assert.strictEqual(aldigestBin({}, alcore, path.join(root, 'repo')), sibling, 'next to alcore beats the repo build')
    const over = exe(path.join(root, 'over', 'aldigest'))
    assert.strictEqual(aldigestBin({ AGENTLENS_ALDIGEST_BIN: over }, alcore, path.join(root, 'repo')), over)
    assert.strictEqual(aldigestBin({ AGENTLENS_ALDIGEST_BIN: path.join(root, 'gone') }, alcore, path.join(root, 'repo')), null, 'a bad explicit override does not fall through')
    fs.chmodSync(sibling, 0o644)
    assert.strictEqual(aldigestBin({}, alcore, null), null, 'a non-executable file is not found')
  })

  test('ingestManifestPath rungs: env override, package-root ingest-schemas, repo checkout, else null', () => {
    const root = path.join(tmp, 'r6')
    assert.strictEqual(ingestManifestPath({}, null, null), null)
    const repoMan = file(path.join(root, 'repo', 'rust-core', 'crates', 'agentlens-digest', 'schemas', 'manifest.json'))
    assert.strictEqual(ingestManifestPath({}, null, path.join(root, 'repo')), repoMan)
    const alcore = path.join(root, 'pkg', 'bin-native', 'linux-x64', 'alcore')
    const pkgMan = file(path.join(root, 'pkg', 'ingest-schemas', 'manifest.json'))
    assert.strictEqual(ingestManifestPath({}, alcore, path.join(root, 'repo')), pkgMan, 'package root beats the repo copy')
    const over = file(path.join(root, 'over', 'manifest.json'))
    assert.strictEqual(ingestManifestPath({ AGENTLENS_INGEST_MANIFEST: over }, alcore, null), over)
    assert.strictEqual(ingestManifestPath({ AGENTLENS_INGEST_MANIFEST: path.join(root, 'gone') }, alcore, null), null)
  })

  test('invalid AGENTLENS_INGEST_SOURCES: both ingest flags kept, sources dropped, warning names value and valid names', () => {
    const bin = exe(path.join(tmp, 'b7', 'aldigest'))
    const man = file(path.join(tmp, 'm7', 'manifest.json'))
    const env = { ...ON, AGENTLENS_ALDIGEST_BIN: bin, AGENTLENS_INGEST_MANIFEST: man }
    for (const bad of ['otel,logs', 'hooks,otel']) {
      resetIngestWarnings()
      const { result, err } = captureStderr(() => alcoreServeArgs({ ...env, AGENTLENS_INGEST_SOURCES: bad }, path.join(tmp, 'd7')))
      assert.strictEqual(valueOf(result, '--ingest-sources'), undefined)
      assert.strictEqual(valueOf(result, '--aldigest-bin'), bin)
      assert.strictEqual(valueOf(result, '--ingest-manifest'), man)
      assert.ok(err.includes(JSON.stringify(bad)) && err.includes('hooks, statusline, events, spans, bodies'), err)
    }
    const ok = alcoreServeArgs({ ...env, AGENTLENS_INGEST_SOURCES: 'statusline,bodies' }, path.join(tmp, 'd7'))
    assert.strictEqual(valueOf(ok, '--ingest-sources'), 'statusline,bodies')
  })

  test('AGENTLENS_INGEST_SOURCES: empty items are dropped; an all-empty value is unset, with no warning', () => {
    const bin = exe(path.join(tmp, 'b10', 'aldigest'))
    const man = file(path.join(tmp, 'm10', 'manifest.json'))
    const env = { ...ON, AGENTLENS_ALDIGEST_BIN: bin, AGENTLENS_INGEST_MANIFEST: man }
    const dir = path.join(tmp, 'd10')
    const run = (v: string): { result: string[]; err: string } => captureStderr(() => alcoreServeArgs({ ...env, AGENTLENS_INGEST_SOURCES: v }, dir))
    const a = run('hooks,,spans')
    assert.strictEqual(valueOf(a.result, '--ingest-sources'), 'hooks,spans')
    assert.strictEqual(a.err, '')
    for (const empty of [' ', ',', ' , ,']) {
      const r = run(empty)
      assert.strictEqual(valueOf(r.result, '--ingest-sources'), undefined, JSON.stringify(empty))
      assert.strictEqual(valueOf(r.result, '--aldigest-bin'), bin)
      assert.strictEqual(r.err, '')
    }
  })

  test('a warning prints once per process: two calls, one line', () => {
    const dir = path.join(tmp, 'd8')
    const env = { ...ON, AGENTLENS_ALDIGEST_BIN: path.join(tmp, 'nope'), AGENTLENS_INGEST_MANIFEST: path.join(tmp, 'nope.json') }
    const { err } = captureStderr(() => { alcoreServeArgs(env, dir); alcoreServeArgs(env, dir) })
    assert.strictEqual(err.split('\n').filter(Boolean).length, 1, err)
  })

  test('on with no resolvable alcore: no ingest flags, does not throw', () => {
    assert.deepStrictEqual(captureStderr(() => ingestArgs({ AGENTLENS_INGEST: 'on' }, null)).result, [])
    // a corrupt install makes alcoreBin throw; the opt-in must not surface that
    const dir = path.join(tmp, 'd9')
    const { result } = captureStderr(() => alcoreServeArgs({ ...BASE, AGENTLENS_INGEST: 'on', AGENTLENS_ALCORE: ' ' }, dir))
    assert.ok(Array.isArray(result))
  })

  test('defaultRepoRoot needs rust-core/ AND a package.json named agentlenspro', () => {
    const mk = (name: string, pkg?: string): string => {
      const root = path.join(tmp, 'rr', name)
      fs.mkdirSync(path.join(root, 'rust-core'), { recursive: true })
      fs.mkdirSync(path.join(root, 'standalone'), { recursive: true })
      if (pkg !== undefined) fs.writeFileSync(path.join(root, 'package.json'), pkg)
      return path.join(root, 'standalone')
    }
    assert.strictEqual(defaultRepoRoot(mk('none')), null)
    assert.strictEqual(defaultRepoRoot(mk('other', '{"name":"someone-else"}')), null)
    assert.strictEqual(defaultRepoRoot(mk('broken', '{nope')), null)
    const ours = mk('ours', '{"name":"agentlenspro"}')
    assert.strictEqual(defaultRepoRoot(ours), path.dirname(ours))
  })
})
