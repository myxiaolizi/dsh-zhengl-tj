/**
 * Cost estimation and alias labelling.
 *
 * The panel must never invent a price: a model contributes to the estimated
 * spend only when the reader stored a unit price for it, and the unpriced mass
 * has to be reported rather than silently billed at zero.
 */
import { describe, expect, it } from 'vitest'
import type { ModelPreference, ModelTokenUsage } from '../src/wire.ts'
import {
  costOfModel,
  estimateCost,
  formatCost,
  formatPrice,
  indexPrefs,
  isPriced,
  modelLabel,
  normalizePrefsPayload,
} from '../src/client/pricing.ts'

function pref(model: string, patch: Partial<ModelPreference> = {}): ModelPreference {
  return {
    model,
    alias: '',
    inputPerM: 0,
    outputPerM: 0,
    cacheReadPerM: 0,
    cacheWritePerM: 0,
    updatedAt: 1,
    ...patch,
  }
}

function usage(model: string, buckets: Partial<ModelTokenUsage> = {}): ModelTokenUsage {
  const inputTokens = buckets.inputTokens ?? 0
  const outputTokens = buckets.outputTokens ?? 0
  const cacheReadTokens = buckets.cacheReadTokens ?? 0
  const cacheWriteTokens = buckets.cacheWriteTokens ?? 0
  return {
    model,
    provider: model.split('/')[0] ?? '',
    tokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    percent: 0,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  }
}

describe('isPriced', () => {
  it('treats an alias-only row as unpriced', () => {
    expect(isPriced(pref('p/m', { alias: 'NICK' }))).toBe(false)
  })

  it('treats any non-zero unit price as priced', () => {
    expect(isPriced(pref('p/m', { cacheWritePerM: 0.01 }))).toBe(true)
  })

  it('treats a missing row as unpriced', () => {
    expect(isPriced(undefined)).toBe(false)
  })
})

describe('costOfModel', () => {
  it('prices each bucket at its own rate per million tokens', () => {
    const p = pref('p/m', { inputPerM: 1, outputPerM: 8, cacheReadPerM: 0.1, cacheWritePerM: 2 })
    const m = usage('p/m', { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 250_000 })
    // 1 + 0.5*8 + 2*0.1 + 0.25*2 = 1 + 4 + 0.2 + 0.5
    expect(costOfModel(m, p)).toBeCloseTo(5.7, 10)
  })

  it('charges nothing when the model has no price, even with huge usage', () => {
    expect(costOfModel(usage('p/m', { inputTokens: 9_000_000 }), undefined)).toBe(0)
    expect(costOfModel(usage('p/m', { inputTokens: 9_000_000 }), pref('p/m'))).toBe(0)
  })

  it('tolerates a host that predates the bucket fields', () => {
    const legacy: ModelTokenUsage = { model: 'p/m', provider: 'p', tokens: 100, percent: 0 }
    expect(costOfModel(legacy, pref('p/m', { inputPerM: 5 }))).toBe(0)
  })
})

describe('estimateCost', () => {
  const prefs = indexPrefs([
    pref('a/one', { inputPerM: 1, outputPerM: 2 }),
    pref('b/two', { alias: 'TWO' }), // alias only, no price
  ])

  it('sums only the priced models and reports the unpriced mass', () => {
    const est = estimateCost([
      usage('a/one', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      usage('b/two', { inputTokens: 3_000_000 }),
      usage('c/three', { inputTokens: 2_000_000 }),
    ], prefs)
    expect(est.total).toBeCloseTo(3, 10)
    expect(est.anyPriced).toBe(true)
    expect(est.unpricedTokens).toBe(5_000_000)
    expect(est.lines.find((l) => l.model === 'b/two')!.unpriced).toBe(true)
    expect(est.lines.find((l) => l.model === 'c/three')!.unpriced).toBe(true)
  })

  it('shares are computed over the priced total only', () => {
    const est = estimateCost([
      usage('a/one', { inputTokens: 1_000_000 }),
      usage('c/three', { inputTokens: 9_000_000 }),
    ], prefs)
    // one priced model with 1M input at 1/M = 1; the unpriced 9M is not in the denominator
    expect(est.total).toBeCloseTo(1, 10)
    expect(est.lines.find((l) => l.model === 'a/one')!.percent).toBeCloseTo(100, 10)
  })

  it('reports anyPriced=false on a fresh install with no prices', () => {
    const est = estimateCost([usage('a/one', { inputTokens: 1_000_000 })], indexPrefs([pref('a/one')]))
    expect(est.anyPriced).toBe(false)
    expect(est.total).toBe(0)
    expect(est.unpricedTokens).toBe(1_000_000)
  })

  it('handles an empty range', () => {
    const est = estimateCost([], prefs)
    expect(est).toEqual({ total: 0, lines: [], unpricedTokens: 0, anyPriced: false })
  })
})

describe('formatCost', () => {
  it('keeps sub-cent amounts readable instead of rounding them to zero', () => {
    expect(formatCost(0.000234, '$')).toBe('$0.000234')
    expect(formatCost(0.0123, '$')).toBe('$0.0123')
    expect(formatCost(1.5, '$')).toBe('$1.5')
    expect(formatCost(1234.567, '$')).toBe('$1234.57')
  })

  it('renders an exact zero as zero', () => {
    expect(formatCost(0, '$')).toBe('$0')
  })
})

describe('formatPrice', () => {
  it('renders unset prices as a dash', () => {
    expect(formatPrice(0, '$')).toBe('—')
  })

  it('keeps precision on small unit prices', () => {
    expect(formatPrice(0.14, '$')).toBe('$0.14')
    expect(formatPrice(15, '$')).toBe('$15')
  })
})

describe('modelLabel', () => {
  const prefs = indexPrefs([pref('brainyaiclaw/wcn/deepseek-v4.1-flash', { alias: 'BAC-DS4.1F' })])

  it('uses the stored alias', () => {
    expect(modelLabel('brainyaiclaw/wcn/deepseek-v4.1-flash', prefs, 'deepseek-v4.1-flash')).toBe('BAC-DS4.1F')
  })

  it('falls back to the bare model name', () => {
    expect(modelLabel('p/other', prefs, 'other')).toBe('other')
  })

  it('treats a whitespace-only alias as absent', () => {
    const blank = indexPrefs([pref('p/m', { alias: '   ' })])
    expect(modelLabel('p/m', blank, 'm')).toBe('m')
  })
})

describe('normalizePrefsPayload', () => {
  it('degrades a foreign payload to the empty shape', () => {
    expect(normalizePrefsPayload(undefined)).toEqual({ options: [], prefs: [], currency: '$' })
    expect(normalizePrefsPayload({ daily: [] })).toEqual({ options: [], prefs: [], currency: '$' })
  })

  it('drops malformed rows instead of throwing', () => {
    const payload = normalizePrefsPayload({
      prefs: [pref('p/a'), null, { alias: 'x' }],
      options: [{ model: 'p/a', provider: 'p', name: 'a', seen: true }, 'nope'],
      currency: '¥',
    })
    expect(payload.prefs).toHaveLength(1)
    expect(payload.options).toHaveLength(1)
    expect(payload.currency).toBe('¥')
  })
})
