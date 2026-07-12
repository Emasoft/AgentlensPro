// src/environment/index.ts — the environment-facet REGISTRY (TRDD-HUWJVQJA). One flat array is the
// single source of truth the CLI drives: add a facet = add its module import + one array entry. Each
// facet is queried on its own or all at once (gatherAll runs them concurrently — they are independent).

import { terminalFacet } from './terminal'
import { osFacet } from './os'
import { runtimeFacet } from './runtime'
import { claudeFacet } from './claude'
import { filesystemFacet } from './filesystem'
import { userFacet } from './user'
import { networkFacet } from './network'
import { cloudFacet } from './cloud'
import { toolingFacet } from './tooling'
import { mcpFacet } from './mcp'
import type { EnvFacet, EnvReport } from './types'

// Ordered for a top-to-bottom human digest: what/where first, then tooling/cloud/network detail.
export const FACETS: readonly EnvFacet[] = [
  terminalFacet,
  osFacet,
  runtimeFacet,
  claudeFacet,
  filesystemFacet,
  userFacet,
  networkFacet,
  cloudFacet,
  toolingFacet,
  mcpFacet,
]

/** Resolve a facet by its name or any alias (case-insensitive). */
export function resolveFacet(name: string): EnvFacet | undefined {
  const n = name.trim().toLowerCase()
  return FACETS.find((f) => f.name === n || f.aliases.includes(n))
}

/** Gather every facet concurrently into one report. Each facet is fail-soft, so this always resolves. */
export async function gatherAll(): Promise<EnvReport> {
  const facets: Record<string, unknown> = {}
  await Promise.all(
    FACETS.map(async (f) => {
      try {
        facets[f.name] = await f.gather()
      } catch (e) {
        // A facet contract violation must not sink the whole report — record the error and continue.
        facets[f.name] = { error: (e as Error).message }
      }
    }),
  )
  return { capturedAt: new Date().toISOString(), facets }
}
