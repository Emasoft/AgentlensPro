import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { startupVerdict, readyTimeoutMs, logTail, raceWinnerPid } from '../cli/serverControl'

// TRDD-M8SV6LK5 — `server start` announced a failure that had not happened.
//
// Observed 2026-08-01 on a store of 2.89M spans: the server came up and served correctly, and the CLI
// still printed "did not become ready within 20s". The operator reads that as "it failed", re-runs
// `server start`, the single-owner guard correctly refuses the second one, and the machine now looks
// wedged — off the back of a sentence that was untrue when it was printed.
//
// The defect was a DECISION, not a duration: startup is O(store), so a fixed budget fails exactly on
// the machines that have used the tool most. The wait is now bounded by LIVENESS, and the decision is
// this pure function, so the four cases can be pinned instead of living inside a `for` bound.

suite('server startup: the verdict is about liveness, not a stopwatch (TRDD-M8SV6LK5)', () => {
  test('answering wins over everything else, including a dead child', () => {
    // Our spawn exits whenever ANOTHER server won the single-instance race. If the endpoint answers,
    // that race was won by someone and the start succeeded — reporting a death there would be false.
    assert.strictEqual(startupVerdict({ answered: true, childExited: true, anotherServing: true, raceWinnerAlive: false, deadlinePassed: true }), 'ready')
    assert.strictEqual(startupVerdict({ answered: true, childExited: false, anotherServing: false, raceWinnerAlive: false, deadlinePassed: false }), 'ready')
  })

  test('a dead child with nothing serving AND no live race winner fails IMMEDIATELY', () => {
    // The whole budget could only delay a diagnosis the server log already holds.
    assert.strictEqual(startupVerdict({ answered: false, childExited: true, anotherServing: false, raceWinnerAlive: false, deadlinePassed: false }), 'died')
  })

  test('a dead child while another server IS serving is not a death — it is the race being lost', () => {
    // This is the single-instance guard working: our spawn refused the data dir and exited. Calling
    // it a death would turn correct behaviour into an error the operator then tries to "fix".
    assert.strictEqual(startupVerdict({ answered: false, childExited: true, anotherServing: true, raceWinnerAlive: false, deadlinePassed: false }), 'keep-waiting')
  })

  test('a dead child that LOST the race to a still-BOOTING winner keeps waiting (TRDD-861LC4VW second half)', () => {
    // Observed live 2026-08-13 19:23: restart's child lost the single-owner race to a concurrent
    // hook's spawn; the winner spent seconds booting (first DB open is O(store)) and answered
    // nothing, so anotherServing was false and the old decision declared 'died' — restart printed
    // FAIL while the winner came up healthy moments later. A live race winner is a start in
    // progress, not a death.
    assert.strictEqual(startupVerdict({ answered: false, childExited: true, anotherServing: false, raceWinnerAlive: true, deadlinePassed: false }), 'keep-waiting')
    // And if even the winner dies before the deadline, the verdict falls back honestly.
    assert.strictEqual(startupVerdict({ answered: false, childExited: true, anotherServing: false, raceWinnerAlive: false, deadlinePassed: false }), 'died')
    // The deadline still bounds a winner that boots forever.
    assert.strictEqual(startupVerdict({ answered: false, childExited: true, anotherServing: false, raceWinnerAlive: true, deadlinePassed: true }), 'timed-out')
  })

  test('alive and not yet answering keeps waiting — that is the case the old fixed budget got wrong', () => {
    assert.strictEqual(startupVerdict({ answered: false, childExited: false, anotherServing: false, raceWinnerAlive: false, deadlinePassed: false }), 'keep-waiting')
  })

  test('only an expired deadline on a still-alive process is a timeout, and it is the LAST resort', () => {
    assert.strictEqual(startupVerdict({ answered: false, childExited: false, anotherServing: false, raceWinnerAlive: false, deadlinePassed: true }), 'timed-out')
  })

  test('the ready budget is generous by default and overridable, and nonsense is floored not obeyed', () => {
    const prev = process.env.AGENTLENS_SERVER_READY_TIMEOUT_MS
    try {
      delete process.env.AGENTLENS_SERVER_READY_TIMEOUT_MS
      assert.strictEqual(readyTimeoutMs(), 180_000, 'the default must outlast a slow first DB open on a big store')
      process.env.AGENTLENS_SERVER_READY_TIMEOUT_MS = '45000'
      assert.strictEqual(readyTimeoutMs(), 45_000)
      // A too-small or unparseable value would reintroduce the false-failure this fix removes.
      for (const bad of ['0', '-5', 'soon', '', '999']) {
        process.env.AGENTLENS_SERVER_READY_TIMEOUT_MS = bad
        assert.strictEqual(readyTimeoutMs(), 180_000, `${bad || '(empty)'} must fall back to the default`)
      }
    } finally {
      if (prev === undefined) delete process.env.AGENTLENS_SERVER_READY_TIMEOUT_MS
      else process.env.AGENTLENS_SERVER_READY_TIMEOUT_MS = prev
    }
  })
})

suite('server startup: the error SHOWS the log instead of pointing at it', () => {
  const withDataDir = (fn: (dir: string) => void): void => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-logtail-'))
    const prev = process.env.DATA_DIR
    process.env.DATA_DIR = dir
    try { fn(dir) } finally {
      if (prev === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  test('returns the LAST lines of the server log, so the reason travels with the error', () => {
    withDataDir(dir => {
      fs.writeFileSync(path.join(dir, 'server.log'), Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n') + '\n')
      const tail = logTail(8)
      assert.ok(tail.includes('line-19'), 'the newest line must be there — it is the one that says why')
      assert.ok(tail.includes('line-12'), 'exactly the last 8')
      assert.ok(!tail.includes('line-11'), 'and not more than asked for')
    })
  })

  test('a missing or unreadable log degrades to a stated reason and NEVER throws', () => {
    // This runs inside an error path. A tail reader that throws replaces the real diagnosis with
    // its own stack — the exact failure the server log exists to prevent.
    withDataDir(() => {
      const tail = logTail(5)
      assert.ok(typeof tail === 'string' && tail.length > 0)
      assert.ok(/could not read|is empty/.test(tail), `expected a stated reason, got: ${tail}`)
    })
  })

  test('raceWinnerPid reads ONLY our attempt\'s bytes and names the winner — foreign eras are invisible', () => {
    withDataDir(dir => {
      const refusal = (pid: number): string =>
        `[AgentlensPro] Refusing to start: another AgentlensPro server (pid ${pid}) already owns this data directory (${dir}).\n` +
        '[AgentlensPro] Only ONE server may run per data directory — two processes appending to the same span store, offsets and cards corrupt each other.\n'
      // A HISTORICAL refusal from another era sits before our offset — quoting its pid would be
      // the exact resurrection of the shared-log confusion the card documents.
      fs.writeFileSync(path.join(dir, 'server.log'), refusal(11111))
      const ours = fs.statSync(path.join(dir, 'server.log')).size
      assert.strictEqual(raceWinnerPid(ours), null, 'no bytes from our attempt yet — no winner claim')
      fs.appendFileSync(path.join(dir, 'server.log'), refusal(22222))
      assert.strictEqual(raceWinnerPid(ours), 22222, 'the winner named by OUR attempt\'s refusal')
      assert.strictEqual(raceWinnerPid(0), 22222, 'unscoped, the LAST refusal wins (never an older era over a newer one)')
    })
  })

  test('raceWinnerPid answers null, never throws, on a missing log or refusal-free bytes', () => {
    withDataDir(dir => {
      assert.strictEqual(raceWinnerPid(0), null, 'no log at all')
      fs.writeFileSync(path.join(dir, 'server.log'), 'listening on 4318\nno refusals here\n')
      assert.strictEqual(raceWinnerPid(0), null, 'a healthy boot names no winner — a genuine death stays a death')
    })
  })
})
