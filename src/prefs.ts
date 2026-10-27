/**
 * Model alias & unit-price preferences.
 *
 * Two jobs:
 *  1. Build the model catalogue the panel's alias/price editor lists. That
 *     catalogue is the UNION of the LLM service's advertised routes (the same
 *     source the Settings → Models picker reads) and every model ref the usage
 *     store has actually recorded — a model that has been used but is no
 *     longer advertised still needs its alias and price editable, and a model
 *     that is advertised but unused must still be priceable BEFORE it is used.
 *  2. Validate and normalise the writes coming from the browser, so a
 *     malformed or hostile body can never poison the stored prices.
 *
 * The same module also carries the PROVIDER alias layer: one short label per
 * provider (no prices — spend is a per-model property) and the provider
 * catalogue the provider editor lists, merged from the same two directories.
 *
 * The unit prices are per ONE MILLION tokens: every provider quotes them that
 * way, and a per-token float would round-trip badly through JSON.
 */

import type { Context } from './context-types.ts'
import type { UsageModelOption, ModelPreference, UsagePrefsPayload, UsageProviderOption, ProviderPreference } from './wire.ts'
import { UsageError } from './wire.ts'
import { providerOf, modelNameOf } from './shared.ts'
import type { UsageStore } from './store.ts'
import { DEFAULT_CURRENCY } from './store.ts'

/** Longest alias accepted. Long enough for "BAC-DS4.1F", short enough that a
 *  pasted paragraph cannot wreck the legend layout. */
export const MAX_ALIAS_LEN = 24

/** Highest unit price accepted, per 1M tokens. A typo of "1000" instead of
 *  "1.000" would otherwise produce a nonsensical cost headline; 10000 is far
 *  above any real catalogue price but still bounds the estimate. */
export const MAX_UNIT_PRICE = 10_000

/** The faces of the `llm` service the catalogue merge reads (all optional so a
 *  host without one of them still yields a usable catalogue). */
interface LlmDirectoryFaces {
  listProviders?: () => Array<{ id: string; name: string }>
  listConfigurableProviders?: () => Array<{ provider: string; displayName: string }>
  listModels?: (provider: string) => Promise<Array<{ provider?: string; id: string; name?: string }>>
}

/**
 * Read the model catalogue the LLM service advertises.
 *
 * The merge mirrors what Settings → Models enumerates, which is the UNION of
 * two directories the service publishes:
 *  - `listProviders()` — routes with a registered adapter (their `listModels`
 *    is authoritative and is what the picker actually offers);
 *  - `listConfigurableProviders()` — every declared provider, registered or
 *    dormant (a provider the reader configured but has not activated still
 *    belongs in the list, and its models come from the same `listModels`
 *    probe, which fails harmlessly while it is dormant).
 *
 * Tolerating an absent service or a failing provider is deliberate: the editor
 * then falls back to the recorded usage alone, which is still useful.
 */
async function catalogModels(ctx: Context): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const llm = ctx.get('llm') as LlmDirectoryFaces | undefined
  if (llm === undefined || typeof llm.listModels !== 'function') return out

  // Provider ids from both directories, de-duplicated; the display name is not
  // needed here (rows are labelled per MODEL) so only the ids survive.
  const ids = new Set<string>()
  try {
    for (const p of llm.listProviders?.() ?? []) if (typeof p.id === 'string' && p.id !== '') ids.add(p.id)
  } catch {
    // A broken adapter directory must not hide the configurable one below.
  }
  try {
    for (const p of llm.listConfigurableProviders?.() ?? []) if (typeof p.provider === 'string' && p.provider !== '') ids.add(p.provider)
  } catch {
    // Same: one directory failing must not blank the other.
  }

  // One failing provider (an adapter whose endpoint is down, or a dormant route)
  // must not blank the whole catalogue: each is read on its own and skipped.
  const listModels = llm.listModels.bind(llm)
  const settled = await Promise.allSettled([...ids].map(async (provider) => ({ provider, models: await listModels(provider) })))
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue
    for (const model of result.value.models) {
      if (typeof model.id !== 'string' || model.id === '') continue
      const ref = `${result.value.provider}/${model.id}`
      out.set(ref, typeof model.name === 'string' && model.name !== '' ? model.name : model.id)
    }
  }
  return out
}

/**
 * Read the PROVIDER catalogue the LLM service advertises: the ids of the same
 * two directories {@link catalogModels} merges, paired with their display name.
 *
 * The provider alias editor needs only the directories themselves (no
 * `listModels` probe): a provider whose adapter is down or whose route is
 * dormant still has a name worth aliasing. `listProviders` wins the name race
 * because its `name` is the label the running route reports, while a
 * configurable-only entry carries the settings-page `displayName`.
 */
export async function catalogProviders(ctx: Context): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const llm = ctx.get('llm') as LlmDirectoryFaces | undefined
  if (llm === undefined) return out

  try {
    for (const p of llm.listProviders?.() ?? []) {
      if (typeof p.id !== 'string' || p.id === '') continue
      out.set(p.id, typeof p.name === 'string' && p.name !== '' ? p.name : p.id)
    }
  } catch {
    // A broken adapter directory must not hide the configurable one below.
  }
  try {
    for (const p of llm.listConfigurableProviders?.() ?? []) {
      if (typeof p.provider !== 'string' || p.provider === '') continue
      // First writer wins: the adapter's own `name` is the live label.
      if (out.has(p.provider)) continue
      out.set(p.provider, typeof p.displayName === 'string' && p.displayName !== '' ? p.displayName : p.provider)
    }
  } catch {
    // Same: one directory failing must not blank the other.
  }
  return out
}

/** The provider reads the payload builder uses. Declared optional so a store
 *  stand-in that predates the provider-alias feature (or a test double built
 *  before it) degrades to "catalogue only" instead of failing the whole
 *  payload — the same tolerance the model catalogue gets from a missing
 *  `llm` service. */
interface ProviderReads {
  distinctProviders?: () => Promise<string[]>
  providerTokenTotals?: () => Promise<Map<string, number>>
  providerPreferences?: () => Promise<ProviderPreference[]>
}

/** Build the full payload the alias/price editor renders. */
export async function buildPrefsPayload(ctx: Context, store: UsageStore): Promise<UsagePrefsPayload> {
  const [catalog, recorded, prefs, currency, providerCatalog] = await Promise.all([
    catalogModels(ctx),
    store.distinctModels(),
    store.preferences(),
    store.currency(),
    catalogProviders(ctx),
  ])
  const providerReads = store as unknown as ProviderReads
  const [recordedProviders, providerTokens, providerPrefs]: [string[], Map<string, number>, ProviderPreference[]] = await Promise.all([
    providerReads.distinctProviders?.() ?? [],
    providerReads.providerTokenTotals?.() ?? new Map<string, number>(),
    providerReads.providerPreferences?.() ?? [],
  ])
  const options = new Map<string, UsageModelOption>()
  // Catalogue first (it carries display names), then recorded models fill the
  // gaps (a de-advertised route keeps its row so its price stays editable).
  for (const [ref, name] of catalog) {
    options.set(ref, { model: ref, provider: providerOf(ref), name, seen: false })
  }
  for (const ref of recorded) {
    const existing = options.get(ref)
    if (existing !== undefined) {
      existing.seen = true
      continue
    }
    options.set(ref, { model: ref, provider: providerOf(ref), name: modelNameOf(ref), seen: true })
  }
  // A pref for a model that is neither advertised nor recorded still gets a
  // row: the user wrote it, and hiding it would make the value uneditable.
  for (const pref of prefs) {
    if (!options.has(pref.model)) {
      options.set(pref.model, { model: pref.model, provider: providerOf(pref.model), name: modelNameOf(pref.model), seen: false })
    }
  }
  const list = [...options.values()]
  // Recorded models first (they are the ones the reader is looking at), then
  // advertised-but-unused, each group alphabetically for a stable edit order.
  list.sort((a, b) => {
    if (a.seen !== b.seen) return a.seen ? -1 : 1
    return a.model.localeCompare(b.model)
  })

  // ── Provider rows ──────────────────────────────────────────────────────
  // Same union as the model rows, one level up: the catalogue's providers
  // (adapter-registered ∪ configured-but-dormant), every provider the usage
  // store recorded, and any provider the reader already aliased. The token
  // total comes from one whole-history aggregate (`providerTokenTotals`), so
  // a `seen` row shows the traffic it actually carried while a
  // catalogue-but-unused row honestly reports 0.
  const seenProviders = new Set(recordedProviders)
  const providerOptions = new Map<string, UsageProviderOption>()
  for (const [provider, name] of providerCatalog) {
    providerOptions.set(provider, { provider, name, tokens: providerTokens.get(provider) ?? 0, seen: seenProviders.has(provider) })
  }
  for (const provider of recordedProviders) {
    const existing = providerOptions.get(provider)
    if (existing !== undefined) {
      existing.seen = true
      existing.tokens = providerTokens.get(provider) ?? existing.tokens
      continue
    }
    providerOptions.set(provider, { provider, name: provider, tokens: providerTokens.get(provider) ?? 0, seen: true })
  }
  // An alias for a provider that is neither advertised nor recorded still gets
  // a row: the reader wrote it, and hiding it would make the value uneditable.
  for (const pref of providerPrefs) {
    if (providerOptions.has(pref.provider)) continue
    providerOptions.set(pref.provider, {
      provider: pref.provider,
      name: pref.provider,
      tokens: providerTokens.get(pref.provider) ?? 0,
      seen: seenProviders.has(pref.provider),
    })
  }
  const providerList = [...providerOptions.values()]
  // Same ordering rule as the model rows: recorded traffic first, then
  // catalogue-only entries, each group alphabetically.
  providerList.sort((a, b) => {
    if (a.seen !== b.seen) return a.seen ? -1 : 1
    return a.provider.localeCompare(b.provider)
  })

  return {
    options: list,
    prefs,
    currency: currency || DEFAULT_CURRENCY,
    providerOptions: providerList,
    providerPrefs,
  }
}

/** Coerce one price field: missing → 0, a non-number or negative → rejected. */
function price(value: unknown, field: string): number {
  if (value === undefined || value === null || value === '') return 0
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) {
    throw new UsageError(400, `usage stats: ${field} must be a non-negative number`)
  }
  if (n > MAX_UNIT_PRICE) {
    throw new UsageError(400, `usage stats: ${field} exceeds the maximum of ${MAX_UNIT_PRICE} per 1M tokens`)
  }
  return n
}

/** Validate one preference write into its stored row. */
export function normalizePreference(body: { model?: unknown; pref?: unknown }): { model: string; pref: ModelPreference | null } {
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (model === '') throw new UsageError(400, 'usage stats: model is required')
  if (body.pref === null || body.pref === undefined) return { model, pref: null }
  if (typeof body.pref !== 'object') throw new UsageError(400, 'usage stats: pref must be an object or null')
  const raw = body.pref as Record<string, unknown>
  const alias = typeof raw.alias === 'string' ? raw.alias.trim() : ''
  if ([...alias].length > MAX_ALIAS_LEN) {
    throw new UsageError(400, `usage stats: alias must be at most ${MAX_ALIAS_LEN} characters`)
  }
  return {
    model,
    pref: {
      model,
      alias,
      inputPerM: price(raw.inputPerM, 'inputPerM'),
      outputPerM: price(raw.outputPerM, 'outputPerM'),
      cacheReadPerM: price(raw.cacheReadPerM, 'cacheReadPerM'),
      cacheWritePerM: price(raw.cacheWritePerM, 'cacheWritePerM'),
      updatedAt: Date.now(),
    },
  }
}

/** Validate one provider-alias write.
 *
 *  The provider is required and trimmed; a blank alias is LEGAL and means
 *  "clear the alias" (the route deletes the row instead of storing an empty
 *  one), matching what an emptied text input posts. Any other alias obeys the
 *  same length cap as a model alias, so a pasted paragraph cannot wreck the
 *  legend layout. */
export function normalizeProviderAlias(body: { provider?: unknown; alias?: unknown }): { provider: string; alias: string } {
  const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
  if (provider === '') throw new UsageError(400, 'usage stats: provider is required')
  const alias = typeof body.alias === 'string' ? body.alias.trim() : ''
  if ([...alias].length > MAX_ALIAS_LEN) {
    throw new UsageError(400, `usage stats: alias must be at most ${MAX_ALIAS_LEN} characters`)
  }
  return { provider, alias }
}

/** Validate the display-currency write: one to four printable characters. */
export function normalizeCurrency(value: unknown): string {
  if (typeof value !== 'string') throw new UsageError(400, 'usage stats: currency must be a string')
  const trimmed = value.trim()
  if (trimmed === '') return DEFAULT_CURRENCY
  if ([...trimmed].length > 4) throw new UsageError(400, 'usage stats: currency must be at most 4 characters')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new UsageError(400, 'usage stats: currency must not contain control characters')
  return trimmed
}
