import * as assert from 'assert'
import {
  vpnFromInterfaces,
  proxyFromEnv,
  parseResolvConf,
  parseListeningPortsLsof,
  parseDefaultGateway,
} from '../environment/network'

suite('environment/network (TRDD-HUWJVQJA — network facet pure helpers)', () => {
  test('vpnFromInterfaces classifies tailscale and utun, skips plain interfaces', () => {
    const out = vpnFromInterfaces(['en0', 'tailscale0', 'utun3'])
    assert.strictEqual(out.length, 2)
    assert.deepStrictEqual(out[0], { iface: 'tailscale0', kind: 'tailscale' })
    assert.deepStrictEqual(out[1], { iface: 'utun3', kind: 'utun (possible VPN/WireGuard)' })
  })

  test('vpnFromInterfaces classifies wireguard, tun, tap, ppp', () => {
    const out = vpnFromInterfaces(['wg0', 'tun0', 'tap0', 'ppp0', 'lo0'])
    assert.strictEqual(out.length, 4, 'lo0 is skipped')
    assert.deepStrictEqual(
      out.map((x) => x.kind),
      ['wireguard', 'tun', 'tap', 'ppp'],
    )
  })

  test('proxyFromEnv collects an uppercase proxy var', () => {
    const out = proxyFromEnv({ HTTPS_PROXY: 'http://p:8080' } as NodeJS.ProcessEnv)
    assert.deepStrictEqual(out, { HTTPS_PROXY: 'http://p:8080' })
  })

  test('proxyFromEnv falls back to the lowercase variant when uppercase is unset', () => {
    const out = proxyFromEnv({ http_proxy: 'http://lower:3128' } as NodeJS.ProcessEnv)
    assert.deepStrictEqual(out, { HTTP_PROXY: 'http://lower:3128' })
  })

  test('proxyFromEnv returns empty object when no proxy vars are set', () => {
    const out = proxyFromEnv({ PATH: '/usr/bin' } as NodeJS.ProcessEnv)
    assert.deepStrictEqual(out, {})
  })

  test('parseResolvConf extracts nameserver IPs and ignores comments/blank lines', () => {
    const text = '# generated\nnameserver 8.8.8.8\n\nnameserver 1.1.1.1\n'
    const out = parseResolvConf(text)
    assert.deepStrictEqual(out, ['8.8.8.8', '1.1.1.1'])
  })

  test('parseListeningPortsLsof extracts proc+port and skips the header line', () => {
    const text = [
      'COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
      'node    12345 user    23u  IPv4 0x123      0t0  TCP *:3000 (LISTEN)',
      'node    12345 user    24u  IPv6 0x124      0t0  TCP 127.0.0.1:4318 (LISTEN)',
    ].join('\n')
    const out = parseListeningPortsLsof(text)
    assert.deepStrictEqual(out, [
      { port: '3000', proc: 'node' },
      { port: '4318', proc: 'node' },
    ])
  })

  test('parseListeningPortsLsof dedupes identical port+proc pairs', () => {
    const text = [
      'COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
      'node    111 user    23u  IPv4 0x1      0t0  TCP *:3000 (LISTEN)',
      'node    222 user    24u  IPv4 0x2      0t0  TCP *:3000 (LISTEN)',
    ].join('\n')
    const out = parseListeningPortsLsof(text)
    assert.strictEqual(out.length, 1, 'same port+proc collapses to one entry')
  })

  test('parseDefaultGateway finds the default route gateway from netstat -rn', () => {
    const text = [
      'Routing tables',
      '',
      'Internet:',
      'Destination        Gateway            Flags        Netif Expire',
      'default             192.168.1.1       UGSc           en0',
      '127                 127.0.0.1         UCS             lo0',
    ].join('\n')
    assert.strictEqual(parseDefaultGateway(text), '192.168.1.1')
  })

  test('parseDefaultGateway finds the Linux 0.0.0.0 default route (netstat -rn numeric)', () => {
    const text = [
      'Kernel IP routing table',
      'Destination     Gateway         Genmask         Flags   MSS Window  irtt Iface',
      '0.0.0.0         192.168.1.254   0.0.0.0         UG        0 0          0 eth0',
      '192.168.1.0     0.0.0.0         255.255.255.0   U         0 0          0 eth0',
    ].join('\n')
    assert.strictEqual(parseDefaultGateway(text), '192.168.1.254')
  })

  test('parseDefaultGateway returns null when there is no default route', () => {
    const text = ['Destination   Gateway   Flags   Netif', '127   127.0.0.1   UCS   lo0'].join('\n')
    assert.strictEqual(parseDefaultGateway(text), null)
  })
})
