// Status-line capture (src/cli/statuslineCapture.ts + the installer half in src/cli/hookInstall.ts).
//
// WHAT THESE GUARD. The status line is the ONE surface where a telemetry bug is visible to the user
// as a broken product: Claude Code blanks it when its command exits non-zero or prints nothing, and
// there is no second `statusLine` entry to fall back on — the capture can only exist by WRAPPING
// the command already there. So the invariants under test are not "does the sample arrive" but
// "can the wrapper ever damage the thing it wraps":
//   * the inner command's stdout is passed through byte-for-byte, and its exit code is ours;
//   * a capture failure (bad JSON, dead server, kill-switch armed) changes neither;
//   * the payload is stored VERBATIM — no allowlist that would silently drop whatever field the
//     next Claude Code version adds;
//   * install/uninstall round-trips a command containing spaces and quotes exactly.

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'
import {
  parseStatuslineArgs, toStatuslineRecord, STATUSLINE_EV, SUBAGENT_STATUSLINE_EV,
} from '../cli/statuslineCapture'
import {
  shSingleQuote, parseSingleQuoted, isOurStatuslineCommand, unwrapStatuslineCommand,
  planStatuslineSurface, installStatusline, STATUSLINE_CMD, SUBAGENT_STATUSLINE_CMD, STATUSLINE_SURFACES,
} from '../cli/hookInstall'

/** A payload shaped like the real thing, including the fields that only appear conditionally. */
const SAMPLE = {
  session_id: 'abc123',
  prompt_id: '550e8400-e29b-41d4-a716-446655440000',
  transcript_path: '/tmp/t.jsonl',
  version: '2.1.216',
  model: { id: 'claude-opus-5', display_name: 'Opus' },
  workspace: { current_dir: '/w', project_dir: '/w', added_dirs: [] },
  cost: { total_cost_usd: 1.5, total_duration_ms: 45000, total_api_duration_ms: 2300 },
  context_window: {
    total_input_tokens: 15500, total_output_tokens: 1200, context_window_size: 1000000,
    used_percentage: 8, remaining_percentage: 92,
    current_usage: { input_tokens: 8500, output_tokens: 1200, cache_creation_input_tokens: 5000, cache_read_input_tokens: 2000 },
  },
  rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } },
  effort: { level: 'high' },
  exceeds_200k_tokens: false,
  fast_mode: false,
}

suite('statusline capture — the wrapper must never damage the status line it wraps', () => {
  test('the payload is forwarded VERBATIM, with only hook_event_name added', () => {
    const rec = toStatuslineRecord(Buffer.from(JSON.stringify(SAMPLE)))
    assert.ok(rec)
    const out = JSON.parse(rec.toString('utf-8')) as Record<string, unknown>
    // An allowlist here would silently drop whatever field the next Claude Code version adds, and
    // the whole value of this store is answering questions nobody had thought of when it was built.
    // Exactly two keys are added: the stream the sample came from, and the legacy event name that
    // keeps a NEW cli ingestible by an OLD server.
    const { hook_event_name, statusline_stream, ...rest } = out
    assert.strictEqual(hook_event_name, STATUSLINE_EV)
    assert.strictEqual(statusline_stream, 'main')
    assert.deepStrictEqual(rest, SAMPLE, 'every field must survive unmodified')
  })

  test('the rate-limit windows survive intact — they are the reason this exists', () => {
    const out = JSON.parse(toStatuslineRecord(Buffer.from(JSON.stringify(SAMPLE)))!.toString()) as typeof SAMPLE
    assert.strictEqual(out.rate_limits.five_hour.used_percentage, 23.5)
    assert.strictEqual(out.rate_limits.seven_day.resets_at, 1738857600)
    // prompt_id is the documented join key to the OTEL `prompt.id` attribute; losing it would make
    // a sample impossible to line up against the span store.
    assert.strictEqual(out.prompt_id, SAMPLE.prompt_id)
  })

  test('a payload that carries its own hook_event_name cannot override ours', () => {
    const rec = toStatuslineRecord(Buffer.from(JSON.stringify({ ...SAMPLE, hook_event_name: 'Stop' })))
    assert.strictEqual((JSON.parse(rec!.toString()) as Record<string, unknown>).hook_event_name, STATUSLINE_EV,
      'a status-line sample landing in the store as a genuine Stop event would corrupt every consumer of it')
  })

  test('unreadable payloads yield null rather than a malformed record', () => {
    assert.strictEqual(toStatuslineRecord(Buffer.from('not json')), null)
    assert.strictEqual(toStatuslineRecord(Buffer.from('[1,2]')), null, 'an array is not a payload object')
    assert.strictEqual(toStatuslineRecord(Buffer.from('null')), null)
    assert.strictEqual(toStatuslineRecord(Buffer.from('')), null)
  })

  test('--subagent selects the per-subagent event name', () => {
    assert.deepStrictEqual(parseStatuslineArgs([]), { inner: null, subagent: false })
    assert.deepStrictEqual(parseStatuslineArgs(['--subagent']), { inner: null, subagent: true })
    assert.deepStrictEqual(parseStatuslineArgs(['--inner', 'x.sh', '--subagent']), { inner: 'x.sh', subagent: true })
    const rec = JSON.parse(toStatuslineRecord(Buffer.from('{"tasks":[]}'), SUBAGENT_STATUSLINE_EV)!.toString()) as Record<string, unknown>
    assert.strictEqual(rec.hook_event_name, SUBAGENT_STATUSLINE_EV)
    assert.strictEqual(rec.statusline_stream, 'subagent', 'the server routes on this — a wrong value files subagent rows in the main stream')
  })

  test('a subagent payload keeps every per-task field, including the worktree cwd', () => {
    // These are the only published per-subagent context figures: tokenCount against
    // contextWindowSize is a live agent's context fill, and cwd is what distinguishes a
    // worktree-isolated agent from one sharing the parent's tree.
    const payload = {
      columns: 80,
      tasks: [{
        id: 't1', name: 'Explore', type: 'Explore', status: 'running', description: 'd', label: 'l',
        startTime: 1738425600, model: 'claude-sonnet-5', effort: 'medium',
        contextWindowSize: 1000000, tokenCount: 42_000, tokenSamples: [1, 2, 3],
        cwd: '/repo/.claude/worktrees/feat-x',
      }],
    }
    const out = JSON.parse(toStatuslineRecord(Buffer.from(JSON.stringify(payload)), SUBAGENT_STATUSLINE_EV)!.toString()) as typeof payload
    assert.deepStrictEqual(out.tasks, payload.tasks)
  })
})

suite('statusline capture — pass-through is sacred (end-to-end through the built CLI)', () => {
  // These drive the ACTUAL command the way Claude Code does: JSON on stdin, output captured. A unit
  // test of the helpers cannot catch the failure that matters (stdout mangled, exit code replaced).
  const cliJs = path.join(__dirname, '..', '..', '..', 'standalone', 'cli.js')
  const available = fs.existsSync(cliJs)

  function runWrapper(args: string[], stdin: string, env: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, [cliJs, 'statusline', ...args], {
      input: stdin,
      encoding: 'utf-8',
      // Point the capture at a dead port so the test never depends on a running server, and
      // never touches the real data dir.
      env: { ...process.env, AGENTLENS_UI_URL: 'http://127.0.0.1:1', AGENTLENS_STATUSLINE_TIMEOUT_MS: '150', ...env },
    })
  }

  test('the inner command\'s stdout reaches stdout untouched, server or no server', function () {
    if (!available) return this.skip()
    const r = runWrapper(['--inner', 'printf "[Opus] 8%% ctx"'], JSON.stringify(SAMPLE))
    assert.strictEqual(r.stdout, '[Opus] 8% ctx', 'anything added, trimmed or re-encoded here is visible to the user')
    assert.strictEqual(r.status, 0)
  })

  test('the inner command receives the payload on ITS stdin', function () {
    if (!available) return this.skip()
    // The wrapper consumes stdin to forward it; if it failed to re-feed the child, every existing
    // status line would render as if it had been given nothing.
    const r = runWrapper(['--inner', `${JSON.stringify(process.execPath)} -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write(JSON.parse(s).model.display_name))"`], JSON.stringify(SAMPLE))
    assert.strictEqual(r.stdout, 'Opus')
  })

  test('the inner command\'s exit code is passed through', function () {
    if (!available) return this.skip()
    assert.strictEqual(runWrapper(['--inner', 'exit 3'], JSON.stringify(SAMPLE)).status, 3)
  })

  test('a capture failure never blanks the status line or fails the exit code', function () {
    if (!available) return this.skip()
    // Unparseable input AND an unreachable server, together — the worst realistic case.
    const r = runWrapper(['--inner', 'printf ok'], 'not json at all')
    assert.strictEqual(r.stdout, 'ok')
    assert.strictEqual(r.status, 0)
    assert.strictEqual(r.stderr, '', 'stderr noise on the render path would spam the user every 3 seconds')
  })

  test('with no inner command the wrapper prints NOTHING and exits 0', function () {
    if (!available) return this.skip()
    // This is the subagentStatusLine shape: printing nothing keeps every row's default rendering.
    const r = runWrapper(['--subagent'], JSON.stringify({ columns: 80, tasks: [] }))
    assert.strictEqual(r.stdout, '')
    assert.strictEqual(r.status, 0)
  })

  test('a server that HANGS (not refuses) must not freeze the render path', function () {
    if (!available) return this.skip()
    this.timeout(20_000)
    // MEASURED at 10.6 SECONDS before the fix — on a surface Claude Code re-runs every render.
    // A dead PORT refuses instantly and hides this; the failure needs an address that DROPS, which
    // is what a firewall rule, a suspended container or a VPN flap actually looks like.
    //
    // The abort was never the problem: AbortSignal.timeout fires correctly (the fetch rejects in
    // ~704 ms). Aborting a fetch does not destroy the underlying TCP socket, the socket holds the
    // event loop open until the OS connect timeout, and the CLI finished by setting `process.exitCode`
    // — i.e. by waiting for that loop to drain. The timeout bounded the REQUEST; nothing bounded the
    // PROCESS. Assert the process, therefore, not the request.
    const t0 = Date.now()
    const r = spawnSync(process.execPath, [cliJs, 'statusline', '--inner', 'printf ok'], {
      input: JSON.stringify(SAMPLE), encoding: 'utf-8',
      env: { ...process.env, AGENTLENS_UI_URL: 'http://10.255.255.1:3000', AGENTLENS_STATUSLINE_TIMEOUT_MS: '700' },
    })
    const ms = Date.now() - t0
    assert.strictEqual(r.stdout, 'ok', 'the status line must still render while the server is unreachable')
    assert.strictEqual(r.status, 0)
    assert.ok(ms < 5_000, `the render path took ${ms}ms — a hung socket is holding the process open`)
  })
})

suite('statusline install — wrapping and unwrapping must round-trip exactly', () => {
  test('shell quoting survives spaces, quotes and metacharacters', () => {
    for (const original of [
      '/usr/bin/python3 /Users/me/.claude/statusline.py',
      "/opt/my dir/py3 '/Users/me/x y.py' --flag",
      'sh -c "echo $(date)" | tr -d "\\n"',
      "it's a path/with'quotes'.sh",
    ]) {
      assert.strictEqual(parseSingleQuoted(shSingleQuote(original)), original, `round-trip failed for: ${original}`)
    }
  })

  test('a malformed quoted word parses to null instead of a truncated command', () => {
    // Restoring a truncated command would leave the user with a broken status line and no way to
    // know why — refusing is the only safe direction.
    assert.strictEqual(parseSingleQuoted("'unterminated"), null)
    assert.strictEqual(parseSingleQuoted("'a' trailing"), null)
    assert.strictEqual(parseSingleQuoted('no quotes'), null)
  })

  test('wrap then unwrap returns the original command byte-for-byte', () => {
    const original = "/opt/my dir/python3 '/Users/me/status line.py' --x"
    const wrapped = `${STATUSLINE_CMD} --inner ${shSingleQuote(original)}`
    assert.ok(isOurStatuslineCommand(wrapped))
    assert.strictEqual(unwrapStatuslineCommand(wrapped), original)
  })

  test('a capture-only wrapper unwraps to the empty string, not null', () => {
    // '' means "there was nothing to wrap" (remove the key on uninstall); null means "not ours" or
    // "unparseable" (refuse). Collapsing the two would delete a status line we should have restored.
    assert.strictEqual(unwrapStatuslineCommand(STATUSLINE_CMD), '')
    assert.strictEqual(unwrapStatuslineCommand(SUBAGENT_STATUSLINE_CMD), '')
    assert.strictEqual(unwrapStatuslineCommand('/usr/bin/foo.sh'), null, "a foreign command is not ours")
  })

  test('installing over an existing wrapper is a no-op, never a double wrap', () => {
    const wrapped = `${STATUSLINE_CMD} --inner ${shSingleQuote('x.sh')}`
    const p = planStatuslineSurface(STATUSLINE_SURFACES[0], wrapped, false, '/settings.json')
    assert.deepStrictEqual(p.ops, [], 'a second wrap would make uninstall unable to reach the real command')
    assert.strictEqual(p.result.action, 'unchanged')
  })

  test('uninstall refuses rather than restore a command it cannot parse', () => {
    assert.throws(
      () => planStatuslineSurface(STATUSLINE_SURFACES[0], `${STATUSLINE_CMD} --inner 'unterminated`, true, '/s.json'),
      /not parseable/,
    )
  })

  test('a full install/uninstall cycle restores settings.json exactly', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-install-'))
    const file = path.join(dir, 'settings.json')
    const before = {
      statusLine: { type: 'command', command: "/opt/py3 '/Users/me/status line.py'", refreshInterval: 3, padding: 2 },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'agentlenspro hook' }] }] },
    }
    fs.writeFileSync(file, JSON.stringify(before, null, 2))
    // Same shim-bin fixture the hook-install tests use: install refuses unless `agentlenspro`
    // actually resolves on the PATH it is given.
    const binDir = path.join(dir, 'bin')
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(path.join(binDir, 'agentlenspro'), '#!/bin/sh\nexit 0\n')
    fs.chmodSync(path.join(binDir, 'agentlenspro'), 0o755)
    const log = () => { /* silence */ }
    try {
      const ins = await installStatusline(false, { settingsPath: file, pathEnv: binDir, log })
      const mid = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>
      assert.ok(ins.changed)
      assert.ok(isOurStatuslineCommand(mid.statusLine.command))
      assert.strictEqual(unwrapStatuslineCommand(mid.statusLine.command as string), before.statusLine.command)
      // Siblings of `command` are the user's display preferences — a transaction that dropped them
      // would silently change how the status line renders.
      assert.strictEqual(mid.statusLine.refreshInterval, 3)
      assert.strictEqual(mid.statusLine.padding, 2)
      // The second surface is wired in the SAME transaction, capture-only (nothing to wrap).
      assert.strictEqual(mid.subagentStatusLine.command, SUBAGENT_STATUSLINE_CMD)
      assert.strictEqual(mid.subagentStatusLine.type, 'command')
      // Unrelated settings are never touched.
      assert.deepStrictEqual(mid.hooks, before.hooks)

      await installStatusline(true, { settingsPath: file, log })
      const after = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
      assert.deepStrictEqual(after.statusLine, before.statusLine, 'uninstall must restore the original exactly')
      assert.strictEqual(after.subagentStatusLine, undefined,
        'a capture-only surface had no original, so uninstall removes the key rather than leaving a stub')
      assert.deepStrictEqual(after.hooks, before.hooks)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('install refuses when the CLI is not on PATH', async () => {
    // A registration pointing at a missing binary produces NO output, and Claude Code blanks the
    // status line on empty output — the user would simply lose it with no explanation.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-nopath-'))
    try {
      await assert.rejects(
        () => installStatusline(false, { settingsPath: path.join(dir, 'settings.json'), pathEnv: path.join(dir, 'empty'), log: () => {} }),
        /not on PATH/,
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
