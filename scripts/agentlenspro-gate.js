#!/usr/bin/env node
// agentlenspro-gate — PATH-bin wrapper for the agent-launch burn gate.
//
// WHY THIS EXISTS (P10, Homebrew safety): same reason as agentlenspro-hook — the
// installer registers this BARE bin name instead of an absolute path into the
// package tree, so Homebrew version bumps (which move the Cellar path) can never
// leave a dangling hook registration. The wrapper resolves the real gate script
// relative to its own (symlink-resolved) location at every fire.
//
// Contract (inherited from spy-agentlens-gate): stdio must pass through UNTOUCHED —
// the hook payload arrives on stdin and the server's deny/advisory JSON leaves on
// stdout VERBATIM. Any wrapper-level failure is a silent exit 0 (fail-open): a gate
// that can block a launch because AgentLens is missing would be worse than no gate.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

let here
try { here = path.dirname(fs.realpathSync(__filename)) } catch { process.exit(0) }

const win = process.platform === 'win32'
const target = path.join(here, win ? 'spy-agentlens-gate.mjs' : 'spy-agentlens-gate.sh')

const r = win
  ? spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' })
  : spawnSync('bash', [target, ...process.argv.slice(2)], { stdio: 'inherit' })

process.exit(r.status ?? 0)
