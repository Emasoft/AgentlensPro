// Regenerates callcontext-expected.json from the COMPILED TS rawBodyContext.js — the parity
// oracle for freeze row 35 (resolveCallContext's four post-assignments).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-callcontext-expected.mjs
//
// This writes only into fixtures/bodies/, NOT claude-home/, so it does not disturb row 32's
// listSessionFileIds oracle.
//
// The discriminators here are almost entirely about KEY ORDER, which no test of freshly-built
// contexts can observe:
//  - `ctx.requestId = …` APPENDS, so requestId lands AFTER `truncated`.
//  - `if (!ctx.model) ctx.model = ptr.model` is a FALSY test. When the body carried NO model the
//    key is created HERE, landing after requestId; when it carried an EMPTY STRING the key already
//    exists and keeps its ORIGINAL position while its value is replaced. Same code path, two
//    different wire shapes.
//  - assigning an undefined ptr.model over a falsy ctx.model REMOVES the key from the JSON.
//  - `sel.requestId ?? ptr.requestId` — nullish, and with neither the key is omitted entirely.
import { createRequire } from 'module'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
const require = createRequire(import.meta.url)
const dir = new URL('.', import.meta.url).pathname
const bodiesDir = join(dir, 'bodies')
mkdirSync(bodiesDir, { recursive: true })
const { resolveCallContext, callBodyRegistry } = require('../../../../../out/test/rawBodyContext.js')

const META = JSON.stringify({ session_id: 'cc-inner', account_uuid: 'cc-acct' })
writeFileSync(join(bodiesDir, 'cc-model.request.json'), JSON.stringify({
  model: 'claude-opus-5', metadata: { user_id: META },
  system: 'sys', messages: [{ role: 'user', content: 'hi' }],
}))
writeFileSync(join(bodiesDir, 'cc-nomodel.request.json'), JSON.stringify({
  metadata: { user_id: META }, system: 'sys', messages: [{ role: 'user', content: 'hi' }],
}))
writeFileSync(join(bodiesDir, 'cc-emptymodel.request.json'), JSON.stringify({
  model: '', metadata: { user_id: META }, system: 'sys', messages: [{ role: 'user', content: 'hi' }],
}))

const B = (f) => join(bodiesDir, f)
// Each case gets its OWN session id so the registry lookups cannot cross-contaminate.
const cases = [
  { name: 'model-and-sel-request-id', session: 's-a', sel: { requestId: 'req-sel' },
    pointers: [{ kind: 'request', bodyRef: B('cc-model.request.json'), ts: 1, requestId: 'req-ptr', model: 'ptr-model' }] },
  { name: 'no-sel-falls-back-to-pointer-request-id', session: 's-b', sel: {},
    pointers: [{ kind: 'request', bodyRef: B('cc-model.request.json'), ts: 1, requestId: 'req-ptr' }] },
  { name: 'no-request-id-anywhere-omits-the-key', session: 's-c', sel: {},
    pointers: [{ kind: 'request', bodyRef: B('cc-model.request.json'), ts: 1 }] },
  { name: 'body-without-model-appends-it-after-requestId', session: 's-d', sel: { requestId: 'r1' },
    pointers: [{ kind: 'request', bodyRef: B('cc-nomodel.request.json'), ts: 1, model: 'ptr-model' }] },
  { name: 'empty-string-model-is-replaced-in-place', session: 's-e', sel: { requestId: 'r1' },
    pointers: [{ kind: 'request', bodyRef: B('cc-emptymodel.request.json'), ts: 1, model: 'ptr-model' }] },
  { name: 'falsy-model-and-no-pointer-model-drops-the-key', session: 's-f', sel: {},
    pointers: [{ kind: 'request', bodyRef: B('cc-emptymodel.request.json'), ts: 1 }] },
  { name: 'inline-body', session: 's-g', sel: { requestId: 'r1' },
    pointers: [{ kind: 'request', inlineBody: JSON.stringify({ model: 'inline-model', metadata: { user_id: META }, messages: [{ role: 'user', content: 'inline hi' }] }), ts: 1 }] },
  { name: 'unparseable-inline-body-is-null', session: 's-h', sel: {},
    pointers: [{ kind: 'request', inlineBody: '{ broken', ts: 1 }] },
  { name: 'missing-body-file-is-null', session: 's-i', sel: {},
    pointers: [{ kind: 'request', bodyRef: B('no-such.request.json'), ts: 1 }] },
  { name: 'no-pointer-at-all-is-null', session: 's-j', sel: {}, pointers: [] },
  // A response pointer carrying the request_id, hopped back to its request via the shared spanId.
  { name: 'request-id-hops-response-to-request-via-spanId', session: 's-k', sel: { requestId: 'req-only-on-response' },
    pointers: [
      { kind: 'request', bodyRef: B('cc-model.request.json'), ts: 10, spanId: 'sp-x' },
      { kind: 'response', bodyRef: B('cc-model.request.json'), ts: 11, spanId: 'sp-x', requestId: 'req-only-on-response' },
    ] },
]
for (const c of cases) for (const p of c.pointers) callBodyRegistry.record(c.session, p)

const J = (v) => JSON.parse(JSON.stringify(v ?? null))
const strip = (t) => t.split(bodiesDir + '/').join('')
const results = []
for (const c of cases) {
  const ctx = await resolveCallContext(c.session, c.sel)
  results.push({ ctx: J(ctx), accountAfter: callBodyRegistry.accountFor(c.session) ?? null })
}
writeFileSync(join(dir, 'callcontext-expected.json'), strip(JSON.stringify({
  cases: J(cases),
  results: J(results),
}, null, 1)))
console.log(`callcontext-expected.json: ${cases.length} cases`)
