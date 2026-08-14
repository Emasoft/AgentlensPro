// TEMPLATE — copy this somewhere writable, fill the PROJECT block, then run it with the
// Workflow tool. Everything outside PROJECT is the pipeline and should not need editing.
//
// Shape (why it looks like this — the measurements are in ../references/measurements.md):
//   • An agent launch costs ~118k tokens BEFORE it does anything, so work is BATCHED per worker.
//     Fewer launches is the only large lever; reading fewer bytes per launch is noise.
//   • Find and fix live in ONE worker. A reader agent + a fixer agent measured 2.05x for the
//     same output — two boot floors for one job.
//   • The fix lane is SERIAL. A test suite (and even `tsc --noEmit`) verifies a TREE, not a file,
//     so two concurrent workers cannot verify against a tree the other is editing.

export const meta = {
  name: 'scan-and-fix',
  description: 'Collect red signals, cluster them, then fix each cluster serially with verification',
  phases: [
    { title: 'Fix', detail: 'one batched worker per cluster, serial — the verifier is global' },
  ],
}

// ─── PROJECT — the only part you customize ────────────────────────────────────────────────────
const PROJECT = {
  // Rebuild whatever the verification consumes (compiled tests, bundles). Runs BEFORE each
  // verify. Leave '' if your tests run straight from source.
  rebuild: 'pnpm run compile-tests',
  // Verify one cluster. `{files}` is replaced with the worker's space-separated file list.
  // Prefer a SCOPED run (fast); the full suite runs once at the end regardless.
  verifyScoped: 'npx mocha --no-config --ui tdd --require ./src/test/setup.js {files}',
  // The whole-project gates + full suite, run once after every cluster is done.
  gates: 'pnpm run check-types && pnpm run lint && pnpm run test:unit',
  // How many files one worker owns. The boot floor is ~118k tokens per launch, so batching 5
  // small files instead of 5 launches saves ~470k. Lower it only if the files are large.
  batch: 5,
}
// ──────────────────────────────────────────────────────────────────────────────────────────────

// `args` is the work list the orchestrator passes in — the output of the zero-LLM COLLECT and
// CLUSTER stages, which run OUTSIDE this script (a compiler and a test runner find errors for
// free; never spend an agent request finding what an exit code already reported).
//   [{ id: 'freePort-race', files: ['src/test/a.test.ts', …], evidence: 'error text + stack' }, …]
const clusters = Array.isArray(args) ? args : (args && args.clusters) || []
if (clusters.length === 0) return { fixed: 0, note: 'no clusters passed — nothing red to fix' }

const RESULT = {
  type: 'object',
  required: ['ok', 'cluster'],
  properties: {
    ok: { type: 'boolean' },
    cluster: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    verified: { type: 'string', description: 'the command actually run, or why none was' },
    crossFile: { type: 'string', description: 'set when the fix needs a file outside this batch' },
    remainder: { type: 'string', description: 'set when the cluster was really two bugs' },
    failReason: { type: 'string' },
  },
}

// The prompt is assembled fixed-part-first with the per-cluster variables LAST, so every worker
// shares one byte-identical prefix and only the tail diverges.
const FIXED = [
  'You own ONE cluster of failing tests in this repo. Find the root cause and fix it.',
  '',
  'PROCEDURE',
  '1. BEFORE writing a fix, search for an existing owner of this failure mode — a helper, a',
  '   fixture, a prior fix. Reimplementing one that exists is the most common way this goes',
  '   wrong: the copy lacks the safety properties the original earned.',
  '2. Confirm the failure against code you have actually read. Name the exact input or',
  '   interleaving that fails. If you cannot reproduce the claim, change NOTHING and say so.',
  '3. Fix the ROOT CAUSE, minimally, with a one-line comment stating the constraint that makes',
  '   the fix necessary. Never reach green by suppression: no ignore comments, no loosened',
  '   config, no deleted assertions, no removed callers.',
  '4. Batch ALL edits in ONE response. Then, as the LAST call of that SAME response, run the',
  '   rebuild and the scoped verification given below (tool calls in one response run in order,',
  '   so it sees your edits). A check that does not EXECUTE the code is not a verification.',
  '5. Two failed attempts means your model of the problem is wrong. Stop and report what you saw.',
  '',
  'OWNERSHIP: edit only the files listed for your cluster. If the correct fix needs another file,',
  'do NOT touch it — return crossFile with what is needed. Never run any git command.',
  '',
  'REBUILD: ' + (PROJECT.rebuild || '(none)'),
].join('\n')

const mkPrompt = (c) => [
  FIXED,
  '',
  'VERIFY: ' + PROJECT.verifyScoped.replace('{files}', (c.verifyTargets || c.files).join(' ')),
  '',
  'CLUSTER: ' + c.id,
  'FILES: ' + c.files.join(' '),
  'EVIDENCE:',
  c.evidence || '(none supplied)',
].join('\n')

phase('Fix')
const results = []
// SERIAL on purpose. Parallelism here buys wall-clock and costs correctness: the verifier is the
// whole tree. Measured — three concurrent workers each reported type errors that belonged to
// another worker's half-finished edits, so no worker could trust its own green.
for (const c of clusters) {
  if (budget.total && budget.remaining() < 150_000) {
    log(`budget floor reached — ${clusters.length - results.length} cluster(s) NOT attempted`)
    break
  }
  const r = await agent(mkPrompt(c), {
    agentType: 'agentlens-tldr-worker',
    label: `fix:${c.id}`,
    phase: 'Fix',
    schema: RESULT,
  })
  results.push(r || { ok: false, cluster: c.id, failReason: 'agent returned nothing' })
  log(`${c.id}: ${r && r.ok ? 'fixed' : 'NOT fixed'}`)
}

// Report every non-fixed cluster explicitly. A silent cap reads as "all clean" and is the one
// failure mode a fix pipeline must never have.
return {
  attempted: results.length,
  ofClusters: clusters.length,
  fixed: results.filter(r => r.ok).length,
  crossFile: results.filter(r => r.crossFile),
  remainders: results.filter(r => r.remainder),
  failed: results.filter(r => !r.ok),
  notAttempted: clusters.slice(results.length).map(c => c.id),
  // The orchestrator runs this itself afterwards — inside the script it would race the workers.
  gatesToRun: PROJECT.gates,
}
