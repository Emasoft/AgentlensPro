import * as assert from 'assert'
import {
  parsePsTable, processAncestry, terminalFromCommand, terminalFromEnv, terminalKind,
  aiMaestroFromEnv, multiplexerFromEnv,
} from '../environment/terminal'
import { parseOsRelease } from '../environment/os'
import { ciFromEnv, containerSignals, claudeContextFromEnv } from '../environment/runtime'

suite('environment/terminal (TRDD-HUWJVQJA — process-ancestry terminal detection)', () => {
  test('parsePsTable tolerates a header row and malformed lines', () => {
    const t = parsePsTable('  PID PPID COMMAND\n100 90 -zsh\ngarbage line\n90 1 /usr/bin/login\n')
    assert.strictEqual(t.size, 2)
    assert.deepStrictEqual(t.get(100), { ppid: 90, command: '-zsh' })
    assert.deepStrictEqual(t.get(90), { ppid: 1, command: '/usr/bin/login' })
  })

  test('processAncestry returns parents nearest-first and stops at pid<=1', () => {
    const t = parsePsTable('100 90 -zsh\n90 80 tmux: server\n80 1 /Applications/iTerm.app/Contents/MacOS/iTerm2\n')
    assert.deepStrictEqual(processAncestry(100, t), ['tmux: server', '/Applications/iTerm.app/Contents/MacOS/iTerm2'])
  })

  test('processAncestry cannot loop on a cyclic table', () => {
    const t = parsePsTable('5 6 a\n6 5 b\n')
    // 5→parent 6 ('b'), then 6→parent 5 already seen → stop. No infinite loop.
    assert.deepStrictEqual(processAncestry(5, t), ['b'])
  })

  test('terminalFromCommand classifies the known hosts', () => {
    assert.strictEqual(terminalFromCommand('tmux: server'), 'tmux')
    assert.strictEqual(terminalFromCommand('/Applications/iTerm.app/Contents/MacOS/iTerm2'), 'iterm')
    assert.strictEqual(terminalFromCommand('/Applications/Ghostty.app/Contents/MacOS/ghostty'), 'ghostty')
    assert.strictEqual(terminalFromCommand('/opt/homebrew/bin/wezterm-gui'), 'wezterm')
    assert.strictEqual(terminalFromCommand('/Applications/Visual Studio Code.app/Contents/MacOS/Code Helper'), 'vscode')
    assert.strictEqual(terminalFromCommand('/System/.../Terminal.app/Contents/MacOS/Terminal'), 'apple-terminal')
    assert.strictEqual(terminalFromCommand('/usr/bin/some-random-daemon'), null)
  })

  test('terminalKind: nearest ancestor wins (tmux over an iTerm further up)', () => {
    const ps = '100 90 -zsh\n90 80 tmux: server\n80 1 /Applications/iTerm.app/Contents/MacOS/iTerm2\n'
    assert.strictEqual(terminalKind(ps, 100, {}), 'tmux')
  })

  test('terminalKind: force override short-circuits the walk', () => {
    assert.strictEqual(terminalKind('anything', 1, { AGENTLENS_FORCE_TERMINAL_KIND: 'kitty' }), 'kitty')
  })

  test('terminalKind: env fallback when ancestry is unknown (Windows Terminal, VS Code)', () => {
    assert.strictEqual(terminalKind('1 0 init', 1, { WT_SESSION: 'abc' }), 'windows-terminal')
    assert.strictEqual(terminalKind('1 0 init', 1, { TERM_PROGRAM: 'vscode' }), 'vscode')
    assert.strictEqual(terminalKind('1 0 init', 1, {}), 'unknown')
  })

  test('terminalFromEnv maps the common host env signals', () => {
    assert.strictEqual(terminalFromEnv({ TERM_PROGRAM: 'iTerm.app' }), 'iterm')
    assert.strictEqual(terminalFromEnv({ KITTY_WINDOW_ID: '1' }), 'kitty')
    assert.strictEqual(terminalFromEnv({ TERM_PROGRAM: 'Apple_Terminal' }), 'apple-terminal')
    assert.strictEqual(terminalFromEnv({}), null)
  })

  test('aiMaestroFromEnv: explicit flag or internal id', () => {
    assert.strictEqual(aiMaestroFromEnv({ AIMAESTRO_AGENT: '1' }), true)
    assert.strictEqual(aiMaestroFromEnv({ THIS_IS_AIMAESTRO: 'true' }), true)
    assert.strictEqual(aiMaestroFromEnv({ AMP_AGENT_ID: 'abc' }), true)
    assert.strictEqual(aiMaestroFromEnv({ AID_AUTH: 'x' }), true)
    assert.strictEqual(aiMaestroFromEnv({ AIMAESTRO_AGENT: '0' }), false)
    assert.strictEqual(aiMaestroFromEnv({}), false)
  })

  test('multiplexerFromEnv detects tmux/zellij/screen', () => {
    assert.strictEqual(multiplexerFromEnv({ TMUX: '/tmp/tmux-501/default,123,0' }), 'tmux')
    assert.strictEqual(multiplexerFromEnv({ ZELLIJ: '0' }), 'zellij')
    assert.strictEqual(multiplexerFromEnv({ STY: '123.pts-0' }), 'screen')
    assert.strictEqual(multiplexerFromEnv({}), null)
  })
})

suite('environment/os (TRDD-HUWJVQJA — os-release parsing)', () => {
  test('parseOsRelease strips quotes, skips comments and blanks', () => {
    const rel = parseOsRelease('# comment\nNAME="Ubuntu"\nVERSION_ID="22.04"\nPRETTY_NAME="Ubuntu 22.04.3 LTS"\n\nEMPTY=\n')
    assert.strictEqual(rel.NAME, 'Ubuntu')
    assert.strictEqual(rel.PRETTY_NAME, 'Ubuntu 22.04.3 LTS')
    assert.strictEqual(rel.EMPTY, '')
    assert.ok(!('# comment' in rel))
  })
})

suite('environment/runtime (TRDD-HUWJVQJA — CI/container/Claude context)', () => {
  test('ciFromEnv: named provider, generic CI, and off', () => {
    assert.deepStrictEqual(ciFromEnv({ GITHUB_ACTIONS: 'true' }), { isCi: true, provider: 'GitHub Actions' })
    assert.deepStrictEqual(ciFromEnv({ CI: 'true' }), { isCi: true, provider: 'CI (generic)' })
    assert.deepStrictEqual(ciFromEnv({ CI: 'false' }), { isCi: false, provider: null })
    assert.deepStrictEqual(ciFromEnv({}), { isCi: false, provider: null })
  })

  test('containerSignals: fs markers + env markers, empty on bare host', () => {
    assert.deepStrictEqual(containerSignals({}, { dockerenv: false, containerenv: false, wsl: false }), [])
    assert.deepStrictEqual(
      containerSignals({}, { dockerenv: true, containerenv: false, wsl: false }),
      ['docker (/.dockerenv)'],
    )
    const sig = containerSignals({ REMOTE_CONTAINERS: 'true' }, { dockerenv: false, containerenv: false, wsl: true })
    assert.ok(sig.includes('WSL'))
    assert.ok(sig.some((s) => s.includes('VS Code dev container')))
  })

  test('claudeContextFromEnv: detects Claude Code, entrypoint, vscode-integrated', () => {
    const a = claudeContextFromEnv({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 'abcdef123456' })
    assert.strictEqual(a.inClaudeCode, true)
    assert.strictEqual(a.entrypoint, 'cli')
    assert.strictEqual(a.sessionId, 'abcdef123456')
    const b = claudeContextFromEnv({ CLAUDE_CODE_ENTRYPOINT: 'cli', TERM_PROGRAM: 'vscode' })
    assert.strictEqual(b.vscodeIntegrated, true)
    const c = claudeContextFromEnv({})
    assert.strictEqual(c.inClaudeCode, false)
  })
})
