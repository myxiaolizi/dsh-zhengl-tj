/**
 * Cost estimation and model labelling.
 *
 * The panel never guesses a price: a model contributes to the estimated spend
 * ONLY when the reader has stored a unit price for it. Everything here is pure
 * arithmetic over the aggregate the host already returns, so the estimate can
 * be recomputed on every render without another request.
 *
 * Unit prices are per ONE MILLION tokens (the way every provider quotes them),
 * so a cost is `tokens / 1e6 * pricePerM`.
 */

import type { ModelPreference, ModelTokenUsage, ProviderPreference, UsageModelOption, UsagePrefsPayload, UsageProviderOption } from '../wire.ts'

/** The four billed buckets one model accumulated over a range. */
export interface ModelBuckets {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Lookup table: model ref -> its stored preference. */
export type PrefIndex = ReadonlyMap<string, ModelPreference>

/**
 * Coerce whatever the host returned into a usable payload.
 *
 * A host that predates the pricing feature (or a route that answers with a
 * different value) must degrade to "no aliases and no prices" rather than
 * crash the panel: the aggregate branch is the useful one and it must keep
 * rendering.
 *
 * Every field the panel reads is rebuilt here, INCLUDING the provider
 * catalogue and provider aliases. Dropping them looked harmless (they are
 * optional on the wire) but it silently disabled the whole provider-alias
 * feature: the host sent the rows, this function discarded them, and every
 * provider kept its raw id no matter what the reader typed. Optional on the
 * wire still has to be carried through the normaliser.
 */
export function normalizePrefsPayload(value: unknown): UsagePrefsPayload {
  const raw = (value ?? {}) as Partial<UsagePrefsPayload>
  const prefs = Array.isArray(raw.prefs)
    ? raw.prefs.filter((p): p is ModelPreference => typeof p === 'object' && p !== null && typeof p.model === 'string')
    : []
  const options = Array.isArray(raw.options)
    ? raw.options.filter((o): o is UsageModelOption => typeof o === 'object' && o !== null && typeof o.model === 'string')
    : []
  const providerPrefs = Array.isArray(raw.providerPrefs)
    ? raw.providerPrefs.filter((p): p is ProviderPreference => typeof p === 'object' && p !== null && typeof p.provider === 'string')
    : []
  const providerOptions = Array.isArray(raw.providerOptions)
    ? raw.providerOptions.filter((o): o is UsageProviderOption => typeof o === 'object' && o !== null && typeof o.provider === 'string')
    : []
  return {
    options,
    prefs,
    currency: typeof raw.currency === 'string' && raw.currency !== '' ? raw.currency : '$',
    providerPrefs,
    providerOptions,
  }
}

/** Index the host's preference rows by model ref. */
export function indexPrefs(prefs: readonly ModelPreference[]): PrefIndex {
  const map = new Map<string, ModelPreference>()
  if (!Array.isArray(prefs)) return map
  for (const p of prefs) map.set(p.model, p)
  return map
}

/** True when a preference carries at least one non-zero price — the row then
 *  takes part in the estimate instead of being a pure alias. */
export function isPriced(pref: ModelPreference | undefined): pref is ModelPreference {
  if (pref === undefined) return false
  return pref.inputPerM > 0 || pref.outputPerM > 0 || pref.cacheReadPerM > 0 || pref.cacheWritePerM > 0
}

/** The four buckets of one aggregate model row. */
export function bucketsOf(m: ModelTokenUsage): ModelBuckets {
  return {
    input: m.inputTokens ?? 0,
    output: m.outputTokens ?? 0,
    cacheRead: m.cacheReadTokens ?? 0,
    cacheWrite: m.cacheWriteTokens ?? 0,
  }
}

/** Estimated spend for one model, in the payload's currency. Zero when the
 *  model has no stored price (never a silent guess). */
export function costOfModel(m: ModelTokenUsage, pref: ModelPreference | undefined): number {
  if (!isPriced(pref)) return 0
  const b = bucketsOf(m)
  return (
    (b.input / 1e6) * pref.inputPerM
    + (b.output / 1e6) * pref.outputPerM
    + (b.cacheRead / 1e6) * pref.cacheReadPerM
    + (b.cacheWrite / 1e6) * pref.cacheWritePerM
  )
}

/** One model's line in the cost breakdown. */
export interface CostLine {
  model: string
  cost: number
  /** Share of the PRICED total, 0..100. */
  percent: number
  /** True when the model has no stored price: it contributes nothing and the
   *  panel says so rather than implying it was free. */
  unpriced: boolean
}

/** The whole estimate for one range. */
export interface CostEstimate {
  total: number
  lines: CostLine[]
  /** Tokens belonging to models with no stored price — the part of the range
   *  the estimate does NOT cover, surfaced so the figure is never read as
   *  "everything cost this". */
  unpricedTokens: number
  /** True when at least one model in the range carries a price. */
  anyPriced: boolean
}

/** Estimate the range's spend from the per-model buckets and the stored
 *  unit prices. Models without a price are reported, never charged. */
export function estimateCost(models: readonly ModelTokenUsage[], prefs: PrefIndex): CostEstimate {
  const lines: CostLine[] = []
  let total = 0
  let unpricedTokens = 0
  let anyPriced = false
  for (const m of models) {
    const pref = prefs.get(m.model)
    const priced = isPriced(pref)
    const cost = priced ? costOfModel(m, pref) : 0
    if (priced) anyPriced = true
    else unpricedTokens += m.tokens
    total += cost
    lines.push({ model: m.model, cost, percent: 0, unpriced: !priced })
  }
  if (total > 0) {
    for (const line of lines) line.percent = (line.cost / total) * 100
  }
  lines.sort((a, b) => b.cost - a.cost)
  return { total, lines, unpricedTokens, anyPriced }
}

/**
 * A money amount for display.
 *
 * Precision follows magnitude: a total worth thousands needs no sub-cent
 * noise, while a fraction of a cent must not render as "0.00" (which reads as
 * free). Below one unit four decimals are kept, below a hundredth six.
 */
export function formatCost(value: number, currency: string): string {
  if (!Number.isFinite(value) || value < 0) return `${currency}0`
  if (value === 0) return `${currency}0`
  if (value >= 100) return `${currency}${value.toFixed(2)}`
  if (value >= 1) return `${currency}${value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`
  if (value >= 0.01) return `${currency}${value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
  return `${currency}${value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`
}

/** A unit price for display (per 1M tokens), keeping meaningful decimals. */
export function formatPrice(value: number, currency: string): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value >= 10) return `${currency}${value.toFixed(2).replace(/\.00$/, '')}`
  if (value >= 1) return `${currency}${value.toFixed(2)}`
  return `${currency}${value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
}

/**
 * The label a model is shown under: its custom alias when one is stored,
 * otherwise the bare model name (the ref minus its provider prefix).
 *
 * A whitespace-only alias is treated as absent — clearing the field must
 * restore the model name, not blank the legend.
 */
export function modelLabel(model: string, prefs: PrefIndex, bareName: string): string {
  const alias = prefs.get(model)?.alias?.trim()
  return alias !== undefined && alias !== '' ? alias : bareName
}

// ── Provider aliases ──────────────────────────────────────────────────────

/** Lookup table: provider name -> its custom short name. */
export type ProviderAliasIndex = ReadonlyMap<string, string>

/** Index the host's provider-alias rows by provider name. Tolerates the
 *  payload arriving before the provider-alias feature exists (an older host
 *  simply sends nothing, and every provider then keeps its own name). */
export function indexProviderAliases(rows: readonly { provider: string; alias: string }[] | undefined): ProviderAliasIndex {
  const map = new Map<string, string>()
  if (!Array.isArray(rows)) return map
  for (const row of rows) {
    if (typeof row?.provider !== 'string') continue
    const alias = row.alias?.trim()
    if (alias !== undefined && alias !== '') map.set(row.provider, alias)
  }
  return map
}

/**
 * The label a provider is shown under: its custom short name when one is
 * stored, otherwise the provider id itself.
 *
 * A whitespace-only alias counts as absent for the same reason as the model
 * variant: clearing the field restores the name instead of blanking the row.
 */
export function providerLabel(provider: string, aliases: ProviderAliasIndex, fallback?: string): string {
  const alias = aliases.get(provider)
  if (alias !== undefined && alias !== '') return alias
  return fallback !== undefined && fallback !== '' ? fallback : provider
}
