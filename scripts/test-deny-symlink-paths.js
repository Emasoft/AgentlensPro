#!/usr/bin/env node
// Matrix for scripts/deny-symlink-paths.js. Real dirs, real symlinks — the guard's whole job is a
// filesystem judgement, so a mocked fs would test nothing.
//
// The load-bearing halves: an agent-created symlink in a NAMED path is stopped once with an OTP,
// and the platform's own symlinks (/tmp, homebrew) are NOT — a guard that demanded a password for
// every command touching /tmp would be switched off within the hour.

const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const GUARD = path.join(__dirname, 'deny-symlink-paths.js')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symguard-'))
const real = path.join(root, 'real')
const link = path.join(root, 'linked')
const deep = path.join(link, 'a', 'b')
fs.mkdirSync(path.join(real, 'a', 'b'), { recursive: true })
fs.symlinkSync(real, link)
fs.writeFileSync(path.join(real, 'file.txt'), 'x')

const run = (command) => {
  const out = execFileSync('node', [GUARD], {
    input: JSON.stringify({ tool_input: { command }, cwd: root }), encoding: 'utf8',
  })
  return { denied: out.includes('"deny"'), otp: (/SYMLINK_OTP=([0-9A-F]{8})/.exec(out) || [])[1], out }
}

let failed = 0
const check = (ok, desc) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${desc}`) }

// --- the point of the guard -------------------------------------------------------------------
check(run(`ls ${link}`).denied, 'a named symlink is stopped')
check(run(`cat ${deep}/../file.txt`).denied, 'a symlink as an ANCESTOR of the named path is stopped')
check(run(`rm -rf ${link}/a`).denied, 'the destructive shape that motivated this is stopped')
check(!run(`ls ${real}`).denied, 'the real path behind the link is allowed')
check(!run('echo hello').denied, 'a command with no path is allowed')
check(!run('git status').denied, 'an ordinary command is allowed')

// --- paths with SPACES. Routine on macOS; all three spellings silently bypassed the guard until
// --- quoted segments were extracted whole (measured 2026-09-03).
const spaced = path.join(root, 'My Project')
fs.symlinkSync(real, spaced)
check(run(`ls "${spaced}/x"`).denied, 'double-quoted spaced path')
check(run(`ls '${spaced}/x'`).denied, 'single-quoted spaced path')
check(run(`ls ${spaced.replace(' ', '\\ ')}/x`).denied, 'backslash-escaped spaced path')

// --- the exclusions: platform symlinks must NOT cost an OTP -----------------------------------
// AND their SUBTREES must still be inspected. Listing /tmp and /var as PREFIXES excluded every
// scratch dir and worktree — including the incident path — and the matrix only noticed because its
// fixture happens to live in a temp dir. This case makes that explicit instead of accidental.
// The owner's own example, on a LITERAL /tmp path — not under mkdtemp, so it cannot pass by an
// accident of where fixtures happen to live: "/tmp is a known symlink, so it's ignored. but if
// after tmp there is a non whitelisted symlink folder (i.e. /tmp/this-is-a-symlink/) then it must
// trigger the protection."
const litReal = `/tmp/symguard-real-${process.pid}`
const litLink = `/tmp/symguard-link-${process.pid}`
fs.mkdirSync(path.join(litReal, 'sub'), { recursive: true })
fs.symlinkSync(litReal, litLink)
check(run(`ls ${litLink}/`).denied, 'a symlink COMPONENT under /tmp triggers, though /tmp itself does not')
check(run(`cat ${litLink}/sub/f.txt`).denied, '...at any depth beneath it')
check(!run(`ls ${litReal}/sub`).denied, 'a real path under /tmp stays allowed')
fs.unlinkSync(litLink); fs.rmSync(litReal, { recursive: true, force: true })

const tmpLink = path.join(os.tmpdir(), `symguard-probe-${process.pid}`)
try { fs.symlinkSync(real, tmpLink) } catch { /* leftover from a crashed run */ }
check(run(`ls ${tmpLink}`).denied, 'a symlink UNDER the excluded /var|/tmp root is still caught')
try { fs.unlinkSync(tmpLink) } catch { /* already gone */ }
check(!run('ls /tmp/whatever').denied, 'macOS /tmp (itself a symlink) is excluded')
check(!run('cat /etc/hosts').denied, 'macOS /etc is excluded')
check(!run('ls /opt/homebrew/bin/node').denied, 'homebrew bin shims are excluded')

// --- env / ~ / composite resolution ------------------------------------------------------------
check(run(`ls $\{SYMGUARD_T\}/linked`.replace('${SYMGUARD_T}', root)).denied, 'literal composite path')
process.env.SYMGUARD_T = root
check(run('ls $SYMGUARD_T/linked').denied, '$VAR is resolved before checking')
check(run('ls ${SYMGUARD_T}/linked').denied, '${VAR} is resolved before checking')
check(!run('ls $SYMGUARD_UNSET_VAR/x').denied, 'an unresolvable $VAR is skipped, never guessed')

// --- the OTP contract --------------------------------------------------------------------------
const first = run(`ls ${link}`)
check(!!first.otp, 'a denial issues an OTP')
check(!run(`SYMLINK_OTP=${first.otp} ls ${link}`).denied, 'the OTP lets the SAME command through')

const second = run(`ls ${link}`)
check(!run(`SYMLINK_OTP=${second.otp} ls ${link}`).denied, 'a fresh OTP works once')
check(run(`SYMLINK_OTP=${second.otp} ls ${link}`).denied, 'the SAME OTP does not work twice')

const third = run(`ls ${link}`)
check(run(`SYMLINK_OTP=${third.otp} rm -rf ${link}`).denied, 'an OTP is bound to its command, not reusable for another')
check(run(`SYMLINK_OTP=DEADBEEF ls ${link}`).denied, 'a fabricated OTP does not pass')

// --- fail-open ---------------------------------------------------------------------------------
try {
  const out = execFileSync('node', [GUARD], { input: 'not json', encoding: 'utf8' })
  check(!out.includes('deny'), 'unparseable payload falls through silently')
} catch (e) { check(false, `unparseable payload: ${e.message}`) }

fs.rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? '\nOK — all cases' : `\n${failed} FAILING`)
process.exit(failed === 0 ? 0 : 1)
