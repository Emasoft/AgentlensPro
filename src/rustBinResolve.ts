// src/rustBinResolve.ts — resolves an alcore/alstore/alscan/allogscan binary shipped INSIDE the
// one `agentlenspro` package, under `bin-native/<platform>-<arch>/` (TRDD-EAK9R8IY).
//
// ONE package, every platform. The earlier design published four separate
// `agentlenspro-<platform>` packages as optionalDependencies (the esbuild/swc pattern) and it
// could not ship: npm's OIDC trusted publishing cannot create a package name that does not yet
// exist, so all four legs 404'd and — because publish-npm waited on them — the MAIN package never
// published either. Owner ruling 2026-08-28: the binaries go in the agentlenspro package itself
// and no new package name is ever created. The cost is measured and accepted: four targets is
// ~121.5 MB downloaded / ~384 MB unpacked, versus ~30 MB / ~96 MB for a per-platform package.
//
// This is the THIRD and lowest-priority channel behind the two every rust*Bin() resolver already
// had (env override wins; then `<dataDir>/bin/<name>` for a locally-copied dev binary). A plain
// `npm i -g agentlenspro` has neither of those — this is what lets it run the Rust binaries at
// all. It is also the one that returns null instead of throwing: an unsupported platform, or a
// dev checkout where CI has not staged `bin-native/`, must yield null so the caller can report
// "no server available" (there is no TS server to fall back to) rather than crash the CLI.
//
// win32-x64 is deliberately absent: rust-core/crates/agentlens-core/src/pid_lock.rs calls
// `libc::kill`/`libc::EPERM` with no `#[cfg(unix)]` guard, so the crate does not build for
// windows-msvc today. Shipping a windows leg is future work, not a musl-style speculative add.
import * as fs from 'fs'
import * as path from 'path'

/** The platform-arch keys we ship binaries for. A key absent here means "no binary shipped",
 *  which is a null result, not an error. */
const SHIPPED_TARGETS = new Set(['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'])

/** `bin-native/` sits at the package root; this module is bundled into `<root>/standalone/*.js`,
 *  so one level up from __dirname is the package root in an installed tarball AND in a dev
 *  checkout (where the directory simply does not exist yet — hence the existence check). */
const DEFAULT_BASE_DIR = path.join(__dirname, '..', 'bin-native')

/** True when `p` is a file we can execute. Used instead of a bare existsSync because an
 *  archive that lost the x-bit in transit is the failure this whole channel is most likely to
 *  hit — a non-executable binary must read as "not shipped" and fall back, not as a spawn EACCES
 *  deep inside a server boot. */
function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The binary's path inside this package's `bin-native/<platform-arch>/`, or null when this
 *  platform has no shipped binary, the file is missing (a dev checkout, or `bin-native/` pruned),
 *  or it is present but not executable.
 *
 *  `platformArch`, `exists` and `baseDir` are injectable (defaults: the real
 *  `process.platform-arch`, an X_OK check, and the packaged `bin-native/`) purely so tests can
 *  exercise every branch without a real cross-platform install. */
export function npmPlatformBin(
  name: string,
  platformArch: string = `${process.platform}-${process.arch}`,
  exists: (p: string) => boolean = isExecutableFile,
  baseDir: string = DEFAULT_BASE_DIR,
): string | null {
  if (!SHIPPED_TARGETS.has(platformArch)) return null
  const p = path.join(baseDir, platformArch, name)
  return exists(p) ? p : null
}


/** The repo checkout root, for the dev-only resolver rungs: the first of 1-3 levels above this
 *  module (bundled `standalone/`, `src/`, `out/test/`) that holds `rust-core/`. Null in an
 *  installed package, which ships no rust-core/. A candidate must hold BOTH `rust-core/` and a
 *  `package.json` named exactly `agentlenspro`: an installed copy sitting under an unrelated
 *  project that has its own `rust-core/` must not make us run a binary found by directory name. */
export function defaultRepoRoot(start: string = __dirname): string | null {
  for (const up of [['..'], ['..', '..'], ['..', '..', '..']]) {
    const c = path.resolve(start, ...up)
    if (!fs.existsSync(path.join(c, 'rust-core'))) continue
    try {
      if (JSON.parse(fs.readFileSync(path.join(c, 'package.json'), 'utf8')).name === 'agentlenspro') return c
    } catch {
      // no readable package.json: not our checkout
    }
  }
  return null
}

/** `aldigest`, the ingest-digest sidecar, or null when it cannot be found (never throws: it is
 *  optional, see alcoreServeArgs). Order: `AGENTLENS_ALDIGEST_BIN` (explicit — authoritative, a
 *  bad value is null, not a fall-through); then the file next to the resolved alcore; then, for a
 *  repo checkout only, `rust-core/target/release/aldigest`. */
export function aldigestBin(
  env: NodeJS.ProcessEnv = process.env,
  alcore: string | null = null,
  repoRoot: string | null = defaultRepoRoot(),
): string | null {
  const v = env.AGENTLENS_ALDIGEST_BIN?.trim()
  if (v) return isExecutableFile(v) ? v : null
  const candidates: string[] = []
  if (alcore) candidates.push(path.join(path.dirname(alcore), 'aldigest'))
  if (repoRoot) candidates.push(path.join(repoRoot, 'rust-core', 'target', 'release', 'aldigest'))
  return candidates.find(isExecutableFile) ?? null
}

/** The ingest schemas `manifest.json`, or null. Order: `AGENTLENS_INGEST_MANIFEST` (explicit,
 *  authoritative); then `ingest-schemas/manifest.json` at the package root, found from the alcore
 *  path (`<root>/bin-native/<platform-arch>/alcore`); then, for a repo checkout only,
 *  `rust-core/crates/agentlens-digest/schemas/manifest.json`. */
export function ingestManifestPath(
  env: NodeJS.ProcessEnv = process.env,
  alcore: string | null = null,
  repoRoot: string | null = defaultRepoRoot(),
): string | null {
  const isFile = (p: string): boolean => { try { return fs.statSync(p).isFile() } catch { return false } }
  const v = env.AGENTLENS_INGEST_MANIFEST?.trim()
  if (v) return isFile(v) ? v : null
  const candidates: string[] = []
  if (alcore) candidates.push(path.resolve(path.dirname(alcore), '..', '..', 'ingest-schemas', 'manifest.json'))
  if (repoRoot) candidates.push(path.join(repoRoot, 'rust-core', 'crates', 'agentlens-digest', 'schemas', 'manifest.json'))
  return candidates.find(isFile) ?? null
}
