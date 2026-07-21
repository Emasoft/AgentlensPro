// Lifecycle-events model (TRDD-EYA3X5MQ) — a PURE mapping from the raw hook-event store
// (src/hookEventStore.ts) to typed, human-meaningful session-lifecycle events. No I/O, no globals:
// it takes the records the store already persisted and classifies them, so it is trivially testable
// and shared by the host (get_lifecycle_events / reload-cost) and, via the API, the dashboard.
//
// WHY this exists: the store keeps every hook payload verbatim (refinement at read time), so the
// `source`/`reason`/`trigger` discriminators that make a SessionStart mean "/clear" vs "resume" are
// buried in `payload`. This module surfaces them as first-class events — most importantly `/clear`
// (SessionStart source="clear"), the cost-remedy that resets the transcript floor, which was
// captured but never labeled. ConfigChange is mapped ahead of its hook being installed (P3) so the
// plugin-reload signal drops straight in once `--install-hooks` registers it.
import type { HookEventRecord } from './hookEventStore'

export type LifecycleKind =
  | 'STARTUP'        // SessionStart source=startup — a brand-new session
  | 'CLEAR'          // SessionStart source=clear — /clear reset the transcript floor (the cost remedy)
  | 'COMPACT'        // SessionStart source=compact — context was compacted (auto/manual)
  | 'RESUME'         // SessionStart source=resume — --resume/--continue//resume
  | 'FORK'           // SessionStart source=fork — --fork-session / /fork / /branch
  | 'SESSION_END'    // SessionEnd — the session terminated (detail = reason)
  | 'STOP'           // Stop — a turn finished (per-turn; noisy — consumers usually filter it out)
  | 'STOP_FAILURE'   // StopFailure — a turn died on an API error (detail = error_type)
  | 'PRE_COMPACT'    // PreCompact — a full-prefix rewrite is about to happen (detail = trigger)
  | 'POST_COMPACT'   // PostCompact — compaction finished (detail = trigger)
  | 'CONFIG_CHANGE'  // ConfigChange — a config file changed mid-session (detail = source; source=skills ≈ /reload-plugins)

export interface LifecycleEvent {
  ts: number              // server receive time (ms epoch); the hook fires within ~1s of the real event
  session?: string        // session_id when the payload carried one
  kind: LifecycleKind
  detail?: string         // the discriminator: SessionStart source / SessionEnd reason / *Compact trigger / StopFailure error_type / ConfigChange source
  ev: string              // the raw hook_event_name, kept for traceability
}

// The subset of SessionStart `source` values, mapped to their lifecycle kind. An UNKNOWN/absent
// source degrades to STARTUP (the doc's default new-session meaning) rather than being dropped.
const SESSION_START_KIND: Record<string, LifecycleKind> = {
  startup: 'STARTUP', clear: 'CLEAR', compact: 'COMPACT', resume: 'RESUME', fork: 'FORK',
}

// hook_event_name → the field on the payload that carries the human-meaningful discriminator.
const DETAIL_FIELD: Record<string, string> = {
  SessionStart: 'source', SessionEnd: 'reason', PreCompact: 'trigger', PostCompact: 'trigger',
  StopFailure: 'error_type', ConfigChange: 'source',
}

function str(v: unknown): string | undefined { return typeof v === 'string' ? v : undefined }

/**
 * Map one hook record to a lifecycle event, or null when the record is not a lifecycle event we
 * surface (e.g. PermissionRequest, Notification, SubagentStart — operational, not session-lifecycle).
 */
export function toLifecycleEvent(rec: HookEventRecord): LifecycleEvent | null {
  const detail = str(rec.payload[DETAIL_FIELD[rec.ev]])
  const base = { ts: rec.ts, session: rec.session, ev: rec.ev, detail }
  switch (rec.ev) {
    case 'SessionStart': return { ...base, kind: SESSION_START_KIND[detail ?? ''] ?? 'STARTUP' }
    case 'SessionEnd':   return { ...base, kind: 'SESSION_END' }
    case 'Stop':         return { ...base, kind: 'STOP' }
    case 'StopFailure':  return { ...base, kind: 'STOP_FAILURE' }
    case 'PreCompact':   return { ...base, kind: 'PRE_COMPACT' }
    case 'PostCompact':  return { ...base, kind: 'POST_COMPACT' }
    case 'ConfigChange': return { ...base, kind: 'CONFIG_CHANGE' }
    default:             return null
  }
}

export interface LifecycleFilter {
  kinds?: LifecycleKind[]     // keep only these kinds (default: all EXCEPT the per-turn STOP noise)
  session?: string            // keep only this session
  limit?: number              // cap the returned count (after most-recent-first sort)
}

// Kinds excluded by default because they are high-volume and low-signal, and would drown the
// cost-relevant boundaries (/clear, compaction, turn-death) a lifecycle view exists to show: STOP
// fires every TURN, and SESSION_END fires for every session (expected, rarely actionable). Opt
// either back in with an explicit `kinds` filter.
const DEFAULT_EXCLUDED: ReadonlySet<LifecycleKind> = new Set<LifecycleKind>(['STOP', 'SESSION_END'])

/**
 * Extract typed lifecycle events from raw hook records, most-recent-first. By default the per-turn
 * STOP events are excluded (noise); pass `kinds` to select an exact set (including STOP).
 */
export function extractLifecycleEvents(records: HookEventRecord[], filter: LifecycleFilter = {}): LifecycleEvent[] {
  const want = filter.kinds ? new Set(filter.kinds) : null
  const out: LifecycleEvent[] = []
  for (const rec of records) {
    if (filter.session !== undefined && rec.session !== filter.session) continue
    const ev = toLifecycleEvent(rec)
    if (!ev) continue
    if (want ? !want.has(ev.kind) : DEFAULT_EXCLUDED.has(ev.kind)) continue
    out.push(ev)
  }
  out.sort((a, b) => b.ts - a.ts)
  return filter.limit !== undefined ? out.slice(0, filter.limit) : out
}

// True when a ConfigChange record is the plugin-reload proxy: /reload-plugins re-reads the plugin/
// skill config, so a `skills`-sourced ConfigChange is the closest hook-confirmed reload signal
// (verify empirically per P3). Used by the reload-cost surface to tag hook-evidenced reloads.
export function isReloadConfigChange(ev: LifecycleEvent): boolean {
  return ev.kind === 'CONFIG_CHANGE' && ev.detail === 'skills'
}
