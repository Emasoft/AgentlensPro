// src/environment/types.ts — the contract every environment detector implements (TRDD-HUWJVQJA).
// A facet is a self-describing unit: a name, aliases, an async gather() that returns a JSON-safe
// object (fail-soft — it must resolve, never reject), and a render() that turns that object into a
// compact human digest. The registry in index.ts lists them; the CLI (envCli.ts) drives them, either
// one facet at a time or all at once as a single JSON report written to disk (token economy).

export interface EnvFacet {
  /** Canonical facet name, e.g. 'terminal' — also the `agentlenspro env <name>` subcommand. */
  name: string
  /** Alternate names the CLI accepts for this facet (e.g. 'net' → 'network'). */
  aliases: string[]
  /** One-line description for `agentlenspro env list`. */
  summary: string
  /** Collect the facet's data. MUST resolve (fail-soft); on partial failure return what it could. */
  gather(): Promise<unknown>
  /** Render a gathered value as a compact multi-line human digest (no ANSI — matches the CLI style). */
  render(value: unknown): string
}

/** The whole-environment report: every facet keyed by name, plus capture metadata. */
export interface EnvReport {
  capturedAt: string
  facets: Record<string, unknown>
}
