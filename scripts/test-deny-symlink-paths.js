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
check(run(`cp x ${link}`).denied, 'a named symlink is stopped')
check(run(`cp ${deep}/../file.txt y`).denied, 'a symlink as an ANCESTOR of the named path is stopped')
check(run(`rm -rf ${link}/a`).denied, 'the destructive shape that motivated this is stopped')
check(!run(`cp x ${real}`).denied, 'the real path behind the link is allowed')
check(!run('echo hello').denied, 'a command with no path is allowed')
check(!run('git status').denied, 'an ordinary command is allowed')

// --- READ-ONLY commands are exempt, but only when the INVOCATION is read-only ---------------
check(!run(`ls ${link}`).denied, 'ls through a symlink reads nothing destructive: exempt')
check(!run(`cat ${link}/file.txt`).denied, 'cat is exempt')
check(!run(`find ${link} -name x`).denied, 'find is exempt')
check(!run(`grep -r foo ${link}`).denied, 'grep is exempt')
// ...and the exemption must NOT survive a redirect or a mutating flag, or it is a hole an agent
// walks through by accident.
check(run(`cat ${link}/file.txt > out.txt`).denied, 'a redirect makes a read-only command WRITE')
check(run(`ls ${link} >> log`).denied, 'append redirect too')
check(run(`find ${link} -delete`).denied, 'find -delete mutates')
check(run(`find ${link} -exec rm {} ;`).denied, 'find -exec mutates')
check(run(`cp x ${link} && ls ${link}`).denied, 'a mixed line is judged per segment, not as a whole')
// The case above passes under BOTH per-segment and judge-by-first-word, so it pins nothing. This
// one distinguishes them: read-only FIRST, mutating second. First-word judgement would allow it.
check(run(`ls ${link} && cp x ${link}`).denied, 'read-only first, mutating second: still denied')
check(run(`awk '{system("rm " $0)}' ${link}/f`).denied, 'awk is a language with system(), not a read-only filter')

// PIPING re-arms the exemption. A read-only command is harmless only if its OUTPUT goes nowhere
// dangerous — `ls <symlink> | oppa` reads through the link and hands the result to an unknown
// binary. Judging stages independently allowed exactly this.
check(run(`ls ${link} | oppa`).denied, 'read-only piped into an UNKNOWN binary re-arms the guard')
check(run(`cat ${link}/f | xargs rm`).denied, 'cat piped into xargs rm')
check(!run(`ls ${link} | grep foo`).denied, 'a pipeline of ALL-known-read-only stages stays exempt')
check(!run(`cat ${link}/f | head -5 | wc -l`).denied, 'three read-only stages stay exempt')

// A quoted `|` is DATA. Splitting on it invented a stage whose command word was `b"` — unknown, so
// the pipeline re-armed and a plain grep was denied.
check(!run(`grep "a|b" ${link}/f`).denied, 'a | inside a quoted pattern is not a pipe')

// LONG-FORM mutating flags. `-o` alone missed `sort --output=`, which writes — a mutating
// invocation classified read-only, i.e. a bypass (found by security review 2026-09-03).
check(run(`sort --output=${link}/o ${link}/i`).denied, 'sort --output= writes, like -o')
check(run(`find ${link} -execdir rm {} +`).denied, 'find -execdir mutates')

// An UNKNOWN binary is the common real shape — a project script, a tool the guard has never heard
// of. It is caught by being absent from READONLY, with or without a pipe.
check(run(`oppa ${link}/f`).denied, 'an unknown binary with a symlink arg is denied')
check(run(`oppa ${link}`).denied, '...symlink as the FINAL component too')

// OFFSET ALIGNMENT. Stage content is sliced from the ORIGINAL text by offset, so every mask applied
// before splitting MUST preserve length. Collapsing `2>&1` to one space shifted everything after
// it and the misaligned stage's paths were never extracted — a MISS, not friction: any command with
// a redirect before the dangerous one went unchecked.
check(run(`cp a b 2>&1 ; cp x ${link}`).denied, 'a fd-dup BEFORE the dangerous command must not shift offsets')
check(run(`ls ${link} 2>&1 | oppa`).denied, 'fd-dup inside a pipeline into an unknown binary')
check(run(`cp x ${link} ; cp x ${link}`).denied, 'two identical pipelines: indexOf must not mis-slice')
check(run(`./scripts/ci.sh ${link}`).denied, 'a project script is denied')

// The flag letters mean OPPOSITE things per command, and a global list denied the two most common
// read-only invocations an agent runs. Measured 2026-09-03; pinned so it cannot regress.
check(!run(`grep -i foo ${link}/f`).denied, 'grep -i is IGNORE-CASE, not in-place')
check(!run(`diff -i ${link}/a ${link}/b`).denied, 'diff -i is ignore-case too')
check(!run(`ls ${link} 2>&1`).denied, '2>&1 merges stderr and creates nothing')
check(!run(`grep "a > b" ${link}/f`).denied, 'a > inside a quoted ARGUMENT is data, not a redirect')
// A RELATIVE token that does not exist is not a path the command means. Walking up from it reaches
// the HOOK's cwd ancestors, so on a machine whose project sits under a symlinked path this would
// deny every command carrying a quoted slash-containing string.
check(!run(`grep "src/foo bar" ${real}/f`).denied, 'a nonexistent RELATIVE token is not a path candidate')

// THE ORIGINATING INCIDENT'S SHAPE. This guard shipped with no cd tracking, so a relative path
// after a `cd` resolved against the HOOK's cwd — and if a same-named directory happened to exist
// there (`node_modules` in the repo root, which it does) the guard confirmed a path the command
// never touched and ALLOWED. Deferred four turns while patching around it.
const wtDir = path.join(root, 'wt')
fs.mkdirSync(wtDir, { recursive: true })
fs.symlinkSync(real, path.join(wtDir, 'node_modules'))
check(run(`cd ${wtDir} && cp x node_modules/`).denied, 'cd then a RELATIVE symlinked path: the incident shape')
check(run(`pushd ${wtDir} && mv a node_modules/b`).denied, 'pushd form')
check(run(`cd ${wtDir} ; cp x node_modules/`).denied, 'cd carried across ; into a later pipeline')
check(run(`cd ${wtDir} && cp x ./node_modules/notyet`).denied, 'a symlinked ANCESTOR counts even when the leaf does not exist yet')
check(!run(`cd ${wtDir} && ls node_modules/`).denied, 'read-only after a cd is still exempt')
// A cd reaches the NEXT command only when the separator means "it ran and we are still in that
// shell". `||` runs its right side only if the cd FAILED; `&` backgrounds it in a subshell; every
// stage of a `|` pipeline is its own subshell. Carrying the dir across those made the guard DENY
// while naming a path the command cannot reach — a verdict about the wrong file, not friction.
check(!run(`cd ${wtDir} || cp x node_modules/`).denied, '|| : the cd did NOT run, so it sets no base')
check(!run(`cd ${wtDir} & cp x node_modules/`).denied, '& : the cd is backgrounded in a subshell')
check(!run(`cd ${wtDir} | cp x node_modules/`).denied, '| : each pipeline stage is its own subshell')
check(run(`cd ${wtDir} && cp x node_modules/ | cat`).denied, '...but a cd BEFORE the pipeline still reaches it')
check(run(`cd ${wtDir} && cat f | cp x node_modules/`).denied, '...and reaches a LATER stage, not just the first')
// `(` is a boundary. Without this the paren form ALLOWED while the brace form denied — the brace
// only ever worked because `{` happens to be followed by a space, which is not a design.
check(run(`(cd ${wtDir} && cp x node_modules/)`).denied, 'a subshell in parens is still the incident shape')
// The one case that distinguishes an explicit cd from a CHANGED dir. `cd .` changes nothing, so a
// guard inferring "a cd occurred" from `dir !== sessionCwd` gates this relative nonexistent leaf
// away and ALLOWS — which is why effectiveCwd reports `matched` instead of the caller guessing.
check(run(`cd . && cp x linked/notyet`).denied, 'cd . is an explicit cd even though the dir is unchanged')
// ...and its complement, which is what stops `matched` from being hardcoded true: with NO cd, a
// relative leaf that does not exist is gated away instead of resolved.
check(!run(`cp x linked/notyet`).denied, 'no cd: a nonexistent relative leaf stays gated')
// A no-op prefix must not defeat the guard. `cd $PWD` used to resolve to `<cwd>/$PWD` — fictional —
// and then wave the relative path past the existence gate, so the real symlink was never examined.
check(run(`cd $PWD && cp x ${path.basename(link)}/f`).denied, 'cd $PWD does not redirect the search into a fictional dir')
check(run(`cd \${PWD} && cp x ${path.basename(link)}/f`).denied, '...brace form too')
// An unexpandable target leaves the base where it was rather than inventing `<cwd>/$NOPE`. It does
// NOT claim `matched`, so a nonexistent leaf still gets gated — we do not know where that cd went,
// and guessing a directory is how the $PWD bypass worked.
check(run(`cd $NOPE_UNSET && cp x ${path.basename(link)}/`).denied, 'an unexpandable cd target leaves the base where it was')
check(!run(`cd $NOPE_UNSET && cp x ${path.basename(link)}/notyet`).denied, '...and claims no explicit base, so a nonexistent leaf stays gated')
// DOCUMENTS AN ACCEPTED MISS, and pins nothing: `cd *` lands wherever the shell's glob lands, so
// `cd * && cp x <symlink>/` is not caught. Treating the glob as unresolvable stops the guard
// INVENTING `<cwd>/*` as a base, but that is a narrowing with no observable verdict change — the
// gate skips the nonexistent leaf either way. Resolving it would mean running the glob.
check(!run(`cd * && cp x ${path.basename(link)}/notyet`).denied, 'a glob is a directory only the shell knows')
// A cd inside a command substitution runs in a subshell. Segmentation splits on the `&&` INSIDE
// it, so effectiveCwd sees a torn `echo $( cd x ` whose cd looks top-level — prefixing that to any
// command moved the base and hid the real symlink. All three spellings, because the first fix was
// a lookbehind on `(` and one space walked straight past it.
const sub = path.join(root, 'elsewhere')
fs.mkdirSync(sub, { recursive: true })
check(run(`cp x ${path.basename(link)}/`).denied, 'baseline for the substitution cases')
check(run(`echo $( cd ${sub} && pwd ) && cp x ${path.basename(link)}/`).denied, 'a spaced $( cd … ) prefix does not move the base')
check(run(`echo $(cd ${sub} && pwd) && cp x ${path.basename(link)}/`).denied, '...nor an unspaced one')
check(run('echo `cd ' + sub + ' && pwd` && cp x ' + path.basename(link) + '/').denied, '...nor a backtick one')
check(run(`(cd ${wtDir} && cp x node_modules/)`).denied, 'a plain subshell is NOT a substitution: its cd still counts')
// Nesting puts the inner `)` in the OPENER's part, so the cd lands in a part with no opener and
// reads as top-level. Per-part blanking cannot see two parts back; only depth counted across parts
// can. This is the shape blanking alone missed.
check(run(`echo $( echo $(date) && cd ${sub} ) && cp x ${path.basename(link)}/`).denied, 'a NESTED substitution does not let its cd escape')
// A glob char in a name that REALLY EXISTS is a name, not a pattern. A blanket character test
// stopped tracking these, trading a real regression for a `cd *` improvement worth nothing.
const bracket = path.join(root, 'My Docs [2026]')
fs.mkdirSync(bracket, { recursive: true })
fs.symlinkSync(real, path.join(bracket, 'node_modules'))
check(run(`cd 'My Docs [2026]' && cp x node_modules/`).denied, 'a directory whose real name contains glob chars is still tracked')
check(run(`sort -o ${link}/out ${link}/in`).denied, 'sort -o DOES write in place')
check(run(`sed -i s/a/b/ ${link}/f`).denied, 'sed is not read-only at all')

// --- paths with SPACES. Routine on macOS; all three spellings silently bypassed the guard until
// --- quoted segments were extracted whole (measured 2026-09-03).
const spaced = path.join(root, 'My Project')
fs.symlinkSync(real, spaced)
check(run(`cp "${spaced}/x" y`).denied, 'double-quoted spaced path')
check(run(`cp '${spaced}/x' y`).denied, 'single-quoted spaced path')
check(run(`cp ${spaced.replace(' ', '\\ ')}/x y`).denied, 'backslash-escaped spaced path')

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
check(run(`cp x ${litLink}/`).denied, 'a symlink COMPONENT under /tmp triggers, though /tmp itself does not')
check(run(`mv ${litLink}/sub/f.txt z`).denied, '...at any depth beneath it')
check(!run(`cp x ${litReal}/sub`).denied, 'a real path under /tmp stays allowed')
fs.unlinkSync(litLink); fs.rmSync(litReal, { recursive: true, force: true })

const tmpLink = path.join(os.tmpdir(), `symguard-probe-${process.pid}`)
try { fs.symlinkSync(real, tmpLink) } catch { /* leftover from a crashed run */ }
check(run(`cp x ${tmpLink}`).denied, 'a symlink UNDER the excluded /var|/tmp root is still caught')
try { fs.unlinkSync(tmpLink) } catch { /* already gone */ }
check(!run('ls /tmp/whatever').denied, 'macOS /tmp (itself a symlink) is excluded')
check(!run('cat /etc/hosts').denied, 'macOS /etc is excluded')
check(!run('ls /opt/homebrew/bin/node').denied, 'homebrew bin shims are excluded')

// --- env / ~ / composite resolution ------------------------------------------------------------
check(run(`cp x $\{SYMGUARD_T\}/linked`.replace('${SYMGUARD_T}', root)).denied, 'literal composite path')
process.env.SYMGUARD_T = root
check(run('cp x $SYMGUARD_T/linked').denied, '$VAR is resolved before checking')
check(run('cp x ${SYMGUARD_T}/linked').denied, '${VAR} is resolved before checking')
check(!run('cp a $SYMGUARD_UNSET_VAR/x').denied, 'an unresolvable $VAR is skipped, never guessed')

// --- the OTP contract --------------------------------------------------------------------------
const first = run(`cp x ${link}`)
check(!!first.otp, 'a denial issues an OTP')
check(!run(`SYMLINK_OTP=${first.otp} cp x ${link}`).denied, 'the OTP lets the SAME command through')

const second = run(`cp x ${link}`)
check(!run(`SYMLINK_OTP=${second.otp} cp x ${link}`).denied, 'a fresh OTP works once')
check(run(`SYMLINK_OTP=${second.otp} cp x ${link}`).denied, 'the SAME OTP does not work twice')

const third = run(`cp x ${link}`)
check(run(`SYMLINK_OTP=${third.otp} mv ${link} q`).denied, 'an OTP is bound to its command, not reusable for another')
check(run(`SYMLINK_OTP=DEADBEEF cp x ${link}`).denied, 'a fabricated OTP does not pass')

// --- fail-open ---------------------------------------------------------------------------------
try {
  const out = execFileSync('node', [GUARD], { input: 'not json', encoding: 'utf8' })
  check(!out.includes('deny'), 'unparseable payload falls through silently')
} catch (e) { check(false, `unparseable payload: ${e.message}`) }

fs.rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? '\nOK — all cases' : `\n${failed} FAILING`)
process.exit(failed === 0 ? 0 : 1)
