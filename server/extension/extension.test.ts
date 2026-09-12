import { describe, expect, it } from 'vitest'
import { ExtensionPairing } from './pairing'
import { approvedSampleUrl, requirePublicAddresses } from './sample'
import { trainingFixtures } from '../scraper/fixtures'

describe('extension pairing', () => {
  const extensionId = 'a'.repeat(32)
  it('issues one-time, extension-bound approvals without returning the library token', () => {
    const pairing = new ExtensionPairing()
    const approval = pairing.create(extensionId, 'owner', 'private-library-token')
    expect(() => pairing.exchange('b'.repeat(32), approval.code)).toThrow('another extension')
    const connection = pairing.exchange(extensionId, approval.code)
    expect(JSON.stringify(connection)).not.toContain('private-library-token')
    expect(pairing.authorize(extensionId, connection.token).ownerId).toBe('owner')
    expect(() => pairing.exchange(extensionId, approval.code)).toThrow()
    expect(() => pairing.authorize('b'.repeat(32), connection.token)).toThrow('Reconnect')
    pairing.revoke(extensionId, connection.token)
    expect(() => pairing.authorize(extensionId, connection.token)).toThrow('Reconnect')
  })
  it('expires approvals and connections and revokes previous connections on re-pairing', () => {
    let now = 0
    const pairing = new ExtensionPairing(() => now)
    const old = pairing.create(extensionId, 'owner', 'token')
    now = 120_001
    expect(() => pairing.exchange(extensionId, old.code)).toThrow('expired')
    const first = pairing.exchange(extensionId, pairing.create(extensionId, 'owner', 'token').code)
    const second = pairing.exchange(extensionId, pairing.create(extensionId, 'owner', 'token').code)
    expect(() => pairing.authorize(extensionId, first.token)).toThrow()
    now += 30 * 60_000
    expect(() => pairing.authorize(extensionId, second.token)).toThrow()
  })
})

describe('chapter sampling destinations', () => {
  it('only permits real same-origin navigation from the approved page', () => {
    const page = trainingFixtures[0].page
    expect(approvedSampleUrl(page, 'https://books.example.test/river-ledger/1').pathname).toBe(
      '/river-ledger/1',
    )
    expect(() => approvedSampleUrl(page, 'https://untrusted.example/1')).toThrow(
      'from the captured page',
    )
    expect(() => approvedSampleUrl(page, 'http://127.0.0.1/')).toThrow()
  })
  it('rejects private, mapped, loopback and mixed DNS answers', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '192.168.1.1',
      '::1',
      'fc00::1',
      '::ffff:127.0.0.1',
    ])
      expect(() =>
        requirePublicAddresses([{ address, family: address.includes(':') ? 6 : 4 }]),
      ).toThrow('network destinations')
    expect(() =>
      requirePublicAddresses([
        { address: '1.1.1.1', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]),
    ).toThrow()
    expect(requirePublicAddresses([{ address: '1.1.1.1', family: 4 }]).address).toBe('1.1.1.1')
  })
})
