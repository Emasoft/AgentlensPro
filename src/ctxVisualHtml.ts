// src/ctxVisualHtml.ts — the self-contained visual report for `agentlenspro ctxvis --html FILE`.
//
// Emits ONE file that opens offline: no CDN, no fetch, no external font. The data is injected as
// JSON and the page renders itself, so the report survives being emailed, attached to an issue, or
// opened six months later when the server it came from is gone.
//
// WHY THERE IS NO "DIVERGENCE LINE" DRAWN ACROSS THE BAR. The obvious idea is to mark the break
// point on the turn-2 bar. It would be a lie: the bar is stacked by CATEGORY (CLAUDE.md, rules,
// MCP, ...), while the cache prefix is ordered tools -> system -> messages. A horizontal line at
// "the height where the prefix broke" would land in a band that has nothing to do with where the
// break was. So the break is stated in words, and the money is shown as a separate BILLING bar
// beside the content bar — same scale, directly comparable, and it is the number that actually got
// charged rather than a proxy for it.

export interface HtmlElement { label: string; tokens: number; full?: string }
export interface HtmlTurn { total: number; elements: HtmlElement[] }
export interface HtmlVerdict {
  kind: 'identical' | 'append' | 'break'
  headline: string
  detail: string
  predictedSurviving: number | null
  predictedRewritten: number | null
  actualCacheRead: number | null
  actualCacheWrite: number | null
  actualCostUsd: number | null
  agreement: string
  agreementNote: string
}
export interface HtmlAgent {
  agent: string
  isSubject: boolean
  fromBaseline: boolean
  note?: string
  turns: HtmlTurn[]
  verdict: HtmlVerdict | null
}
export interface HtmlReport { generatedAt: string; agents: HtmlAgent[]; warnings: string[] }

/** `</script>` inside injected JSON would close the tag early and break the page; escaping the
 *  slash is the standard fix and is invisible to JSON.parse. */
const safeJson = (v: unknown): string =>
  JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function renderCtxVisHtml(report: HtmlReport): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ctxvis — agent context and cache prefix</title>
<style>
  :root {
    --ground:#E9EDEF; --panel:#F5F7F8; --panel-2:#FFFFFF; --ink:#0F1B22; --ink-soft:#46585F;
    --ink-faint:#7B8A91; --rule:#C9D3D7;
    --ctx-1:#1F5F7A; --ctx-2:#4E90A8; --srf-1:#9C4A21; --srf-2:#C97B3E; --srf-3:#E0A94A;
    --neutral:#7B8A91; --other:#A8B4B9; --good:#1F7A4A; --bad:#B03A28;
    --display:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;
    --body:ui-sans-serif,-apple-system,"Helvetica Neue",Arial,sans-serif;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme: dark) { :root {
    --ground:#0F1B22; --panel:#16242C; --panel-2:#1C2E37; --ink:#E6EDF0; --ink-soft:#A8B8BF;
    --ink-faint:#78898F; --rule:#26383F;
    --ctx-1:#4E9EC2; --ctx-2:#7FBDD2; --srf-1:#C86B36; --srf-2:#E29A5A; --srf-3:#EFC777;
    --neutral:#6E8189; --other:#4A5C64; --good:#3FA36B; --bad:#E0705A; } }
  :root[data-theme="dark"] {
    --ground:#0F1B22; --panel:#16242C; --panel-2:#1C2E37; --ink:#E6EDF0; --ink-soft:#A8B8BF;
    --ink-faint:#78898F; --rule:#26383F;
    --ctx-1:#4E9EC2; --ctx-2:#7FBDD2; --srf-1:#C86B36; --srf-2:#E29A5A; --srf-3:#EFC777;
    --neutral:#6E8189; --other:#4A5C64; --good:#3FA36B; --bad:#E0705A; }
  :root[data-theme="light"] {
    --ground:#E9EDEF; --panel:#F5F7F8; --panel-2:#FFFFFF; --ink:#0F1B22; --ink-soft:#46585F;
    --ink-faint:#7B8A91; --rule:#C9D3D7;
    --ctx-1:#1F5F7A; --ctx-2:#4E90A8; --srf-1:#9C4A21; --srf-2:#C97B3E; --srf-3:#E0A94A;
    --neutral:#7B8A91; --other:#A8B4B9; --good:#1F7A4A; --bad:#B03A28; }

  body { background:var(--ground); color:var(--ink); font-family:var(--body); line-height:1.55;
         margin:0; padding:2.5rem 1.75rem 4rem; }
  .wrap { max-width:72rem; margin:0 auto; display:flex; flex-direction:column; gap:2.25rem; }
  .eyebrow { font-family:var(--mono); font-size:.72rem; letter-spacing:.14em; text-transform:uppercase;
             color:var(--ink-faint); margin:0 0 .5rem; }
  h1 { font-family:var(--display); font-weight:600; font-size:clamp(1.7rem,3.6vw,2.5rem);
       line-height:1.14; margin:0 0 .6rem; text-wrap:balance; letter-spacing:-.01em; }
  .standfirst { font-size:1rem; color:var(--ink-soft); max-width:60ch; margin:0; }
  .standfirst strong { color:var(--ink); font-weight:600; }
  h2 { font-family:var(--display); font-size:1.25rem; font-weight:600; margin:0 0 .25rem; }
  .sub { color:var(--ink-soft); font-size:.9rem; margin:0 0 1.1rem; max-width:64ch; }
  code, .mono { font-family:var(--mono); font-size:.85em; }

  .warn { background:var(--panel); border-left:3px solid var(--srf-1); padding:.8rem 1rem;
          border-radius:0 3px 3px 0; font-size:.86rem; color:var(--ink-soft); }
  .warn b { color:var(--ink); font-weight:650; }
  .warn ul { margin:.4rem 0 0; padding-left:1.1rem; } .warn li { margin:.2rem 0; }

  .chart { background:var(--panel); border:1px solid var(--rule); border-radius:3px;
           padding:1.3rem 1.4rem; width:max-content; min-width:100%; box-sizing:border-box; }
  .bar-controls { display:flex; gap:.6rem; align-items:baseline; flex-wrap:wrap;
                  padding-bottom:1rem; margin-bottom:1.2rem; border-bottom:1px solid var(--rule); }
  .bar-controls .hint { font-size:.84rem; color:var(--ink-soft); }
  .bar-controls .zoom { font-family:var(--mono); font-size:.78rem; font-weight:600; color:var(--ctx-1);
                        margin-left:auto; font-variant-numeric:tabular-nums; }
  button { font-family:var(--body); font-size:.8rem; padding:.3rem .7rem; border:1px solid var(--rule);
           background:var(--panel-2); color:var(--ink-soft); border-radius:2px; cursor:pointer; }
  button:hover { border-color:var(--ink-faint); color:var(--ink); }
  button:focus-visible { outline:2px solid var(--ctx-1); outline-offset:1px; }

  .grid { display:grid; column-gap:0; }
  .axis { grid-row:1; grid-column:1; position:relative; }
  .axis b { position:absolute; right:.45rem; transform:translateY(50%); font-family:var(--mono);
            font-size:.66rem; font-weight:400; color:var(--ink-faint);
            font-variant-numeric:tabular-nums; white-space:nowrap; }
  .lines { grid-row:1; grid-column:2/-1; position:relative; pointer-events:none; }
  .lines i { position:absolute; left:0; right:0; border-top:1px solid var(--rule); }
  .lines i.major { border-top-color:var(--ink-faint); opacity:.4; }
  .cell { grid-row:1; position:relative; display:flex; flex-direction:column;
          justify-content:flex-end; align-items:flex-start; }
  .total { font-family:var(--mono); font-size:.82rem; font-weight:600;
           font-variant-numeric:tabular-nums; margin-bottom:.3rem; }
  .bar { position:relative; display:flex; flex-direction:column-reverse; }
  .seg { width:100%; position:relative; cursor:pointer; }
  .seg:hover { filter:brightness(1.12); }
  .seg:focus-visible { outline:2px solid var(--ink); outline-offset:1px; z-index:3; }
  .seg .lab { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
              font-family:var(--mono); font-size:.64rem; color:#fff; pointer-events:none;
              white-space:nowrap; overflow:hidden; }
  .sub-seg { width:100%; position:relative; box-shadow:inset 0 1px 0 rgba(255,255,255,.42); }
  .sub-seg .lab { position:absolute; left:.3rem; right:.3rem; top:0; bottom:0; display:flex;
                  align-items:center; gap:.4rem; font-family:var(--mono); font-size:.62rem;
                  color:#fff; pointer-events:none; overflow:hidden; text-shadow:0 0 3px rgba(0,0,0,.5); }
  /* min-width:0 or a long path refuses to shrink and gets sliced at BOTH ends with no ellipsis. */
  .sub-seg .lab .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
  .sub-seg .lab .tk { margin-left:auto; flex:none; font-variant-numeric:tabular-nums; }
  .open-mark { outline:2px solid var(--ink); z-index:2; }
  .btnlayer { position:absolute; inset:0; pointer-events:none; }
  .leader { position:absolute; height:0; border-top:1px dotted var(--ink-faint); opacity:.5; }
  .fcopy { position:absolute; pointer-events:auto; width:1.2rem; height:1rem; display:flex;
           align-items:center; justify-content:center; cursor:pointer; border:1px solid var(--rule);
           background:var(--panel-2); color:var(--ink-soft); border-radius:2px;
           font-family:var(--mono); font-size:.62rem; line-height:1; padding:0;
           transform:translateY(-50%); }
  .fcopy.done { color:var(--good); border-color:var(--good); }
  .names { grid-row:2; padding-top:.7rem; }
  .names b { display:block; font-size:.84rem; font-weight:650; }
  .names span { font-family:var(--mono); font-size:.66rem; color:var(--ink-faint); }
  .names.subject b { color:var(--ctx-1); }
  .turnlab { font-family:var(--mono); font-size:.63rem; color:var(--ink-faint); margin-bottom:.15rem; }

  .legend { display:flex; flex-wrap:wrap; gap:.3rem 1.3rem; margin-top:1.4rem; padding-top:1rem;
            border-top:1px solid var(--rule); }
  .legend div { display:flex; align-items:center; gap:.4rem; font-size:.8rem; color:var(--ink-soft); }
  .sw { width:.75rem; height:.75rem; border-radius:2px; flex:none; }

  .verdicts { display:grid; grid-template-columns:repeat(auto-fit,minmax(19rem,1fr)); gap:1rem; }
  .v { background:var(--panel); border:1px solid var(--rule); border-radius:3px; padding:1rem 1.1rem; }
  .v.broken { border-left:3px solid var(--bad); }
  .v.intact { border-left:3px solid var(--good); }
  .v h3 { font-size:.95rem; margin:0 0 .1rem; font-weight:650; }
  .v .who { font-family:var(--mono); font-size:.68rem; color:var(--ink-faint); margin-bottom:.6rem; }
  .v .head { font-weight:650; font-size:.86rem; margin-bottom:.35rem; }
  .v.broken .head { color:var(--bad); } .v.intact .head { color:var(--good); }
  .v p { margin:0 0 .5rem; font-size:.82rem; color:var(--ink-soft); }
  .v dl { display:grid; grid-template-columns:auto 1fr; gap:.15rem .7rem; margin:.5rem 0 0;
          font-family:var(--mono); font-size:.76rem; font-variant-numeric:tabular-nums; }
  .v dt { color:var(--ink-faint); } .v dd { margin:0; }
  .v .agree { margin-top:.6rem; font-size:.78rem; color:var(--ink-soft); }
  .v .agree.ok { color:var(--good); }

  table { border-collapse:collapse; width:100%; font-size:.86rem; }
  th, td { padding:.45rem .5rem; border-bottom:1px solid var(--rule); text-align:right; }
  th:first-child, td:first-child { text-align:left; }
  thead th { font-family:var(--mono); font-size:.66rem; text-transform:uppercase; letter-spacing:.07em;
             color:var(--ink-faint); font-weight:500; border-bottom:2px solid var(--ink-faint); }
  tbody td { font-family:var(--mono); font-variant-numeric:tabular-nums; }
  tbody td:first-child { font-family:var(--body); font-weight:650; }
  tbody tr:last-child td { border-bottom:none; }

  footer { color:var(--ink-faint); font-size:.78rem; font-family:var(--mono);
           border-top:1px solid var(--rule); padding-top:1rem; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <p class="eyebrow">measured with count_tokens · ${esc(report.generatedAt)}</p>
    <h1>What each agent puts in context — and what its second turn costs</h1>
    <p class="standfirst">
      Turn 1 is what an agent costs to <em>start</em>. Turn 2 is what it costs to <strong>keep
      running</strong>, and that depends on whether the turn-1 prefix survived byte-exact. Every
      number here is <strong>measured</strong>, not estimated. The cache verdict is
      <strong>predicted from the request bytes and then checked against what was actually
      billed</strong> — where the two disagree, the report says so.
    </p>
  </header>

  <div id="warnings"></div>

  <section>
    <h2>Context, turn 1 vs turn 2</h2>
    <p class="sub">Each agent contributes two bars. Click any band to break it into its individual
      elements; one band per bar at a time. The narrow bar beside turn 2 is what was actually
      <em>billed</em> — reused versus re-written.</p>
    <div class="chart">
      <div class="bar-controls">
        <span class="hint">Click a band to open it.</span>
        <button type="button" id="reset">Reset</button>
        <button type="button" id="copyAll">⧉ copy every element name</button>
        <button type="button" id="saveSvg">⤓ save as SVG</button>
        <span class="zoom" id="zoomLabel"></span>
      </div>
      <div class="grid" id="chart"></div>
      <div class="legend" id="legend"></div>
    </div>
  </section>

  <section>
    <h2>The cache verdict</h2>
    <p class="sub">A cached segment ends at a <code>cache_control</code> breakpoint, so what survives
      a change is the last breakpoint <em>before</em> it — not the change's own position. A prefix
      that is byte-identical but sits before the first breakpoint is still re-written.</p>
    <div class="verdicts" id="verdicts"></div>
  </section>

  <section>
    <h2>Totals</h2>
    <table id="totals"></table>
  </section>

  <footer id="foot"></footer>
</div>

<script>
const DATA = ${safeJson(report)};

const fmt = n => (n == null ? '—' : n.toLocaleString('en-US'));
const BANDS = [
  { id:'claude', name:'CLAUDE.md',     color:'var(--ctx-1)',   short:'CLAUDE.md',
    test:e => e.label === 'file:CLAUDE.md' || e.label === 'file:CLAUDE.md:' },
  { id:'rules',  name:'rules/*.md',    color:'var(--ctx-2)',   short:'rules',
    test:e => e.label.startsWith('file:') },
  { id:'skill',  name:'skill listing', color:'var(--srf-3)',   short:'skills',
    test:e => e.label === 'skill-listing' || e.label === 'agent-listing' },
  { id:'mcp',    name:'MCP schemas',   color:'var(--srf-1)',   short:'MCP',
    test:e => e.label.startsWith('tool:mcp__') },
  { id:'native', name:'native tools',  color:'var(--srf-2)',   short:'tools',
    test:e => e.label.startsWith('tool:') },
  { id:'system', name:'system prompt', color:'var(--neutral)', short:'system',
    test:e => e.label.startsWith('system') },
  { id:'other',  name:'prompt + rest', color:'var(--other)',   short:'',  test:() => true },
];

// Assign every element to exactly ONE band, first match wins. A band's height is therefore always
// the sum of the very rows it opens into — the chart cannot drift from the data it came from.
function bandsOf(turn) {
  const left = turn.elements.slice();
  return BANDS.map(b => {
    const mine = [];
    for (let i = left.length - 1; i >= 0; i--) if (b.test(left[i])) { mine.unshift(left[i]); left.splice(i, 1); }
    mine.sort((x, y) => y.tokens - x.tokens);
    return { ...b, rows: mine, tokens: mine.reduce((s, e) => s + e.tokens, 0) };
  });
}

const COLUMNS = [];
DATA.agents.forEach(a => a.turns.forEach((t, i) => COLUMNS.push({
  agent: a, turnIndex: i, turn: t, bands: bandsOf(t),
  label: 'turn ' + (i + 1), isLastOfAgent: i === a.turns.length - 1,
})));

const MAXT = Math.max(1, ...COLUMNS.map(c => c.turn.total),
  ...DATA.agents.map(a => (a.verdict?.actualCacheRead || 0) + (a.verdict?.actualCacheWrite || 0)));
const BASE_H = 440, BAR_W = 150, BILL_W = 34;
const BTN_GAP = 12, BTN_STEP = 24, BTN_W = 19, BTN_MIN_DY = 19;
const open = new Map();            // column key -> band id; one open band per bar
const host = document.getElementById('chart');
const zoomLabel = document.getElementById('zoomLabel');

const nameOf = r => r.full || r.label.replace(/^file:|^tool:/, '');
const namesOf = rows => rows.map(nameOf).join('\\n');

function copyText(text, btn) {
  const done = () => {
    const was = btn.textContent;
    btn.textContent = '✓';
    btn.classList.add('done');
    setTimeout(() => { btn.textContent = was; btn.classList.remove('done'); }, 1300);
  };
  // An artifact/file:// page can have navigator.clipboard denied, so the button must never be dead.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => legacy(text, done));
  } else legacy(text, done);
}
function legacy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { /* nothing left to try */ }
  document.body.removeChild(ta);
}

const niceStep = (perPx, zoom) => {
  // Gridlines are a ruler, not a texture: at high zoom a small target produced ~90 lines that read
  // as grey haze and hid the bars. Zooming means each line is worth FEWER tokens, not more lines.
  const target = (zoom === 1 ? 45 : 110) / perPx;
  return [100,200,250,500,1000,2000,2500,5000,10000,25000,50000].find(s => s >= target) || 50000;
};

function render() {
  const zoom = open.size ? 12 : 1;
  const H = BASE_H * zoom, perPx = H / MAXT;
  host.innerHTML = '';

  // Lay out every column before building it: a band's copy button is packed into a tier to the
  // right of the bar, and the column must be wide enough for the deepest tier or a button lands on
  // top of the next bar.
  const layouts = COLUMNS.map((col, i) => {
    const key = col.agent.agent + '#' + col.turnIndex;
    const live = col.bands.filter(b => b.tokens > 0);
    const barH = col.turn.total * perPx;
    let acc = 0;
    const items = live.map(b => {
      const h = b.tokens * perPx, y = barH - (acc + h / 2);
      acc += h;
      return { band: b, h, y };
    });
    const tiers = [];
    items.slice().sort((p, q) => p.y - q.y).forEach(it => {
      let t = 0;
      while (tiers[t] && tiers[t].some(y => Math.abs(y - it.y) < BTN_MIN_DY)) t++;
      (tiers[t] = tiers[t] || []).push(it.y);
      it.tier = t;
    });
    const depth = Math.max(tiers.length, 1);
    const bill = col.isLastOfAgent && col.turnIndex > 0 && col.agent.verdict?.actualCacheRead != null;
    return { col, key, items, barH, bill,
      width: BAR_W + BTN_GAP + (depth - 1) * BTN_STEP + BTN_W + (bill ? BILL_W + 8 : 0) + 10,
      last: i === COLUMNS.length - 1 };
  });

  host.style.gridTemplateRows = H + 'px auto';
  host.style.gridTemplateColumns = '3.4rem ' + layouts.map(l => l.width + 'px').join(' ');

  const step = niceStep(perPx, zoom);
  const axis = document.createElement('div'); axis.className = 'axis';
  const lines = document.createElement('div'); lines.className = 'lines';
  for (let v = 0; v <= MAXT; v += step) {
    const y = v * perPx;
    axis.insertAdjacentHTML('beforeend',
      '<b style="bottom:' + y + 'px">' + (step >= 1000 ? (v / 1000) + 'k' : v) + '</b>');
    lines.insertAdjacentHTML('beforeend',
      '<i class="' + (v % (step * 5) === 0 ? 'major' : '') + '" style="bottom:' + y + 'px"></i>');
  }
  host.append(axis, lines);

  layouts.forEach((L, i) => {
    const cell = document.createElement('div');
    cell.className = 'cell';
    // Explicit column: the gridline layer spans 2/-1 on this row, so an auto-placed cell is pushed
    // into an IMPLICIT column past the grid, which silently divorces every bar from its label.
    cell.style.gridColumn = String(i + 2);

    const tl = document.createElement('div');
    tl.className = 'turnlab';
    tl.textContent = L.col.label;
    const tot = document.createElement('div');
    tot.className = 'total';
    tot.textContent = fmt(L.col.turn.total);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:flex-end; gap:8px;';

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.width = BAR_W + 'px';
    const openBand = open.get(L.key);

    L.items.forEach(it => {
      const b = it.band;
      if (openBand === b.id) {
        const holder = document.createElement('div');
        holder.className = 'seg open-mark';
        holder.style.cssText = 'height:' + it.h + 'px; display:flex; flex-direction:column-reverse;';
        holder.tabIndex = 0;
        holder.title = b.name + ' — click to collapse';
        b.rows.forEach(r => {
          const sh = r.tokens * perPx;
          const el = document.createElement('div');
          el.className = 'sub-seg';
          el.style.height = sh + 'px';
          el.style.background = b.color;
          // The full path lives in the tooltip: a thin band is unreadable, and the basename alone
          // is not something you can paste back into a conversation and act on.
          el.title = nameOf(r) + ' — ' + fmt(r.tokens) + ' tokens';
          if (sh >= 10) {
            el.innerHTML = '<span class="lab"><span class="nm">' +
              r.label.replace(/^file:|^tool:/, '').replace(/&/g, '&amp;').replace(/</g, '&lt;') +
              '</span><span class="tk">' + fmt(r.tokens) + '</span></span>';
          }
          holder.appendChild(el);
        });
        holder.onclick = () => { open.delete(L.key); render(); };
        holder.onkeydown = ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); holder.click(); } };
        bar.appendChild(holder);
      } else {
        const seg = document.createElement('div');
        seg.className = 'seg';
        seg.style.height = it.h + 'px';
        seg.style.background = b.color;
        seg.tabIndex = 0;
        seg.title = b.name + ' — ' + fmt(b.tokens) + ' tokens, ' + b.rows.length +
                    ' element' + (b.rows.length === 1 ? '' : 's') + ' — click to open';
        if (it.h >= 12 && b.short) {
          seg.innerHTML = '<span class="lab">' + b.short + '</span>';
        }
        // One open band per bar: opening a second collapses the first. That is what keeps the page
        // height bounded at 12x and makes you read one band ACROSS the bars, not a wall of one bar.
        seg.onclick = () => { open.set(L.key, b.id); render(); };
        seg.onkeydown = ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); seg.click(); } };
        bar.appendChild(seg);
      }
    });

    const layer = document.createElement('div');
    layer.className = 'btnlayer';
    L.items.forEach(it => {
      const x = BAR_W + BTN_GAP + it.tier * BTN_STEP;
      const lead = document.createElement('i');
      lead.className = 'leader';
      lead.style.cssText = 'left:' + BAR_W + 'px; width:' + (x - BAR_W) + 'px; top:' + it.y + 'px;';
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'fcopy'; btn.textContent = '⧉';
      const title = 'Copy the ' + it.band.rows.length + ' element names in ' + it.band.name +
                    ' (' + L.col.agent.agent + ', ' + L.col.label + ')';
      btn.title = title; btn.setAttribute('aria-label', title);
      btn.style.cssText = 'left:' + x + 'px; top:' + it.y + 'px;';
      btn.onclick = ev => { ev.stopPropagation(); copyText(namesOf(it.band.rows), btn); };
      layer.append(lead, btn);
    });
    bar.appendChild(layer);
    row.appendChild(bar);

    // The BILLING bar: what the API actually charged for this turn's input, same scale as the
    // content bar beside it. This is the money, not a proxy for it.
    if (L.bill) {
      const v = L.col.agent.verdict;
      const billBar = document.createElement('div');
      billBar.className = 'bar';
      billBar.style.width = BILL_W + 'px';
      const mk = (tok, color, what) => {
        if (!tok) return;
        const d = document.createElement('div');
        d.style.cssText = 'width:100%; height:' + (tok * perPx) + 'px; background:' + color + ';';
        d.title = what + ' — ' + fmt(tok) + ' tokens';
        billBar.appendChild(d);
      };
      mk(v.actualCacheRead, 'var(--good)', 'reused from cache (0.1x)');
      mk(v.actualCacheWrite, 'var(--bad)', 're-written (cache write)');
      const wrap = document.createElement('div');
      // The caption is absolutely positioned ABOVE the bar rather than stacked in the flex row:
      // in-flow it added ~16px to this column's height, which floated the whole turn-2 header
      // 18px above turn-1's and made the two columns' labels visibly fail to line up.
      wrap.style.cssText = 'position:relative; display:flex; flex-direction:column; align-items:center;';
      const cap = document.createElement('div');
      cap.className = 'turnlab';
      cap.style.cssText = 'position:absolute; bottom:100%; left:0; right:0; text-align:center;';
      cap.textContent = 'billed';
      wrap.append(cap, billBar);
      row.appendChild(wrap);
    }

    cell.append(tl, tot, row);
    host.appendChild(cell);
  });

  // Agent names sit under the FIRST turn column of each agent and span its turns.
  let col = 2;
  DATA.agents.forEach(a => {
    const n = document.createElement('div');
    n.className = 'names' + (a.isSubject ? ' subject' : '');
    n.style.gridColumn = col + ' / span ' + a.turns.length;
    n.style.gridRow = '2';
    const tag = a.isSubject ? ' — subject' : a.fromBaseline ? ' — cached baseline' : '';
    n.innerHTML = '<b>' + a.agent.replace(/&/g, '&amp;').replace(/</g, '&lt;') + tag + '</b>' +
      '<span>' + (a.verdict ? a.verdict.headline : (a.note || '')).replace(/</g, '&lt;') + '</span>';
    host.appendChild(n);
    col += a.turns.length;
  });

  zoomLabel.textContent = (open.size ? 'axis ×12' : 'axis ×1') +
    '  ·  1 gridline = ' + fmt(step) + ' tokens';
}

function renderLegend() {
  // Only the bands that actually OCCUR. Listing CLAUDE.md and rules/*.md for an agent that carries
  // neither implies it has them — in a report whose whole finding can be "this agent skips project
  // context entirely", that is the one thing the legend must not suggest.
  const present = new Set();
  COLUMNS.forEach(c => c.bands.forEach(b => { if (b.tokens > 0) present.add(b.id); }));
  const bills = DATA.agents.some(a => a.verdict && a.verdict.actualCacheRead != null);
  const el = document.getElementById('legend');
  el.innerHTML = BANDS.filter(b => present.has(b.id))
    .map(b => '<div><span class="sw" style="background:' + b.color + '"></span>' + b.name + '</div>').join('') +
    (bills
      ? '<div><span class="sw" style="background:var(--good)"></span>billed: reused from cache</div>' +
        '<div><span class="sw" style="background:var(--bad)"></span>billed: re-written</div>'
      : '');
}

function renderWarnings() {
  const el = document.getElementById('warnings');
  if (!DATA.warnings.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="warn"><b>Caveats from this run</b><ul>' +
    DATA.warnings.map(w => '<li>' + w.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</li>').join('') +
    '</ul></div>';
}

function renderVerdicts() {
  const el = document.getElementById('verdicts');
  el.innerHTML = DATA.agents.map(a => {
    const v = a.verdict;
    if (!v) {
      return '<div class="v"><h3>' + a.agent + '</h3><div class="who">no second turn</div>' +
        '<p>' + (a.note || 'no verdict available').replace(/</g, '&lt;') + '</p></div>';
    }
    const cls = v.kind === 'break' ? 'broken' : 'intact';
    const rows = [
      ['predicted reused', fmt(v.predictedSurviving)],
      ['predicted rewritten', fmt(v.predictedRewritten)],
      ['billed cache_read', fmt(v.actualCacheRead)],
      ['billed write', fmt(v.actualCacheWrite)],
      ['input cost', v.actualCostUsd == null ? '—' : '$' + v.actualCostUsd.toFixed(4)],
    ];
    const ok = v.agreement === 'agree' || v.agreement === 'shortfall-within-tolerance';
    return '<div class="v ' + cls + '"><h3>' + a.agent + '</h3>' +
      '<div class="who">' + (a.isSubject ? 'subject' : a.fromBaseline ? 'cached baseline' : 'measured') + '</div>' +
      '<div class="head">' + v.headline.replace(/</g, '&lt;') + '</div>' +
      '<p>' + v.detail.replace(/</g, '&lt;') + '</p>' +
      '<dl>' + rows.map(r => '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>').join('') + '</dl>' +
      '<div class="agree' + (ok ? ' ok' : '') + '">' + (ok ? '✓ ' : '? ') +
      v.agreementNote.replace(/</g, '&lt;') + '</div></div>';
  }).join('');
}

function renderTotals() {
  const t = document.getElementById('totals');
  t.innerHTML = '<thead><tr><th>agent</th><th>turn 1</th><th>turn 2</th><th>Δ</th>' +
    '<th>reused</th><th>re-written</th><th>prefix</th></tr></thead><tbody>' +
    DATA.agents.map(a => {
      const t1 = a.turns[0]?.total ?? null, t2 = a.turns[1]?.total ?? null;
      const v = a.verdict;
      return '<tr><td>' + a.agent + '</td><td>' + fmt(t1) + '</td><td>' + fmt(t2) + '</td>' +
        '<td>' + (t1 != null && t2 != null ? (t2 - t1 >= 0 ? '+' : '') + fmt(t2 - t1) : '—') + '</td>' +
        '<td>' + fmt(v?.actualCacheRead ?? null) + '</td>' +
        '<td>' + fmt(v?.actualCacheWrite ?? null) + '</td>' +
        '<td>' + (v ? (v.kind === 'break' ? 'BROKEN' : 'intact') : '—') + '</td></tr>';
    }).join('') + '</tbody>';
}

// SVG export. This wraps the rendered DOM in <foreignObject> with the page CSS inlined — it is an
// HTML-in-SVG document, not vector primitives, so it renders in browsers but will not open in a
// vector editor. Said plainly rather than implied.
function saveSvg() {
  const node = document.querySelector('.chart');
  const w = Math.ceil(node.scrollWidth), h = Math.ceil(node.scrollHeight);
  const css = Array.from(document.querySelectorAll('style')).map(s => s.textContent).join('\\n');
  const clone = node.cloneNode(true);
  clone.querySelectorAll('.bar-controls').forEach(n => n.remove());
  const ground = getComputedStyle(document.documentElement).getPropertyValue('--ground').trim() || '#fff';
  const xml = new XMLSerializer().serializeToString(clone);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
    '<rect width="100%" height="100%" fill="' + ground + '"/>' +
    '<foreignObject x="0" y="0" width="' + w + '" height="' + h + '">' +
    '<style type="text/css"><![CDATA[' + css + ']]></style>' + xml +
    '</foreignObject></svg>';
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'ctxvis-chart.svg';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

document.getElementById('reset').onclick = () => { open.clear(); render(); };
document.getElementById('saveSvg').onclick = saveSvg;
document.getElementById('copyAll').onclick = ev => copyText(
  COLUMNS.map(c => '# ' + c.agent.agent + ' — ' + c.label + ' — ' + fmt(c.turn.total) + ' tokens\\n' +
    c.bands.filter(b => b.tokens > 0)
      .map(b => '## ' + b.name + ' (' + fmt(b.tokens) + ')\\n' + namesOf(b.rows)).join('\\n\\n')
  ).join('\\n\\n'), ev.currentTarget);

document.getElementById('foot').textContent =
  'ctxvis · ' + DATA.agents.length + ' agent(s), ' + COLUMNS.length + ' captured turn(s) · ' +
  'every token measured with count_tokens; the cache verdict is predicted from the request bytes ' +
  'and cross-checked against the billed usage.';

renderWarnings(); renderLegend(); renderVerdicts(); renderTotals(); render();
</script>
</body>
</html>
`
}
