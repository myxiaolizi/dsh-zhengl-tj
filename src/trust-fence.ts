/**
 * Browser-trust fence for the /usage/api routes, mirroring the official /api
 * gateway fence (dsh-client-connection `isTrustedApiRequest`). A route accepts
 * a request only when ALL of these hold:
 *
 * 1. Host fence (DNS-rebinding defense): the Host header names the loopback
 *    interface, a trusted authority, or the listener's own bind address. A
 *    port-less trustedHosts entry matches its hostname on ANY port, an entry
 *    with an explicit port matches that exact host:port; both sides compare
 *    through WHATWG URL normalization, so case and a redundant default port
 *    never decide trust.
 * 2. Cross-site fence: a browser-labeled `sec-fetch-site: cross-site`
 *    request is refused regardless of Origin.
 * 3. Origin fence: when a browser attaches an Origin it must be exactly the
 *    Host authority; the literal "null" (sandboxed iframes, file: pages) is
 *    an opaque origin and refused. Absent Origin is fine — the Host fence
 *    already bound the request.
 *
 * The three trust inputs are read live per request, because the host line
 * decides where each of them lives (see TrustInputs): DSH 0.2.1-alpha.2 moved
 * the explicit authorities onto the `webStartup` provider, deleted the
 * `webRuntime` service whose list also carried the LAN literals sampled at bind
 * time, and began admitting the listener's own bind address independently of
 * that list. The face stays structural (no node:types) so it can live in the
 * shared declaration graph.
 */

import type { UsageHttpRequest } from './context-types.ts'

/**
 * Whether a WHATWG URL hostname names the loopback authority. The input is
 * expected in URL hostname form (IPv6 literals keep their brackets), matching
 * dsh-client-connection's loopback classification: localhost, [::1], or any
 * IPv4 address in 127/8.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/** The raw Host header value (lowercased), or null when absent. */
export function parseHostHeader(req: UsageHttpRequest): string | null {
  const header = req.headers.host
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return null
  return value.trim().toLowerCase()
}

/** Normalized URL of a bare authority (hostname lowercased, default port
 *  stripped, IPv6 bracketed), or undefined when unparsable. The scheme decides
 *  which default port is stripped, matching the official fence. */
function parseAuthority(authority: string, scheme: 'http:' | 'https:' = 'http:'): URL | undefined {
  try {
    // http: and https: are WHATWG "special schemes": parsing yields a non-empty hostname or throws.
    return new URL(`${scheme}//${authority}`)
  } catch {
    return undefined
  }
}

/**
 * Canonical form of a parsed trustedHosts entry: `hostname` when no port was
 * written, else `hostname:port`. The port is judged from URL parses under
 * both special schemes (their default ports differ, so `:80` and `:443`
 * still count as explicit), never from the raw string.
 */
function canonicalAuthority(entry: string, entryUrl: URL): string {
  // An authority that parsed under http cannot fail under https.
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/**
 * Whether the request authority matches a `trustedHosts` entry. An entry with
 * an explicit port matches that exact authority; a port-less entry matches
 * the hostname on any port (the shape the CLI derives for IP-literal LAN
 * serving, where the bound port may be OS-assigned).
 */
function isTrustedAuthority(
  hostUrl: URL, trustedHosts: readonly string[], protocol: 'http:' | 'https:',
): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry, protocol)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/** Bind spellings that name every interface. The current host line rejects them
 *  when its config loads and only ever hands over a concrete literal, but the
 *  pre-0.2.1-alpha.2 line can still carry `0.0.0.0`; "every interface" is not
 *  the single authority a browser dials, and that line's own trustedHosts list
 *  (the sampled LAN literals) covers its real reachability instead. */
const WILDCARD_BIND_ADDRESSES = new Set(['0.0.0.0', '::', '::ffff:0.0.0.0'])

/**
 * Whether the request authority names the listener's own bind address. A browser
 * dialing that literal sends it as Host, the literal is no rebinding target, and
 * accepting it grants nothing further: the Origin and cross-site checks still
 * apply, and it stays outside `trustedHosts`. Matching ignores the port, like a
 * port-less entry, and any `%zone` id (an interface selector, not address text).
 */
function isBindAddressAuthority(hostUrl: URL, bindHost: string | undefined): boolean {
  if (bindHost === undefined) return false
  const zoneAt = bindHost.indexOf('%')
  const address = (zoneAt === -1 ? bindHost : bindHost.slice(0, zoneAt)).toLowerCase()
  if (WILDCARD_BIND_ADDRESSES.has(address)) return false
  const bindUrl = parseAuthority(address.includes(':') ? `[${address}]` : address)
  return bindUrl !== undefined && bindUrl.hostname === hostUrl.hostname
}

/**
 * Compare Host under the Origin's HTTP(S) scheme so default ports normalize
 * consistently. The transport may remain HTTP behind an HTTPS proxy.
 * @param origin - verbatim Origin header value.
 * @param host - verbatim Host header value already accepted by the Host fence.
 * @returns true only when the Origin is this listener's own `http(s)` authority.
 */
function isSameAuthorityOrigin(origin: string, host: string): boolean {
  let originUrl: URL
  try {
    originUrl = new URL(origin)
  } catch {
    // The opaque "null" (sandboxed iframes, file: pages) throws here.
    return false
  }
  // Only http(s) can name this listener: every other scheme (file:, ftp:) fails
  // here rather than matching by hostname alone.
  const scheme = originUrl.protocol === 'https:' ? 'https:'
    : originUrl.protocol === 'http:' ? 'http:'
      : undefined
  if (scheme === undefined) return false
  const hostUrl = parseAuthority(host, scheme)
  return hostUrl !== undefined && originUrl.host === hostUrl.host
}

/**
 * The live trust inputs one fence evaluation reads. Every field is optional in
 * the sense that a host line may not publish it; the fence falls back to the
 * narrower behavior.
 */
export interface TrustInputs {
  /** Authorities this deployment serves, beyond loopback and its own bind
   *  address: `--trusted-host` on DSH >= 0.2.1-alpha.2, that list plus the LAN
   *  literals sampled at bind time before it. */
  trustedHosts: readonly string[]
  /** The listener's configured bind address, admitted on any port. A concrete
   *  IPv4 or IPv6 literal on every host line (`webServer.host`). */
  bindHost?: string
  /** The listener's protocol, for default-port normalization. Treated as plain
   *  HTTP when the host line does not publish it. */
  protocol?: 'http:' | 'https:'
}

export interface TrustFence {
  /** Accept the request when the Host is ours (loopback, trusted, or this
   *  listener's bind address) and any attached browser markers are same-origin. */
  isTrusted(req: UsageHttpRequest): boolean
}

export function createTrustFence(trust: () => TrustInputs): TrustFence {
  return {
    isTrusted(req: UsageHttpRequest): boolean {
      const { trustedHosts, bindHost, protocol = 'http:' } = trust()
      // 1. Host fence, applied to every request: over plain HTTP a browser
      // attaches neither Origin nor Fetch-Metadata to reads, so an unmarked
      // request may still be a rebound browser read and Host is the one
      // header rebinding cannot forge.
      const host = parseHostHeader(req)
      if (host === null) return false
      const hostUrl = parseAuthority(host, protocol)
      if (hostUrl === undefined) return false
      if (!isLoopbackHostname(hostUrl.hostname)
        && !isTrustedAuthority(hostUrl, trustedHosts, protocol)
        && !isBindAddressAuthority(hostUrl, bindHost)) return false
      // 2. Cross-site fence: modern browsers label the initiator relationship
      // on every fetch; an explicit cross-site marker is refused.
      const site = req.headers['sec-fetch-site']
      if ((Array.isArray(site) ? site[0] : site) === 'cross-site') return false
      // 3. Origin fence: an attached Origin must be exactly this authority.
      // The literal "null" fails the URL parse below and is refused.
      const origin = req.headers.origin
      const originValue = Array.isArray(origin) ? origin[0] : origin
      if (originValue === undefined) return true
      return isSameAuthorityOrigin(originValue, host)
    },
  }
}
