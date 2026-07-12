// src/environment/cloud.ts — cloud provider signals (TRDD-HUWJVQJA): env vars, local config
// files, and installed CLIs for AWS/Azure/GCP. NEVER probes a cloud metadata server / IMDS — an
// off-cloud IMDS request hangs for seconds with no route; env vars and local files are instant
// and always safe. `cloudFromEnvAndFiles` is pure (injected env/exists/home) so it is unit-testable
// without touching the real filesystem; `gather()` wires it to the real fs + adds CLI detection.

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { toolVersion } from './exec'
import type { EnvFacet } from './types'

export interface CloudProvider {
  envVars: string[]
  configPresent: boolean
  hint: string | null
}

interface CloudProviderWithCli extends CloudProvider {
  cli: string | null
}

interface CloudFacetValue {
  aws: CloudProviderWithCli
  azure: CloudProviderWithCli
  gcp: CloudProviderWithCli
}

/** Pure classifier: env-var/config/hint signals for each provider, from an injected env, an
 *  injected `exists` probe, and an injected home dir — no real fs/process access. */
export function cloudFromEnvAndFiles(
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
  home: string,
): { aws: CloudProvider; azure: CloudProvider; gcp: CloudProvider } {
  const names = Object.keys(env)

  const aws: CloudProvider = {
    envVars: names.filter((n) => n.startsWith('AWS_')),
    configPresent: exists(path.join(home, '.aws', 'config')) || exists(path.join(home, '.aws', 'credentials')),
    hint: env.AWS_PROFILE || env.AWS_REGION || null,
  }

  const azure: CloudProvider = {
    envVars: names.filter((n) => n.startsWith('AZURE_')),
    configPresent: exists(path.join(home, '.azure')),
    hint: env.AZURE_SUBSCRIPTION_ID || null,
  }

  const gcp: CloudProvider = {
    envVars: names.filter((n) => n.startsWith('GOOGLE_') || n.startsWith('CLOUDSDK_') || n.startsWith('GCLOUD_')),
    configPresent: exists(path.join(home, '.config', 'gcloud')),
    hint: env.GOOGLE_CLOUD_PROJECT || env.CLOUDSDK_CORE_PROJECT || null,
  }

  return { aws, azure, gcp }
}

async function gather(): Promise<CloudFacetValue> {
  const exists = (p: string): boolean => {
    try {
      return fs.existsSync(p)
    } catch {
      return false
    }
  }
  const base = cloudFromEnvAndFiles(process.env, exists, os.homedir())
  const [awsCli, azureCli, gcpCli] = await Promise.all([
    toolVersion('aws', ['--version']),
    toolVersion('az', ['version']),
    toolVersion('gcloud', ['--version']),
  ])
  return {
    aws: { ...base.aws, cli: awsCli },
    azure: { ...base.azure, cli: azureCli },
    gcp: { ...base.gcp, cli: gcpCli },
  }
}

function renderProvider(label: string, p: CloudProviderWithCli): string | null {
  const hasSignal = p.envVars.length > 0 || p.configPresent || p.cli !== null
  if (!hasSignal) return null
  const parts: string[] = []
  if (p.envVars.length > 0) parts.push(`${p.envVars.length} env var${p.envVars.length === 1 ? '' : 's'}`)
  if (p.configPresent) parts.push('config present')
  if (p.cli) parts.push(`cli ${p.cli}`)
  if (p.hint) parts.push(`hint ${p.hint}`)
  return `${label}:          ${parts.join(' · ')}`
}

function render(value: unknown): string {
  const v = value as CloudFacetValue
  const lines = [renderProvider('aws', v.aws), renderProvider('azure', v.azure), renderProvider('gcp', v.gcp)].filter(
    (l): l is string => l !== null,
  )
  return lines.length > 0 ? lines.join('\n') : 'none detected'
}

export const cloudFacet: EnvFacet = {
  name: 'cloud',
  aliases: ['aws', 'azure', 'gcp'],
  summary: 'Cloud provider signals: env vars, local config, installed CLI (AWS/Azure/GCP)',
  gather,
  render,
}
