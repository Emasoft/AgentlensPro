// TRDD-FMIZO8Y4 — embed/deep-link query params for the dashboard (the ai-maestro iframe contract).
//
// RUNTIME-NEUTRAL (src/shared/ law): no Node imports, no DOM — URLSearchParams exists in both
// runtimes. The webview entry (media/src/dashboard.tsx) parses location.search through this ONE
// function before rendering; the unit tests exercise the same function under mocha. Validation is
// REAL here because the app's normalizeTabId is an identity passthrough — an unvalidated ?tab=
// would land the UI on a blank panel.

export interface EmbedParams {
  /** True when the page is embedded (?embed=1|true|yes) — the host hides VS-Code-era chrome. */
  embed: boolean
  /** A VALIDATED initial tab id, or undefined when absent/unknown (caller keeps its default). */
  tab?: string
}

export function parseEmbedParams(search: string, validTabs: readonly string[]): EmbedParams {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const embedRaw = (q.get('embed') ?? '').toLowerCase()
  const embed = embedRaw === '1' || embedRaw === 'true' || embedRaw === 'yes'
  const tabRaw = q.get('tab')
  const tab = tabRaw && validTabs.includes(tabRaw) ? tabRaw : undefined
  return { embed, ...(tab !== undefined ? { tab } : {}) }
}
