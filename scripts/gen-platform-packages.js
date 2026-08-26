#!/usr/bin/env node
// scripts/gen-platform-packages.js — stages one `agentlenspro-<platform>` npm package
// (TRDD-EAK9R8IY) from the binaries `cargo build --release` just produced on THIS runner.
//
// One generator instead of four hand-maintained package.json files: version lockstep with the
// main package is by construction (read once, written everywhere) rather than a separate check
// script that could drift out of sync with the thing it's checking.
//
// Usage: node scripts/gen-platform-packages.js <platform-suffix>
//   platform-suffix is one of: darwin-arm64 darwin-x64 linux-x64 linux-arm64
// Reads binaries from rust-core/target/release/{alcore,alstore,alscan,allogscan} and stages
// npm-platform-packages/agentlenspro-<suffix>/{package.json,bin/*,LICENSE,README.md}.
'use strict'
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const BINARIES = ['alcore', 'alstore', 'alscan', 'allogscan']

// win32-x64 is deliberately absent — see src/rustBinResolve.ts for why (an unguarded
// libc::kill/EPERM call in pid_lock.rs does not build for windows-msvc today).
const PLATFORMS = {
  'darwin-arm64': { os: 'darwin', cpu: 'arm64' },
  'darwin-x64': { os: 'darwin', cpu: 'x64' },
  'linux-x64': { os: 'linux', cpu: 'x64' },
  'linux-arm64': { os: 'linux', cpu: 'arm64' },
}

function main() {
  const suffix = process.argv[2]
  const target = PLATFORMS[suffix]
  if (!target) {
    console.error(`unknown platform suffix ${JSON.stringify(suffix)} — expected one of: ${Object.keys(PLATFORMS).join(', ')}`)
    process.exit(1)
  }

  const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const pkgName = `agentlenspro-${suffix}`
  const pkgDir = path.join(ROOT, 'npm-platform-packages', pkgName)
  const binDir = path.join(pkgDir, 'bin')
  fs.mkdirSync(binDir, { recursive: true })

  const releaseDir = path.join(ROOT, 'rust-core', 'target', 'release')
  for (const bin of BINARIES) {
    const src = path.join(releaseDir, bin)
    if (!fs.existsSync(src)) {
      console.error(`missing built binary: ${src} — run \`cargo build --release\` in rust-core/ first`)
      process.exit(1)
    }
    const dest = path.join(binDir, bin)
    fs.copyFileSync(src, dest)
    fs.chmodSync(dest, 0o755)
  }

  const pkg = {
    name: pkgName,
    version: root.version,
    description: `AgentlensPro Rust server binaries for ${suffix} — installed automatically as an optionalDependency of agentlenspro; not meant to be depended on directly.`,
    license: root.license,
    repository: root.repository,
    os: [target.os],
    cpu: [target.cpu],
    files: ['bin/'],
  }
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

  const licenseSrc = path.join(ROOT, 'LICENSE')
  if (fs.existsSync(licenseSrc)) fs.copyFileSync(licenseSrc, path.join(pkgDir, 'LICENSE'))

  fs.writeFileSync(path.join(pkgDir, 'README.md'),
    `# ${pkgName}\n\nRust server binaries (\`alcore\`, \`alstore\`, \`alscan\`, \`allogscan\`) for ${suffix}, ` +
    `published for [agentlenspro](https://www.npmjs.com/package/agentlenspro) as an optionalDependency. ` +
    `Do not depend on this package directly.\n`)

  console.log(`staged ${pkgName}@${pkg.version} at ${pkgDir}`)
}

main()
