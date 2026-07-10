#!/usr/bin/env node
// agentlenspro-hook — PATH-bin wrapper for the lifecycle hook forwarder.
//
// WHY THIS EXISTS (P10, Homebrew safety): `--install-hooks` used to register the
// ABSOLUTE path of scripts/spy-agentlens.sh into ~/.claude/settings.json. That is
// stable for `npm i -g` (the install prefix never moves) but breaks under Homebrew,
// whose Cellar path embeds the version (…/Cellar/agentlenspro/1.0.0/…) and therefore
// dangles after every `brew upgrade`. The installer now registers this BARE bin name;
// npm/Homebrew keep the PATH shim pointing at the CURRENT install, and this wrapper
// resolves the real spy script relative to ITS OWN location at every fire.
//
// Contract (same as the spy scripts it wraps): never block a turn. Any failure to
// locate or spawn the underlying script is a silent exit 0 (fail-open), because a
// telemetry hook that can fail a tool call is worse than no telemetry.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// realpathSync resolves the npm-link / global-bin / Homebrew symlink chain to the
// package's actual scripts/ dir — the sibling spy scripts always live next to it.
let here
try { here = path.dirname(fs.realpathSync(__filename)) } catch { process.exit(0) }

const win = process.platform === 'win32'
const target = path.join(here, win ? 'spy-agentlens.mjs' : 'spy-agentlens.sh')

// POSIX keeps the bash+curl path (no second node boot inside the hook); native
// Windows has no bash, so the node twin runs on the already-booted runtime.
const r = win
  ? spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' })
  : spawnSync('bash', [target, ...process.argv.slice(2)], { stdio: 'inherit' })

// The spy scripts always exit 0 by contract; propagate anyway so a future change
// in them is not masked. A spawn failure (status null) fails open.
process.exit(r.status ?? 0)
