// LaunchAgent that re-creates the RAM-disk spool on boot/login (TRDD-K3WDPR7M Phase 3, item 6).
//
// The spool lives in volatile memory, so a reboot destroys it. Claude Code reads OTEL_LOG_RAW_API_BODIES
// (pointing at the spool) at LAUNCH, so after a reboot the very first session would write bodies to a
// path whose RAM disk no longer exists — landing them on the SSD unless something re-creates the spool
// first. This LaunchAgent runs `agentlenspro spool ensure` at login (RunAtLoad), which re-creates the
// spool iff capture is still on (else it is a no-op).
//
// It is PRODUCT-OWNED state (not a user config), so it is written directly with an atomic temp+rename —
// NOT through safeConfigEdit (that editor is for USER config files: settings.json, config.toml). It is
// installed/removed ONLY from the capture on/off path.
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'

export const SPOOL_PLIST_LABEL = 'com.agentlens.spool'

/** ~/Library/LaunchAgents/com.agentlens.spool.plist. `home` is overridable for tests. */
export function spoolPlistPath(home: string = os.homedir()): string {
  return path.join(home, 'Library', 'LaunchAgents', `${SPOOL_PLIST_LABEL}.plist`)
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/**
 * The plist content for a given ProgramArguments vector (typically [node, cli.js, 'spool', 'ensure']).
 * Deterministic given its input, so the content is unit-testable without touching launchd.
 */
export function spoolPlistContent(programArgs: string[]): string {
  const args = programArgs.map((a) => `      <string>${escapeXml(a)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SPOOL_PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`
}

/**
 * Install the LaunchAgent plist (atomic temp+rename). Idempotent — a re-install overwrites in place.
 * Writing it into ~/Library/LaunchAgents is sufficient for it to run at the next login; a manual
 * `launchctl load` (deliberately not run here, to keep this a pure, testable file op) activates it now.
 */
export function installSpoolLaunchAgent(programArgs: string[], home: string = os.homedir()): string {
  const target = spoolPlistPath(home)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, spoolPlistContent(programArgs), 'utf-8')
  fs.renameSync(tmp, target) // atomic replace
  return target
}

/** Remove the LaunchAgent plist. Idempotent — absent file is a no-op. Returns whether it existed. */
export function removeSpoolLaunchAgent(home: string = os.homedir()): boolean {
  const target = spoolPlistPath(home)
  if (!fs.existsSync(target)) return false
  fs.rmSync(target, { force: true })
  return true
}
