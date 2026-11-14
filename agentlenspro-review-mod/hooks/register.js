// agentlenspro-review-mod — the HARNESS runs the adversarial review and the measurement (TRDD-KZCSO0R2).
//
// Owner requirement (2026-11-14): "make the adversarial review hook a mod so it runs automatically each
// turn without having to force the model to run it. it must be part of the harness cycle, unskippable.
// the same for the measurement."
//
// HOW. At every main-thread Stop the mod asks the shared scanner (`agentlenspro review-gate
// --json-verdict`) what the turn did. The REVIEW runs at every main turn (answers, claims and read-only commands
// included), except (owner 2026-11-14): a janitor-originated turn is NEVER reviewed ("janitor heartbeat or
// chores are absolutely excluded from the adversarial review"; a pending debt waits for the next non-janitor
// stop), and an agent-message turn is exempt only when it wrote and proposed nothing. The MEASUREMENT runs
// only when the turn carries the proposal line. The mod itself runs:
//   - MEASURE (proposal only): a `$.model.fork` lists the proposal's load-bearing assumptions, each with
//     one read-only command; the mod runs those commands itself through `$.process.run` (argv, no shell,
//     an allowlist of read-only programs) and a second fork turns the observed output into verdicts;
//   - REVIEW: a `$.model.fork` over the whole conversation (served from the prompt cache) plus the turn's
//     final message, the measure report and the working-tree diff the mod reads with git.
// A REVIEW verdict of BLOCK blocks the stop (`{ block }`): the model must address the findings in the
// same turn. The model spawns nothing; the review cannot be skipped by the model, because the scanner's
// `work`/`proposal` fields are read WHATEVER review credits the turn carries.
//
// INTERRUPTED TURNS. An Esc fires no Stop (probe E1), so `turn.complete` with `isAborted` schedules the
// same review from a timer (outside the aborted event). Its findings are shown at once ($.ui.log), injected
// as context into the next prompt, and re-checked by the next Stop: an unaddressed BLOCK blocks there.
// (`$.prompt.submit` is not used: after an abort with no user input it is dropped, probe E6.)
//
// LIMITS. At most MAX_ROUNDS blocking reviews per turn (a turn could otherwise loop on review → fix →
// review). A fork that fails (API error) is retried once, then reported on the status line; it does not
// block, because the model could not act on it. The fork has no tools: it reviews what the conversation
// and the diff show it.
// USAGE. The token usage and the deduced cost of every model call the mod makes are shown to the user only; they are
// never put in a block string or a context injection.
// DISPLAY (0.5.0). At a Stop the user-only rows (every report, PASS and BLOCK, the usage table, failures) are written in
// ANSI colour to a per-session file that the plugin's Stop command hook (hooks/show.py) prints as a systemMessage, which
// the model never receives (see USER DISPLAY); the review therefore runs before next(e). An interrupted turn fires no
// Stop, so its rows still go to $.ui.log, plain (a log row is dim and turns ESC into U+FFFD; see REPORT LAYOUT).

import { atom, read, update } from "claude-code"

const MAX_ROUNDS = 2
const DIFF_MAX = 40000
const OBS_MAX = 4000
const MAX_ASSUMPTIONS = 8

// The pending review of an interrupted turn, kept in session state so a module reload does not lose it.
const pendingAtom = atom({ plugin: "agentlenspro-review-mod", key: "pendingReview" }, null)
// The main conversation's transcript path and cwd, from classic.* payloads (turn.complete carries neither).
const sessionAtom = atom({ plugin: "agentlenspro-review-mod", key: "lastSession" }, null)

// Blocking rounds in the current turn; reset when a new prompt starts a turn.
let roundsThisTurn = 0
// The prompt that opened the current turn (classic.UserPromptSubmit); decides the janitor / agent-message exemptions.
let turnPrompt = null
// The proposal marker line, mirrored from src/cli/reviewGateTriggers.ts PROPOSAL_LINE (bold or heading prefix, any dash).
const PROPOSAL_LINE = /^[ \t]*(?:\*\*|#{1,6}[ \t]*)?PROPOSAL FOR ACTION [-–—] PLEASE REVIEW\b/m
// Owner 2026-11-14: "janitor turn must never be reviewved no matter what it says" and "janitor heartbeat or
// chores are absolutely excluded from the adversarial review". A turn opened by a janitor bracket tag
// ([janitor-heartbeat], [janitor-resume], ...) or a janitor slash command/skill is NEVER reviewed, whatever it
// wrote or proposed; classic.Stop returns before measuring or reviewing and leaves any debt pending. Janitor
// subagents (memory/repair/security chores) are already excluded because classic.Stop returns on e.agent_id.
const JANITOR_PROMPT = /^\s*(?:\[janitor-[a-z-]+\]|\/janitor-|\/ai-maestro-janitor:janitor-)|<command-name>\/(?:ai-maestro-janitor:)?janitor-|<command-message>(?:ai-maestro-janitor:)?janitor-/
function isJanitorPrompt(prompt) {
  return typeof prompt === "string" && JANITOR_PROMPT.test(prompt)
}
// Other agents' messages/reports (notification, cross-session, teammate) are exempt ONLY when the turn wrote
// nothing, proposed nothing and carries no debt, so work done in such a turn is still reviewed.
const AGENT_MSG_PROMPT = /^\s*(?:<task-notification>|<cross-session-message\b|<teammate-message\b)/
function shouldReview({ work, proposal, debt, lastMessage, prompt }) {
  if (work || proposal || debt) return true
  if (lastMessage === null || lastMessage.trim() === "") return false
  if (typeof prompt === "string" && AGENT_MSG_PROMPT.test(prompt)) return false
  return true
}
// The turn-relative line indexes of the work and proposal the last review covered. A Stop that another hook
// blocked fires again with the SAME work; re-reviewing it would bill a whole-context fork per block (up to
// the 9-block cap). Reset at turn.complete.
let reviewedMark = { work: -1, proposal: -1, msg: null }

const errText = (err) => (err && err.message ? err.message : String(err))

// ── USAGE / COST (pure part; shown to the user only, through $.ui.log) ───────────────────────────
// The terminal draws ONE $.ui.log call as ONE row and renders a newline inside it as a garbage character, so every
// log text that can hold a newline goes through logLines: one call per line, an empty line as a single space.
// `options` is $.ui.log own (`{ to: "debug" }` keeps the text off screen).
function logLines($, text, options) {
  for (const line of String(text).split(/\r?\n/)) $.ui.log(line === "" ? " " : line, options)
}

// RATES mirrored from src/shared/pricing.ts (PRICING_LAST_UPDATED 2026-11-01); update together. USD per MTok:
// i input, r cache read, w cache write at the 5-minute TTL, o output. The 1-hour write rate is derived exactly as
// pricing.ts cacheWrite1hRate does (2x input when the 5m write has the 1.25x shape). `above` is pricing.ts own
// whole-request surcharge step: once input + cache read + cache write exceeds `over`, EVERY bucket bills at it.
const RATES = {
  "claude-opus-4-8": { i: 5, r: 0.5, w: 6.25, o: 25 },
  "claude-opus-4-8-fast": { i: 10, r: 1, w: 12.5, o: 50 },
  "claude-opus-5": { i: 5, r: 0.5, w: 6.25, o: 25 },
  "claude-opus-5-fast": { i: 10, r: 1, w: 12.5, o: 50 },
  "claude-opus-5-5": { i: 4, r: 0.2, w: 5, o: 20 },
  "claude-opus-5-5-fast": { i: 8, r: 0.4, w: 10, o: 40 },
  "claude-sonnet-5": { i: 2, r: 0.2, w: 2.5, o: 10 },
  "claude-haiku-5-5": { i: 0.1, r: 0.01, w: 0.125, o: 0.5, above: { over: 100000, i: 0.5, r: 0.05, w: 0.625, o: 2.5 } },
  "claude-fable-5": { i: 10, r: 1, w: 12.5, o: 50 },
  "claude-fable-5-1": { i: 10, r: 0.25, w: 12.5, o: 50 },
  "claude-mythos-5": { i: 10, r: 1, w: 12.5, o: 50 },
  "claude-mythos-5-1": { i: 10, r: 0.25, w: 12.5, o: 50 },
}

// pricing.ts lookupRates: exact key, else the LONGEST key the id starts with; no match = null (never a guess).
// A trailing [1m] and a date suffix are stripped first.
function lookupRates(modelId) {
  if (!modelId) return null
  const id = String(modelId).toLowerCase().replace(/\[[^\]]*\]$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "").trim()
  if (RATES[id]) return RATES[id]
  let best = null
  for (const key of Object.keys(RATES)) if (id.startsWith(key) && (best === null || key.length > best.length)) best = key
  return best ? RATES[best] : null
}

function write1hRate(rt) {
  return rt.w > 0 && Math.abs(rt.w - rt.i * 1.25) < 1e-9 ? rt.i * 2 : rt.w
}

// The usage does not say which TTL a cache write used, so the cost is a bracket: all writes at 5m (lo), all at 1h (hi).
function callCostUsd(usage, rt) {
  const inp = usage.input_tokens || 0
  const cr = usage.cache_read_input_tokens || 0
  const cw = usage.cache_creation_input_tokens || 0
  const out = usage.output_tokens || 0
  const b = rt.above && inp + cr + cw > rt.above.over ? rt.above : rt
  const base = (inp * b.i + cr * b.r + out * b.o) / 1e6
  return { lo: base + (cw * b.w) / 1e6, hi: base + (cw * write1hRate(b)) / 1e6 }
}

const fmtInt = (n) => Math.round(n).toLocaleString("en-US")
const fmtRange = (lo, hi) => {
  const a = lo.toFixed(4)
  const b = hi.toFixed(4)
  return a === b ? `$${a}` : `$${a}–${b}`
}
const emptySessionUsage = () => ({ lo: 0, hi: 0, calls: 0, unpriced: 0 })

// calls: [{ label, model (null = the session model), usage | reason }]. Returns the one plain line (the debug log and any
// host that reads text), the structured rows usageTable lays out for the transcript, and the new session total.
function formatUsageLine(calls, sessionModel, prev) {
  const parts = []
  const rows = []
  const tot = { inp: 0, cr: 0, cw: 0, out: 0, lo: 0, hi: 0, billed: 0 }
  const models = []
  const unpriced = []
  for (const c of calls) {
    if (!c.usage) { parts.push(`${c.label}: no reply (${c.reason}), not billed`); rows.push({ label: c.label, cost: `no reply (${c.reason}), not billed`, tokens: null }); continue }
    const id = c.model || sessionModel
    const u = c.usage
    const inp = u.input_tokens || 0
    const cr = u.cache_read_input_tokens || 0
    const cw = u.cache_creation_input_tokens || 0
    const out = u.output_tokens || 0
    tot.inp += inp; tot.cr += cr; tot.cw += cw; tot.out += out; tot.billed++
    if (!models.includes(id)) models.push(id)
    const rt = lookupRates(id)
    let cost
    if (rt) { const k = callCostUsd(u, rt); tot.lo += k.lo; tot.hi += k.hi; cost = fmtRange(k.lo, k.hi) } else { unpriced.push(id); cost = `rate unknown for ${id}` }
    parts.push(`${c.label}: in ${fmtInt(inp)} · cache-read ${fmtInt(cr)} · cache-write ${fmtInt(cw)} · out ${fmtInt(out)} · ${cost}`)
    rows.push({ label: c.label, cost, tokens: { inp, cr, cw, out } })
  }
  const session = { lo: prev.lo + tot.lo, hi: prev.hi + tot.hi, calls: prev.calls + tot.billed, unpriced: prev.unpriced + unpriced.length }
  const unp = unpriced.length ? ` + unpriced call(s) on ${[...new Set(unpriced)].join(", ")}` : ""
  const model = models.join(", ") || sessionModel
  parts.push(`total this turn: in ${fmtInt(tot.inp)} · cache-read ${fmtInt(tot.cr)} · cache-write ${fmtInt(tot.cw)} · out ${fmtInt(tot.out)} · ${fmtRange(tot.lo, tot.hi)}${unp} (cache writes at 5m–1h) · model ${model}`)
  const sessionUnp = session.unpriced ? ` (excludes ${session.unpriced} unpriced)` : ""
  const sessionText = `${fmtRange(session.lo, session.hi)} over ${session.calls} calls${sessionUnp}`
  const table = { model, rows, total: { cost: `${fmtRange(tot.lo, tot.hi)}${unp}`, tokens: tot }, session: sessionText }
  return { line: `[review-mod usage] ${parts.join(" | ")} | session total: ${sessionText}`, table, session }
}

// The user-only layout of one usage cycle: a header, a cost row plus a token row per call, the turn total, and the
// session total. With `paint` (the Stop display file) the header is bold and every row dim; without it (the $.ui.log
// fallback) the rows carry no escape. Rows are kept near 53 cells, because a terminal wraps a long row with no gutter.
// Token counts stay exact.
function usageTable(table, paint = false) {
  const p = painter(paint)
  const pad = Math.max(10, ...table.rows.map((r) => r.label.length))
  const tok = (t) => `│  in ${fmtInt(t.inp)} · out ${fmtInt(t.out)} · cache r ${fmtInt(t.cr)} / w ${fmtInt(t.cw)}`
  const lines = ["╭─ [review-mod usage]", `│ model ${table.model}`, "│ $ spans the 5m–1h cache-write rates"]
  for (const r of table.rows) {
    lines.push(`│ ${r.label.padEnd(pad)}  ${r.cost}`)
    if (r.tokens) lines.push(tok(r.tokens))
  }
  lines.push(`│ ${"this turn".padEnd(pad)}  ${table.total.cost}`, tok(table.total.tokens))
  lines.push(`╰─ session total ${table.session}`)
  return lines.map((l, i) => p(i === 0 ? "bold+dim" : "dim", l))
}
// ── END USAGE / COST (pure part) ──────────────────────────────────────────────────────────────────

// ── REPORT LAYOUT (pure part; the user-only copy of a report) ─────────────────────────────────────
// One layout, two sinks. A plugin Stop COMMAND hook's systemMessage is drawn with real ANSI SGR colour and real
// newlines, and the model never receives it (probe 2026-11-14 on 2.1.325); a $.ui.log row is one plain dim line where
// ESC is drawn as U+FFFD and no render hook can restyle it. So layoutReport and usageTable take `paint`: true for the
// display file hooks/show.py prints at Stop, false for the $.ui.log fallback (interrupted turns fire no Stop), which gets
// the same rows with no escape. Colour always sits beside a word (VERDICT: PASS, [BLOCKER], confirmed), never alone.
// Line-safe: every coloured span is closed on its own line, and control characters in the report text (model output,
// diffs, stderr) are stripped first, so the only escapes in a row are these and show.py may cut between any two lines.
// It is applied ONLY to the user's copy: the block string, the pending-review injection and the review prompt keep the
// raw text, because they reach the model. Total: every input line comes out once, in order; a line it does not
// recognise passes through unchanged behind the gutter.
const SGR = { bold: "1", dim: "2", red: "31", green: "32", yellow: "33" }
// painter(true)("bold+red", s) wraps s in one SGR span closed by a reset; painter(false) returns s unchanged.
const painter = (on) => (style, s) => (on && s !== "" ? `\u001b[${style.split("+").map((k) => SGR[k]).join(";")}m${s}\u001b[0m` : s)
// C0 controls except TAB and LF, DEL, and the C1 range (0x9b is a one-byte CSI).
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
const SEVERITY_STYLE = { "BLOCKER": "bold+red", "SHOULD-FIX": "yellow", "NIT": "dim" }
const MEASURE_STYLE = { confirmed: "green", refuted: "red", unmeasurable: "yellow" }
function layoutReport(text, paint = false) {
  const p = painter(paint)
  const bar = p("dim", "│")
  const out = []
  let section = false // a report header is open
  let spaced = true // the last row is a box top or a spacer: an ASSUMPTION needs no spacer before it
  const push = (row, isSpacer = false) => { out.push(row); spaced = isSpacer }
  const close = () => { if (section) push(p("dim", "╰─")); section = false }
  for (const raw of String(text).split(/\r?\n/)) {
    // Bold markers are drawn literally; a heading, quote or bullet mark only hides the keyword.
    const line = raw.replace(CONTROL, "").replace(/\*\*/g, "").trimEnd()
    const key = line.trim().replace(/^(?:[#>]+\s*|[-•]\s+)/, "")
    const g = section ? `${bar} ` : ""
    let m
    if ((m = key.match(/^\[(AGENTLENSPRO-(?:REVIEW|MEASURE)-REPORT)\]\s*(.*)$/))) {
      close()
      section = true
      push(`${p("dim", "╭─")} ${p("bold", `[${m[1]}] ${m[2]}`.trimEnd())}`, true)
      continue
    }
    if (key === "") { push(section ? bar : " ", true); continue }
    if ((m = key.match(/^VERDICT:\s*(PASS|BLOCK)\b/i))) { push(`${g}${p(m[1].toUpperCase() === "PASS" ? "bold+green" : "bold+red", key)}`); continue }
    if ((m = key.match(/^(?:(\d+)[.)]\s*)?\[?(BLOCKER|SHOULD-FIX|NIT)\]?(?=[\s:—–-]|$)\s*(.*)$/))) {
      const tag = `${m[1] ? `${m[1]}. ` : ""}[${m[2]}]`
      const rest = m[3].replace(/^:\s*/, "")
      push(`${g}${m[2] === "NIT" ? p("dim", `${tag} ${rest}`.trimEnd()) : `${p(SEVERITY_STYLE[m[2]], tag)} ${rest}`.trimEnd()}`)
      continue
    }
    if ((m = key.match(/^WEAKEST LINK:\s*(.*?)\s+[—–-]+\s+SETTLE WITH:\s*(.*)$/))) {
      push(`${g}${p("bold", "WEAKEST LINK:")} ${m[1]}`.trimEnd())
      push(`${g}${p("bold", "SETTLE WITH:")} ${m[2]}`.trimEnd())
      continue
    }
    if ((m = key.match(/^WEAKEST LINK:(.*)$/))) { push(`${g}${p("bold", "WEAKEST LINK:")}${m[1]}`); continue }
    if (/^(?:\d+[.)]\s*)?ASSUMPTION:/.test(key)) {
      if (!spaced) push(section ? bar : " ", true)
      push(`${g}${p("bold", key)}`)
      continue
    }
    if ((m = key.match(/^LOAD-BEARING REFUTED:\s*(.*)$/i))) { push(`${g}${p(/^(?:none|n\/a|-|—)?\.?$/i.test(m[1].trim()) ? "bold+green" : "bold+red", key)}`); continue }
    if ((m = key.match(/\bVERDICT:\s*(confirmed|refuted|unmeasurable)\b/i))) { push(`${g}    ${p(MEASURE_STYLE[m[1].toLowerCase()], key)}`); continue }
    if (/^(?:COMMAND|OBSERVED|EXPECT):/.test(key)) { push(`${g}    ${key}`); continue }
    push(`${g}${line}`)
  }
  close()
  return out
}
// ── END REPORT LAYOUT (pure part) ─────────────────────────────────────────────────────────────────

// Running total for this session, reset on classic.SessionStart.
let sessionUsage = emptySessionUsage()

// ── USER DISPLAY (the coloured user-only rows of one Stop, printed by hooks/show.py) ──────────────────
// The rows of one main-thread Stop (reports, usage, failures) are collected in a sink and written ONCE, before
// classic.Stop calls next(e): the plugin's own Stop command hook (hooks/show.py) runs INSIDE that next(e) (measured
// 2026-11-14 on 2.1.325, `claude -p`: "cmd display_exists=False" logged between "mod before-next" and "mod after-next"),
// prints the file as a systemMessage and deletes it. The path is computed from HOME on both sides:
// $HOME/.claude/plugins/data/agentlenspro-review-mod/display/<session_id>.txt. Not CLAUDE_PLUGIN_DATA: the command hook
// gets it but this process does not ($.env.get gave undefined in the same probe), and its marketplace suffix cannot be
// derived here. The file is written on EVERY main-thread Stop, empty when there is nothing to show, so a file an earlier
// Stop left behind is overwritten before show.py reads it (show.py also drops a file older than 120 s).
const DISPLAY_SUBDIR = ".claude/plugins/data/agentlenspro-review-mod/display"
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/
const ANSI_SGR = /\u001b\[[0-9;]*m/g

function displaySink() {
  const lines = []
  return { lines, add: (rows) => { lines.push(...rows) } }
}

async function writeDisplay($, sessionId, lines) {
  const home = await $.env.get("HOME")
  if (!home || typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) throw new Error(`no display path (HOME ${home ? "set" : "unset"}, session_id ${JSON.stringify(sessionId)})`)
  await $.fs.write(`${home}/${DISPLAY_SUBDIR}/${sessionId}.txt`, lines.length > 0 ? `${lines.join("\n")}\n` : "")
}

// One user-only message: into the Stop display (coloured, plus a plain copy in the debug log) when a sink is given,
// else to the transcript as plain dim rows.
function note($, sink, style, text) {
  const clean = String(text).replace(CONTROL, "")
  if (!sink) { logLines($, clean); return }
  const p = painter(true)
  sink.add(clean.split("\n").map((l) => p(style, l)))
  logLines($, clean, { to: "debug" })
}

// One user-only usage table for the model calls of one review cycle: into the Stop display when a sink is given, else
// to the transcript. A failure here is reported, never thrown: it must not turn a finished review into a failed one.
async function logUsage($, calls, sink = null) {
  try {
    const { line, table, session } = formatUsageLine(calls, await $.session.model(), sessionUsage)
    sessionUsage = session
    if (sink) sink.add(usageTable(table, true))
    else logLines($, usageTable(table).join("\n"))
    // The one-line form goes to the debug log too, where one grep finds a whole cycle.
    logLines($, line, { to: "debug" })
  } catch (err) {
    note($, sink, "yellow", `[review-mod usage] could not be computed: ${errText(err)}`)
  }
}

async function rememberSession($, e) {
  if (!e || e.agent_id || typeof e.transcript_path !== "string" || e.transcript_path === "") return
  const seen = { transcriptPath: e.transcript_path, cwd: typeof e.cwd === "string" ? e.cwd : null }
  const prev = await read($, sessionAtom)
  if (prev && prev.transcriptPath === seen.transcriptPath && prev.cwd === seen.cwd) return
  await update($, sessionAtom, () => seen)
}

// The scanner's verdict for the turn. Returns { ok, work, proposal, reasons } or { ok: false, why }.
async function scanTurn($, session, ignoreInterruptFloor) {
  const argv = ["agentlenspro", "review-gate", "--json-verdict", "--transcript", session.transcriptPath]
  if (session.cwd) argv.push("--cwd", session.cwd)
  if (ignoreInterruptFloor) argv.push("--ignore-interrupt-floor")
  let r
  try { r = await $.process.run(argv, { timeoutMs: 90000 }) } catch (err) { return { ok: false, why: `scanner did not run: ${errText(err)}` } }
  if (r.exitCode !== 0) return { ok: false, why: `scanner exited ${r.exitCode}: ${String(r.stderr || "").trim().slice(0, 200)}` }
  let v
  try { v = JSON.parse(r.stdout) } catch { return { ok: false, why: "scanner printed unparseable output" } }
  if (!v || !v.scan || v.scan.readable !== true) return { ok: false, why: "the transcript could not be read" }
  // An older CLI does not report `work`/`proposal`; without them the harness would fall back to `demands`,
  // which a model-spawned fork can clear. Refuse that build loudly instead of reviewing less.
  if (!("work" in v) || !("proposal" in v)) return { ok: false, why: "the installed agentlenspro is too old (no work/proposal in the verdict)" }
  if (ignoreInterruptFloor && !(v.options && v.options.ignoreInterruptFloor === true)) return { ok: false, why: "the installed agentlenspro ignores --ignore-interrupt-floor" }
  if (v.work && typeof v.work.index !== "number" || typeof v.proposalIndex !== "number") return { ok: false, why: "the installed agentlenspro is too old (no work.index/proposalIndex in the verdict)" }
  return { ok: true, work: v.work, proposal: v.proposal === true, proposalIndex: v.proposalIndex, reasons: Array.isArray(v.reasons) ? v.reasons : [] }
}

// The working tree as git sees it, read by the harness so the review sees worker writes too.
async function gitContext($, cwd) {
  if (!cwd) return "(no cwd known: no git context)"
  const run = async (args) => {
    try {
      const r = await $.process.run(["git", "-C", cwd, ...args], { timeoutMs: 20000 })
      return r.exitCode === 0 ? String(r.stdout) : null
    } catch { return null }
  }
  if ((await run(["rev-parse", "--is-inside-work-tree"])) === null) return "(not a git work tree)"
  // A repository with no commit yet has no HEAD, and `git diff HEAD` fails there: the probe of 2026-11-14
  // reported a fresh `git init` repo as "not a git work tree". Diff against the empty tree in that case.
  const hasHead = (await run(["rev-parse", "--verify", "-q", "HEAD"])) !== null
  const emptyTree = hasHead ? null : ((await run(["hash-object", "-t", "tree", "/dev/null"])) || "").trim()
  const base = hasHead ? "HEAD" : emptyTree
  const stat = base ? ((await run(["diff", base, "--stat"])) || "") : ""
  const status = (await run(["status", "--short"])) || ""
  const diff = base ? ((await run(["diff", base])) || "") : ""
  const log = (await run(["log", "-3", "--stat", "--format=commit %h %s"])) || ""
  // `git diff HEAD` never shows an UNTRACKED file, so a new file (the commonest write) would be invisible to
  // the review: list them and include their text, capped.
  const untracked = ((await run(["ls-files", "--others", "--exclude-standard"])) || "").split("\n").filter(Boolean)
  let newFiles = ""
  for (const f of untracked.slice(0, 20)) {
    let body
    try { body = String(await $.fs.read(`${cwd}/${f}`)) } catch (err) { body = `(unreadable: ${errText(err)})` }
    newFiles += `\n--- new file ${f}\n${body.length > 4000 ? body.slice(0, 4000) + `\n[... cut at 4000 of ${body.length} chars]` : body}\n`
  }
  if (untracked.length > 20) newFiles += `\n[... ${untracked.length - 20} more untracked files not shown]\n`
  const all = diff + newFiles
  const cut = all.length > DIFF_MAX ? all.slice(0, DIFF_MAX) + `\n[... diff cut at ${DIFF_MAX} of ${all.length} chars]` : all
  return `git status --short:\n${status || "(clean)"}\n\ngit diff ${hasHead ? "HEAD" : "(no commit yet: against the empty tree)"} --stat:\n${stat || "(no tracked changes)"}\n\nlast 3 commits:\n${log}\n\ngit diff ${hasHead ? "HEAD" : "(no commit yet)"} + new files:\n${cut || "(empty)"}`
}

// ── MEASURE ────────────────────────────────────────────────────────────────────────────────────
// Read-only programs the mod will run for a measurement. argv only, no shell, so no pipe, redirect or
// expansion can turn a read into a write; the per-program checks close the write flags those have.
const READ_ONLY = new Set(["grep", "rg", "ls", "cat", "head", "tail", "wc", "stat", "file", "du", "diff", "jq", "tldr", "which", "pwd", "date", "find", "git", "sort", "uniq", "cut", "test", "agentlenspro"])
const GIT_READ = new Set(["log", "show", "diff", "status", "grep", "ls-files", "rev-parse", "blame", "describe", "cat-file", "ls-tree", "merge-base", "shortlog"])
const AGENTLENS_READ = new Set(["review-gate", "list", "help", "statusline-history", "last-compact", "cache-expired", "cache-state"])

function refuseArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string")) return "argv is not a list of strings"
  const prog = argv[0]
  if (!READ_ONLY.has(prog)) return `${prog} is not on the read-only list`
  const args = argv.slice(1)
  if (prog === "find" && args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a))) return "find with a write/exec action"
  if (prog === "git") {
    // `git -C <dir> <sub>`: -C takes a separate value, which must not be read as the subcommand
    // (probe 2026-11-14: every `git -C <dir> grep|ls-files|status` was refused as "git <dir>").
    let sub
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-C") { i++; continue }
      if (args[i].startsWith("-")) continue
      sub = args[i]
      break
    }
    if (!GIT_READ.has(sub)) return `git ${sub} is not a read-only subcommand`
    if (args.some((a) => a.startsWith("--output") || a === "-o")) return "git with an output file"
    // -c / --config-env can set core.pager, diff.external or core.fsmonitor (all execute); -O and
    // --ext-diff run a program too.
    if (args.some((a) => a === "-c" || a.startsWith("-c") && !a.startsWith("--") || a.startsWith("--config-env") || a.startsWith("-O") || a.startsWith("--open-files-in-pager") || a === "--ext-diff")) return "git option that runs a program"
  }
  if (prog === "sort" && args.some((a) => a === "-o" || a.startsWith("--output") || a.startsWith("--compress-program"))) return "sort with an output file or a program"
  // uniq IN OUT writes OUT; file -C compiles a magic file; date -s sets the clock.
  if (prog === "uniq" && args.filter((a) => !a.startsWith("-")).length > 1) return "uniq with an output file"
  if (prog === "file" && args.some((a) => a === "-C" || a === "--compile")) return "file --compile writes"
  if (prog === "date" && args.some((a) => a === "-s" || a.startsWith("--set"))) return "date --set"
  if (prog === "rg" && args.some((a) => a.startsWith("--pre"))) return "rg --pre runs a command"
  if (prog === "agentlenspro" && (!AGENTLENS_READ.has(args[0]) || (args[0] === "review-gate" && !args.includes("--json-verdict") && !args.includes("--directive")))) return "agentlenspro verb is not read-only"
  return null
}

function extractJsonArray(text) {
  const a = text.indexOf("[")
  const b = text.lastIndexOf("]")
  if (a === -1 || b <= a) return null
  try { const v = JSON.parse(text.slice(a, b + 1)); return Array.isArray(v) ? v : null } catch { return null }
}

const HARNESS_HEAD = "[agentlenspro-review-mod: this request comes from the HARNESS, not from the user. You are not the main agent and you have NO tools: do not call any tool, answer at once in text.]"

// One model call as the usage log needs it; model null = the session model (a fork runs on it).
function callRecord(label, model, r) {
  return r.isAnswered ? { label, model, usage: r.usage } : { label, model, reason: r.reason }
}

// Returns { r, calls }: r is the final result, calls every attempt (the api-error retry bills on its own).
async function fork($, prompt, label) {
  let r = await $.model.fork({ prompt })
  const calls = [callRecord(label, null, r)]
  if (!r.isAnswered && r.reason === "api-error") {
    r = await $.model.fork({ prompt })
    calls.push(callRecord(`${label} retry`, null, r))
  }
  return { r, calls }
}

async function runMeasure($, session, lastMessage) {
  const calls = []
  const planned = await fork($, [
    HARNESS_HEAD,
    "ROLE: MEASURE (step 1 of 2: plan).",
    "The most recent turn above contains a proposal (a line starting \"PROPOSAL FOR ACTION - PLEASE REVIEW\").",
    lastMessage ? `Its final message was:\n<<<\n${lastMessage}\n>>>` : "",
    `List at most ${MAX_ASSUMPTIONS} LOAD-BEARING assumptions the proposal rests on, each with ONE read-only command that settles it.`,
    "Output ONLY a JSON array, nothing else: [{\"assumption\": \"...\", \"argv\": [\"grep\", \"-n\", \"x\", \"/abs/path\"], \"expect\": \"what output confirms it\"}]",
    "argv runs WITHOUT a shell: no pipes, redirects, globs or $VARS; absolute paths only.",
    `Allowed programs: ${[...READ_ONLY].join(" ")}; git only with ${[...GIT_READ].join(" ")}.`,
  ].join("\n"), "measure-plan")
  calls.push(...planned.calls)
  const plan = planned.r
  if (!plan.isAnswered) return { text: `MEASURE could not plan: ${plan.reason}`, calls }
  const items = (extractJsonArray(plan.text) || []).slice(0, MAX_ASSUMPTIONS)
  if (items.length === 0) return { text: `MEASURE planned no runnable assumption. Raw plan:\n${plan.text.slice(0, 2000)}`, calls }
  const rows = []
  for (const it of items) {
    const argv = it && it.argv
    const refused = refuseArgv(argv)
    if (refused) { rows.push(`ASSUMPTION: ${it && it.assumption}\nCOMMAND: ${JSON.stringify(argv)}\nOBSERVED: NOT RUN — ${refused}`); continue }
    let obs
    try {
      const r = await $.process.run(argv, { cwd: session.cwd || undefined, timeoutMs: 20000 })
      const out = `${r.stdout || ""}${r.stderr ? `\n[stderr] ${r.stderr}` : ""}`
      obs = `exit ${r.exitCode}\n${out.length > OBS_MAX ? out.slice(0, OBS_MAX) + `\n[... cut at ${OBS_MAX} of ${out.length} chars]` : out}`
    } catch (err) { obs = `did not run: ${errText(err)}` }
    rows.push(`ASSUMPTION: ${it.assumption}\nCOMMAND: ${JSON.stringify(argv)}\nEXPECT: ${it.expect}\nOBSERVED: ${obs}`)
  }
  const judged = await fork($, [
    HARNESS_HEAD,
    "ROLE: MEASURE (step 2 of 2: verdicts).",
    "The harness ran these read-only commands for the proposal in the most recent turn. Judge ONLY from the OBSERVED output.",
    rows.join("\n\n"),
    "For each row output: ASSUMPTION / COMMAND / OBSERVED (one line, the decisive part) / VERDICT (confirmed | refuted | unmeasurable).",
    "Then one line: LOAD-BEARING REFUTED: <list or none>.",
  ].join("\n"), "measure-judge")
  calls.push(...judged.calls)
  const verdicts = judged.r
  const head = "[AGENTLENSPRO-MEASURE-REPORT] (run by the harness)"
  return { text: verdicts.isAnswered ? `${head}\n${verdicts.text}` : `${head}\nverdict step failed (${verdicts.reason}); raw rows:\n${rows.join("\n\n")}`, calls }
}

// ── REVIEW ─────────────────────────────────────────────────────────────────────────────────────
function reviewPrompt({ interrupted, lastMessage, scan, measure, pending, debt, git, round }) {
  return [
    HARNESS_HEAD,
    "ROLE: REVIEW",
    interrupted
      ? "The user INTERRUPTED the most recent turn above (Esc). Review the work that turn did before it was cut off."
      : `The most recent turn above just ended${round > 1 ? ` (review round ${round}: the previous round's findings are in the conversation; check each was fixed or explicitly rejected with a reason)` : ""}.`,
    lastMessage ? `Its final message to the user was:\n<<<\n${lastMessage}\n>>>` : "",
    `Scanner: work = ${scan.work ? `${scan.work.cause} — ${scan.work.detail}` : "none"}; proposal = ${scan.proposal}.`,
    measure ? `\n${measure}\n` : "",
    pending ? `An earlier INTERRUPTED turn was reviewed by the harness with these findings; check whether this turn addressed them:\n<<<\n${pending}\n>>>` : "",
    debt ? `An earlier stop ended WITHOUT a harness review (${debt}). Review that earlier work too: it is in the conversation above.` : "",
    `Working tree, read by the harness:\n${git}`,
    "",
    "Review EVERYTHING the most recent turn did or proposed: its claims and answers, its reasoning, every command it ran (read-only ones included), any proposal, and any change. A turn with no change is still reviewed: hunt false or unsupported claims, answers that skip what was asked, and conclusions stronger than the evidence shown. Also hunt: a PROXY read in place of the thing (a pipe's exit status for the tool's, a preview for the file, one run for the variance, an assumed format for the real one); broken references; untested or unverified changes; silent failure paths; destructive or irreversible actions without confirmation; scope beyond the request.",
    "You are the REVIEWER, not the agent: write about the main agent in the third person (\"the agent\", \"the turn\"). Never write \"I\", \"me\" or \"my\" about the agent's actions.",
    "Never recommend, in a finding or in SETTLE WITH, an action the user forbade in the conversation (for example running code the user said not to run); if the only settling check is forbidden, write that instead of the command.",
    "Answer both: the strongest reason NOT to have done what the turn did, and the most likely way it is wrong.",
    "OUTPUT FORMAT, strictly:",
    "Line 1: exactly \"VERDICT: PASS\" or \"VERDICT: BLOCK\" (BLOCK only when at least one finding is a BLOCKER).",
    "Then numbered findings: [BLOCKER|SHOULD-FIX|NIT] claim — evidence — fix.",
    "Last line: \"WEAKEST LINK: <one sentence> — SETTLE WITH: <one command>\".",
  ].filter((s) => s !== "").join("\n")
}

// The verdict is the FIRST line that starts with "VERDICT:"; a preface line before it is tolerated, a quoted
// "VERDICT: BLOCK" inside a later finding is not read. No such line = a malformed answer, never a PASS.
function parseVerdict(text) {
  // Markdown decoration ("**VERDICT: BLOCK**", "# VERDICT: PASS", "> VERDICT: ...") is stripped first:
  // models often bold the line, and an unmatched BLOCK would fail open as a skip.
  const line = text.split("\n").map((l) => l.trim().replace(/^[#>*_\s]+/, "").replace(/[*_\s]+$/, "")).find((l) => /^VERDICT:/.test(l))
  if (!line) return { ok: false, why: "the review answer has no VERDICT line" }
  if (/^VERDICT:\s*BLOCK\b/.test(line)) return { ok: true, block: true, text }
  if (/^VERDICT:\s*PASS\b/.test(line)) return { ok: true, block: false, text }
  return { ok: false, why: `unreadable verdict line: ${line.slice(0, 80)}` }
}

async function runReview($, args, label = "review") {
  const f = await fork($, reviewPrompt(args), label)
  if (!f.r.isAnswered) return { ok: false, why: f.r.reason, calls: f.calls }
  return { ...parseVerdict(f.r.text.trim()), calls: f.calls }
}

// The interrupted turn's review, from a timer: outside the aborted event, so the fork is not cut by it.
async function reviewInterrupted($, prompt) {
  if (isJanitorPrompt(prompt)) return // owner: janitor turns are never reviewed (the scheduler checks too)
  const calls = []
  try {
    const session = await read($, sessionAtom)
    if (!session) { await defer($, "interrupted turn: no transcript path seen yet"); return }
    const scan = await scanTurn($, session, true)
    if (!scan.ok) { await defer($, `interrupted turn: ${scan.why}`); return }
    if (!scan.work && !scan.proposal) return
    const git = await gitContext($, session.cwd)
    const measured = scan.proposal ? await runMeasure($, session, null) : null
    if (measured) calls.push(...measured.calls)
    const measure = measured ? measured.text : null
    let res = await runReview($, { interrupted: true, lastMessage: null, scan, measure, pending: null, git, round: 1 }, "review (interrupted)")
    calls.push(...res.calls)
    if (!res.ok) {
      // A fork from the aborted conversation can fail; fall back to a plain completion over the transcript.
      let excerpt = ""
      try { excerpt = JSON.stringify((await $.session.messages()).slice(-40)).slice(-60000) } catch (err) { excerpt = `(messages unavailable: ${errText(err)})` }
      const c = await $.model.complete({ model: "sonnet", system: reviewPrompt({ interrupted: true, lastMessage: null, scan, measure, pending: null, git, round: 1 }), prompt: `The interrupted conversation's last messages (JSON):\n${excerpt}`, maxTokens: 4000 })
      calls.push(callRecord("review (interrupted, completion)", "sonnet", c))
      res = c.isAnswered ? parseVerdict(c.text.trim()) : { ok: false, why: `fork: ${res.why}; completion: ${c.reason}` }
    }
    if (!res.ok) { await defer($, `interrupted turn: ${res.why}`); return }
    const text = `${measure ? measure + "\n\n" : ""}[AGENTLENSPRO-REVIEW-REPORT] (run by the harness, interrupted turn)\n${res.text}`
    await update($, pendingAtom, () => ({ text, block: res.block, injected: false, at: Date.now() }))
    logLines($, layoutReport(text).join("\n"))
    $.ui.status(res.block ? "review: interrupted turn — BLOCK, findings go to the next prompt" : "review: interrupted turn — PASS")
  } catch (err) {
    await defer($, `interrupted turn: ${errText(err)}`)
  } finally {
    if (calls.length > 0) await logUsage($, calls)
  }
}

// A review that could not run is NOT a pass. The status line alone is lost in an unattended session, so
// every deferral is also shown to the user (the Stop display, or the transcript log from a timer) and counted in the
// plugin store (key "deferred"). Nothing is ever dropped: a stop the harness could not review leaves a DEBT in session
// state, and the next stop must review that work (it is in the conversation the fork reads), even when that turn
// changed nothing.
async function defer($, why, sink = null) {
  note($, sink, "yellow", `REVIEW DEFERRED to the next stop (not dropped): ${why}`)
  $.ui.status(`review: deferred — ${why}`)
  try { const n = (await $.store.get("deferred")) || 0; await $.store.set("deferred", n + 1) } catch { /* the message above records it */ }
  const prev = await read($, pendingAtom)
  await update($, pendingAtom, () => ({ ...(prev || { text: "", block: false, injected: true, at: Date.now() }), debt: true, debtWhy: why }))
}

// One main-thread, non-janitor Stop: scan, measure (proposal only), review. Returns the mod's block text, or null to let
// the stop through. Every user-only row (reports, BLOCK ones included, usage, failures) goes to `sink`; the returned
// block text keeps the RAW report, because it reaches the model.
async function reviewAtStop($, e, sink) {
  // A review that could not run must not let the stop through (owner: "unskippable"). It blocks and the next
  // stop retries, up to MAX_ROUNDS per turn; past that it is deferred (the engine's own 9-block cap
  // would end the turn anyway, and an endless block would wedge the session).
  const failClosed = async (why) => {
    if (roundsThisTurn < MAX_ROUNDS) {
      roundsThisTurn++
      note($, sink, "yellow", `REVIEW FAILED, stop blocked for a retry (round ${roundsThisTurn}/${MAX_ROUNDS}): ${why}`)
      return `[agentlenspro-review-mod] The harness could not review this turn (${why}). End your turn again: the harness retries the review at the next stop. Do not spawn a review fork.`
    }
    await defer($, `${why}; ${MAX_ROUNDS} retries this turn failed`, sink)
    return null
  }
  const calls = []
  try {
    await rememberSession($, e)
    const session = await read($, sessionAtom)
    if (!session) return await failClosed("no transcript path")
    const pending = await read($, pendingAtom)
    const scan = await scanTurn($, session, false)
    if (!scan.ok) return await failClosed(scan.why)
    // The engine fires Stop BEFORE the turn's final assistant message reaches the JSONL, so a text-only
    // proposal turn scans as nothing (measured 2026-11-14: work None, proposal false on a turn whose only
    // message was the proposal, and no measurement ran). The event carries that message: check it here.
    const lastMessage = typeof e.last_assistant_message === "string" ? e.last_assistant_message : null
    const proposalFromLast = !scan.proposal && lastMessage !== null && PROPOSAL_LINE.test(lastMessage)
    if (proposalFromLast) scan.proposal = true
    const pendingBlock = pending && pending.block ? pending.text : null
    const debt = pending && pending.debt ? pending.debtWhy : null
    const clearPending = async () => { if (pending) await update($, pendingAtom, () => null) }
    if (!shouldReview({ work: scan.work, proposal: scan.proposal, debt, lastMessage, prompt: turnPrompt })) {
      await clearPending()
      if (pendingBlock && roundsThisTurn < MAX_ROUNDS) {
        roundsThisTurn++
        return `[agentlenspro-review-mod] The harness review of your INTERRUPTED earlier turn found BLOCKERS and this turn did not address them. Fix each one (or state why it is rejected), then end the turn.\n\n${pendingBlock}`
      }
      if (pendingBlock) await defer($, `cap of ${MAX_ROUNDS} blocking rounds reached; the interrupted turn's BLOCK review was not re-checked`, sink)
      return null
    }
    const workAt = scan.work ? scan.work.index : -1
    // A Stop re-fired with the same final message is skipped; a new final message is new agent output and is reviewed.
    if (!debt && workAt <= reviewedMark.work && scan.proposalIndex <= reviewedMark.proposal && lastMessage === reviewedMark.msg) {
      // Nothing new since the last harness review of this turn (a Stop re-fired after another hook blocked).
      await clearPending()
      return null
    }
    if (roundsThisTurn >= MAX_ROUNDS) {
      await defer($, `cap of ${MAX_ROUNDS} blocking rounds reached this turn`, sink)
      return null
    }
    $.ui.status(scan.proposal ? "review: measuring the proposal, then reviewing…" : "review: reviewing this turn…")
    const measured = scan.proposal ? await runMeasure($, session, lastMessage) : null
    if (measured) calls.push(...measured.calls)
    const measure = measured ? measured.text : null
    const git = await gitContext($, session.cwd)
    const res = await runReview($, { interrupted: false, lastMessage, scan, measure, pending: pendingBlock, debt, git, round: roundsThisTurn + 1 })
    calls.push(...res.calls)
    if (!res.ok) return await failClosed(`the review fork failed (${res.why})`)
    reviewedMark = { work: workAt, proposal: scan.proposalIndex, msg: lastMessage }
    await clearPending()
    const report = `${measure ? measure + "\n\n" : ""}[AGENTLENSPRO-REVIEW-REPORT] (run by the harness)\n${res.text}`
    // The user sees every report, PASS and BLOCK (before 0.5.0 a BLOCK report reached only the model); the debug log
    // keeps a plain copy, since show.py cuts a report past the hook output cap.
    sink.add(layoutReport(report, true))
    logLines($, layoutReport(report).join("\n"), { to: "debug" })
    if (!res.block) {
      $.ui.status("review: PASS")
      // PASS is shown only: Stop additionalContext may start a continuation turn (unmeasured), costing a
      // model turn per changing turn.
      return null
    }
    roundsThisTurn++
    $.ui.status(`review: BLOCK (round ${roundsThisTurn}/${MAX_ROUNDS})`)
    return `[agentlenspro-review-mod] The harness ran an adversarial review of this turn and it found BLOCKERS. Address each finding: fix it, or state why you reject it. Do not spawn a review fork: the harness reviews again when you stop.\n\n${report}`
  } catch (err) {
    return await failClosed(errText(err))
  } finally {
    // Usage of every model call this stop made, shown once on every path (PASS, BLOCK, failed review) and only to the user.
    if (calls.length > 0) await logUsage($, calls, sink)
  }
}
export const register = (on) => {
  on("classic.SessionStart", async ($, e, next) => {
    sessionUsage = emptySessionUsage()
    try { await rememberSession($, e) } catch (err) { $.ui.status(`review: session not remembered — ${errText(err)}`) }
    return next(e)
  })

  on("classic.UserPromptSubmit", async ($, e, next) => {
    // The round cap is NOT reset here: UserPromptSubmit also fires for hand-backs (probe M5) and maybe for a
    // Stop-block continuation, which would reset the cap and loop. It resets at turn.complete only.
    // Main-thread prompts only: a subagent prompt must not overwrite the turn's prompt.
    if (e && !e.agent_id) turnPrompt = typeof e.prompt === "string" ? e.prompt : null
    try { await rememberSession($, e) } catch (err) { $.ui.status(`review: session not remembered — ${errText(err)}`) }
    return next(e)
  })

  // Deliver a pending interrupted-turn review with whatever prompt starts the next turn.
  on("prompt.submit", async ($, e, next) => {
    try {
      const pending = await read($, pendingAtom)
      if (!pending || pending.injected) return next(e)
      await update($, pendingAtom, () => ({ ...pending, injected: true }))
      return next({ ...e, context: [...((e && e.context) || []), `The harness reviewed your INTERRUPTED previous turn. Address every BLOCKER before anything else:\n${pending.text}`] })
    } catch (err) {
      $.ui.status(`review: pending review not injected — ${errText(err)}`)
      return next(e)
    }
  })

  on("turn.complete", async ($, e, next) => {
    if (e && !e.agentId) { roundsThisTurn = 0; reviewedMark = { work: -1, proposal: -1, msg: null } }
    // The prompt is captured now: a new prompt may overwrite turnPrompt before the timer fires.
    if (e && e.isAborted && !e.agentId && !isJanitorPrompt(turnPrompt)) { const prompt = turnPrompt; $.clock.after(1500, () => reviewInterrupted($, prompt)) }
    return next(e)
  })

  // THE GATE. Runs the measurement and the review itself and blocks the stop on a BLOCK verdict.
  // The review runs BEFORE next(e) (TRDD-KZCSO0R2, 0.5.0): the plugin's own Stop command hook (hooks/show.py), which
  // prints the coloured user-only report, runs inside next(e) (measured, see USER DISPLAY), so the display file must
  // be complete before next is called. Cost of this order: every other Stop hook waits for the review. The mod's block
  // text is merged with whatever the other Stop hooks decided, exactly as before.
  on("classic.Stop", async ($, e, next) => {
    if (!e || e.agent_id) return next(e) // janitor subagents (memory/repair/security chores) are subagents: excluded here
    const sink = displaySink()
    // Owner: janitor-originated turns (heartbeat, chores) are NEVER reviewed or measured, whatever they wrote or
    // proposed; no clearPending there, so a debt or a pending BLOCK stays for the next non-janitor stop.
    const mine = isJanitorPrompt(turnPrompt) ? null : await reviewAtStop($, e, sink)
    // Written on every main-thread Stop, empty when the sink is: a leftover from an earlier Stop is never shown.
    try { await writeDisplay($, e.session_id, sink.lines) } catch (err) {
      // The rows must not be lost: fall back to the plain dim transcript rows.
      logLines($, [`[review-mod] display file not written (${errText(err)}); plain copy follows`, ...sink.lines.map((l) => l.replace(ANSI_SGR, ""))].join("\n"))
    }
    const r = await next(e)
    return mine ? { ...r, block: [r.block, mine].filter(Boolean).join("\n\n") } : r
  })
}
