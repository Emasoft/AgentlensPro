// The ONE answer to "which build is this?" — shared by the CLI (`--version`) and the server
// (`/api/server-stats`).
//
// It lives outside src/cli/ because the server bundle must not import the CLI dispatcher just to
// learn its own version, and a second copy of the walker is exactly how two surfaces start
// reporting different numbers. Answering "is the running server the last version?" took three
// probes while the endpoint exposed pid/uptime/ports but nothing identifying the build.
import * as fs from 'fs'
import * as path from 'path'

/** The package version, read from the package.json that ships next to the bundle. Walks up
 *  from __dirname because the bundle lives at <pkg>/standalone/cli.js while the test build
 *  lives at <repo>/out/test/cli/ — a fixed ../package.json would be wrong in one of them.
 *  Throws rather than guessing: a build that cannot identify itself is a broken install, and
 *  a fabricated version is worse than a loud failure. */
export function packageVersion(): string {
  let dir = __dirname
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, 'package.json')
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8')) as { name?: string; version?: string }
      if (pkg.name === 'agentlenspro' && pkg.version) return pkg.version
    } catch { /* not here — keep walking */ }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`cannot locate the agentlenspro package.json above ${__dirname}`)
}
