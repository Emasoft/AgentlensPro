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
// ANSI colour to a per-session temp file under <cwd>/.claude/tmp/ (0.5.1) that the plugin's Stop command hook
// (hooks/show.py) prints as a systemMessage, which the model never receives (see USER DISPLAY); the review therefore
// runs before next(e). An interrupted turn fires no Stop, so its rows still go to $.ui.log, plain (a log row is dim and
// turns ESC into U+FFFD; see REPORT LAYOUT).
// DELIVERY TO THE MODEL (0.5.2, owner 2026-11-14: "only the token counts must be restricted to the user view with
// systemMessage! the adversarial review instead must be injected in the context and visible by both the agent and the
// user!"). The coloured display is the user's copy only. The model gets every report RAW: a BLOCK through the block
// string at once; a PASS, and an interrupted turn's review, through the one store (pendingAtom) that the next
// prompt.submit injects as context, once. The usage table never reaches the model.
// SUBAGENTS (0.6.0, owner 2026-11-14: "subagents must have their fork adversarial review and measure report too at the end
// of each turn, so they too must print the systemMessage"; "only the token counts must be restricted to the user view
// with systemMessage!!! the adversarial review instead must be injected in the context and visible by both the agent and
// the user!!"; "you don't want the subagent stop adversarial review to be triggered on the very adversarial review
// subagent turn stop. that would become an infinite recursion of reviews. be careful."; "once it is been printed on
// screen, it can be deleted."). A typed subagent's turn (Agent-tool forks included) is reviewed with $.model.complete on
// the pinned COMPLETION_MODEL over that agent's own messages, measuring when its last message carries the proposal line.
// An agent that ends with text is reviewed at classic.SubagentStop: a report with findings blocks it once (it continues
// and reads "Stop hook feedback"). An agent that reports with SubagentHandback is reviewed at that tool call (tool.call):
// a report with findings refuses the call once, the agent reads it as the tool's error and can fix or reject each finding,
// and its retried handback goes through (the engine discards a SubagentStop block after a turn that ended on a tool
// result, measured live, so the stop is too late for it). A clean PASS does not block; a harness failure never blocks.
// Every report, and a note for every turn it did not review, also goes to the parent's next prompt.submit. The coloured
// copy goes to <cwd>/.claude/tmp/agentlenspro-review-mod/<session_id>__<agent_id>.txt, which show.py, registered on
// SubagentStop too, prints in that subagent's view and deletes. Reviews are completions, which fire no SubagentStop, so a
// review cannot start another. Four recursion guards keep a main review's own fork from being reviewed (measured each
// alone, test061/alone.mjs: (a) and (c) alone stop it; (b) alone stops it while the fork call is open, which is when its
// SubagentStop fires; (d) alone bounds it to MAX_ROUNDS reviews): (a) no agent
// id, agent_type "" (every $.model.fork), a loop $.agent.list() does not name (at a handback) or a janitor agent;
// (b) reentrancy: a stop of an unlisted loop while any review calls the model; (c) a report-shaped last message or
// a ROLE: REVIEW/MEASURE prompt; (d) MAX_ROUNDS reviews per agent turn, and MAX_CONCURRENT_SUBAGENT_REVIEWS review slots
// (a FIFO wait, handed to the parent after SLOT_WAIT_MS). See SUBAGENT REVIEW.

import { atom, read, update } from "claude-code"

const MAX_ROUNDS = 2
// The model of every $.model.complete this mod makes (a subagent review or measurement, an interrupted-turn fallback):
// the full id, never the alias "sonnet". WHY: a completion result does not name the model an alias resolved to, so the
// usage table could only print "rate unknown for sonnet"; with the full id lookupRates prices it. claude-sonnet-5-5 has its
// own RATES row (read $0.10/MTok; it used to prefix-fall to the claude-sonnet-5 row, whose $0.20 read is 2x high for it).
const COMPLETION_MODEL = "claude-sonnet-5-5"
const DIFF_MAX = 40000
const OBS_MAX = 4000
const MAX_ASSUMPTIONS = 8

// The ONE store of what the model has not been shown yet (0.5.2): `{ text, block, injected, at, debt?, debtWhy? }`. It
// holds a Stop review that PASSED and an interrupted turn's review (RAW, never the usage table), plus a DEBT left by a
// review that could not run; prompt.submit is its one injection point. Session state, so a module reload does not lose it.
const pendingAtom = atom({ plugin: "agentlenspro-review-mod", key: "pendingReview" }, null)
// The head of that injection: the agent must know it is the harness review of its own previous turn, and what to do.
// 0.6.0: the same store also carries the reviews of SUBAGENT turns, each tagged "subagent <type> <id>" in its report header.
const REVIEW_HEAD = "[agentlenspro-review-mod] A harness adversarial review follows (the user sees it too): untagged reviews your PREVIOUS turn (\"interrupted turn\" = the user cut it short), \"subagent <type> <id>\" reviews that subagent's turn (its header says if it was blocked once or its handback refused once), and a note says when a turn was not reviewed. Address every BLOCKER first, apply each finding or state why you reject it, and do not spawn a review fork."
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

// RATES mirrored from src/shared/pricing.ts (PRICING_LAST_UPDATED 2026-11-15); update together. USD per MTok:
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
  "claude-sonnet-5-5": { i: 2, r: 0.1, w: 2.5, o: 10 },
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

// The user-only layout of one usage cycle, in the closed-box layout of the token-reporter plugin (owner asked for it,
// 2026-11-15): a header (title | model), a label | value row per call (its token row has an empty label), the turn total,
// the session total and a rate note, all inside one ╭╮╰╯ frame whose right border aligns. Always painted with token-reporter's
// palette: it only ever goes to the Stop display file. Width is counted in code points, which holds for every character
// this box draws. Token counts stay exact.
function usageTable(table) {
  const BLUE = "94" // static: border, labels, all unchanging text
  const YELLOW = "93" // token numbers
  const GREEN = "92" // costs
  const WHITE = "97" // model
  const clean = (s) => String(s).replace(CONTROL, "")
  const seg = (code, text) => ({ code, text: clean(text) })
  const width = (segs) => segs.reduce((n, s) => n + [...s.text].length, 0)
  // Every span is closed on its own row, so show.py may cut between any two lines.
  const render = (segs) => segs.map((s) => (s.code && s.text !== "" ? `\u001b[${s.code}m${s.text}\u001b[0m` : s.text)).join("")
  const bar = render([seg(BLUE, "│")])
  const tokens = (t) => [seg(BLUE, "in "), seg(YELLOW, fmtInt(t.inp)), seg(BLUE, " · out "), seg(YELLOW, fmtInt(t.out)), seg(BLUE, " · cache r "), seg(YELLOW, fmtInt(t.cr)), seg(BLUE, " / w "), seg(YELLOW, fmtInt(t.cw))]
  const cost = (c) => [seg(String(c).startsWith("$") ? GREEN : BLUE, c)]
  const body = [] // [label, value segments]; an empty label is a continuation row
  for (const r of table.rows) {
    body.push([clean(r.label), cost(r.cost)])
    if (r.tokens) body.push(["", tokens(r.tokens)])
  }
  body.push(["this turn", cost(table.total.cost)], ["", tokens(table.total.tokens)], ["session", cost(table.session)])
  const header = [seg(BLUE, "review-mod usage"), seg(BLUE, " | "), seg(WHITE, table.model)]
  const note = [seg(BLUE, "$ spans 5m–1h cache-write rates")]
  const labelW = Math.max(...body.map(([l]) => [...l].length))
  const inner = Math.max(width(header), width(note), ...body.map(([, v]) => labelW + 3 + width(v)))
  const row = (segs) => `${bar} ${render([...segs, seg(null, " ".repeat(inner - width(segs)))])} ${bar}`
  const rule = (l, r) => render([seg(BLUE, `${l}${"─".repeat(inner + 2)}${r}`)])
  const lines = [rule("╭", "╮"), row(header), rule("├", "┤")]
  for (const [label, value] of body) {
    const lead = label ? [seg(BLUE, `${label}${" ".repeat(labelW - [...label].length)} │ `)] : [seg(null, " ".repeat(labelW + 3))]
    lines.push(row([...lead, ...value]))
  }
  lines.push(row(note), rule("╰", "╯"))
  return lines
}
// ── END USAGE / COST (pure part) ──────────────────────────────────────────────────────────────────

// ── REPORT LAYOUT (pure part; the user-only copy of a report) ─────────────────────────────────────
// A plugin Stop COMMAND hook's systemMessage is drawn with real ANSI SGR colour and real newlines, and the model never
// receives it (probe 2026-11-14 on 2.1.325); a $.ui.log row is one plain dim line where ESC is drawn as U+FFFD and no
// render hook can restyle it. So boxes and reports go to the display file hooks/show.py prints at Stop, never to $.ui.log.
// Line-safe: every coloured span is closed on its own line, and control characters in the report text (model output,
// diffs, stderr) are stripped first, so show.py may cut between any two lines. The user copy only: the block string, the
// pending-review injection and the review prompt keep the raw text, because they reach the model.
const SGR = { yellow: "33" }
// paint("yellow", s) wraps s in one SGR span closed by a reset.
const paint = (style, s) => (s !== "" ? `\u001b[${SGR[style]}m${s}\u001b[0m` : s)
// C0 controls except TAB and LF, DEL, and the C1 range (0x9b is a one-byte CSI).
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
// The user copy of a Stop report (owner, 2026-11-15): the report text exactly as the reviewer wrote it, one row per line,
// no gutter and no colour; only control characters (model output, diffs, stderr) are stripped so a row can never carry an
// escape that show.py's line cut or the terminal would misread.
function plainReport(text) {
  return String(text).split(/\r?\n/).map((l) => l.replace(CONTROL, "").trimEnd())
}

// ── END REPORT LAYOUT (pure part) ─────────────────────────────────────────────────────────────────

// Running total for this session, reset on classic.SessionStart.
let sessionUsage = emptySessionUsage()
// Interrupted-turn boxes waiting for the next Stop display: [{ at: "HH:MM", table, report }] (table and report may be null).
// An interrupted turn fires no Stop, and a $.ui.log row is one plain host-prefixed line, so its box cannot be drawn at the
// time (owner complaint 2026-11-15); classic.Stop prepends these to its display, classic.SessionStart drops them.
const heldInterrupted = []

// ── USER DISPLAY (the coloured user-only rows of one Stop, printed by hooks/show.py) ──────────────────
// The rows of one main-thread Stop (reports, usage, failures) are collected in a sink and written ONCE, before
// classic.Stop calls next(e): the plugin's own Stop command hook (hooks/show.py) runs INSIDE that next(e) (measured
// 2026-11-14 on 2.1.325, `claude -p`: "cmd display_exists=False" logged between "mod before-next" and "mod after-next"),
// prints the file as a systemMessage and deletes it. The path is computed on both sides from the Stop payload, which
// both receive (the mod's classic.Stop `e` is the JSON the command hook reads on stdin): <cwd>/DISPLAY_DIR/<session_id>.txt.
// Owner decision 0.5.1: no HOME, no USERPROFILE, no CLAUDE_PLUGIN_DATA (this process cannot read it). The folder is a
// temp folder: the mod writes a `*` .gitignore in it so nothing shows in git status, and show.py deletes every file there
// older than 120 s (STALE_SECONDS). The file is written on EVERY main-thread Stop, empty when there is nothing to show, so a file an
// earlier Stop left behind is overwritten before show.py reads it (show.py also drops a file older than 120 s).
const DISPLAY_DIR = ".claude/tmp/agentlenspro-review-mod"
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/
const ANSI_SGR = /\u001b\[[0-9;]*m/g

function displaySink() {
  const lines = []
  return { lines, add: (rows) => { lines.push(...rows) } }
}

// Pure: the display file of a Stop, or null when the payload gives no absolute cwd or no plain session id. With an agent
// id (a SubagentStop, 0.6.0) the file is <session_id>__<agent_id>.txt: show.py on SubagentStop reads exactly that name and
// never the main <session_id>.txt, which every main-review fork's own SubagentStop (same session id) would otherwise take.
function displayPath(cwd, sessionId, agentId = null) {
  if (typeof cwd !== "string" || !/^(?:\/|[A-Za-z]:[\\/])/.test(cwd)) return null
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null
  if (agentId !== null && (typeof agentId !== "string" || !SESSION_ID.test(agentId))) return null
  const base = agentId === null ? sessionId : `${sessionId}__${agentId}`
  return { dir: `${cwd.replace(/[\\/]+$/, "")}/${DISPLAY_DIR}`, base, file: `${base}.txt` }
}

// $.fs.write creates the folder; the .gitignore keeps the temp files out of git status from the first write on.
async function ensureDisplayDir($, dir) {
  if (!(await $.fs.exists(`${dir}/.gitignore`))) await $.fs.write(`${dir}/.gitignore`, "*\n")
}

async function writeDisplay($, cwd, sessionId, lines, agentId = null) {
  const at = displayPath(cwd, sessionId, agentId)
  if (!at) throw new Error(`no display path (cwd ${JSON.stringify(cwd)}, session_id ${JSON.stringify(sessionId)}${agentId === null ? "" : `, agent_id ${JSON.stringify(agentId)}`})`)
  await ensureDisplayDir($, at.dir)
  // Claude Code 2.1.325 cuts a systemMessage line at its first U+2502 "│" and drops the rest of the line (probed
  // 2026-11-15: a "x │ …" line showed only "x"; U+254E and nine other bars render). Every box row starts with "│", so
  // the 0.7 token box showed only its rules. Mapped here, the one point every display line passes, so a reviewer
  // report that quotes a box keeps its lines too. U+254E is a light bar centred in its cell, one code point wide.
  const text = lines.join("\n").replaceAll("│", "╎")
  await $.fs.write(`${at.dir}/${at.file}`, lines.length > 0 ? `${text}\n` : "")
}

// One user-only message: into the Stop display (coloured, plus a plain copy in the debug log) when a sink is given,
// else to the transcript as plain dim rows.
function note($, sink, style, text) {
  const clean = String(text).replace(CONTROL, "")
  if (!sink) { logLines($, clean); return }
  sink.add(clean.split("\n").map((l) => paint(style, l)))
  logLines($, clean, { to: "debug" })
}

// One user-only usage table for the model calls of one review cycle: into the Stop display when a sink is given. With no
// sink (the interrupted-turn timer, which fires no Stop) it prints ONE plain $.ui.log row and returns the table so the
// caller can hold the box for the next Stop display. Owner complaint 2026-11-15: the interrupted turn used to print the
// whole box as many $.ui.log rows, each prefixed by the host, with no colour. Returns the table, or null when it could not
// be computed. A failure here is reported, never thrown: it must not turn a finished review into a failed one.
async function logUsage($, calls, sink = null) {
  try {
    const { line, table, session } = formatUsageLine(calls, await $.session.model(), sessionUsage)
    sessionUsage = session
    if (sink) sink.add(usageTable(table))
    else {
      const t = table.total.tokens
      $.ui.log(`review-mod: interrupted review ${table.total.cost} · in ${fmtInt(t.inp)} · out ${fmtInt(t.out)} · cache r ${fmtInt(t.cr)} / w ${fmtInt(t.cw)} · session ${table.session} · box after next reply`)
    }
    // The one-line form goes to the debug log too, where one grep finds a whole cycle.
    logLines($, line, { to: "debug" })
    return table
  } catch (err) {
    note($, sink, "yellow", `[review-mod usage] could not be computed: ${errText(err)}`)
    return null
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

// A subagent's review and measurement (0.6.0): one completion on an explicit model, retried once on an API error like a
// fork. maxTokens is set because the default (1024) cuts a review short.
async function complete($, prompt, label) {
  const ask = () => $.model.complete({ model: COMPLETION_MODEL, prompt, maxTokens: SUBAGENT_MAX_TOKENS, timeoutMs: SUBAGENT_TIMEOUT_MS })
  let r = await ask()
  const calls = [callRecord(label, COMPLETION_MODEL, r)]
  if (!r.isAnswered && r.reason === "api-error") {
    r = await ask()
    calls.push(callRecord(`${label} retry`, COMPLETION_MODEL, r))
  }
  return { r, calls }
}

// The model caller of one review cycle: the main thread forks (its conversation is in the prompt cache), a subagent
// completes (a fork would read the MAIN thread). The prompts are the same; `subject` only adds the agent's messages.
// A plain function, not a returned closure: `claude plugin validate` refuses `$` passed to anything else.
async function callModel($, subject, prompt, label) {
  // Guard (b) counts EVERY review model call, the main thread's forks included: a main review's fork fires its own
  // SubagentStop while the fork call is still open, so a stop of an unlisted loop inside that window is a review's own.
  reviewDepth++
  try { return subject ? await complete($, prompt, label) : await fork($, prompt, label) } finally { reviewDepth-- }
}

async function runMeasure($, session, lastMessage, subject = null) {
  const calls = []
  const planned = await callModel($, subject, [
    HARNESS_HEAD,
    "ROLE: MEASURE (step 1 of 2: plan).",
    subject
      ? `The ${subject.label}'s most recent turn (the end of its conversation below) contains a proposal (a line starting "PROPOSAL FOR ACTION - PLEASE REVIEW").`
      : "The most recent turn above contains a proposal (a line starting \"PROPOSAL FOR ACTION - PLEASE REVIEW\").",
    // Spread, not "": this list is joined unfiltered, so an empty entry would change the main thread's prompt by a line.
    ...(subject ? [`The ${subject.label}'s conversation (the harness's bounded copy of its messages, oldest first):\n<<<\n${subject.rows}\n>>>`] : []),
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
  const judged = await callModel($, subject, [
    HARNESS_HEAD,
    "ROLE: MEASURE (step 2 of 2: verdicts).",
    "The harness ran these read-only commands for the proposal in the most recent turn. Judge ONLY from the OBSERVED output.",
    rows.join("\n\n"),
    "OUTPUT FORMAT: plain text, exactly these lines and nothing else. No preamble, no markdown headings or bold, do not restate the checks; every item is exactly one line; the separator is \" — \".",
    "Line 1: MEASURE: <n> confirmed · <n> refuted · <n> unmeasurable",
    "Then one row per assumption: N. [confirmed|refuted|unmeasurable] <assumption> — `<command>` — <observed, the decisive part>",
    "Last line: LOAD-BEARING REFUTED: <list or none>",
  ].join("\n"), "measure-judge")
  calls.push(...judged.calls)
  const verdicts = judged.r
  const head = `[AGENTLENSPRO-MEASURE-REPORT] (run by the harness${subject ? `, ${subject.label}` : ""})`
  return { text: verdicts.isAnswered ? `${head}\n${verdicts.text}` : `${head}\nverdict step failed (${verdicts.reason}); raw rows:\n${rows.join("\n\n")}`, calls }
}

// ── REVIEW ─────────────────────────────────────────────────────────────────────────────────────
// Report format (owner, 2026-11-15): the review and the measurement reports share ONE concise plain-text skeleton, a summary
// line, one numbered line per item with " — " as the only separator, then closing lines; no markdown, no prose sections. They
// are injected into the model context, so brevity is the point. The review verdict is "VERDICT: PASS|BLOCK" on line 1 and the
// measure summary is "MEASURE: ..." (never "VERDICT:"), so parseVerdict and FINDING_LINE read only review lines.
// `subject` (0.6.0): null for the main thread, whose conversation the fork already holds; for a subagent, `{ label, rows }`,
// the agent's bounded messages, handed in the prompt because a completion holds no conversation. Same review otherwise.
function reviewPrompt({ interrupted, lastMessage, scan, measure, pending, debt, git, round, subject = null }) {
  const turn = subject ? `The ${subject.label}'s most recent turn (the end of its conversation below)` : "The most recent turn above"
  return [
    HARNESS_HEAD,
    "ROLE: REVIEW",
    interrupted
      ? "The user INTERRUPTED the most recent turn above (Esc). Review the work that turn did before it was cut off."
      : `${turn} just ended${round > 1 ? ` (review round ${round}: the previous round's findings are in the conversation; check each was fixed or explicitly rejected with a reason)` : ""}.`,
    subject ? `The ${subject.label}'s conversation (the harness's bounded copy of its messages, oldest first):\n<<<\n${subject.rows}\n>>>` : "",
    lastMessage ? `Its final message${subject ? "" : " to the user"} was:\n<<<\n${lastMessage}\n>>>` : "",
    `Scanner: work = ${scan.work ? `${scan.work.cause} — ${scan.work.detail}` : "none"}; proposal = ${scan.proposal}.`,
    measure ? `\n${measure}\n` : "",
    pending ? `An earlier INTERRUPTED turn was reviewed by the harness with these findings; check whether this turn addressed them:\n<<<\n${pending}\n>>>` : "",
    debt ? `An earlier stop ended WITHOUT a harness review (${debt}). Review that earlier work too: it is in the conversation above.` : "",
    `Working tree, read by the harness:\n${git}`,
    "",
    "Review EVERYTHING the most recent turn did or proposed: its claims and answers, its reasoning, every command it ran (read-only ones included), any proposal, and any change. A turn with no change is still reviewed: hunt false or unsupported claims, answers that skip what was asked, and conclusions stronger than the evidence shown. Also hunt: a PROXY read in place of the thing (a pipe's exit status for the tool's, a preview for the file, one run for the variance, an assumed format for the real one); broken references; untested or unverified changes; silent failure paths; destructive or irreversible actions without confirmation; scope beyond the request.",
    `You are the REVIEWER, not the agent: write about the ${subject ? "subagent" : "main agent"} in the third person ("the agent", "the turn"). Never write "I", "me" or "my" about the agent's actions.`,
    "Never recommend, in a finding or in SETTLE WITH, an action the user forbade in the conversation (for example running code the user said not to run); if the only settling check is forbidden, write that instead of the command.",
    "OUTPUT FORMAT: plain text, exactly these lines and nothing else. No preamble, no markdown headings or bold, no restating the question; every item is exactly one line; the separator is \" — \".",
    "Line 1: exactly \"VERDICT: PASS\" or \"VERDICT: BLOCK\" (BLOCK only when at least one finding is a BLOCKER).",
    "Then numbered findings, one per line: N. [BLOCKER|SHOULD-FIX|NIT] <claim> — <evidence> — <fix>",
    "Then: NOT-DO: <the strongest reason NOT to have done what the turn did, one line>",
    "Then: WRONG-IF: <the most likely way it is wrong, one line>",
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
  const f = await callModel($, args.subject, reviewPrompt(args), label)
  if (!f.r.isAnswered) return { ok: false, why: f.r.reason, calls: f.calls }
  return { ...parseVerdict(f.r.text.trim()), calls: f.calls }
}

// Puts a report the model has not seen into the ONE store (pendingAtom) that prompt.submit delivers from (0.5.2). A report
// still waiting there (stored, not yet injected) is kept and the new one appended, so neither is lost and each is
// delivered exactly once; a waiting BLOCK keeps the record a BLOCK, and a debt survives (only a review that runs clears it).
async function storeForModel($, text, block) {
  await update($, pendingAtom, (prev) => {
    const waiting = prev && !prev.injected && prev.text ? prev : null
    return {
      ...(prev && prev.debt ? { debt: true, debtWhy: prev.debtWhy } : {}),
      text: waiting ? `${waiting.text}\n\n${text}` : text,
      block: block || !!(waiting && waiting.block),
      injected: false,
      at: Date.now(),
    }
  })
}

// The interrupted turn's review, from a timer: outside the aborted event, so the fork is not cut by it. `mark` is what
// this turn's last Stop review covered (captured at turn.complete); work it already covered is not reviewed twice.
async function reviewInterrupted($, prompt, mark) {
  if (isJanitorPrompt(prompt)) return // owner: janitor turns are never reviewed (the scheduler checks too)
  const calls = []
  let heldReport = null // the plain-text report, set once the review ran; held with the usage box until the next Stop
  try {
    const session = await read($, sessionAtom)
    if (!session) { await defer($, "interrupted turn: no transcript path seen yet"); return }
    const scan = await scanTurn($, session, true)
    if (!scan.ok) { await defer($, `interrupted turn: ${scan.why}`); return }
    if (!scan.work && !scan.proposal) return
    // A turn cut after a Stop review (a BLOCK continuation interrupted before any new work or proposal): that review's
    // report already reached the model, so a second report of the same work would be a double delivery.
    if (mark && (scan.work ? scan.work.index : -1) <= mark.work && scan.proposalIndex <= mark.proposal) return
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
      const c = await $.model.complete({ model: COMPLETION_MODEL, system: reviewPrompt({ interrupted: true, lastMessage: null, scan, measure, pending: null, git, round: 1 }), prompt: `The interrupted conversation's last messages (JSON):\n${excerpt}`, maxTokens: 4000 })
      calls.push(callRecord("review (interrupted, completion)", COMPLETION_MODEL, c))
      res = c.isAnswered ? parseVerdict(c.text.trim()) : { ok: false, why: `fork: ${res.why}; completion: ${c.reason}` }
    }
    if (!res.ok) { await defer($, `interrupted turn: ${res.why}`); return }
    const text = `${measure ? measure + "\n\n" : ""}[AGENTLENSPRO-REVIEW-REPORT] (run by the harness, interrupted turn)\n${res.text}`
    await storeForModel($, text, res.block)
    heldReport = text
    $.ui.status(res.block ? "review: interrupted turn — BLOCK, findings go to the next prompt" : "review: interrupted turn — PASS")
  } catch (err) {
    await defer($, `interrupted turn: ${errText(err)}`)
  } finally {
    // The box is held, not printed: one plain row now, the report and the box in the next Stop display (heldInterrupted).
    if (calls.length > 0) {
      const table = await logUsage($, calls)
      heldInterrupted.push({ at: new Date().toTimeString().slice(0, 5), table, report: heldReport })
    }
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
  // The debt is merged into the record as it is at write time (update's own prev, not an earlier read): the record may
  // hold a report still waiting for the model (0.5.2), and a stale copy would drop it.
  await update($, pendingAtom, (prev) => ({ ...(prev || { text: "", block: false, injected: true, at: Date.now() }), debt: true, debtWhy: why }))
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
      return `[agentlenspro-review-mod] The review could not run (${why}); end your turn again and the harness retries it at the next stop. Do not spawn a review fork.`
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
    // Clears what this stop deals with: the record read at its start (its BLOCK goes into this review or into the block
    // string, its debt into this review). A report still waiting for the model that is not a BLOCK is kept for the next
    // prompt.submit (a PASS stored by an earlier Stop of this turn, or an interrupted turn's PASS); a record written after
    // this stop read it (the interrupted timer, during the review) is left alone.
    const clearPending = async () => {
      if (!pending) return
      await update($, pendingAtom, (prev) => {
        if (!prev || prev.at !== pending.at) return prev
        return !prev.injected && prev.text && !prev.block ? { text: prev.text, block: false, injected: false, at: prev.at } : null
      })
    }
    if (!shouldReview({ work: scan.work, proposal: scan.proposal, debt, lastMessage, prompt: turnPrompt })) {
      await clearPending()
      if (pendingBlock && roundsThisTurn < MAX_ROUNDS) {
        roundsThisTurn++
        return `[agentlenspro-review-mod] The review of your INTERRUPTED earlier turn found BLOCKERS this turn did not address; fix each (or state why you reject it), then end the turn.\n\n${pendingBlock}`
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
    // The user sees every report, PASS and BLOCK (before 0.5.0 a BLOCK report reached only the model); the sink copy and
    // the debug-log copy are both the plain text (plainReport), since show.py cuts a report past the hook output cap.
    sink.add(plainReport(report))
    logLines($, plainReport(report).join("\n"), { to: "debug" })
    if (!res.block) {
      $.ui.status("review: PASS")
      // A PASS report is not put in Stop additionalContext (that may start a continuation turn, unmeasured, costing a
      // model turn per changing turn). It goes, RAW (no colour, no usage), into the one store the next prompt.submit
      // delivers from; a BLOCK report is never stored, since the block string below already gives it to the model.
      await storeForModel($, report, false)
      return null
    }
    roundsThisTurn++
    $.ui.status(`review: BLOCK (round ${roundsThisTurn}/${MAX_ROUNDS})`)
    return `[agentlenspro-review-mod] The review of this turn found BLOCKERS; fix each finding or state why you reject it. Do not spawn a review fork: the harness reviews again when you stop.\n\n${report}`
  } catch (err) {
    return await failClosed(errText(err))
  } finally {
    // Usage of every model call this stop made, shown once on every path (PASS, BLOCK, failed review) and only to the user.
    if (calls.length > 0) await logUsage($, calls, sink)
  }
}
// ── SUBAGENT REVIEW (0.6.0) ─────────────────────────────────────────────────────────────────────
// A subagent's turn is reviewed with $.model.complete (model COMPLETION_MODEL), never $.model.fork: a fork repeats the
// MAIN thread's last request (measured: a fork inside SubagentStop read the main prefix, and once continued the main
// task), and every fork fires a SubagentStop of its own (agent_type ""), which is the recursion guard (a) exists for. A
// completion fires no SubagentStop, no agent.spawn and no turn.complete (measured, probe-060 A4). The conversation is
// the agent's own `$.session.messages({ agentId })` rows (measured working at SubagentStop for typed agents), not the
// agent_transcript_path file, whose last record is often not written yet when the hook runs (probe-060 A3). An agent
// that ends with text is reviewed at its SubagentStop; one that reports with SubagentHandback at that tool call.
const SUBAGENT_MAX_TOKENS = 4000
const SUBAGENT_TIMEOUT_MS = 300000
const MAX_CONCURRENT_SUBAGENT_REVIEWS = 2
// How long a subagent turn waits for a review slot before its review is handed to the parent: 10 minutes.
const SLOT_WAIT_MS = 600000
// The conversation handed to the reviewer: its first prompt and as many of the newest messages as fit.
const ROWS_MAX = 60000
const ROW_PART_MAX = 2000
// The janitor's agents (`ai-maestro-janitor:*`, or the bare `janitor-*` form some sessions list): their writes are the
// janitor's actions (owner order 2026-09-15, same exclusion as review-gate's JANITOR_AGENT_RE).
const JANITOR_AGENT = /^(?:ai-maestro-janitor:|janitor-)/
// Per-agent state, keyed by agent_id: { rounds, seen, blocked, denied, quiet, display }. It never touches the main
// thread's roundsThisTurn, reviewedMark or debt; an entry goes at that agent's turn.complete (after its SubagentStop).
const agentState = new Map()
function agentStateOf(id) {
  let st = agentState.get(id)
  if (!st) {
    st = { rounds: 0, seen: null, blocked: false, denied: false, quiet: false, display: [] }
    agentState.set(id, st)
  }
  return st
}
// Guard (b): >0 while any review or measurement model call is open (callModel), the main thread's forks included.
let reviewDepth = 0

// Guard (d), slots: a FIFO semaphore. WHY a wait and not a skip (round 2, coordinator 2026-11-15): with a skip, a fan-out
// of N workers left all but two unreviewed. A released slot passes straight to the oldest waiter; a waiter whose time ran
// out is marked settled and never takes a slot afterwards.
let slotsInUse = 0
const slotQueue = []
function acquireSlot($, ms) {
  if (slotsInUse < MAX_CONCURRENT_SUBAGENT_REVIEWS && slotQueue.length === 0) {
    slotsInUse++
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const w = { resolve, settled: false }
    slotQueue.push(w)
    $.clock.after(ms, () => {
      if (w.settled) return
      w.settled = true
      slotQueue.splice(slotQueue.indexOf(w), 1)
      resolve(false)
    })
  })
}
function releaseSlot() {
  while (slotQueue.length > 0) {
    const w = slotQueue.shift()
    if (!w.settled) { w.settled = true; w.resolve(true); return }
  }
  slotsInUse--
}

// The $.agent.list() entry of an agent loop, or null: the engine's forks (a $.model.fork, compaction, prompt suggestions)
// and a workflow's agents are not listed. A list that cannot be read counts as "not listed".
async function listedAgent($, id) {
  try {
    const list = await $.agent.list()
    return (Array.isArray(list) && list.find((a) => a && a.id === id)) || null
  } catch {
    return null
  }
}

function subagentOutOfScope(e) {
  if (!e || typeof e.agent_id !== "string" || e.agent_id === "") return true
  const type = typeof e.agent_type === "string" ? e.agent_type.trim().toLowerCase() : ""
  return type === "" || JANITOR_AGENT.test(type)
}

// A message that OPENS with a report heading (review-gate's markerOpening: leading `#`, `*`, backticks and spaces off, then
// the heading as a whole word) or with a "VERDICT:" line is a reviewer's output.
const REPORT_OPENING = /^(?:\[AGENTLENSPRO-(?:REVIEW|MEASURE)-REPORT\](?![A-Za-z0-9_-])|VERDICT:)/
function isReportText(text) {
  if (typeof text !== "string") return false
  const first = text.split("\n").find((l) => l.trim() !== "")
  return first !== undefined && REPORT_OPENING.test(first.replace(/^[#*`>_\s]+/, ""))
}

// The role a spawned agent's first prompt declares, read like review-gate's workerDeclaredRole: a fork's prompt is the
// fork boilerplate then a line "Your directive: <prompt>" (measured, probe-060 fork transcript), a plain prompt's first
// non-blank line is the brief's first line; the marker must open that line.
function declaresReviewRole(text) {
  const lines = String(text || "").split("\n")
  const line = lines.find((l) => l.startsWith("Your directive: ")) ?? lines.find((l) => l.trim() !== "") ?? ""
  return /^(?:Your directive: )?ROLE: (?:REVIEW|MEASURE)(?![\w-])/.test(line.trimStart())
}

// A finding line of a report. "any finding" (BLOCKER, SHOULD-FIX or NIT) blocks the subagent once.
const FINDING_LINE = /^(?:\d+[.)]\s*)?\[?(?:BLOCKER|SHOULD-FIX|NIT)\]?(?=[\s:—–-]|$)/
function hasFindings(text) {
  return String(text).split("\n").some((l) => FINDING_LINE.test(l.replace(/\*\*/g, "").trim().replace(/^(?:[#>]+\s*|[-•]\s+)/, "")))
}

function subagentTag(e) {
  return `subagent ${String(e.agent_type).replace(CONTROL, "")} ${e.agent_id}`.slice(0, 200)
}

// The agent's own messages: from its first user message on. A fork's rows open with the PARENT's assistant message that
// spawned it (measured, probe-060 A3); its tool uses are the parent's, not the fork's work.
function ownRows(found) {
  const start = found.findIndex((r) => r && r.role === "user")
  return start === -1 ? [] : found.slice(start)
}

// The final message when the event carries none: an agent that ends with a SubagentHandback tool call has no final text
// block, and last_assistant_message is "" (measured, probe-060 A3, interactive background agent).
function handbackMessage(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role !== "assistant") continue
    const use = (rows[i].toolUses || []).find((u) => u && u.tool === "SubagentHandback" && u.input && typeof u.input.message === "string")
    if (use) return use.input.message
  }
  return null
}

const clip = (s, n) => {
  const t = String(s ?? "")
  return t.length > n ? `${t.slice(0, n)} [... cut at ${n} of ${t.length} chars]` : t
}

function rowText(r) {
  const parts = [`[${r.role}]${r.text ? ` ${clip(r.text, ROW_PART_MAX)}` : ""}`]
  for (const u of r.toolUses || []) {
    parts.push(`  tool_use ${u.tool} ${clip(JSON.stringify(u.input ?? {}), ROW_PART_MAX)}`)
    if (u.text !== undefined) parts.push(`  result${u.isError ? " (error)" : ""}: ${clip(u.text, ROW_PART_MAX)}`)
  }
  return parts.join("\n")
}

// Bounded: the first prompt, then the newest messages that fit in ROWS_MAX, oldest first.
function boundedRows(rows) {
  const head = rowText(rows[0])
  const tail = []
  let size = head.length
  for (let i = rows.length - 1; i >= 1; i--) {
    const t = rowText(rows[i])
    if (size + t.length > ROWS_MAX) break
    tail.unshift(t)
    size += t.length
  }
  const skipped = rows.length - 1 - tail.length
  return [head, ...(skipped > 0 ? [`[... ${skipped} earlier messages not shown]`] : []), ...tail].join("\n\n")
}

// The rows as a transcript the shared scanner reads: one `user`/`assistant` entry per row, the tool uses as tool_use
// blocks and the tool results as tool_result blocks, no isSidechain. WHY a copy and not the agent's own file: the CLI's
// `--event SubagentStop --transcript` path passes no agent_type, so review-gate's subagentExempt("") answers "no demand"
// before scanning, and the default event skips every entry of the agent's file (each is isSidechain); a non-sidechain copy
// read with the default event goes through the SAME rules (toolUseWork, commandWriteReason, textArms) the main scan uses.
function syntheticTranscript(rows) {
  return rows.map((r) => {
    const content = r.text ? [{ type: "text", text: r.text }] : []
    if (r.role === "assistant") for (const u of r.toolUses || []) content.push({ type: "tool_use", id: u.tool_use_id, name: u.tool, input: u.input ?? {} })
    else for (const t of r.toolResults || []) content.push({ type: "tool_result", tool_use_id: t.tool_use_id, is_error: t.isError === true, content: t.text ?? "" })
    return JSON.stringify({ type: r.role, message: { role: r.role, content } })
  }).join("\n") + "\n"
}

// A subagent stop the harness does not review: shown to the user, and the parent is told with its next prompt. Never a
// block: a harness failure, a cap or a skip is not something the subagent can act on.
async function skipSubagent($, sink, tag, why) {
  note($, sink, "yellow", `[${tag}] NOT REVIEWED by the harness (the subagent was not blocked; the parent is told): ${why}`)
  $.ui.status(`review: ${tag} not reviewed — ${why}`)
  // Caught here: the guard branches of classic.SubagentStop call this outside any try, and a throw there must not fail
  // the hook (the subagent would be stopped by a hook error instead of passing untouched).
  try {
    await storeForModel($, `[agentlenspro-review-mod] The turn of your ${tag} was NOT reviewed by the harness (${why}). Check its handback yourself.`, false)
  } catch (err) {
    note($, sink, "yellow", `[${tag}] the note for the parent could not be stored: ${errText(err)}`)
  }
}

// What the gate needs of one subagent turn, or null for a reviewer's or a measurer's turn (guard (c)), or { why } when it
// cannot be read. The final message is the handback's own at a SubagentHandback call; at a SubagentStop it is the event's,
// or the last SubagentHandback message when the event carries none.
async function readSubagentTurn($, ctx) {
  const found = await $.session.messages({ agentId: ctx.agentId })
  if (!Array.isArray(found)) return { why: `its messages could not be read (${found && found.deny ? found.deny : "no reason given"})` }
  const rows = ownRows(found)
  if (rows.length === 0) return { why: "it has no messages" }
  // Guard (c), prompt half: an agent spawned as a reviewer or a measurer is never reviewed.
  if (declaresReviewRole(rows[0].text)) return null
  const lastMessage = ctx.handback !== null ? ctx.handback : ctx.eventMessage !== null ? ctx.eventMessage : handbackMessage(rows)
  if (isReportText(lastMessage)) return null // guard (c) again, for a report handed back with SubagentHandback
  return { rows, lastMessage, seen: turnFingerprint(rows, lastMessage) }
}

// What makes a turn "new" for the gate: its tool uses (SubagentHandback calls aside, a refused one included) and its final
// message. A stop re-fired by another hook, or the SubagentStop after a handback this gate already reviewed, has the same
// fingerprint and is not reviewed twice. Cheap on purpose: it is compared before the scanner runs.
function turnFingerprint(rows, lastMessage) {
  let tools = 0
  for (const r of rows) if (r.role === "assistant") for (const u of r.toolUses || []) if (u && u.tool !== "SubagentHandback") tools++
  return JSON.stringify([tools, lastMessage])
}

const nonEmptyText = (s) => (typeof s === "string" && s.trim() !== "" ? s : null)

// One subagent turn through the gate, at its SubagentStop or at its SubagentHandback call: read it, let through what needs
// no review, wait for a review slot, review. Returns the block (or deny) text, or null to let the agent go on. Every stop
// it does not review, short of guard (c) and "nothing new", is noted for the user and for the parent (skipSubagent).
async function gateSubagentTurn($, ctx, sink, st, tag) {
  let turn
  try { turn = await readSubagentTurn($, ctx) } catch (err) { turn = { why: errText(err) } }
  if (turn === null) return null
  if (turn.why) { await skipSubagent($, sink, tag, turn.why); return null }
  // `seen` is null until this agent's turn was reviewed once: an agent with no work and no final message is still reviewed.
  if (st.seen !== null && turn.seen === st.seen) return null
  if (st.rounds >= MAX_ROUNDS) {
    // Guard (d), per-agent half: at most MAX_ROUNDS reviews of one agent's turn. Noted once per new state of the turn.
    st.seen = turn.seen
    if (!st.quiet) await skipSubagent($, sink, tag, `cap of ${MAX_ROUNDS} review rounds reached for this agent's turn`)
    return null
  }
  // Guard (d), slots: at most MAX_CONCURRENT_SUBAGENT_REVIEWS reviews in flight; the others wait in arrival order. A wait
  // past SLOT_WAIT_MS hands this turn to the parent instead (never a silent drop), and ends this turn's reviews.
  if (!(await acquireSlot($, SLOT_WAIT_MS))) {
    st.rounds = MAX_ROUNDS
    st.quiet = true
    await skipSubagent($, sink, tag, `no review slot freed within ${SLOT_WAIT_MS / 60000} min (${MAX_CONCURRENT_SUBAGENT_REVIEWS} subagent reviews run at a time), so its review is queued to you: review its handback yourself`)
    return null
  }
  try { return await reviewSubagent($, ctx, turn, sink, st, tag) } finally { releaseSlot() }
}

// One subagent turn's review: scan its messages, measure (proposal only), review. Returns the block or deny text, or null.
// Every report also goes to the parent's next prompt.submit (storeForModel, never as a BLOCK record: a stored BLOCK is
// read by the next MAIN Stop as an interrupted main turn's). The usage table goes to the display only.
async function reviewSubagent($, ctx, turn, sink, st, tag) {
  const calls = []
  const notReviewed = async (why) => { await skipSubagent($, sink, tag, why); return null }
  const { rows, lastMessage } = turn
  const atHandback = ctx.handback !== null
  try {
    const at = displayPath(ctx.cwd, ctx.sessionId, ctx.agentId)
    if (!at) return await notReviewed(`no scan path (cwd ${JSON.stringify(ctx.cwd)}, session_id ${JSON.stringify(ctx.sessionId)})`)
    // $.fs has no remove: the copy is emptied once read, and show.py deletes it (this stop's) or sweeps it (after 120 s).
    const scanFile = `${at.dir}/${at.base}.scan.jsonl`
    await ensureDisplayDir($, at.dir)
    await $.fs.write(scanFile, syntheticTranscript(rows))
    let scan
    try { scan = await scanTurn($, { transcriptPath: scanFile, cwd: ctx.cwd }, false) } finally {
      try { await $.fs.write(scanFile, "") } catch { /* show.py deletes it */ }
    }
    if (!scan.ok) return await notReviewed(scan.why)
    // The measurement runs only when the agent's LAST message carries the proposal line (owner spec 0.6.0).
    const proposal = lastMessage !== null && PROPOSAL_LINE.test(lastMessage)
    if (proposal) scan.proposal = true
    st.rounds++
    $.ui.status(proposal ? `review: measuring and reviewing ${tag}…` : `review: reviewing ${tag}…`)
    const subject = { label: tag, rows: boundedRows(rows) }
    const git = await gitContext($, ctx.cwd)
    const measured = proposal ? await runMeasure($, { cwd: ctx.cwd }, lastMessage, subject) : null
    if (measured) calls.push(...measured.calls)
    const res = await runReview($, { interrupted: false, lastMessage, scan, measure: measured ? measured.text : null, pending: null, debt: null, git, round: st.rounds, subject }, "review (subagent)")
    calls.push(...res.calls)
    if (!res.ok) return await notReviewed(`the review failed (${res.why})`)
    st.seen = turn.seen
    const findings = res.block || hasFindings(res.text)
    // At a SubagentStop, an agent that ended with a SubagentHandback call has no final text (the event's message is ""),
    // and the engine DISCARDS a SubagentStop block after a turn that ended on a tool result: measured live 2026-11-14 on
    // 2.1.325, debug log "[end-turn] Stop hook block discarded (turn ended by tool result, no model re-invoke)", no "Stop
    // hook feedback" in the agent's transcript. Such a stop is not blocked; its findings go to the parent. The handback
    // gate (tool.call) reviews that agent BEFORE the call instead, where a refusal does reach it.
    const handedBack = !atHandback && ctx.eventMessage === null && lastMessage !== null
    const outcome = !findings ? "it passed with no findings"
      : atHandback ? "its SubagentHandback was refused once with these findings; it can fix each one or state why it rejects it, then hand back again"
      : handedBack ? "it ended with SubagentHandback, which ends its run, so it was not blocked: these findings are for its parent"
      : "the subagent was blocked once with these findings"
    const report = `${measured ? measured.text + "\n\n" : ""}[AGENTLENSPRO-REVIEW-REPORT] (run by the harness, ${tag}: ${outcome})\n${res.text}`
    sink.add(plainReport(report))
    logLines($, plainReport(report).join("\n"), { to: "debug" })
    await storeForModel($, report, false)
    if (!findings) { $.ui.status(`review: ${tag} PASS`); return null }
    if (handedBack) { $.ui.status(`review: ${tag} has findings; it handed back, so they go to the parent`); return null }
    if (atHandback) {
      $.ui.status(`review: ${tag} handback refused once (round ${st.rounds}/${MAX_ROUNDS})`)
      return `[agentlenspro-review-mod] The review of your turn has findings${res.block ? ", BLOCKERS among them" : ""}; fix each or state in your report why you reject it, then call SubagentHandback again (that call is accepted). Do not spawn a review fork.\n\n${report}`
    }
    st.blocked = true
    $.ui.status(`review: ${tag} blocked once (round ${st.rounds}/${MAX_ROUNDS})`)
    return `[agentlenspro-review-mod] The review of your turn has findings${res.block ? ", BLOCKERS among them" : ""}; fix each or state why you reject it, then finish. Do not spawn a review fork: the harness reviews again when you stop.\n\n${report}`
  } catch (err) {
    return await notReviewed(errText(err))
  } finally {
    if (calls.length > 0) await logUsage($, calls, sink)
  }
}

export const register = (on) => {
  on("classic.SessionStart", async ($, e, next) => {
    sessionUsage = emptySessionUsage()
    heldInterrupted.length = 0 // a held interrupted-turn box belongs to the session that produced it
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

  // Deliver to the model, with whatever prompt starts the next turn (0.5.2, owner 2026-11-14: "the adversarial review
  // instead must be injected in the context and visible by both the agent and the user! otherwise how the agent is
  // supposed to use the review to correct itself?"). ONE store (pendingAtom) and this ONE injection point carry every
  // report the model has not seen yet: a Stop review that PASSED and an interrupted-turn review (a BLOCK report reached
  // the model through the block string and is never stored). The record is TAKEN in one update (marked injected), so
  // it is delivered once, on the first prompt.submit only: typed, mod-submitted and hand-back prompts all fire this
  // event (probes M9/M11). A janitor prompt receives it too: the agent must see it, and a janitor turn's own Stop
  // stores nothing. The usage table is never stored or injected: it stays on the user's screen only.
  on("prompt.submit", async ($, e, next) => {
    try {
      let pending = null
      await update($, pendingAtom, (prev) => {
        pending = prev && !prev.injected && prev.text ? prev : null
        return pending ? { ...prev, injected: true } : prev
      })
      if (!pending) return next(e)
      return next({ ...e, context: [...((e && e.context) || []), `${REVIEW_HEAD}\n\n${pending.text}`] })
    } catch (err) {
      $.ui.status(`review: review not injected — ${errText(err)}`)
      return next(e)
    }
  })

  on("turn.complete", async ($, e, next) => {
    // The Stop review's mark is captured before the reset: an interrupted turn whose work that review already covered
    // (a BLOCK continuation cut with nothing new) is not reviewed again, so the same work never yields two reports.
    const mark = reviewedMark
    if (e && !e.agentId) { roundsThisTurn = 0; reviewedMark = { work: -1, proposal: -1, msg: null } }
    // The prompt is captured now: a new prompt may overwrite turnPrompt before the timer fires.
    if (e && e.isAborted && !e.agentId && !isJanitorPrompt(turnPrompt)) { const prompt = turnPrompt; $.clock.after(1500, () => reviewInterrupted($, prompt, mark)) }
    // A subagent's turn is over: its per-agent state goes, unless a block of ours is still waiting for its continuation
    // (whether turn.complete fires between a SubagentStop block and the continuation is not measured, so this cannot reset
    // the round cap mid-loop either way).
    if (e && e.agentId) { const st = agentState.get(e.agentId); if (st && !st.blocked) agentState.delete(e.agentId) }
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
    // Interrupted turns held since the last Stop (owner complaint 2026-11-15: their boxes printed as many $.ui.log rows
    // with the host prefix, no colour). Flushed here, ahead of this turn's own rows, on the next Stop of ANY kind
    // (a janitor turn writes the display too). show.py fit() protects only the LAST box, so with several held items
    // an earlier box can be cut by the output cap; accepted: the tail box is the current turn's.
    for (const item of heldInterrupted.splice(0).reverse()) {
      sink.lines.unshift(...[`interrupted turn ${item.at}`, ...(item.report === null ? [] : plainReport(item.report)), ...(item.table ? usageTable(item.table) : [])])
    }
    // Written on every main-thread Stop, empty when the sink is: a leftover from an earlier Stop is never shown.
    // When it cannot be written (no usable cwd in the payload, a refused write) the rows must not be lost: they fall
    // back to plain dim transcript rows. A Stop with nothing to show logs nothing then.
    try { await writeDisplay($, e.cwd, e.session_id, sink.lines) } catch (err) {
      if (sink.lines.length > 0) logLines($, [`[review-mod] display file not written (${errText(err)}); plain copy follows`, ...sink.lines.map((l) => l.replace(ANSI_SGR, ""))].join("\n"))
    }
    const r = await next(e)
    return mine ? { ...r, block: [r.block, mine].filter(Boolean).join("\n\n") } : r
  })

  // THE SUBAGENT GATE (0.6.0, owner 2026-11-14: "subagents must have their fork adversarial review and measure report too
  // at the end of each turn, so they too must print the systemMessage"). Reviews the subagent's own turn with
  // $.model.complete over that agent's messages and blocks it ONCE per report that has findings. Runs before next(e) for
  // the reason classic.Stop does: the plugin's SubagentStop command hook (hooks/show.py) runs inside next(e) (measured on
  // 2.1.325, probe-060 A2) and prints this agent's display file in the subagent's own view.
  // RECURSION (owner: "you don't want the subagent stop adversarial review to be triggered on the very adversarial review
  // subagent turn stop. that would become an infinite recursion of reviews. be careful."): reviews are completions (no
  // SubagentStop of their own), and four guards keep a review's fork out: (a) out of scope, (b) reentrancy for agents
  // $.agent.list() does not name, (c) report-shaped or roled agent, (d) the per-agent round cap and the review slots (at
  // most two in flight; a third waits its turn). (a), (b) and (c) each alone stop a main review's fork; (d) alone bounds it.
  on("classic.SubagentStop", async ($, e, next) => {
    // Guard (a), before anything is read or written: no agent id; agent_type "" (EVERY $.model.fork, the main review's own
    // forks included, plus internal agents such as prompt suggestions and /btw; measured, probe-060 A1/A4); a janitor agent.
    if (subagentOutOfScope(e)) return next(e)
    // Guard (c), message half: a reviewer's own report is never reviewed. The prompt half runs once the messages are read.
    if (isReportText(e.last_assistant_message)) return next(e)
    const st = agentStateOf(e.agent_id)
    // A stop of this agent means the continuation a block asked for has run (or this is its first stop): that block is spent.
    st.blocked = false
    const sink = displaySink()
    // A review run at this agent's SubagentHandback call left its coloured copy in st.display: it is shown in this stop's file.
    sink.add(st.display.splice(0))
    const tag = subagentTag(e)
    let mine = null
    if (reviewDepth > 0 && !(await listedAgent($, e.agent_id))) {
      // Guard (b): while any review or measurement is calling the model (the main thread's forks included), a stop of a loop $.agent.list() does not
      // name passes untouched. Real agents, siblings of a fan-out included, are listed and reviewed (they wait for a slot);
      // a $.model.fork, an engine fork and a workflow's agents are not listed (measured 2026-11-15, probe-061: a prompt
      // suggestion's SubagentStop, agent_type "", was absent from the list while the typed agent was present).
      await skipSubagent($, sink, tag, "it stopped while a review was calling the model and $.agent.list() does not name it (reentrancy guard)")
    } else {
      mine = await gateSubagentTurn($, { agentId: e.agent_id, cwd: e.cwd, sessionId: e.session_id, eventMessage: nonEmptyText(e.last_assistant_message), handback: null }, sink, st, tag)
    }
    // Written for every typed agent's stop, empty when the sink is, so a leftover is overwritten before show.py reads it.
    try { await writeDisplay($, e.cwd, e.session_id, sink.lines, e.agent_id) } catch (err) {
      if (sink.lines.length > 0) logLines($, [`[review-mod] display file not written (${errText(err)}); plain copy follows`, ...sink.lines.map((l) => l.replace(ANSI_SGR, ""))].join("\n"))
    }
    const r = await next(e)
    return mine ? { ...r, block: [r && r.block, mine].filter(Boolean).join("\n\n") } : r
  })

  // THE HANDBACK GATE (0.6.0 round 2). An agent that reports with SubagentHandback ends its run on a tool result, and the
  // engine discards a SubagentStop block after such a turn (measured live, run 1: "[end-turn] Stop hook block discarded
  // (turn ended by tool result, no model re-invoke)"). Its turn is reviewed HERE instead, before the handback runs: a
  // report with findings refuses the call ONCE ({ deny }: the agent reads it as the tool's error), so the agent can fix or
  // reject each finding and hand back again; the retried handback goes through unreviewed, and the SubagentStop that
  // follows reviews again only if the agent did something new (no new tool use, same message: nothing new). Measured
  // 2026-11-15 (probe-061, 2.1.325): tool.call fires for SubagentHandback with agentId and the input's `message`; a deny
  // reached the agent as a tool_use_error, the agent answered it ("...conflicts with your instruction..., so I'm ignoring
  // it") and called SubagentHandback again 3 s later; classic.PreToolUse carries no agentId, so it cannot be used here.
  on("tool.call", { tool: "SubagentHandback" }, async ($, e, next) => {
    // Guard (a): no agent id, or a loop $.agent.list() does not name (forks of the engine, a workflow's agents), or an
    // untyped or janitor agent.
    if (!e || typeof e.agentId !== "string" || e.agentId === "") return next(e)
    const info = await listedAgent($, e.agentId)
    if (!info || subagentOutOfScope({ agent_id: e.agentId, agent_type: info.type })) return next(e)
    // Guard (c), message half: a report handed back is a reviewer's or a measurer's.
    if (isReportText(e.message)) return next(e)
    const st = agentStateOf(e.agentId)
    // One refusal per agent turn: the retried handback goes through. Past the round cap it goes through too; the
    // SubagentStop that follows tells the parent.
    if (st.denied || st.rounds >= MAX_ROUNDS) return next(e)
    let cwd
    let sessionId
    try { cwd = await $.session.cwd(); sessionId = await $.session.id() } catch (err) {
      $.ui.status(`review: handback of ${e.agentId} not reviewed here (${errText(err)}); its SubagentStop reviews it`)
      return next(e)
    }
    const tag = subagentTag({ agent_type: info.type, agent_id: e.agentId })
    // This review's coloured copy waits in st.display for the agent's SubagentStop, whose file show.py prints.
    const sink = { lines: st.display, add: (rows) => { st.display.push(...rows) } }
    const denial = await gateSubagentTurn($, { agentId: e.agentId, cwd, sessionId, eventMessage: null, handback: typeof e.message === "string" ? e.message : "" }, sink, st, tag)
    if (!denial) return next(e)
    st.denied = true
    return { deny: denial }
  })
}
