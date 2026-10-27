/**
 * Provider alias preferences: host-side persistence + the two
 * /usage/api/prefs/provider/* routes.
 *
 * Three contracts are pinned here:
 *  - a provider alias is CONFIGURATION, like the model prefs: an unknown
 *    provider is still stored (the reader may alias a route before it is
 *    recorded, and it must stay visible afterwards), and a blank alias is the
 *    editor's "clear" gesture;
 *  - the editor's provider list is the UNION of the LLM directory (adapter +
 *    configurable) and the usage store, each row carrying a real token total
 *    and a `seen` flag;
 *  - a malformed write (missing provider, over-long alias) is refused with a
 *    4xx instead of poisoning the table, and the browser-trust fence keeps
 *    external hosts out.
 */
import { describe, expect, it } from 'vitest'
import { buildUsageRoute } from '../src/routes.ts'
import type { UsageDomain, UsageHttpRequest, UsageHttpResponse, UsageKvTable, UsageStorageDomain } from '../src/context-types.ts'
import type { ProviderPreference } from '../src/wire.ts'
import type { UsageDayRow, UsageHourRow } from '../src/store.ts'
import { UsageStore } from '../src/store.ts'
import { normalizeProviderAlias } from '../src/prefs.ts'

function mockRes(): UsageHttpResponse & { bodyText: string; jsonStatus?: number } {
  const res = {
    statusCode: undefined as number | undefined,
    jsonStatus: undefined as number | undefined,
    bodyText: '',
    writeHead(status: number) {
      res.jsonStatus = status
      return res
    },
    end(payload: string) {
      res.bodyText = payload
    },
  }
  return res as unknown as UsageHttpResponse & { bodyText: string; jsonStatus?: number }
}

function post(url: string, body?: unknown): UsageHttpRequest {
  const payload = body === undefined ? [] : [JSON.stringify(body)]
  return {
    url,
    method: 'POST',
    headers: { host: '127.0.0.1:8090' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  } as unknown as UsageHttpRequest
}

/** An in-memory store carrying exactly the faces `buildPrefsPayload` and the
 *  provider routes touch. `sz-llm` and `zz-unlisted` are recorded in usage;
 *  `a-catalog-only` exists only in the LLM directory. */
function memoryStore(initial: ProviderPreference[] = [], tokens: Map<string, number> = new Map([['sz-llm', 1500]])) {
  const rows = new Map<string, ProviderPreference>()
  for (const pref of initial) rows.set(pref.provider, pref)
  return {
    // model-pref faces (the shared payload builder still reads them)
    preferences: async () => [],
    savePreference: async () => {},
    deletePreference: async () => {},
    currency: async () => '$',
    setCurrency: async () => {},
    distinctModels: async () => ['sz-llm/deepseek-v4'],
    // provider faces
    distinctProviders: async () => ['sz-llm', 'zz-unlisted'],
    providerTokenTotals: async () => tokens,
    providerPreferences: async () => [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    saveProviderPreference: async (pref: ProviderPreference) => { rows.set(pref.provider, pref) },
    deleteProviderPreference: async (provider: string) => { rows.delete(provider) },
    rows,
  }
}

function depsFor(store: ReturnType<typeof memoryStore>) {
  return {
    store,
    collector: { running: false, status: { running: false, done: 0, total: 0 } },
    trust: () => ({ trustedHosts: [] }),
    isRebuilding: () => false,
    resetAndRescan: async () => {},
  } as unknown as Parameters<typeof buildUsageRoute>[1]
}

/** A ctx whose two provider directories disagree on the display name for
 *  `sz-llm` (the adapter's own name wins) and list one configurable-only
 *  provider besides. */
function ctxWithProviders(): never {
  return {
    get(name: string) {
      if (name !== 'llm') return undefined
      return {
        listProviders: () => [{ id: 'sz-llm', name: 'Shenzhen LLM' }],
        listConfigurableProviders: () => [
          { provider: 'sz-llm', displayName: 'Shenzhen LLM (settings)', settingsNs: 'sz', settingsPath: [] },
          { provider: 'a-catalog-only', displayName: 'Catalog Only', settingsNs: 'catalog', settingsPath: [] },
        ],
        listModels: async (provider: string) => (provider === 'sz-llm'
          ? [{ provider, id: 'deepseek-v4', name: 'DeepSeek V4' }]
          : []),
      }
    },
  } as never
}

describe('POST /usage/api/prefs/provider/save', () => {
  it('stores the alias and echoes it back in providerPrefs', async () => {
    const store = memoryStore()
    const route = buildUsageRoute(ctxWithProviders(), depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs/provider/save', { provider: 'sz-llm', alias: 'SZ' }), res)
    expect(res.jsonStatus).toBe(200)
    expect(store.rows.get('sz-llm')!.alias).toBe('SZ')
    expect(store.rows.get('sz-llm')!.updatedAt).toBeGreaterThan(0)
    const body = JSON.parse(res.bodyText) as { value: { providerPrefs: ProviderPreference[] } }
    expect(body.value.providerPrefs).toHaveLength(1)
    expect(body.value.providerPrefs[0]!.alias).toBe('SZ')
  })

  it('trims surrounding whitespace before storing', async () => {
    const store = memoryStore()
    const route = buildUsageRoute({ get: () => undefined } as never, depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs/provider/save', { provider: '  sz-llm  ', alias: '  SZ  ' }), res)
    expect(res.jsonStatus).toBe(200)
    expect(store.rows.get('sz-llm')!.alias).toBe('SZ')
  })

  it('clears the row when the alias is blank', async () => {
    const store = memoryStore([{ provider: 'sz-llm', alias: 'SZ', updatedAt: 1 }])
    const route = buildUsageRoute(ctxWithProviders(), depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs/provider/save', { provider: 'sz-llm', alias: '   ' }), res)
    expect(res.jsonStatus).toBe(200)
    expect(store.rows.has('sz-llm')).toBe(false)
    const body = JSON.parse(res.bodyText) as { value: { providerPrefs: ProviderPreference[] } }
    expect(body.value.providerPrefs).toHaveLength(0)
  })

  it('refuses an over-long alias instead of storing it', async () => {
    const store = memoryStore()
    const route = buildUsageRoute({ get: () => undefined } as never, depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs/provider/save', { provider: 'sz-llm', alias: 'x'.repeat(25) }), res)
    expect(res.jsonStatus).toBe(400)
    expect(store.rows.size).toBe(0)
  })

  it('refuses a missing provider', async () => {
    const store = memoryStore()
    const route = buildUsageRoute({ get: () => undefined } as never, depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs/provider/save', { alias: 'SZ' }), res)
    expect(res.jsonStatus).toBe(400)
    expect(store.rows.size).toBe(0)
  })

  it('keeps an unknown provider alias and still lists it in the payload', async () => {
    // The reader may alias a provider that neither directory advertises and
    // the store has never recorded (a route they are about to use). Hiding it
    // would make the value they just wrote uneditable.
    const store = memoryStore()
    const route = buildUsageRoute(ctxWithProviders(), depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs/provider/save', { provider: 'ghost-provider', alias: 'GHOST' }), res)
    expect(res.jsonStatus).toBe(200)
    expect(store.rows.get('ghost-provider')!.alias).toBe('GHOST')
    const body = JSON.parse(res.bodyText) as {
      value: { providerPrefs: ProviderPreference[]; providerOptions: Array<{ provider: string; seen: boolean }> }
    }
    expect(body.value.providerPrefs.map((p) => p.provider)).toEqual(['ghost-provider'])
    const row = body.value.providerOptions.find((o) => o.provider === 'ghost-provider')!
    expect(row).toBeDefined()
    expect(row.seen).toBe(false)
  })

  it('keeps untrusted hosts out', async () => {
    const store = memoryStore()
    const route = buildUsageRoute({ get: () => undefined } as never, depsFor(store))
    const res = mockRes()
    const req = { url: '/usage/api/prefs/provider/save', method: 'POST', headers: { host: 'evil.example.com' } } as unknown as UsageHttpRequest
    await route.handler(req, res)
    expect(res.jsonStatus).toBe(403)
    expect(store.rows.size).toBe(0)
  })
})

describe('POST /usage/api/prefs/provider/reset', () => {
  it('drops one row and leaves the others', async () => {
    const store = memoryStore([
      { provider: 'sz-llm', alias: 'SZ', updatedAt: 2 },
      { provider: 'zz-unlisted', alias: 'ZZ', updatedAt: 1 },
    ])
    const route = buildUsageRoute({ get: () => undefined } as never, depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs/provider/reset', { provider: 'sz-llm' }), res)
    expect(res.jsonStatus).toBe(200)
    expect(store.rows.has('sz-llm')).toBe(false)
    expect(store.rows.has('zz-unlisted')).toBe(true)
    const body = JSON.parse(res.bodyText) as { value: { providerPrefs: ProviderPreference[] } }
    expect(body.value.providerPrefs.map((p) => p.provider)).toEqual(['zz-unlisted'])
  })

  it('is idempotent for an unknown provider', async () => {
    const store = memoryStore()
    const route = buildUsageRoute({ get: () => undefined } as never, depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs/provider/reset', { provider: 'nope' }), res)
    expect(res.jsonStatus).toBe(200)
  })

  it('rejects an empty provider', async () => {
    const store = memoryStore()
    const route = buildUsageRoute({ get: () => undefined } as never, depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs/provider/reset', { provider: '  ' }), res)
    expect(res.jsonStatus).toBe(400)
  })
})

describe('POST /usage/api/prefs provider rows', () => {
  it('merges the LLM directory with the usage store', async () => {
    const store = memoryStore()
    const route = buildUsageRoute(ctxWithProviders(), depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs', {}), res)
    expect(res.jsonStatus).toBe(200)
    const body = JSON.parse(res.bodyText) as {
      value: { providerOptions: Array<{ provider: string; name: string; tokens: number; seen: boolean }> }
    }
    const byId = new Map(body.value.providerOptions.map((o) => [o.provider, o]))
    // recorded + advertised: catalogue name, real token total, seen
    expect(byId.get('sz-llm')).toEqual({ provider: 'sz-llm', name: 'Shenzhen LLM', tokens: 1500, seen: true })
    // recorded only: falls back to the provider id as the display name
    expect(byId.get('zz-unlisted')).toEqual({ provider: 'zz-unlisted', name: 'zz-unlisted', tokens: 0, seen: true })
    // advertised only (configurable, never used): display name, no traffic
    expect(byId.get('a-catalog-only')).toEqual({ provider: 'a-catalog-only', name: 'Catalog Only', tokens: 0, seen: false })
    // recorded rows sort first, then catalogue-only, alphabetically
    expect(body.value.providerOptions.map((o) => o.provider)).toEqual(['sz-llm', 'zz-unlisted', 'a-catalog-only'])
  })

  it('survives a throwing configurable directory', async () => {
    const store = memoryStore()
    const route = buildUsageRoute({
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          listProviders: () => [{ id: 'sz-llm', name: 'Shenzhen LLM' }],
          listConfigurableProviders: () => { throw new Error('settings service down') },
        }
      },
    } as never, depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs', {}), res)
    expect(res.jsonStatus).toBe(200)
    const body = JSON.parse(res.bodyText) as { value: { providerOptions: Array<{ provider: string }> } }
    expect(body.value.providerOptions.map((o) => o.provider)).toContain('sz-llm')
  })
})

describe('normalizeProviderAlias', () => {
  it('trims both fields and accepts a blank alias as "clear"', () => {
    expect(normalizeProviderAlias({ provider: ' sz-llm ', alias: '  ' })).toEqual({ provider: 'sz-llm', alias: '' })
  })

  it('rejects a missing provider', () => {
    expect(() => normalizeProviderAlias({ provider: '  ', alias: 'X' })).toThrow(/provider is required/)
  })

  it('rejects an alias longer than the cap', () => {
    expect(() => normalizeProviderAlias({ provider: 'sz-llm', alias: 'x'.repeat(25) })).toThrow(/at most 24 characters/)
  })
})

/** A KvTable stand-in mirroring the real contract (update requires an existing
 *  record), so the store's seed-and-retry path stays honest. */
function kv<V>(records: Map<string, V>, name: string): UsageKvTable<string, V> {
  return {
    get: (key) => records.get(key),
    entries: () => records.entries() as IterableIterator<[string, V]>,
    keys: () => records.keys() as IterableIterator<string>,
    get size() { return records.size },
    delete: async (key) => records.delete(key),
    put: async (key, value) => { records.set(key, value) },
    update: async (key, fn) => {
      const current = records.get(key)
      if (current === undefined) {
        throw new Error(`domain 'usage_history' table '${name}' has no record '${key}' to update`)
      }
      const next = fn(current)
      records.set(key, next)
      return next
    },
  }
}

/** The storage-domain stand-in: `days`/`hours` for usage, `providers` for the
 *  alias rows, and a non-empty cursor so no open-time rebuild drops the rows. */
function memoryDomain(): UsageStorageDomain {
  const dayTable = kv(new Map<string, UsageDayRow>(), 'days')
  const hourTable = kv(new Map<string, UsageHourRow>(), 'hours')
  const providerTable = kv(new Map<string, ProviderPreference>(), 'providers')
  const domain: UsageDomain = {
    table: (name: string) => (name === 'days'
      ? dayTable
      : name === 'hours'
        ? hourTable
        : providerTable) as unknown as UsageKvTable<string, unknown>,
    global: { get: () => ({ backfilledSessions: ['seed'] }), set: async () => {} },
  }
  return { open: async () => domain }
}

describe('UsageStore provider aliases', () => {
  it('persists, lists newest first, and deletes rows', async () => {
    const store = new UsageStore(memoryDomain())
    await store.saveProviderPreference({ provider: 'old', alias: 'O', updatedAt: 1 })
    await store.saveProviderPreference({ provider: 'new', alias: 'N', updatedAt: 2 })
    expect((await store.providerPreferences()).map((p) => p.provider)).toEqual(['new', 'old'])
    await store.deleteProviderPreference('old')
    expect((await store.providerPreferences()).map((p) => p.provider)).toEqual(['new'])
    // idempotent, like the model reset path
    await store.deleteProviderPreference('old')
    await store.deleteProviderPreference('never-there')
    expect((await store.providerPreferences()).map((p) => p.provider)).toEqual(['new'])
  })

  it('collects providers from recorded usage and skips the synthetic one', async () => {
    const store = new UsageStore(memoryDomain())
    await store.record({ day: '2026-08-01', model: 'sz-llm/deepseek-v4', inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 })
    await store.record({ day: '2026-08-01', model: 'zz-other/x', inputTokens: 7, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    // a turn marker lands on the synthetic `default` provider — never a row
    await store.record({ day: '2026-08-01', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turn: true })
    const providers = await store.distinctProviders()
    expect(providers).toContain('sz-llm')
    expect(providers).toContain('zz-other')
    expect(providers).not.toContain('default')
  })

  it('sums the four billed buckets per provider for the whole history', async () => {
    const store = new UsageStore(memoryDomain())
    await store.record({ day: '2026-08-01', model: 'sz-llm/deepseek-v4', inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 })
    await store.record({ day: '2026-08-02', model: 'sz-llm/deepseek-v4', inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    await store.record({ day: '2026-08-01', model: 'zz-other/x', inputTokens: 7, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    const totals = await store.providerTokenTotals()
    expect(totals.get('sz-llm')).toBe(175)
    expect(totals.get('zz-other')).toBe(7)
    // a provider that only ever carried turn markers is omitted, not zeroed
    expect(totals.has('default')).toBe(false)
  })
})
