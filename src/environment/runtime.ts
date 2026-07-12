// src/environment/runtime.ts — the EXECUTION context (TRDD-HUWJVQJA): is this a CI runner, a
// container/dev-container/WSL/sandbox, and what Claude Code context (CLI vs VS Code integrated,
// session id, plugin-hook, project dir) is it running under. Container markers are ported from the
// ai-maestro-janitor's detect_sandboxing. The classifiers are PURE (env + pre-read fs markers
// injected) so they unit-test without a container; gather() does the actual fs/reads.

import * as fs from 'fs'
import type { EnvFacet } from './types'

const CI_PROVIDERS: ReadonlyArray<readonly [string, string]> = [
  ['GITHUB_ACTIONS', 'GitHub Actions'],
  ['GITLAB_CI', 'GitLab CI'],
  ['CIRCLECI', 'CircleCI'],
  ['TRAVIS', 'Travis CI'],
  ['BUILDKITE', 'Buildkite'],
  ['JENKINS_URL', 'Jenkins'],
  ['TEAMCITY_VERSION', 'TeamCity'],
  ['TF_BUILD', 'Azure Pipelines'],
  ['APPVEYOR', 'AppVeyor'],
  ['DRONE', 'Drone'],
  ['BITBUCKET_BUILD_NUMBER', 'Bitbucket Pipelines'],
  ['CODEBUILD_BUILD_ID', 'AWS CodeBuild'],
  ['SEMAPHORE', 'Semaphore'],
]

/** Detect a CI runner from env. Named provider wins; a bare truthy `CI` is a generic fallback. Pure. */
export function ciFromEnv(env: NodeJS.ProcessEnv): { isCi: boolean; provider: string | null } {
  for (const [key, name] of CI_PROVIDERS) {
    if ((env[key] ?? '').trim() && (env[key] ?? '').trim().toLowerCase() !== 'false') {
      return { isCi: true, provider: name }
    }
  }
  const ci = (env.CI ?? '').trim().toLowerCase()
  if (ci && ci !== 'false' && ci !== '0') return { isCi: true, provider: 'CI (generic)' }
  return { isCi: false, provider: null }
}

export interface FsMarkers {
  dockerenv: boolean
  containerenv: boolean
  wsl: boolean
}

const CONTAINER_ENV_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ['KUBERNETES_SERVICE_HOST', 'kubernetes'],
  ['CODESPACES', 'GitHub Codespaces'],
  ['REMOTE_CONTAINERS', 'VS Code dev container'],
  ['DEVCONTAINER', 'dev container'],
  ['GITPOD_WORKSPACE_ID', 'Gitpod'],
  ['container', 'container (systemd $container)'],
  ['APP_SANDBOX_CONTAINER_ID', 'macOS app sandbox'],
]

/** Every container / dev-box / sandbox signal observable from env + pre-read fs markers. Empty = bare
 *  host. Ported from the janitor's detect_sandboxing. Pure (markers injected). */
export function containerSignals(env: NodeJS.ProcessEnv, markers: FsMarkers): string[] {
  const out: string[] = []
  if (markers.dockerenv) out.push('docker (/.dockerenv)')
  if (markers.containerenv) out.push('podman (/run/.containerenv)')
  if (markers.wsl) out.push('WSL')
  for (const [key, label] of CONTAINER_ENV_MARKERS) {
    if ((env[key] ?? '').trim()) out.push(`${label} ($${key})`)
  }
  return out
}

export interface ClaudeContext {
  inClaudeCode: boolean
  sessionId: string | null
  entrypoint: string | null
  vscodeIntegrated: boolean
  inPluginHook: boolean
  projectDir: string | null
}

/** What Claude Code context is this (if any) — from the CLAUDE* env the harness sets. Pure. */
export function claudeContextFromEnv(env: NodeJS.ProcessEnv): ClaudeContext {
  const entrypoint = (env.CLAUDE_CODE_ENTRYPOINT ?? '').trim() || null
  const inClaudeCode = ['1', 'true', 'yes'].includes((env.CLAUDECODE ?? '').trim().toLowerCase()) || entrypoint !== null
  return {
    inClaudeCode,
    sessionId: (env.CLAUDE_CODE_SESSION_ID ?? '').trim() || null,
    entrypoint,
    vscodeIntegrated: inClaudeCode && (env.TERM_PROGRAM ?? '').trim() === 'vscode',
    inPluginHook: (env.CLAUDE_PLUGIN_ROOT ?? '').trim() !== '',
    projectDir: (env.CLAUDE_PROJECT_DIR ?? '').trim() || null,
  }
}

function readFsMarkers(): FsMarkers {
  const exists = (p: string): boolean => {
    try { return fs.existsSync(p) } catch { return false }
  }
  let wsl = false
  try {
    const ver = fs.readFileSync('/proc/version', 'utf-8').toLowerCase()
    wsl = ver.includes('microsoft') || ver.includes('wsl')
  } catch {
    wsl = false
  }
  return { dockerenv: exists('/.dockerenv'), containerenv: exists('/run/.containerenv'), wsl }
}

interface RuntimeFacet {
  ci: { isCi: boolean; provider: string | null }
  container: string[]
  claude: ClaudeContext
}

async function gather(): Promise<RuntimeFacet> {
  const env = process.env
  return {
    ci: ciFromEnv(env),
    container: containerSignals(env, readFsMarkers()),
    claude: claudeContextFromEnv(env),
  }
}

function render(value: unknown): string {
  const v = value as RuntimeFacet
  const c = v.claude
  const lines: string[] = []
  lines.push(`ci:            ${v.ci.isCi ? v.ci.provider : 'no'}`)
  lines.push(`container:     ${v.container.length ? v.container.join('; ') : 'none (bare host)'}`)
  if (c.inClaudeCode) {
    const bits = [c.entrypoint ? `entrypoint ${c.entrypoint}` : null, c.vscodeIntegrated ? 'VS Code integrated' : null, c.inPluginHook ? 'in plugin hook' : null, c.sessionId ? `session ${c.sessionId.slice(0, 8)}` : null].filter(Boolean)
    lines.push(`claude code:   yes${bits.length ? `   · ${bits.join(' · ')}` : ''}`)
  } else {
    lines.push('claude code:   not detected')
  }
  return lines.join('\n')
}

export const runtimeFacet: EnvFacet = {
  name: 'runtime',
  aliases: ['context', 'ci', 'container', 'claude-context'],
  summary: 'CI runner, container/dev-container/WSL/sandbox, Claude Code context',
  gather,
  render,
}
