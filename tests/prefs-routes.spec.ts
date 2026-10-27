/**
 * The model alias / unit-price preference routes.
 *
 * Two contracts are pinned here:
 *  - the prefs table is CONFIGURATION: a /reset (which replays session logs)
 *    must never erase it, and an unknown model is rejected rather than
 *    silently stored;
 *  - a malformed price body is refused with a 4xx instead of poisoning the
 *    stored estimate (a NaN price would make every cost read "NaN").
 */
import { describe, expect, it } from 'vitest'
import { buildUsageRoute, aggregateRange } from '../src/routes.ts'
import type { UsageHttpRequest, UsageHttpResponse } from '../src/context-types.ts'
import type { ModelPreference } from '../src/wire.ts'

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

/** An in-memory store carrying only what the prefs routes touch. */
function memoryStore(initial: ModelPreference[] = [], currency = '$') {
  const rows = new Map<string, ModelPreference>()
  for (const pref of initial) rows.set(pref.model, pref)
  const state = { currency }
  return {
    preferences: async () => [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    savePreference: async (pref: ModelPreference) => { rows.set(pref.model, pref) },
    deletePreference: async (model: string) => { rows.delete(model) },
    currency: async () => state.currency,
    setCurrency: async (next: string) => { state.currency = next },
    distinctModels: async () => ['seen/model-a'],
    rows,
    state,
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

/** A fake ctx whose `llm` advertises one provider with two models. */
function ctxWithLlm(): never {
  return {
    get(name: string) {
      if (name !== 'llm') return undefined
      return {
        listProviders: () => [{ id: 'brainyaiclaw', name: 'BrainyAIClaw' }],
        listModels: async (provider: string) => (provider === 'brainyaiclaw'
          ? [
              { provider, id: 'wcn/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
              { provider, id: 'wcn/qwen3.8-max', name: 'Qwen 3.8 Max' },
            ]
          : []),
      }
    },
  } as never
}

describe('POST /usage/api/prefs', () => {
  it('lists recorded models and catalogue models together', async () => {
    const store = memoryStore()
    const route = buildUsageRoute(ctxWithLlm(), depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs', {}), res)
    expect(res.jsonStatus).toBe(200)
    const body = JSON.parse(res.bodyText) as { value: { options: Array<{ model: string; seen: boolean }> } }
    const models = body.value.options.map((o) => o.model)
    // catalogue (advertised by the llm service, the same source Settings → Models reads)
    expect(models).toContain('brainyaiclaw/wcn/deepseek-v4.1-flash')
    expect(models).toContain('brainyaiclaw/wcn/qwen3.8-max')
    // recorded usage
    expect(models).toContain('seen/model-a')
    // recorded models sort first
    expect(body.value.options[0]!.model).toBe('seen/model-a')
    expect(body.value.options.find((o) => o.model === 'seen/model-a')!.seen).toBe(true)
  })

  it('still lists recorded models when the llm service is absent', async () => {
    const store = memoryStore()
    const route = buildUsageRoute({ get: () => undefined } as never, depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs', {}), res)
    const body = JSON.parse(res.bodyText) as { value: { options: Array<{ model: string }> } }
    expect(body.value.options.map((o) => o.model)).toEqual(['seen/model-a'])
  })

  it('keeps a stored pref for a model that is neither advertised nor recorded', async () => {
    const store = memoryStore([{
      model: 'gone/model-x', alias: 'GONE', inputPerM: 1, outputPerM: 2, cacheReadPerM: 0, cacheWritePerM: 0, updatedAt: 5,
    }])
    const route = buildUsageRoute({ get: () => undefined } as never, depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs', {}), res)
    const body = JSON.parse(res.bodyText) as { value: { options: Array<{ model: string }>; prefs: ModelPreference[] } }
    // The recorded model keeps its row, and the orphaned pref still gets one:
    // a model the reader priced must stay editable even after it disappears
    // from both catalogues.
    expect(body.value.options.map((o) => o.model)).toEqual(['seen/model-a', 'gone/model-x'])
    expect(body.value.prefs[0]!.alias).toBe('GONE')
  })
})

describe('POST /usage/api/prefs/save', () => {
  it('stores an alias and the unit prices', async () => {
    const store = memoryStore()
    const route = buildUsageRoute(ctxWithLlm(), depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs/save', {
      model: 'brainyaiclaw/wcn/deepseek-v4.1-flash',
      pref: { alias: 'BAC-DS4.1F', inputPerM: 0.5, outputPerM: 2, cacheReadPerM: 0.05, cacheWritePerM: 0 },
    }), res)
    expect(res.jsonStatus).toBe(200)
    const stored = store.rows.get('brainyaiclaw/wcn/deepseek-v4.1-flash')!
    expect(stored.alias).toBe('BAC-DS4.1F')
    expect(stored.inputPerM).toBe(0.5)
    expect(stored.outputPerM).toBe(2)
    expect(stored.cacheReadPerM).toBe(0.05)
    expect(stored.updatedAt).toBeGreaterThan(0)
  })

  it('clears the row when pref is null', async () => {
    const store = memoryStore([{
      model: 'm/x', alias: 'X', inputPerM: 1, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, updatedAt: 1,
    }])
    const route = buildUsageRoute({ get: () => undefined } as never, depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs/save', { model: 'm/x', pref: null }), res)
    expect(res.jsonStatus).toBe(200)
    expect(store.rows.has('m/x')).toBe(false)
  })

  it('rejects a negative price rather than storing it', async () => {
    const store = memoryStore()
    const route = buildUsageRoute({ get: () => undefined } as never, depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs/save', { model: 'm/x', pref: { alias: '', inputPerM: -1 } }), res)
    expect(res.jsonStatus).toBe(400)
    expect(store.rows.has('m/x')).toBe(false)
  })

  it('rejects a non-numeric price', async () => {
    const store = memoryStore()
    const route = buildUsageRoute({ get: () => undefined } as never, depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs/save', { model: 'm/x', pref: { alias: '', outputPerM: 'abc' } }), res)
    expect(res.jsonStatus).toBe(400)
  })

  it('rejects an absurd price instead of storing an unbounded estimate', async () => {
    const store = memoryStore()
    const route = buildUsageRoute({ get: () => undefined } as never, depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs/save', { model: 'm/x', pref: { alias: '', inputPerM: 1e9 } }), res)
    expect(res.jsonStatus).toBe(400)
  })

  it('rejects an over-long alias', async () => {
    const store = memoryStore()
    const route = buildUsageRoute({ get: () => undefined } as never, depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs/save', { model: 'm/x', pref: { alias: 'x'.repeat(25) } }), res)
    expect(res.jsonStatus).toBe(400)
  })

  it('rejects a missing model', async () => {
    const store = memoryStore()
    const route = buildUsageRoute({ get: () => undefined } as never, depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs/save', { pref: { alias: 'x' } }), res)
    expect(res.jsonStatus).toBe(400)
  })

  it('keeps untrusted hosts out', async () => {
    const store = memoryStore()
    const route = buildUsageRoute({ get: () => undefined } as never, depsFor(store))
    const res = mockRes()
    const req = { url: '/usage/api/prefs/save', method: 'POST', headers: { host: 'evil.example.com' } } as unknown as UsageHttpRequest
    await route.handler(req, res)
    expect(res.jsonStatus).toBe(403)
    expect(store.rows.size).toBe(0)
  })
})

describe('POST /usage/api/prefs/reset', () => {
  it('drops one row and leaves the others', async () => {
    const store = memoryStore([
      { model: 'a/one', alias: 'A', inputPerM: 1, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, updatedAt: 2 },
      { model: 'b/two', alias: 'B', inputPerM: 2, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, updatedAt: 1 },
    ])
    const route = buildUsageRoute({ get: () => undefined } as never, depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs/reset', { model: 'a/one' }), res)
    expect(res.jsonStatus).toBe(200)
    expect(store.rows.has('a/one')).toBe(false)
    expect(store.rows.has('b/two')).toBe(true)
  })

  it('is idempotent for an unknown model', async () => {
    const store = memoryStore()
    const route = buildUsageRoute({ get: () => undefined } as never, depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs/reset', { model: 'nope/none' }), res)
    expect(res.jsonStatus).toBe(200)
  })

  it('rejects an empty model', async () => {
    const store = memoryStore()
    const route = buildUsageRoute({ get: () => undefined } as never, depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs/reset', { model: '  ' }), res)
    expect(res.jsonStatus).toBe(400)
  })
})

describe('POST /usage/api/prefs/currency', () => {
  it('stores the display currency and echoes it back', async () => {
    const store = memoryStore()
    const route = buildUsageRoute({ get: () => undefined } as never, depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs/currency', { currency: '¥' }), res)
    expect(res.jsonStatus).toBe(200)
    expect(store.state.currency).toBe('¥')
    expect((JSON.parse(res.bodyText) as { value: { currency: string } }).value.currency).toBe('¥')
  })

  it('falls back to the default for a blank symbol', async () => {
    const store = memoryStore([], '¥')
    const route = buildUsageRoute({ get: () => undefined } as never, depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs/currency', { currency: '   ' }), res)
    expect(store.state.currency).toBe('$')
  })

  it('rejects control characters', async () => {
    const store = memoryStore()
    const route = buildUsageRoute({ get: () => undefined } as never, depsFor(store))
    const res = mockRes()
    await route.handler(post('/usage/api/prefs/currency', { currency: '\u0000' }), res)
    expect(res.jsonStatus).toBe(400)
  })
})

describe('aggregateRange per-model buckets', () => {
  it('carries the four billed buckets per model so the panel can price them', async () => {
    const store = {
      async rangeRows() {
        return [{
          day: '2026-08-01',
          provider: 'deepseek',
          model: 'deepseek/deepseek-chat',
          inputTokens: 100,
          outputTokens: 40,
          cacheReadTokens: 900,
          cacheWriteTokens: 7,
          requests: 1,
          turns: 0,
          lastSeen: 0,
        }]
      },
      async rangeHourRows() { return [] },
    } as never
    const out = await aggregateRange(store, '2026-08-01', '2026-08-01')
    const model = out.models[0]!
    expect(model.inputTokens).toBe(100)
    expect(model.outputTokens).toBe(40)
    expect(model.cacheReadTokens).toBe(900)
    expect(model.cacheWriteTokens).toBe(7)
    // the headline stays the provider-inclusive sum
    expect(model.tokens).toBe(1047)
  })
})
