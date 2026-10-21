#!/usr/bin/env node
'use strict'
// scripts/deploy-rust-helper.js — the RUST half of `pnpm run deploy:safe`, in Node.
//
// WHY THIS EXISTS: the deploy's rust half has to answer two questions a shell cannot answer
// reliably:
//
//   1. WHICH binary would the server actually execute? The product's own order is
//      AGENTLENS_ALCORE → <dataDir>/bin/alcore → bin-native/<platform>-<arch>/alcore
//      (src/cli/serverControl.ts alcoreBin). A second copy of that order inside a shell script
//      would drift from the one the server actually uses — and a drift there is exactly the class
//      of bug this whole half exists to prevent (a deploy that says it shipped a binary the
//      server never runs).
//   2. Does the process running RIGHT NOW execute the file that was just staged? That is an INODE
//      comparison, not a path comparison: replacing a running binary (rename over it) leaves the
//      running process on the OLD inode while the PATH still reads the NEW file. A path comparison
//      would say "fine" while the server keeps running the old code — the silent-stale-server
//      failure the card calls out.
//
// Both answers already exist in the product, so this helper REUSES them
// (src/cli/portSelect.ts liveLockPid for the owner of the data dir; src/rustBinResolve.ts
// npmPlatformBin for the platform key) rather than re-deriving a second mechanism. The compiled
// modules are read from out/test/…, which `pnpm run compile-tests` (one of the deploy's own gates)
// has just produced — so the helper always runs against the CURRENT source.
//
// Usage: scripts/deploy-rust-helper.js <platform-arch|rust-hash|verify-running>
//
// Exit codes: 0 ok · 1 FAILED (the caller must fail the deploy) · 2 "nothing to verify" (no live
// server owns the data dir and the caller did not expect one).

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const REPO = path.resolve(__dirname, '..')

function fail(msg) {
  process.stderr.write('deploy-rust-helper: ' + msg + '\n')
  process.exit(1)
}

/** The platform-arch key the product itself uses. `npmPlatformBin` (src/rustBinResolve.ts) and
 *  `alcoreBin` (src/cli/serverControl.ts) both default to `${process.platform}-${process.arch}` —
 *  the same spelling, so the deploy stages into the directory the resolver will look in. */
function platformArch() {
  return `${process.platform}-${process.arch}`
}

/** The compiled product modules. `pnpm run compile-tests` (a deploy gate) emits them under
 *  out/test/…, mirroring src/ one-for-one. out/ is the older, non-gate build and is only a
 *  fallback. Returns null when neither exists — the caller reports that loudly rather than
 *  guessing. */
function loadProductModules() {
  const bases = [path.join(REPO, 'out', 'test'), path.join(REPO, 'out')]
  for (const base of bases) {
    const serverControl = path.join(base, 'cli', 'serverControl.js')
    const portSelect = path.join(base, 'cli', 'portSelect.js')
    const dataDirMod = path.join(base, 'dataDir.js')
    if (fs.existsSync(serverControl) && fs.existsSync(portSelect) && fs.existsSync(dataDirMod)) {
      return {
        serverControl: require(serverControl),
        portSelect: require(portSelect),
        dataDir: require(dataDirMod).dataDir,
      }
    }
  }
  return null
}

/** The rust workspace's source files, as a sorted list of repo-relative paths.
 *
 *  `git ls-files --cached --others --exclude-standard` is the working set: tracked files AND
 *  untracked-but-not-ignored ones, with gitignored build output (rust-core/target/) and the
 *  gitignored fixture databases excluded. A plain filesystem walk would include target/ (hundreds
 *  of MB, and the build output changes on every build — so the hash would never match) and the
 *  ignored .db fixtures. */
function rustSourceFiles() {
  let out
  try {
    out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'rust-core'], {
      cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    })
  } catch {
    out = null
  }
  let files
  if (out !== null) {
    files = out.split('\0').filter((f) => f !== '' && !f.startsWith('rust-core/target/'))
  } else {
    files = []
    const walk = (dir, prefix) => {
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const rel = prefix + e.name
        if (e.isDirectory()) { if (e.name !== 'target') walk(path.join(dir, e.name), rel + '/') }
        else files.push(rel)
      }
    }
    walk(path.join(REPO, 'rust-core'), 'rust-core/')
  }
  return files.sort()
}

/** A content hash of the rust workspace. The skip decision ("the workspace is unchanged → do not
 *  pay for a cargo build") is this hash compared against the stamp written next to the staged
 *  binaries. Content-based, not mtime-based: a `git checkout` back and forth rewrites mtimes
 *  without changing the code, and a rebuild is then pure waste. */
function rustSourceHash() {
  const h = crypto.createHash('sha256')
  for (const rel of rustSourceFiles()) {
    h.update(rel)
    h.update('\0')
    try { h.update(fs.readFileSync(path.join(REPO, rel))) } catch { h.update('<unreadable>') }
    h.update('\0')
  }
  return h.digest('hex')
}

/** The inode of a file, or null when it does not exist. */
function inodeOf(p) {
  try { return fs.statSync(p).ino } catch { return null }
}

/** The executable the given pid is running, as { ino, path } — or null when it cannot be
 *  determined. The INODE is the point: it is the file the process actually has mapped, which a
 *  path lookup cannot tell you once the path has been replaced. */
function runningExecutable(pid) {
  if (process.platform === 'linux') {
    try {
      const link = fs.readlinkSync(`/proc/${pid}/exe`)
      const ino = fs.statSync(`/proc/${pid}/exe`).ino
      return { ino, path: link.replace(/ \(deleted\)$/, '') }
    } catch { /* fall through to lsof */ }
  }
  const lsof = ['lsof', '/usr/sbin/lsof'].find((c) => {
    try { execFileSync(c, ['-v'], { stdio: 'ignore' }); return true } catch { return false }
  })
  if (!lsof) return null
  let out
  try {
    out = execFileSync(lsof, ['-a', '-p', String(pid), '-d', 'txt', '-Fni'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch { return null }
  // lsof -F emits one file block: "f<type>" then "i<inode>" / "n<name>" for that file.
  let type = null
  let ino = null
  let name = null
  const blocks = []
  for (const line of out.split('\n')) {
    if (line.startsWith('f')) {
      if (type !== null) blocks.push({ type, ino, name })
      type = line.slice(1); ino = null; name = null
    } else if (line.startsWith('i')) {
      ino = Number(line.slice(1))
    } else if (line.startsWith('n')) {
      name = line.slice(1)
    }
  }
  if (type !== null) blocks.push({ type, ino, name })
  const exe = blocks.find((b) => b.type === 'txt' && b.name)
  if (!exe) return null
  return { ino: exe.ino, path: exe.name }
}

/** The binary the product's own resolver would start, or null. */
function resolvedAlcore(serverControl) {
  try {
    return serverControl.alcoreBin(process.env, undefined, undefined, serverControl.resolveBinNativeDir())
  } catch { return null }
}

function cmdVerifyRunning() {
  const mods = loadProductModules()
  if (mods === null) {
    fail('the compiled product modules are missing (out/test/…). Run `pnpm run compile-tests` first — the deploy runs it as a gate.')
  }
  const stageDir = process.env.RUST_STAGE_DIR || path.join(REPO, 'bin-native', platformArch())
  const stagedAlcore = process.env.RUST_STAGED_ALCORE || path.join(stageDir, 'alcore')
  // exit 2 = 'not yet / nobody home' — the caller RETRIES, because  can return
  // before the new server has written its pidfile. After the caller's retry budget is spent, a
  // still-absent server becomes a loud failure there, not a silent pass here.
  const dataDir = mods.dataDir()
  const pid = mods.portSelect.liveLockPid(dataDir)
  if (pid === null) {
    process.stdout.write(`  no live server owns ${dataDir} — nothing to verify\n`)
    process.exit(2)
  }
  const running = runningExecutable(pid)
  if (running === null) {
    fail(`cannot determine which executable pid ${pid} is running (lsof gave nothing) — CANNOT confirm the deploy took.`)
  }
  const stagedIno = inodeOf(stagedAlcore)
  if (stagedIno !== null && stagedIno === running.ino) {
    process.stdout.write(`  ✓ pid ${pid} executes the staged binary (inode ${running.ino}) — ${running.path}\n`)
    process.exit(0)
  }
  const resolved = resolvedAlcore(mods.serverControl)
  const resolvedIno = resolved ? inodeOf(resolved) : null
  process.stderr.write(
    `  ✗ pid ${pid} executes ${running.path} (inode ${running.ino}) — NOT the staged ${stagedAlcore}` +
    ` (inode ${stagedIno === null ? 'MISSING' : stagedIno}).\n` +
    `    The deploy did NOT take: the running server is still on the old binary.\n` +
    (resolved && resolvedIno !== running.ino
      ? `    Note: the product's own resolver would start ${resolved} — an override (AGENTLENS_ALCORE or <dataDir>/bin/alcore) or a stale process is in play.\n`
      : '') +
    `    Restart the server and re-run, or investigate before trusting a measurement.\n`,
  )
  process.exit(1)
}

function main() {
  const cmd = process.argv[2]
  switch (cmd) {
    case 'platform-arch':
      process.stdout.write(platformArch() + '\n')
      return
    case 'rust-hash':
      process.stdout.write(rustSourceHash() + '\n')
      return
    case 'verify-running':
      cmdVerifyRunning()
      return
    default:
      process.stderr.write('usage: deploy-rust-helper.js <platform-arch|rust-hash|verify-running>\n')
      process.exit(2)
  }
}

main()
