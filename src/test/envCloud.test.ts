import * as assert from 'assert'
import * as path from 'path'
import { cloudFromEnvAndFiles, type CloudProvider } from '../environment/cloud'

const HOME = '/home/tester'

function noExists(_p: string): boolean {
  return false
}

suite('cloudFromEnvAndFiles (TRDD-HUWJVQJA — cloud environment detector)', () => {
  test('AWS_ env vars are collected and AWS_PROFILE wins as the hint', () => {
    const env = { AWS_PROFILE: 'dev', AWS_REGION: 'us-east-1' }
    const exists = (p: string): boolean => p === path.join(HOME, '.aws', 'config')
    const { aws } = cloudFromEnvAndFiles(env, exists, HOME)
    assert.deepStrictEqual(aws.envVars.sort(), ['AWS_PROFILE', 'AWS_REGION'])
    assert.strictEqual(aws.configPresent, true)
    assert.strictEqual(aws.hint, 'dev')
  })

  test('other providers stay empty when only AWS signals are present', () => {
    const env = { AWS_PROFILE: 'dev', AWS_REGION: 'us-east-1' }
    const exists = (p: string): boolean => p === path.join(HOME, '.aws', 'config')
    const { azure, gcp } = cloudFromEnvAndFiles(env, exists, HOME)
    assert.deepStrictEqual(azure.envVars, [])
    assert.strictEqual(azure.configPresent, false)
    assert.strictEqual(azure.hint, null)
    assert.deepStrictEqual(gcp.envVars, [])
    assert.strictEqual(gcp.configPresent, false)
    assert.strictEqual(gcp.hint, null)
  })

  test('AWS config presence is true when only credentials (not config) exists', () => {
    const env = {}
    const exists = (p: string): boolean => p === path.join(HOME, '.aws', 'credentials')
    const { aws } = cloudFromEnvAndFiles(env, exists, HOME)
    assert.strictEqual(aws.configPresent, true)
    assert.strictEqual(aws.hint, null, 'no AWS_PROFILE/AWS_REGION set')
  })

  test('AZURE_SUBSCRIPTION_ID becomes the hint and ~/.azure marks configPresent', () => {
    const env = { AZURE_SUBSCRIPTION_ID: 'sub-123', AZURE_TENANT_ID: 'tenant-9' }
    const exists = (p: string): boolean => p === path.join(HOME, '.azure')
    const { azure } = cloudFromEnvAndFiles(env, exists, HOME)
    assert.deepStrictEqual(azure.envVars.sort(), ['AZURE_SUBSCRIPTION_ID', 'AZURE_TENANT_ID'])
    assert.strictEqual(azure.configPresent, true)
    assert.strictEqual(azure.hint, 'sub-123')
  })

  test('GOOGLE_CLOUD_PROJECT sets the gcp hint and is counted in envVars', () => {
    const env = { GOOGLE_CLOUD_PROJECT: 'my-proj' }
    const { gcp } = cloudFromEnvAndFiles(env, noExists, HOME)
    assert.deepStrictEqual(gcp.envVars, ['GOOGLE_CLOUD_PROJECT'])
    assert.strictEqual(gcp.hint, 'my-proj')
    assert.strictEqual(gcp.configPresent, false)
  })

  test('CLOUDSDK_CORE_PROJECT is used as the gcp hint fallback when GOOGLE_CLOUD_PROJECT is unset', () => {
    const env = { CLOUDSDK_CORE_PROJECT: 'fallback-proj', GCLOUD_KEY: 'x' }
    const exists = (p: string): boolean => p === path.join(HOME, '.config', 'gcloud')
    const { gcp } = cloudFromEnvAndFiles(env, exists, HOME)
    assert.deepStrictEqual(gcp.envVars.sort(), ['CLOUDSDK_CORE_PROJECT', 'GCLOUD_KEY'])
    assert.strictEqual(gcp.hint, 'fallback-proj')
    assert.strictEqual(gcp.configPresent, true)
  })

  test('GRPC_ prefixed vars are NOT counted as gcp signals', () => {
    const env = { GRPC_VERBOSITY: 'debug', GRPC_TRACE: 'all' }
    const { gcp } = cloudFromEnvAndFiles(env, noExists, HOME)
    assert.deepStrictEqual(gcp.envVars, [], 'GRPC_ is not a gcp prefix')
    assert.strictEqual(gcp.hint, null)
  })

  test('no env vars and no config files present yields empty results for every provider', () => {
    const { aws, azure, gcp }: { aws: CloudProvider; azure: CloudProvider; gcp: CloudProvider } =
      cloudFromEnvAndFiles({}, noExists, HOME)
    for (const p of [aws, azure, gcp]) {
      assert.deepStrictEqual(p.envVars, [])
      assert.strictEqual(p.configPresent, false)
      assert.strictEqual(p.hint, null)
    }
  })
})
