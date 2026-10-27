/**
 * Trust-fence tests — the /usage/api fence must match the official /api
 * gateway semantics (dsh-client-connection isTrustedApiRequest): Host fence
 * (loopback, the listener's own bind address, or a trusted authority, with
 * port-aware entry matching), the sec-fetch-site cross-site refusal, and the
 * same-origin Origin check.
 */
import { describe, expect, it } from 'vitest'
import { createTrustFence, isLoopbackHostname, parseHostHeader, type TrustInputs } from '../src/trust-fence.ts'
import type { UsageHttpRequest } from '../src/context-types.ts'

function reqOf(headers: Record<string, string>): UsageHttpRequest {
  return { headers } as unknown as UsageHttpRequest
}

describe('isLoopbackHostname', () => {
  it('accepts localhost, bracketed IPv6 loopback, and the whole 127/8 range', () => {
    expect(isLoopbackHostname('localhost')).toBe(true)
    expect(isLoopbackHostname('[::1]')).toBe(true)
    expect(isLoopbackHostname('127.0.0.1')).toBe(true)
    expect(isLoopbackHostname('127.8.15.9')).toBe(true)
  })

  it('rejects non-loopback hosts', () => {
    expect(isLoopbackHostname('192.168.1.5')).toBe(false)
    expect(isLoopbackHostname('evil.example')).toBe(false)
    expect(isLoopbackHostname('127.1')).toBe(false) // not four dotted parts
  })
})

describe('parseHostHeader', () => {
  it('lowercases and returns the raw authority', () => {
    expect(parseHostHeader(reqOf({ host: 'LocalHost:3080' }))).toBe('localhost:3080')
    expect(parseHostHeader(reqOf({}))).toBeNull()
  })
})

describe('createTrustFence', () => {
  const fence = createTrustFence(() => ({ trustedHosts: ['192.168.1.5', 'myhost.example:3080'] }))

  it('accepts a loopback Host with port', () => {
    expect(fence.isTrusted(reqOf({ host: '127.0.0.1:3080' }))).toBe(true)
    expect(fence.isTrusted(reqOf({ host: 'localhost:3080' }))).toBe(true)
  })

  it('matches a port-less trusted entry on any port', () => {
    expect(fence.isTrusted(reqOf({ host: '192.168.1.5:3000' }))).toBe(true)
    expect(fence.isTrusted(reqOf({ host: '192.168.1.5' }))).toBe(true)
  })

  it('matches a port-bearing trusted entry only on that exact port', () => {
    expect(fence.isTrusted(reqOf({ host: 'myhost.example:3080' }))).toBe(true)
    // The old fence stripped the request port and never matched this shape.
    expect(fence.isTrusted(reqOf({ host: 'myhost.example:9999' }))).toBe(false)
  })

  it('refuses a missing or unparsable Host and unknown hosts', () => {
    expect(fence.isTrusted(reqOf({}))).toBe(false)
    expect(fence.isTrusted(reqOf({ host: ':::' }))).toBe(false)
    expect(fence.isTrusted(reqOf({ host: 'attacker.example' }))).toBe(false)
  })

  it('refuses an explicit cross-site fetch even from a loopback Host', () => {
    expect(fence.isTrusted(reqOf({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }))).toBe(false)
    // Same-site and absent markers stay fine.
    expect(fence.isTrusted(reqOf({ host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }))).toBe(true)
  })

  it('requires an attached Origin to be same-origin with the Host', () => {
    expect(fence.isTrusted(reqOf({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }))).toBe(true)
    expect(fence.isTrusted(reqOf({ host: '127.0.0.1:3080', origin: 'http://attacker.example' }))).toBe(false)
    // The opaque origin "null" (sandboxed iframe / file:) is refused.
    expect(fence.isTrusted(reqOf({ host: '127.0.0.1:3080', origin: 'null' }))).toBe(false)
  })
})

/**
 * The two inputs DSH 0.2.1-alpha.2 added to the official fence — the listener's
 * own bind address, and the protocol that decides default-port normalization —
 * plus the live read the panel route depends on. The bind address is admitted
 * because a browser dialing that literal sends it as Host and the literal is no
 * rebinding target; the Origin and cross-site checks still apply.
 */
describe('createTrustFence bind address and live inputs', () => {
  it('admits the listener bind address on any port', () => {
    const fence = createTrustFence(() => ({ trustedHosts: [], bindHost: '10.33.227.252' }))
    expect(fence.isTrusted(reqOf({ host: '10.33.227.252:3290' }))).toBe(true)
    expect(fence.isTrusted(reqOf({ host: '10.33.227.252' }))).toBe(true)
    // Any other address still needs trustedHosts.
    expect(fence.isTrusted(reqOf({ host: '10.33.227.253:3290' }))).toBe(false)
  })

  it('admits a zoned IPv6 bind literal and strips the zone', () => {
    const fence = createTrustFence(() => ({ trustedHosts: [], bindHost: 'fe80::1%12' }))
    expect(fence.isTrusted(reqOf({ host: '[fe80::1]:3290' }))).toBe(true)
    expect(fence.isTrusted(reqOf({ host: '[fe80::2]:3290' }))).toBe(false)
  })

  it('never admits an unspecified bind address', () => {
    // The pre-0.2.1-alpha.2 host line can still bind 0.0.0.0; "every interface"
    // is not the single authority a browser dials, and that line's own sampled
    // trustedHosts entries carry its reachability instead.
    for (const bindHost of ['0.0.0.0', '::', '::ffff:0.0.0.0']) {
      const fence = createTrustFence(() => ({ trustedHosts: [], bindHost }))
      expect(fence.isTrusted(reqOf({ host: '0.0.0.0:3080' })), bindHost).toBe(false)
      expect(fence.isTrusted(reqOf({ host: '[::]:3080' })), bindHost).toBe(false)
      expect(fence.isTrusted(reqOf({ host: 'attacker.example' })), bindHost).toBe(false)
    }
  })

  it('reads its inputs live, so a provider that publishes later takes effect', () => {
    let inputs: TrustInputs = { trustedHosts: [] }
    const fence = createTrustFence(() => inputs)
    expect(fence.isTrusted(reqOf({ host: 'app.example:3080' }))).toBe(false)
    inputs = { trustedHosts: ['app.example'], protocol: 'https:' }
    expect(fence.isTrusted(reqOf({ host: 'app.example:3080' }))).toBe(true)
  })

  it('normalizes Host under the Origin scheme for the same-origin check', () => {
    // An HTTPS listener behind the default port: https://127.0.0.1 omits :443,
    // and the Host literal is re-parsed under the Origin's scheme to match.
    const fence = createTrustFence(() => ({ trustedHosts: [], protocol: 'https:' }))
    expect(fence.isTrusted(reqOf({ host: '127.0.0.1:443', origin: 'https://127.0.0.1' }))).toBe(true)
    // The transport's own scheme decides the default port: :443 is explicit
    // under http, so an http Origin on that authority is a different one.
    expect(fence.isTrusted(reqOf({ host: '127.0.0.1:443', origin: 'http://127.0.0.1' }))).toBe(false)
  })
})
