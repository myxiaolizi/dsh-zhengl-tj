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
 * The unit prices are per ONE MILLION tokens: every provider quotes them that
 * way, and a per-token float would round-trip badly through JSON.
 */

import type { Context } from './context-types.ts'
import type { UsageModelOption, ModelPreference, UsagePrefsPayload } from './wire.ts'
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

/** Read the catalogue the LLM service advertises, tolerating an absent or
 *  failing service (the editor then lists recorded models only). */
async function catalogModels(ctx: Context): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const llm = ctx.get('llm') as { listProviders?: () => Array<{ id: string; name: string }>; listModels?: (p: string) => Promise<Array<{ provider: string; id: string; name: string }>> } | undefined
  if (llm === undefined || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') return out
  let providers: Array<{ id: string; name: string }> = []
  try {
    providers = llm.listProviders()
  } catch {
    return out
  }
  // One failing provider (an adapter whose endpoint is down) must not blank the
  // whole catalogue: each provider is read on its own and skipped on failure.
  const settled = await Promise.allSettled(providers.map(async (p) => ({ provider: p.id, models: await llm.listModels!(p.id) })))
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

/** Build the full payload the alias/price editor renders. */
export async function buildPrefsPayload(ctx: Context, store: UsageStore): Promise<UsagePrefsPayload> {
  const [catalog, recorded, prefs, currency] = await Promise.all([
    catalogModels(ctx),
    store.distinctModels(),
    store.preferences(),
    store.currency(),
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
  return { options: list, prefs, currency: currency || DEFAULT_CURRENCY }
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
