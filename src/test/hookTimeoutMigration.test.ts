import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { safeConfigEdit } from '../safeConfigEdit'
import {
  buildEventOps, isOurHookCommand, rebuildEventMatchers, HOOK_EVENTS, GATE_EVENTS,
  REVIEW_EVENTS, SUPERVISOR_EVENTS, HOOK_TIMEOUT_SEC, type HookMatcher,
} from '../cli/hookInstall'
import { packageVersion } from '../packageVersion'

// The registrations are stamped with the running version (TRDD-YL3EWT6N item 5B), so the op lists are built for that version.
const RUN = packageVersion()

const EVENTS = [...new Set([...HOOK_EVENTS, ...GATE_EVENTS, ...REVIEW_EVENTS, ...SUPERVISOR_EVENTS])]
const fresh = (ev: string): HookMatcher[] => rebuildEventMatchers([], ev, false, RUN).rebuilt
const at = (ms: HookMatcher[], timeout: number): HookMatcher[] =>
  ms.map(m => ({ ...m, hooks: m.hooks.map(h => ({ ...h, timeout })) }))

suite('hook timeout migration — an old registration is rewritten on the next install', () => {
  // a registration still carrying the previous 30s ceiling is drift: the installer must emit ops
  test('registrations at timeout 30 produce a non-empty op list and rebuild to HOOK_TIMEOUT_SEC', () => {
    assert.strictEqual(HOOK_TIMEOUT_SEC, 120)
    for (const ev of EVENTS) {
      const stale = at(fresh(ev), 30)
      assert.ok(buildEventOps(ev, stale, false, RUN).length > 0, `${ev}: 30s registration must be treated as drift`)
      const rebuilt = rebuildEventMatchers(stale, ev, false, RUN).rebuilt
      assert.ok(rebuilt.length > 0)
      for (const h of rebuilt.flatMap(m => m.hooks)) assert.strictEqual(h.timeout, HOOK_TIMEOUT_SEC, `${ev}: ${h.command}`)
    }
  })

  // registrations already at HOOK_TIMEOUT_SEC need no change
  test('registrations already at HOOK_TIMEOUT_SEC are idempotent (no ops)', () => {
    for (const ev of EVENTS) assert.deepStrictEqual(buildEventOps(ev, at(fresh(ev), HOOK_TIMEOUT_SEC), false, RUN), [], ev)
  })
})
suite('hook timeout migration — ops applied through the real safe_config_edit engine', () => {
  // a settings.json whose agentlenspro entries sit at 30s is rewritten to 120s, and a second apply is a no-op
  test('applying buildEventOps to a 30s settings.json yields 120s everywhere, then changes nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-hooktimeout-'))
    const file = path.join(dir, 'settings.json')
    try {
      const hooks: Record<string, HookMatcher[]> = {}
      for (const ev of EVENTS) hooks[ev] = at(fresh(ev), 30)
      fs.writeFileSync(file, JSON.stringify({ hooks }, null, 2))
      const read = (): Record<string, HookMatcher[]> => (JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks: Record<string, HookMatcher[]> }).hooks
      // One engine call for every event (one python spawn, not ~30).
      const before = read()
      const ops = EVENTS.flatMap(ev => {
        const o = buildEventOps(ev, before[ev] ?? [], false, RUN)
        assert.ok(o.length > 0, ev)
        return o
      })
      await safeConfigEdit(file, 'json', ops)
      const after = read()
      const entries = Object.values(after).flat().flatMap(m => m.hooks).filter(h => isOurHookCommand(h.command))
      assert.ok(entries.length > 0)
      for (const h of entries) assert.strictEqual(h.timeout, HOOK_TIMEOUT_SEC, h.command)
      for (const ev of EVENTS) assert.deepStrictEqual(buildEventOps(ev, after[ev] ?? [], false, RUN), [], `${ev}: second apply must change nothing`)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
