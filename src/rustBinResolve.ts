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
// dev checkout where CI has not staged `bin-native/`, must fall back to the TS server rather than
// crash the CLI.
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
