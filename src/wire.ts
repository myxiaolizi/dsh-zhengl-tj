/**
 * Wire contract shared by the host aggregation layer and the browser panel,
 * plus the JSON request/response helpers for the /usage/api route handlers.
 * These types mirror the reasonix stats wire (internal/stats/query.go +
 * desktop/stats_app.go): the aggregate response the panel renders maps 1:1
 * to the panel sections (totals, derived stats, daily trend, per-model
 * split). No Node or DOM types leak into the shared declarations — the HTTP
 * helpers are host-only and import the node faces explicitly.
 */

import type { UsageHttpRequest, UsageHttpResponse } from './context-types.ts'

/** One bucket's token usage and turn count in a trend series. The `day`
 *  field is the bucket key: "YYYY-MM-DD" in day mode, "YYYY-MM-DDTHH" in
 *  hour mode (see {@link UsageStatsRange.granularity}). */
export interface DailyTokenUsage {
  day: string // bucket key; "YYYY-MM-DD" or "YYYY-MM-DDTHH", local calendar
  total: number // provider-inclusive tokens (input+output+cache reads/writes)
  byModel: Record<string, number> // model ref -> tokens
  byProvider: Record<string, number> // provider name -> tokens
  requests: number // usage events (API calls)
  turns: number // completed turns
  cacheHit: number // cached input tokens in the bucket
  cacheMiss: number // uncached input tokens in the bucket
}

/** One model's aggregate within the range. */
export interface ModelTokenUsage {
  model: string
  provider: string
  tokens: number
  percent: number // 0..100
  // The four billed buckets behind `tokens`, kept per model so the panel can
  // price each one at its own unit rate (an output token costs several times
  // an uncached input token; a cache read costs a fraction of one). Optional
  // on the wire so a host that predates the cost estimate still parses; the
  // estimator treats a missing bucket as zero.
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** One provider's aggregate within the range (each provider may serve several models). */
export interface ProviderTokenUsage {
  provider: string
  tokens: number
  percent: number
}

/** The full aggregate the panel renders for one time range. */
export interface UsageStatsRange {
  from: string // inclusive
  to: string // inclusive
  // Totals
  tokens: number // provider-inclusive (input + output + cache reads/writes)
  requests: number // usage events (API calls)
  turns: number // completed turns
  cacheHit: number
  cacheMiss: number
  // Derived
  activeDays: number
  topModel: string
  topProvider: string
  // Series
  /** Bucket size of `daily`: day presets and custom ranges group per day;
   *  the "today" / "last 3 days" presets group per local hour. */
  granularity: 'day' | 'hour'
  daily: DailyTokenUsage[]
  models: ModelTokenUsage[]
  providers: ProviderTokenUsage[]
}

/** The usage statistics panel aggregate request. */
export interface UsageStatsRequest {
  range: string // "today" | "3" | "7" | "14" | "30" | "90" | "custom"
  from?: string // "YYYY-MM-DD", custom only
  to?: string // "YYYY-MM-DD", custom only
}

// ── Model preferences (alias + unit prices) ───────────────────────────────

/**
 * One model's user preferences: the short alias the panel labels it with, and
 * the four unit prices used to estimate spend.
 *
 * Prices are per ONE MILLION tokens in @kenz1117's own currency (the payload
 * carries a single display currency symbol), because every provider quotes
 * them that way and a per-token float would round-trip badly through JSON.
 */
export interface ModelPreference {
  model: string // canonical "provider/model" ref
  alias: string // "" = no alias, the panel shows the bare model name
  inputPerM: number // uncached input, per 1M tokens
  outputPerM: number // output, per 1M tokens
  cacheReadPerM: number // cache hit / cache read, per 1M tokens
  cacheWritePerM: number // cache write, per 1M tokens
  updatedAt: number // epoch ms of the last edit
}

/**
 * One model the alias/price editor offers as a row.
 *
 * `options` is the UNION of two catalogues, which is what makes the editor
 * track the settings page: every provider/model the LLM service advertises
 * (the same catalogue the Settings → Models picker is built from), plus every
 * model the usage store has actually recorded (a model the catalogue no longer
 * advertises still needs its alias and price editable).
 */
export interface UsageModelOption {
  model: string // canonical "provider/model" ref
  provider: string
  /** Display name from the provider catalogue; falls back to the model id. */
  name: string
  /** True when the usage store has recorded this model inside the queried window. */
  seen: boolean
}

/** The alias/price editor's full payload. */
export interface UsagePrefsPayload {
  options: UsageModelOption[]
  prefs: ModelPreference[]
  /** Display currency symbol shared by every price in the payload. */
  currency: string
}

/** One write to the preference store: an upsert, or a reset when `pref` is null. */
export interface UsagePrefsSaveRequest {
  model: string
  pref: ModelPreference | null
  currency?: string
}

/** The backfill (historical session scan) progress state. */
export interface BackfillStatus {
  running: boolean
  total: number
  done: number
  scannedSessions: number
  lastSessionId?: string
  error?: string
}

// ── HTTP helpers (host half only) ─────────────────────────────────────────

/** Default cap for a JSON request body. The panel posts tiny objects
 *  ({ range, from?, to? }); the cap only bounds a misbehaving trusted
 *  client, so 64 KiB is generous. */
const MAX_JSON_BODY_BYTES = 64 * 1024

/** One line of an async-iterable request body read as UTF-8 text. */
export async function readJsonBody(req: UsageHttpRequest, maxBytes: number = MAX_JSON_BODY_BYTES): Promise<unknown> {
  let body = ''
  let bytes = 0
  for await (const chunk of req) {
    bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
    if (bytes > maxBytes) {
      throw new UsageError(413, `request body exceeds ${maxBytes} bytes`)
    }
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  }
  if (body === '') return undefined
  try {
    return JSON.parse(body)
  } catch {
    throw new UsageError(400, 'invalid json body')
  }
}

/** A user-visible error carrying its HTTP status. */
export class UsageError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function writeJson(res: UsageHttpResponse, value: unknown, status = 200): void {
  res.statusCode = status
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

export function writeError(res: UsageHttpResponse, err: unknown): void {
  const status = err instanceof UsageError ? err.status : 500
  // Deliberate 4xx carries its user-facing message; an unexpected 500 must
  // not echo internal error text (paths, driver messages) to the client —
  // the route handler logs the real error server-side.
  const message = err instanceof UsageError ? err.message : 'internal error'
  writeJson(res, { ok: false, error: { code: 'usage_api_error', message } }, status)
}
