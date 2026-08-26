// src/rustBinResolve.ts — resolves an alcore/alstore/alscan/allogscan binary shipped inside the
// per-platform npm optionalDependency package (TRDD-EAK9R8IY). Same shape as
// `@duckdb/node-bindings`, already in this dependency tree: one `agentlenspro-<platform>`
// package per (process.platform, process.arch), each carrying the binaries for that target.
//
// This is the THIRD and lowest-priority channel behind the two every rust*Bin() resolver already
// had (env override wins; then `<dataDir>/bin/<name>` for a locally-copied dev binary). A plain
// `npm i -g agentlenspro` has neither of those — this is what lets it run the Rust binaries at
// all. It is also the one that silently returns null instead of throwing: an unsupported
// platform, or `--omit=optional` stripping the platform package, must fall back to the TS
// server, not crash the CLI.
//
// win32-x64 is deliberately absent: rust-core/crates/agentlens-core/src/pid_lock.rs calls
// `libc::kill`/`libc::EPERM` with no `#[cfg(unix)]` guard, so the crate does not build for
// windows-msvc today. Shipping a windows leg is future work, not a musl-style speculative add.
const PLATFORM_PACKAGES: Record<string, string> = {
  'darwin-arm64': 'agentlenspro-darwin-arm64',
  'darwin-x64': 'agentlenspro-darwin-x64',
  'linux-x64': 'agentlenspro-linux-x64',
  'linux-arm64': 'agentlenspro-linux-arm64',
}

/** The binary's resolved path inside its platform package, or null when this platform has no
 *  published package for it (unsupported arch/OS) or the package/binary is missing
 *  (`--omit=optional` stripped it, or a dev checkout with no platform packages installed).
 *
 *  `platformArch` and `resolve` are injectable (default: the real `process.platform-arch` and
 *  `require.resolve`) purely so tests can exercise both branches without a real platform
 *  package installed. */
export function npmPlatformBin(
  name: string,
  platformArch: string = `${process.platform}-${process.arch}`,
  resolve: (id: string) => string = (id) => require.resolve(id),
): string | null {
  const pkg = PLATFORM_PACKAGES[platformArch]
  if (!pkg) return null
  try {
    return resolve(`${pkg}/bin/${name}`)
  } catch {
    return null
  }
}
