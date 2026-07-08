// Structural stand-ins for the few VS Code API shapes that the retained
// persistence (database/*, sessionRepository), export, and collector modules
// still reference. The VS Code extension host was removed (TRDD-6E6416B8), so
// there is no longer a `vscode` module (or `@types/vscode`) to import from.
// These modules are kept per the TRDD KEEP inventory and are now exercised only
// by unit tests, which inject fakes. Defining the shapes here lets the whole
// `src/` tree type-check — and the standalone bundle — with ZERO dependency on
// `vscode`, while preserving the exact runtime behaviour the modules had.

/** The subset of `vscode.Uri` these modules use: a `path` they join onto. */
export interface UriLike {
  readonly scheme?: string
  readonly path: string
  readonly fsPath?: string
}

/**
 * Mirrors `vscode.Uri.joinPath` for a UriLike: appends '/'-joined segments to
 * `path`, preserving the other fields. Kept byte-identical to the behaviour the
 * old `vscode.Uri.joinPath` gave these code paths so the persisted blob layout
 * is unchanged.
 */
export function joinUri(base: UriLike, ...parts: string[]): UriLike {
  return { ...base, path: [base.path, ...parts].join('/') }
}

/** The `vscode.workspace.fs` methods the blob writer uses. */
export interface WriteBlobFs {
  stat(uri: UriLike): PromiseLike<unknown>
  writeFile(uri: UriLike, content: Uint8Array): PromiseLike<void>
}

/** The `vscode.workspace.fs` method the blob reader uses. */
export interface ReadBlobFs {
  readFile(uri: UriLike): PromiseLike<Uint8Array>
}

/** The `vscode.workspace.fs` methods `clearBlobs` enumerates + deletes with. */
export interface DirBlobFs {
  readDirectory(uri: UriLike): PromiseLike<Array<[string, number]>>
  delete(uri: UriLike): PromiseLike<void>
}

/** `vscode.FileType` values our code compares against. */
export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const

/** The `vscode.OutputChannel` surface the OTLP collector logs to (appendLine). */
export interface OutputChannelLike {
  appendLine(value: string): void
}
