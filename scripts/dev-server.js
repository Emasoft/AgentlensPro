// Dev supervisor: run the standalone server and auto-restart it whenever esbuild
// rebuilds standalone/server.js. Pair with `node esbuild.js --watch` (see the
// `dev` script) so a source edit → rebuild → server restart happens with no
// manual step. Opens the browser once, after the first successful start.
//
// No new dependency (keeps the supply-chain policy happy) — plain child_process
// + fs.watch. We watch the standalone/ DIRECTORY, not the single file, because
// esbuild writes output atomically (write-temp-then-rename), which fs.watch on a
// bare file misses.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'standalone');
const BUILT = path.join(DIR, 'server.js');
const UI_PORT = process.env.UI_PORT || '3000';

let child = null;
let restarting = false;
let opened = false;
let debounce = null;

function openBrowser() {
  if (opened) return;
  opened = true;
  const url = `http://localhost:${UI_PORT}`;
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  // Give the server a moment to bind the UI port before we point a browser at it.
  setTimeout(() => { try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* no browser opener — ignore */ } }, 800);
}

function start() {
  child = spawn('node', [BUILT], { stdio: 'inherit', cwd: ROOT });
  openBrowser();
  child.on('exit', (code) => {
    // Only propagate an exit we didn't cause; a restart-triggered exit is expected.
    if (!restarting) process.exit(code == null ? 0 : code);
  });
}

function restart() {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    if (!child) return start();
    restarting = true;
    child.once('exit', () => { restarting = false; start(); });
    child.kill('SIGTERM');
    console.log('[dev-server] rebuild detected → restarting server');
  }, 200); // coalesce the burst of write events from one rebuild
}

function boot() {
  if (!fs.existsSync(BUILT)) { setTimeout(boot, 300); return; } // wait for first build
  start();
  fs.watch(DIR, { persistent: true }, (_evt, name) => { if (name === 'server.js') restart(); });
}

process.on('SIGINT', () => { if (child) child.kill('SIGTERM'); process.exit(0); });
process.on('SIGTERM', () => { if (child) child.kill('SIGTERM'); process.exit(0); });
boot();
