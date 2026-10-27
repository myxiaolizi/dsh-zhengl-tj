/**
 * UsageStatsPanel renders the "usage statistics" panel. One component mounts
 * in two places — the Plugins page's own page for this bundle and the panel's
 * standalone main panel — so it reads the aggregate from the host (via the
 * fenced /usage/api route) and draws every chart by hand in SVG — a
 * GitHub-style activity heatmap, a stacked per-day token trend with a cache
 * hit-rate curve, and two ranked sections (models and providers) that each
 * pair a ring with a detail list.
 * No chart library; colours come from a fixed two-series palette
 * (--dsw-chart-1..10 + the gray --dsw-chart-other for models,
 * --dsw-provider-1..5 + the gray --dsw-provider-other for providers, the
 * reasonix usage-stats palette with a lifted dark variant, defined in this
 * plugin's module css).
 *
 * The panel follows the DSH client conventions: component styles are a CSS
 * Module (hashed class map imported as `css`), interactive atoms use the
 * ui-primitives Button/Input, and every visual value rides the --dsw-alias-*
 * semantic tokens. The functionality replicates the reasonix usage stats
 * feature; the implementation is DSH-native.
 */
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import clsx from 'clsx'
import { Activity, CalendarDays, ChevronDown, ChevronRight, Coins, Cpu, MessageSquare, MessagesSquare, Receipt, SlidersHorizontal } from 'lucide-react'
import { Button, Input, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DailyTokenUsage, ModelPreference, ModelTokenUsage, ProviderTokenUsage, UsageModelOption, UsagePrefsPayload, UsageStatsRange, UsageStatsRequest } from '../wire.ts'
import { fetchPrefs, fetchRange, rebuildStats, resetPref, saveCurrency, savePref, UsageApiError } from './api.ts'
import { ChartTip } from './ChartTip.tsx'
import { Donut, useDonutSize, type DonutSegment } from './Donut.tsx'
import { estimateCost, formatCost, indexPrefs, isPriced, modelLabel, normalizePrefsPayload, type CostEstimate, type CostLine } from './pricing.ts'
import { formatTokens, formatCompact, formatPercent, cacheRate, cacheRateText, daysBetween, localDay, indexOfDay, bucketAxisLabel, bucketTitle, providerOf, modelNameOf, smoothPath, niceTicks } from './format.ts'
import type { UsageStatsKey } from './locales.ts'
import type { UsageStatsTranslator } from './index.tsx'
import { statsLineState } from './stats-line-state.ts'
import css from './UsageStatsPanel.module.css'

/** The prefs payload before the first fetch: no aliases, no prices. */
const EMPTY_PREFS: UsagePrefsPayload = { options: [], prefs: [], currency: '$' }

type Translator = UsageStatsTranslator

const RANGE_PRESETS = ['today', '3', '7', '14', '30', '90'] as const

/** How long the rebuild button stays armed without a second press. */
const REBUILD_ARM_MS = 5000

// The heatmap used to draw a FIXED one-year window regardless of the range
// preset above it, which made the chart disagree with every other section: a
// 7-day selection still rendered 52 columns of squares. The window now follows
// the selected range (see heatWindowFor below); HEAT_WEEKS remains only as the
// WIDEST window the renderer solves geometry for, so a long custom range still
// trims to the container instead of overflowing it.
export const HEAT_MAX_WEEKS = 53

/** The trend chart caps its visible window at 180 days (mirrors reasonix). */
const TREND_MAX_DAYS = 180

/** The top-10 models keep a distinct rank colour; everything beyond collapses
 *  into the gray "Other" step. */
const TOP_MODELS = 10
const OTHER_MODEL = '\u0000other' // sentinel; cannot collide with a real model ref
const OTHER_COLOR = 'var(--dsw-chart-other)'

/** The top-5 providers keep a distinct rank colour from the provider series;
 *  everything beyond collapses into the gray "Other" step, mirroring the
 *  model chart's shape at the provider dimension. */
const TOP_PROVIDERS = 5
const OTHER_PROVIDER = '\u0000pother' // sentinel; cannot collide with a real provider name
const OTHER_PROVIDER_COLOR = 'var(--dsw-provider-other)'

/** Shared empty key set: one stable identity for a collapsed expand state. */
const NO_KEYS: ReadonlySet<string> = new Set()

/**
 * The heatmap's data window for a selection.
 *
 * The heatmap follows the range preset above it instead of always drawing the
 * last 365 days:
 *  - a day-based preset / custom range maps to exactly that [from, to];
 *  - the hour-based presets ("today", "last 3 days") still map to whole local
 *    days, because a heatmap cell IS a day;
 *  - the window is clamped to one year, the widest span the renderer's
 *    geometry is solved for (the host refuses spans longer than 366 days).
 *
 * Returns real calendar day keys, so the caller needs no further date math.
 */
export function heatWindowFor(range: string, customFrom: string, customTo: string): { from: string; to: string } {
  const to = range === 'custom' && customTo !== '' ? customTo : localDay(0)
  const daySpan = (n: number): string => {
    // n days counted inclusively: "last 3 days" = today, -1 and -2.
    const anchor = range === 'custom' && customTo !== '' ? new Date(`${customTo}T00:00:00`) : new Date()
    anchor.setDate(anchor.getDate() - (n - 1))
    const y = anchor.getFullYear()
    const m = String(anchor.getMonth() + 1).padStart(2, '0')
    const d = String(anchor.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  if (range === 'custom') {
    const from = customFrom !== '' ? customFrom : daySpan(HEAT_MAX_WEEKS * 7)
    return { from, to }
  }
  const preset = range === 'today' ? 1 : Number(range)
  const days = Number.isFinite(preset) && preset > 0 ? Math.min(preset, HEAT_MAX_WEEKS * 7) : 7
  return { from: daySpan(days), to }
}

/** Grouped daily rows: the top models stay individual, the tail collapses
 *  into the OTHER_MODEL bucket with the breakdown kept for tooltips. */
type GroupedDaily = DailyTokenUsage & { otherByModel: Record<string, number> }
type GroupedModel = ModelTokenUsage & { items?: ModelTokenUsage[] }
/** A provider folded into the aggregated Other bucket, carrying the models it
 *  served so its own row can open that breakdown. */
type FoldedProvider = ProviderTokenUsage & { models: ModelTokenUsage[] }
/** One provider row: its own volume plus every model it served, so the hover
 *  tip and the expandable detail list show the breakdown behind the number.
 *  The Other row additionally carries the providers it folded, so opening it
 *  lists PROVIDERS — their models sit one level further down, behind each of
 *  those rows, not flattened into this one. */
type GroupedProvider = ProviderTokenUsage & {
  models: ModelTokenUsage[]
  /** Folded providers behind the Other bucket; absent on a ranked row. */
  folded?: FoldedProvider[]
}

export function UsageStatsPanel({ t }: { t: Translator }): JSX.Element {
  const [range, setRange] = useState<string>('30')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  // The rebuild action is destructive (it clears the store and replays the
  // logs), so it takes two presses: the first arms the button, the second
  // runs. Arming cancels itself on blur, on Escape, and on a short timer, so
  // a primed destructive control can never be left behind on the toolbar.
  const [rebuildArmed, setRebuildArmed] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const rebuildTimer = useRef<number | null>(null)
  const [stats, setStats] = useState<UsageStatsRange | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const generationRef = useRef(0)
  // Model aliases and unit prices: one fetch on mount, refreshed whenever the
  // editor saves. Kept separate from `stats` because the two are independent —
  // editing a price must not re-read the usage aggregate.
  const [prefs, setPrefs] = useState<UsagePrefsPayload>(EMPTY_PREFS)
  const [prefsError, setPrefsError] = useState('')
  const [showPriceEditor, setShowPriceEditor] = useState(false)
  // The panel bounds the chart tooltips: a tip must never leave the panel
  // even when the hovered cell sits near its edge.
  const panelRef = useRef<HTMLDivElement>(null)

  // Heatmap window: it FOLLOWS the range preset (see heatWindowFor). The
  // window is a day window even for the hour presets, because a heatmap cell
  // is a day; `stats.daily` in hour mode cannot feed it.
  const heatWindow = useMemo(
    () => heatWindowFor(range, customFrom, customTo),
    [range, customFrom, customTo],
  )
  const [heatDaily, setHeatDaily] = useState<DailyTokenUsage[]>([])
  const heatGenRef = useRef(0)

  const loadHeat = useCallback(async () => {
    const generation = ++heatGenRef.current
    try {
      const res = await fetchRange({ range: 'custom', from: heatWindow.from, to: heatWindow.to })
      if (heatGenRef.current !== generation) return
      setHeatDaily(res.daily)
    } catch (e) {
      // The heatmap is auxiliary and must never block the panel, but it must
      // not fail silently either: a failed request (a backend still booting,
      // an auth race on mount) would leave the grid at level-0 for the rest of
      // the session. Log the failure; `load` retries on the next range change.
      console.error('[usage-stats] heatmap window request failed', e)
    }
  }, [heatWindow.from, heatWindow.to])

  const load = useCallback(async () => {
    if (range === 'custom' && (!customFrom || !customTo)) return
    const req: UsageStatsRequest =
      range === 'custom'
        ? { range, from: customFrom, to: customTo }
        : { range }
    const generation = ++generationRef.current
    setLoading(true)
    setError('')
    try {
      const res = await fetchRange(req)
      if (generationRef.current !== generation) return // stale response
      setStats(res)
      // The heatmap window now rides the SAME selection, so both surfaces are
      // re-read together: one trigger chain keeps the grid consistent with the
      // range buttons instead of drifting to its own year-long window.
      void loadHeat()
    } catch (e) {
      if (generationRef.current !== generation) return
      setError(e instanceof UsageApiError ? e.message : String(e))
    } finally {
      if (generationRef.current === generation) setLoading(false)
    }
  }, [range, customFrom, customTo, loadHeat])

  useEffect(() => {
    void load()
  }, [load])

  // The alias/price rows load once and after every save. A failure is not
  // fatal for the panel: without them it simply shows bare model names and no
  // cost card, which is still a useful panel.
  const loadPrefs = useCallback(async () => {
    try {
      setPrefs(normalizePrefsPayload(await fetchPrefs()))
      setPrefsError('')
    } catch (e) {
      setPrefsError(e instanceof UsageApiError ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void loadPrefs()
  }, [loadPrefs])

  // Persist one model row (an alias and/or prices), then fold the host's
  // reply straight back into state so the panel re-renders with the new
  // labels and estimate without a second round trip.
  const savePrefRow = useCallback(async (model: string, pref: ModelPreference | null) => {
    try {
      setPrefs(normalizePrefsPayload(await savePref(model, pref)))
      setPrefsError('')
    } catch (e) {
      setPrefsError(e instanceof UsageApiError ? e.message : String(e))
    }
  }, [])

  const resetPrefRow = useCallback(async (model: string) => {
    try {
      setPrefs(normalizePrefsPayload(await resetPref(model)))
      setPrefsError('')
    } catch (e) {
      setPrefsError(e instanceof UsageApiError ? e.message : String(e))
    }
  }, [])

  const saveCurrencySymbol = useCallback(async (currency: string) => {
    try {
      setPrefs(normalizePrefsPayload(await saveCurrency(currency)))
      setPrefsError('')
    } catch (e) {
      setPrefsError(e instanceof UsageApiError ? e.message : String(e))
    }
  }, [])

  // The armed rebuild (see the state note above): arm on the first press,
  // run on the second, and disarm from blur, Escape, the timer, or unmount.
  const disarmRebuild = useCallback(() => {
    if (rebuildTimer.current !== null) {
      window.clearTimeout(rebuildTimer.current)
      rebuildTimer.current = null
    }
    setRebuildArmed(false)
  }, [])

  const armRebuild = useCallback(() => {
    disarmRebuild()
    setRebuildArmed(true)
    rebuildTimer.current = window.setTimeout(() => {
      rebuildTimer.current = null
      setRebuildArmed(false)
    }, REBUILD_ARM_MS)
  }, [disarmRebuild])

  const runRebuild = useCallback(async () => {
    disarmRebuild()
    setRebuilding(true)
    setError('')
    try {
      await rebuildStats()
      // The host wiped the rows and replayed the logs, so both surfaces the
      // panel draws have to be read again — `load` re-reads the range
      // aggregate and the heatmap window that rides on it.
      await load()
    } catch (e) {
      setError(e instanceof UsageApiError ? e.message : String(e))
    } finally {
      setRebuilding(false)
    }
  }, [disarmRebuild, load])

  useEffect(() => disarmRebuild, [disarmRebuild])

  // A model's colour is its TOKEN rank (the host returns `models` sorted by
  // token volume), matching reasonix: rank 1..10 take --dsw-chart-1..10 and the
  // aggregated tail is the gray --dsw-chart-other. First-seen order would
  // scramble the rank colours (the top model could lose its blue, and a
  // top-10 model could fall into the gray bucket), so the rank is looked up in
  // `stats.models`, never in the daily walk.
  const colorForModel = useCallback((model: string): string => {
    if (model === OTHER_MODEL) return OTHER_COLOR
    const slot = (stats?.models ?? []).findIndex((m) => m.model === model)
    const rank = Math.min(slot < 0 ? 0 : slot, TOP_MODELS - 1) + 1
    return `var(--dsw-chart-${rank})`
  }, [stats])

  // Top-10 grouping: models beyond the top ten by token volume collapse into
  // the OTHER_MODEL bucket for the bar and the daily stacks; the per-day
  // breakdown stays available for the tooltip.
  const groupedStats = useMemo<{ models: GroupedModel[]; daily: GroupedDaily[] } | null>(() => {
    if (!stats) return null
    const top = stats.models.slice(0, TOP_MODELS)
    const rest = stats.models.slice(TOP_MODELS)
    const topSet = new Set(top.map((m) => m.model))
    const models: GroupedModel[] = rest.length > 0
      ? [
          ...top,
          {
            model: OTHER_MODEL,
            provider: '',
            tokens: rest.reduce((sum, m) => sum + m.tokens, 0),
            percent: rest.reduce((sum, m) => sum + m.percent, 0),
            // The tail's buckets are summed too, so the cost estimate sees the
            // whole range (an unpriced tail must still be counted as unpriced
            // rather than silently disappearing from the caveat).
            inputTokens: rest.reduce((sum, m) => sum + (m.inputTokens ?? 0), 0),
            outputTokens: rest.reduce((sum, m) => sum + (m.outputTokens ?? 0), 0),
            cacheReadTokens: rest.reduce((sum, m) => sum + (m.cacheReadTokens ?? 0), 0),
            cacheWriteTokens: rest.reduce((sum, m) => sum + (m.cacheWriteTokens ?? 0), 0),
            items: rest,
          },
        ]
      : top
    const daily: GroupedDaily[] = stats.daily.map((d) => {
      const otherByModel: Record<string, number> = {}
      const byModel: Record<string, number> = {}
      for (const [m, v] of Object.entries(d.byModel)) {
        if (topSet.has(m)) byModel[m] = v
        else otherByModel[m] = v
      }
      const other = Object.values(otherByModel).reduce((sum, v) => sum + v, 0)
      if (other > 0) byModel[OTHER_MODEL] = other
      return { ...d, byModel, otherByModel }
    })
    return { models, daily }
  }, [stats])

  // Provider colours are the provider's own rank — a palette separate from the
  // model series, so a provider never wears a model's hue.
  const providerRank = useMemo(
    () => (stats?.providers ?? []).filter((p) => p.tokens > 0).slice(0, TOP_PROVIDERS).map((p) => p.provider),
    [stats],
  )
  const colorForProvider = useCallback((provider: string): string => {
    if (provider === OTHER_PROVIDER) return OTHER_PROVIDER_COLOR
    const slot = providerRank.indexOf(provider)
    return `var(--dsw-provider-${Math.min(slot < 0 ? 0 : slot, TOP_PROVIDERS - 1) + 1})`
  }, [providerRank])

  // Top-5 providers by token volume with the tail aggregated into one gray
  // bucket. Providers carrying no tokens in the range are dropped: a
  // request-only provider (calls that produced nothing) has no usage to rank.
  const groupedProviders = useMemo<GroupedProvider[] | null>(() => {
    if (!stats) return null
    const modelsOf = new Map<string, ModelTokenUsage[]>()
    for (const m of stats.models) {
      const list = modelsOf.get(m.provider)
      if (list === undefined) modelsOf.set(m.provider, [m])
      else list.push(m)
    }
    const ranked = stats.providers.filter((p) => p.tokens > 0)
    const top = ranked.slice(0, TOP_PROVIDERS)
    // The tail keeps its own rows (each with the models it served) instead of
    // being flattened into one model list: the Other bucket stands for
    // PROVIDERS, and expanding it must answer "which providers, and how much
    // each" before "which models".
    const folded: FoldedProvider[] = ranked
      .slice(TOP_PROVIDERS)
      .map((p) => ({ ...p, models: modelsOf.get(p.provider) ?? [] }))
    const out: GroupedProvider[] = top.map((p) => ({ ...p, models: modelsOf.get(p.provider) ?? [] }))
    if (folded.length > 0) {
      out.push({
        provider: OTHER_PROVIDER,
        tokens: folded.reduce((sum, p) => sum + p.tokens, 0),
        percent: folded.reduce((sum, p) => sum + p.percent, 0),
        models: folded.flatMap((p) => p.models),
        folded,
      })
    }
    return out
  }, [stats])

  const trendDaily = groupedStats?.daily ?? []
  const trendModels = groupedStats?.models ?? []

  // ── Aliases and the cost estimate ──────────────────────────────────────
  // The preference rows (custom short names + per-million unit prices) are
  // read once per load: they come from the host, where they are stored beside
  // the usage history, and they never change as a side effect of a range
  // switch, so one fetch on mount plus a refetch after each save is enough.
  const prefIndex = useMemo(() => indexPrefs(prefs.prefs), [prefs.prefs])

  // A model's display label: its custom alias when set, else the bare name.
  // Every surface in the panel goes through this, so an alias typed once shows
  // up in the legend, the ring's tooltip, the ranked list, the top-model card
  // and the cost breakdown alike.
  const labelForModel = useCallback(
    (model: string): string => (model === OTHER_MODEL ? t('other') : modelLabel(model, prefIndex, modelNameOf(model))),
    [prefIndex, t],
  )

  // The estimate prices the RAW model rows, not the grouped ones: the Other
  // bucket is a display aggregation and has no price of its own.
  const estimate = useMemo(
    () => estimateCost(stats?.models ?? [], prefIndex),
    [stats, prefIndex],
  )
  const pricedModels = useMemo(
    () => [...prefIndex.values()].filter((p) => isPriced(p)).length,
    [prefIndex],
  )

  // The rebuild button's label: its idle name, the armed confirm, or the
  // in-flight state (the ellipsis is glued on here, the way the loading
  // indicator does it, so no dictionary carries punctuation).
  const rebuildLabel = rebuilding
    ? `${t('rebuilding')}…`
    : rebuildArmed ? t('rebuildConfirm') : t('rebuild')

  return (
    <div className={css.panel} data-dsh-usage-glass="panel" ref={panelRef}>
      <div className={css.toolbar}>
        <div className={css.group} data-dsh-usage-glass="group" role="group" aria-label={t('range')}>
          {RANGE_PRESETS.map((r) => (
            <Button
              key={r}
              size="sm"
              variant="ghost"
              className={clsx(css.segItem, range === r && css.segActive)}
              aria-pressed={range === r}
              onClick={() => setRange(r)}
            >
              {t(`rangePreset.${r}` as UsageStatsKey)}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            className={clsx(css.segItem, range === 'custom' && css.segActive)}
            aria-pressed={range === 'custom'}
            onClick={() => setRange('custom')}
          >
            {t('rangeCustom')}
          </Button>
        </div>
        {range === 'custom' && (
          <div className={css.customRange}>
            <Input
              type="date"
              className={css.dateInput}
              value={customFrom}
              max={customTo || undefined}
              onChange={(e) => setCustomFrom(e.target.value)}
              aria-label={t('from')}
            />
            <span className={css.customSep}>–</span>
            <Input
              type="date"
              className={css.dateInput}
              value={customTo}
              min={customFrom || undefined}
              max={localDay(0)}
              onChange={(e) => setCustomTo(e.target.value)}
              aria-label={t('to')}
            />
          </div>
        )}
        {/* The two toolbar actions are one flex item, not two: the toolbar
            wraps, and a pair that wrapped apart would strand the rebuild
            button on a line of its own. The container owns the trailing auto
            margin, so the pair rides the right edge together. */}
        <div className={css.actions}>
          <Button
            size="sm"
            variant="outline"
            className={css.refresh}
            onClick={() => { void load() }}
            disabled={loading}
          >
            {t('refresh')}
          </Button>
          <Tooltip label={t('rebuildHint')} side="top" portal maxWidth={260}>
            <Button
              size="sm"
              variant="outline"
              className={clsx(css.rebuild, rebuildArmed && css.rebuildArmed)}
              aria-pressed={rebuildArmed}
              disabled={rebuilding}
              onClick={() => { if (rebuildArmed) void runRebuild(); else armRebuild() }}
              onBlur={disarmRebuild}
              onKeyDown={(e) => { if (e.key === 'Escape') disarmRebuild() }}
            >
              {rebuildLabel}
            </Button>
          </Tooltip>
        </div>
      </div>

      {error && <div className={css.errorBanner}>{error}</div>}
      {loading && !stats && <div className={css.loading}>{t('loading')}…</div>}
      {/* Content stays mounted across refreshes (stats keeps its last value):
          only the FIRST load shows the spinner, so a range switch or a manual
          refresh never blanks the whole data area. */}
      {stats && (
        <>
          <StatCards stats={stats} t={t} estimate={estimate} prefs={prefs} labelForModel={labelForModel} pricedModels={pricedModels} onOpenEditor={() => setShowPriceEditor(true)} />
          <Heatmap daily={heatDaily} from={heatWindow.from} to={heatWindow.to} t={t} panelRef={panelRef} />
          <DailyTrend models={trendModels} daily={trendDaily} granularity={stats?.granularity ?? 'day'} t={t} colorForModel={colorForModel} panelRef={panelRef} labelForModel={labelForModel} />
          <ModelUsage models={trendModels} t={t} colorForModel={colorForModel} panelRef={panelRef} labelForModel={labelForModel} estimate={estimate} currency={prefs.currency} />
          <ProviderUsage providers={groupedProviders ?? []} t={t} colorForProvider={colorForProvider} panelRef={panelRef} labelForModel={labelForModel} />
          {stats.to && (
            <div className={css.foot}>
              {t('asOf')} {stats.to}
            </div>
          )}
        </>
      )}
      {/* The alias/price editor: always reachable, even when the range is
          empty, because prices are configuration rather than data. */}
      {showPriceEditor && (
        <PrefEditor
          t={t}
          payload={prefs}
          error={prefsError}
          onClose={() => setShowPriceEditor(false)}
          onSave={savePrefRow}
          onReset={resetPrefRow}
          onCurrency={saveCurrencySymbol}
        />
      )}
      {!error && stats && isEmptyRange(stats) && (
        <div className={css.empty}>{t('empty')}</div>
      )}
      <div className={css.prefGroup} data-dsh-usage-glass="pref">
        <StatsLineOptions t={t} />
      </div>
    </div>
  )
}

// ── Section 2+3: numeric cards ────────────────────────────────────────────

/** A range is empty only when NOTHING was recorded in it: a pure-cache day
 *  (zero input/output but real cache hits) or a failed-call day (requests
 *  but no tokens) both carry real usage and must not read as "no data". */
function isEmptyRange(stats: UsageStatsRange): boolean {
  return stats.tokens === 0 && stats.cacheHit === 0 && stats.requests === 0 && stats.turns === 0
}

// ── Bottom-bar preference rows ────────────────────────────────────────────

/**
 * One framed preference row: title + subtitle on the left, the switch on the
 * right. The switch mirrors the official DSH switch (role=switch, track +
 * thumb); the shared store keeps each row and its consumer in sync
 * instantly because both run in the same client bundle.
 */
function SettingToggle({ title, desc, checked, ariaLabel, onChange }: {
  title: string
  desc: string
  checked: boolean
  ariaLabel: string
  onChange: (next: boolean) => void
}) {
  // One description id per row; the switch names it so a screen reader
  // announces the explanation alongside the title.
  const descId = useId()
  return (
    <div className={css.prefRow}>
      <div className={css.entryOptionText}>
        <div className={css.entryOptionTitle}>{title}</div>
        <div className={css.entryOptionDesc} id={descId}>{desc}</div>
      </div>
      <button
        type="button"
        className={css.switch}
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        aria-describedby={descId}
        onClick={() => { onChange(!checked) }}
      >
        <span className={css.switchTrack} data-on={checked || undefined} aria-hidden="true">
          <span className={css.switchThumb} />
        </span>
      </button>
    </div>
  )
}

/**
 * The three bottom-bar enhancement preferences:
 * "Precise cache hit rate" (two decimals on the usage pill and dialog),
 * "Session token breakdown" (an extra cache-miss row in the usage dialog) and
 * "Streaming throughput" (a live decode-speed estimate while a step streams,
 * replaced by the exact session figure the moment it settles).
 */
function StatsLineOptions({ t }: { t: Translator }) {
  const [cachePrecision, setCachePrecision] = useState(statsLineState.cachePrecision)
  const [tokenDetail, setTokenDetail] = useState(statsLineState.tokenDetail)
  const [streamThroughput, setStreamThroughput] = useState(statsLineState.streamThroughput)
  useEffect(() => statsLineState.subscribe(() => {
    setCachePrecision(statsLineState.cachePrecision)
    setTokenDetail(statsLineState.tokenDetail)
    setStreamThroughput(statsLineState.streamThroughput)
  }), [])
  return (
    <>
      <SettingToggle
        title={t('cachePrecision')}
        desc={t('cachePrecisionDesc')}
        checked={cachePrecision}
        ariaLabel={t('cachePrecision')}
        onChange={(next) => { statsLineState.setCachePrecision(next) }}
      />
      <SettingToggle
        title={t('tokenDetail')}
        desc={t('tokenDetailDesc')}
        checked={tokenDetail}
        ariaLabel={t('tokenDetail')}
        onChange={(next) => { statsLineState.setTokenDetail(next) }}
      />
      <SettingToggle
        title={t('streamThroughput')}
        desc={t('streamThroughputDesc')}
        checked={streamThroughput}
        ariaLabel={t('streamThroughput')}
        onChange={(next) => { statsLineState.setStreamThroughput(next) }}
      />
    </>
  )
}

function StatCards({ stats, t, estimate, prefs, labelForModel, pricedModels, onOpenEditor }: {
  stats: UsageStatsRange
  t: Translator
  estimate: CostEstimate
  prefs: UsagePrefsPayload
  labelForModel: (m: string) => string
  pricedModels: number
  onOpenEditor: () => void
}) {
  const cards: Array<{ icon: typeof Coins; label: string; value: string; sm?: boolean; wrap?: boolean; hint?: string; modelRef?: boolean; sub?: string; cost?: boolean }> = [
    // The headline is provider-inclusive (uncached input + output + cached
    // tokens) — the number a provider dashboard reports for the same calls.
    // The headline is the compact K/M/B form (the number a provider dashboard
    // shows); the exact, separator-formatted count stays underneath so the
    // precise figure is still readable at a glance.
    { icon: Coins, label: t('tokens'), value: formatCompact(stats.tokens), hint: t('tokensHint'), sub: `${formatTokens(stats.tokens)} ${t('tokensUnit')}` },
    { icon: MessageSquare, label: t('sessions'), value: String(stats.turns) },
    { icon: MessagesSquare, label: t('requests'), value: String(stats.requests) },
    {
      icon: Activity,
      label: t('cacheRate'),
      value: cacheRateText(stats.cacheHit, stats.cacheMiss),
      hint: t('cacheRateHint'),
      // The absolute cached volume lives under the percentage: the rate
      // alone hides how many tokens the cache actually served.
      sub: `${formatCompact(stats.cacheHit)} ${t('cachedTokens')}`,
    },
    { icon: CalendarDays, label: t('activeDays'), value: String(stats.activeDays) },
    // The cost card is the estimated spend: it replaces a plain numeric card
    // only when at least one unit price exists, and its action button opens
    // the editor — the only way to make a "—" number meaningful.
    {
      icon: Receipt,
      label: t('estimatedCost'),
      value: estimate.anyPriced ? formatCost(estimate.total, prefs.currency) : '—',
      hint: t('estimatedCostHint'),
      cost: true,
      sub: estimate.anyPriced
        ? (estimate.unpricedTokens > 0
            ? t('costUnpriced').replace('{tokens}', formatCompact(estimate.unpricedTokens))
            : `${pricedModels} ${t('priceUnit')}`)
        : t('costNone'),
    },
    // The two long-valued cards bookend the row: total tokens leads it and the
    // top model closes it, each on a wider track than the four short numerics
    // between them. The model sits last because it carries the longest text —
    // the model name over its provider — and the row's end is where that has
    // the most room before FitText would have to shrink it.
    { icon: Cpu, label: t('topModel'), value: stats.topModel || '—', hint: t('topModelHint'), modelRef: true },
  ]
  return (
    <div className={css.cards}>
      {cards.map((c) => (
        <div className={css.card} data-dsh-usage-glass="card" key={c.label} title={c.hint}>
          <div className={css.cardHead}>
            <c.icon className={css.cardIcon} size={14} strokeWidth={2} aria-hidden="true" />
            <span className={css.cardLabel}>{c.label}</span>
            {c.cost && (
              <button type="button" className={css.cardAction} onClick={onOpenEditor} title={t('priceEditorHint')}>
                <SlidersHorizontal size={12} aria-hidden="true" />
                {t('priceEditorOpen')}
              </button>
            )}
          </div>
          {c.modelRef ? (
            // The model card mirrors the per-model list rows: model name on
            // line one, provider on line two in the muted small style — not
            // the raw "provider/model" ref.
            <div className={clsx(css.cardValue, css.cardValueSm, css.cardModelLines)}>
              {stats.topModel ? (
                <>
                  <span className={css.modelName}>{labelForModel(stats.topModel)}</span>
                  <span className={css.modelProvider}>{providerOf(stats.topModel)}</span>
                </>
              ) : '—'}
            </div>
          ) : c.wrap ? (
            <div className={clsx(css.cardValue, css.cardValueSm, css.cardValueWrap)}>{c.value}</div>
          ) : c.sub !== undefined ? (
            <div className={clsx(css.cardValue, css.cardModelLines)}>
              <FitText text={c.value} className={css.cardValue} maxSize={22} />
              <div className={css.cardSub}>{c.sub}</div>
            </div>
          ) : (
            <FitText text={c.value} className={clsx(css.cardValue, c.sm && css.cardValueSm)} maxSize={c.sm ? 14 : 22} />
          )}
        </div>
      ))}
    </div>
  )
}

// FitText renders `text` on a single line, shrinking the font until it fits
// the card width (long token numbers never overflow or wrap).
function FitText({ text, className, maxSize }: { text: string; className?: string; maxSize: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState(maxSize)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      let s = maxSize
      el.style.fontSize = `${s}px`
      while (el.scrollWidth > el.clientWidth + 1 && s > 11) {
        s -= 0.5
        el.style.fontSize = `${s}px`
      }
      setSize(s)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, maxSize])

  return (
    <div ref={ref} className={className} style={{ fontSize: size }}>
      {text}
    </div>
  )
}

// ── Section 4: GitHub-style activity heatmap ──────────────────────────────

// Cell/gap ratio follows reasonix (base 13 / gap 3): a 1px gap against a
// ~20px grown cell read as tiles touching edge to edge. The gap also equals
// the legend's own 3px swatch spacing, and the fixed rx matches the legend
// swatch border-radius, so the key renders at exactly the chart's geometry.
const HEAT_BASE = 14 // cell size at which column trimming starts
const HEAT_GAP = 3 // breathing gap between cells; mirrors the legend swatch gap
const HEAT_RX = 3 // cell corner radius; matches the legend swatch (css .heatCell)

/** One heatmap frame's geometry. */
export interface HeatGeometry {
  /** Cell edge in px. */
  size: number
  /** Weeks drawn. */
  cols: number
  /** Columns actually laid out, including the partial first week. */
  totalWeeks: number
}

/**
 * Solve the heatmap's geometry for an available width and a data window.
 *
 * Two rules, in this order: spend spare width on MORE WEEKS (up to the data
 * window), and only then grow the cells to close the remaining gap. When the
 * window does not fit at the base cell size, trim the earliest weeks and keep
 * the base size.
 *
 * `weeks` is the window length in weeks (derived from the selected range), so a
 * 7-day selection solves for ONE column while a 90-day selection solves for
 * thirteen — the chart no longer pads every selection out to a year of empty
 * cells.
 *
 * Two off-by-one traps are handled explicitly, because both produce a real
 * overflow at the page's ~900px content width:
 *  - "does it fit" is tested against `totalWeeks` (the laid-out column count,
 *    one more than `cols` when the first week is partial), not the window size;
 *  - the fitting test reserves the trailing gap, so `baseCols` is derived from
 *    `avail - HEAT_GAP` and the rendered width `cols*(size+GAP)+GAP` can never
 *    exceed `avail`.
 *
 * The growth branch runs only when the solved cell size is still at or above
 * the base size; otherwise the window does not truly fit and the trim branch
 * runs. A `max(BASE, size)` fallback would silently render one column too many.
 * @param avail - available width in px.
 * @param startOffset - leading empty cells of the first week (0..6).
 * @param weeks - the data window's length in weeks (clamped to 1..HEAT_MAX_WEEKS).
 * @returns the cell size, the week count, and the laid-out column count.
 */
export function heatGeometry(avail: number, startOffset: number, weeks: number = HEAT_MAX_WEEKS): HeatGeometry {
  const window = Math.max(1, Math.min(HEAT_MAX_WEEKS, Math.ceil(weeks)))
  const totalWeeks = Math.ceil((window * 7 + startOffset) / 7)
  const baseCols = Math.max(1, Math.floor((avail - HEAT_GAP) / (HEAT_BASE + HEAT_GAP)))
  if (baseCols >= totalWeeks) {
    const size = (avail - HEAT_GAP) / totalWeeks - HEAT_GAP
    if (size >= HEAT_BASE) return { size, cols: window, totalWeeks }
  }
  // `cols * 7` days behind a leading partial week occupy one MORE track than
  // `cols`, and the SVG viewport is sized from the track count — so a `cols`
  // that only fits `cols` tracks leaves the newest column outside the viewBox,
  // clipped to a sliver at the right edge. Drop the OLDEST week in that case:
  // one fewer week reads far better than a half-drawn newest one, and the
  // remaining cells grow to fill the width exactly. `cols` was derived from
  // `avail - GAP`, so the solved size stays at or above the base size; the
  // floor only guards absurd widths.
  const tracksFor = (c: number): number => Math.max(c, Math.ceil((c * 7 + startOffset) / 7))
  let cols = Math.max(1, Math.min(baseCols, window))
  while (cols > 1 && tracksFor(cols) > baseCols) cols -= 1
  const totalCols = tracksFor(cols)
  const size = (avail - HEAT_GAP) / totalCols - HEAT_GAP
  return { size: Math.max(HEAT_BASE, size), cols, totalWeeks: totalCols }
}

function Heatmap({ daily, from, to, t, panelRef }: { daily: DailyTokenUsage[]; from: string; to: string; t: Translator; panelRef: RefObject<HTMLDivElement | null> }) {
  // Memoized so a hover/tip state change re-renders without rebuilding the
  // per-day lookup (the daily array is stable between fetches).
  const byDay = useMemo(() => {
    const map = new Map<string, DailyTokenUsage>()
    for (const d of daily) map.set(d.day, d)
    return map
  }, [daily])
  const [tip, setTip] = useState<{ day: string; tokens: number; requests: number; cacheHit: number; cacheMiss: number; anchor: Element } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  // The window's length in weeks, solved from the SELECTED range rather than
  // assumed to be a year: a 7-day selection is one column, a 90-day selection
  // is thirteen.
  const windowDays = daysBetween(from, to).length
  const windowWeeks = Math.max(1, Math.ceil(windowDays / 7))
  const [geom, setGeom] = useState<HeatGeometry>(() => heatGeometry(HEAT_BASE * HEAT_MAX_WEEKS, 0, windowWeeks))

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => {
      const avail = Math.max(1, el.clientWidth - 2)
      const next = heatGeometry(avail, (indexOfDay(from) + 1) % 7, windowWeeks)
      // Only commit when the geometry actually changed — the heatmap SVG
      // width follows `geom.size`, and committing an identical value on
      // every ResizeObserver callback would feed a render loop and jitter.
      setGeom((prev) => (prev.size === next.size && prev.cols === next.cols ? prev : next))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [from, windowWeeks])

  const allDays = daysBetween(from, to)
  if (allDays.length === 0) return null
  const days = allDays.slice(-Math.min(geom.cols * 7, allDays.length))
  const max = Math.max(1, ...days.map((d) => byDay.get(d)?.total ?? 0))

  const rows = 7
  const startOffset = days[0] ? (indexOfDay(days[0]) + 1) % 7 : 0
  // The solver already knows how many columns the layout has, including the
  // partial first week, so the SVG width follows it directly.
  const weeks = geom.totalWeeks

  return (
    <section className={css.section}>
      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>{t('heatmap')}</h3>
        <div className={css.heatLegend}>
          <span>{t('heatLess')}</span>
          <i className={clsx(css.heatCell, css.heatLevel1)} style={{ width: geom.size, height: geom.size }} />
          <i className={clsx(css.heatCell, css.heatLevel2)} style={{ width: geom.size, height: geom.size }} />
          <i className={clsx(css.heatCell, css.heatLevel3)} style={{ width: geom.size, height: geom.size }} />
          <i className={clsx(css.heatCell, css.heatLevel4)} style={{ width: geom.size, height: geom.size }} />
          <i className={clsx(css.heatCell, css.heatLevel5)} style={{ width: geom.size, height: geom.size }} />
          <span>{t('heatMore')}</span>
        </div>
      </div>
      <div className={css.heatWrap} ref={wrapRef}>
        <svg className={css.heatmap} width={weeks * (geom.size + HEAT_GAP) + HEAT_GAP} height={rows * (geom.size + HEAT_GAP) + HEAT_GAP} role="img" aria-label={t('heatmap')}>
          {days.map((day, i) => {
            const col = Math.floor((i + startOffset) / 7)
            const row = (i + startOffset) % 7
            const rec = byDay.get(day)
            const tokens = rec?.total ?? 0
            const level = tokens === 0 ? 0 : 1 + Math.floor((tokens / max) * 4)
            const x = HEAT_GAP + col * (geom.size + HEAT_GAP)
            const y = HEAT_GAP + row * (geom.size + HEAT_GAP)
            return (
              <rect
                key={day}
                className={clsx(css.heatCell, level === 0 && css.heatLevel0, level === 1 && css.heatLevel1, level === 2 && css.heatLevel2, level === 3 && css.heatLevel3, level === 4 && css.heatLevel4, level === 5 && css.heatLevel5)}
                x={x}
                y={y}
                width={geom.size}
                height={geom.size}
                rx={HEAT_RX}
                onMouseEnter={(e) => {
                  // The tip anchors to the hovered cell's viewport rect, so it
                  // can escape the wrap's overflow clipping and follow scroll.
                  setTip({ day, tokens, requests: rec?.requests ?? 0, cacheHit: rec?.cacheHit ?? 0, cacheMiss: rec?.cacheMiss ?? 0, anchor: e.currentTarget })
                }}
                onMouseLeave={() => setTip(null)}
              />
            )
          })}
        </svg>
        {tip && (
          <ChartTip anchor={tip.anchor} panelRef={panelRef}>
            <div className={css.tipTitle}>{tip.day}</div>
            <div>{t('tokens')}: {formatTokens(tip.tokens)}</div>
            <div>{t('requests')}: {tip.requests}</div>
            <div>{t('cacheHitRate')}: {cacheRateText(tip.cacheHit, tip.cacheMiss)}</div>
          </ChartTip>
        )}
      </div>
    </section>
  )
}

// ── Section 5: stacked daily token trend ──────────────────────────────────

function DailyTrend({ models, daily, granularity, t, colorForModel, panelRef, labelForModel }: { models: GroupedModel[]; daily: GroupedDaily[]; granularity: 'day' | 'hour'; t: Translator; colorForModel: (m: string) => string; panelRef: RefObject<HTMLDivElement | null>; labelForModel: (m: string) => string }) {
  const [tip, setTip] = useState<{ day: string; total: number; byModel: Record<string, number>; otherByModel?: Record<string, number>; cacheHit: number; cacheMiss: number; anchor: Element } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  // Per-model visibility, driven by clicking the legend. A model switched off
  // is removed from the stacks AND from the vertical scale, so the remaining
  // series re-scale to fill the plot instead of leaving a hidden model's
  // headroom as dead space. The set holds HIDDEN ids (empty = everything on),
  // so a new model appearing in the range is visible by default.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(NO_KEYS)
  const toggleHidden = useCallback((model: string) => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(model)) next.delete(model)
      else next.add(model)
      return next
    })
  }, [])
  const wrapRef = useRef<HTMLDivElement>(null)

  const W = 720
  const H = 220
  const padL = 46
  const padR = 65
  const padB = 26
  const padT = 10
  const plotH = H - padT - padB
  // The smallest column pitch that still reads as separate bars; below it
  // (very long custom ranges on a narrow pane) the oldest days drop off.
  const MIN_PITCH = 4

  const [view, setView] = useState<{ avail: number; trimN: number }>({ avail: W, trimN: TREND_MAX_DAYS })

  useEffect(() => {
    const el = wrapRef.current
    if (!el || daily.length === 0) return
    const update = () => {
      const avail = Math.max(1, el.clientWidth)
      const maxN = Math.floor((avail - padL - padR) / MIN_PITCH) + 1
      const trimN = Math.max(1, Math.min(daily.length, TREND_MAX_DAYS, maxN))
      setView((prev) => (prev.avail === avail && prev.trimN === trimN ? prev : { avail, trimN }))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [daily.length])

  if (daily.length === 0) return null

  const visible = daily.slice(-view.trimN)
  // The note is honest about whatever window actually rendered (the 180-day
  // cap, or a narrower pane's minimum-pitch trim).
  const trendCapped = daily.length > view.trimN
  const n = visible.length
  // Columns always spread over the full plot width: pinning a minimum pitch
  // for the step itself letterboxes the chart (the viewBox, narrower than
  // the svg box, centres with empty flanks) when few days are in range —
  // 7/14-day presets used to huddle in the middle. The pitch floor above
  // only caps how many days show.
  const step =
    n > 1
      ? (view.avail - padL - padR) / (n - 1)
      : Math.max(1, view.avail - padL - padR)
  const barW = Math.max(3, Math.min(30, step * 0.62))
  const barHalf = barW / 2
  const plotWUsed = view.avail
  // The scale is the largest VISIBLE stack, not the largest total: hiding a
  // model must re-scale the chart, otherwise the toggle only blanks bars while
  // the axis keeps advertising volume that is no longer drawn.
  const stackTotal = (d: GroupedDaily): number => {
    if (hidden.size === 0) return d.total
    let sum = 0
    for (const [m, v] of Object.entries(d.byModel)) if (!hidden.has(m)) sum += v
    return sum
  }
  const maxTotal = Math.max(1, ...visible.map(stackTotal))
  const ticks = niceTicks(maxTotal, 4)
  // X labels keep at least ~46px between their columns — a fixed "every Nth
  // day" count collided when few days stretched across the whole plot
  // (7/14-day presets labelled every bar).
  const labelEvery = Math.max(1, Math.ceil(46 / step))

  const trendPoints: Array<{ x: number; y: number }> = []
  const trendPointByDay = new Map<string, { x: number; y: number }>()
  visible.forEach((d, i) => {
    const rate = cacheRate(d.cacheHit, d.cacheMiss)
    if (rate === null) return
    const pt = { x: padL + barHalf + i * step, y: padT + plotH - (rate / 100) * plotH }
    trendPoints.push(pt)
    trendPointByDay.set(d.day, pt)
  })
  const trendPath = smoothPath(trendPoints)
  const trendTipPt = tip ? trendPointByDay.get(tip.day) : undefined
  const rateTicks = [0, 25, 50, 75, 100]

  // Legend and bar stacks follow the overall usage ranking (not the per-day
  // leader), so a model's colour stays in the same position every day and the
  // aggregated "Other" step always sits on top.
  const legendAgg = aggregateByModel(daily)
  const legendModels = modelOrderOf(models, legendAgg)

  // The tip's headline follows the same visibility rule as the stacks: with a
  // model switched off, the day's total must describe what is drawn, not the
  // full stack the reader has just filtered away.
  const tipTotal = (t2: NonNullable<typeof tip>): number => {
    if (hidden.size === 0) return t2.total
    let sum = 0
    for (const [m, v] of Object.entries(t2.byModel)) if (!hidden.has(m)) sum += v
    return sum
  }

  return (
    <section className={css.section}>
      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>{t(granularity === 'hour' ? 'hourlyTrend' : 'dailyTrend')}</h3>
        {trendCapped && <span className={css.trendNote}>{t('trendLimited').replace('{n}', String(view.trimN))}</span>}
      </div>
      <div className={css.chartWrap} ref={wrapRef}>
        <svg className={css.chart} width="100%" height={H} viewBox={`0 0 ${plotWUsed} ${H}`} onMouseLeave={() => { setTip(null); setHover(null) }}>
          {ticks.map((tk) => {
            const y = padT + plotH - (tk / maxTotal) * plotH
            return (
              <g key={tk}>
                <line className={css.grid} x1={padL} y1={y} x2={padL + (n - 1) * step + barW} y2={y} />
                <text className={css.axis} x={padL - 6} y={y + 3} textAnchor="end">{formatCompact(tk)}</text>
              </g>
            )
          })}
          {visible.map((d, i) => {
            const x = padL + barHalf + i * step - barW / 2
            const dayOrder = legendModels.filter((m) => d.byModel[m] !== undefined && !hidden.has(m))
            let yBottom = padT + plotH
            const bars = dayOrder.map((model) => {
              const tokens = d.byModel[model]!
              const h = (tokens / maxTotal) * plotH
              const y = yBottom - h
              yBottom = y
              return { model, tokens, x, y, h, color: colorForModel(model), dimmed: hover !== null && hover !== model }
            })
            const hovered = tip?.day === d.day
            return (
              <g key={d.day}>
                {bars.map((b) => (
                  <rect
                    key={`${d.day}-${b.model}`}
                    className={clsx(css.bar, b.dimmed && css.barDim)}
                    x={b.x}
                    y={b.y}
                    width={barW}
                    height={b.h}
                    fill={b.color}
                    style={hovered ? { transform: `scaleX(${(barW + 3) / barW})` } : undefined}
                  />
                ))}
                <rect
                  className={css.barHit}
                  x={x}
                  y={padT}
                  width={barW}
                  height={plotH}
                  onMouseEnter={(e) => {
                    // The tip anchors to the hovered day column's viewport
                    // rect, so it can escape wrap clipping and follow scroll.
                    setTip({ day: d.day, total: d.total, byModel: d.byModel, otherByModel: d.otherByModel, cacheHit: d.cacheHit, cacheMiss: d.cacheMiss, anchor: e.currentTarget })
                  }}
                  onMouseLeave={() => setTip(null)}
                />
                {(i % labelEvery === 0 || i === n - 1) && (
                  <text className={css.axis} x={padL + barHalf + i * step} y={H - 8} textAnchor="middle">{bucketAxisLabel(d.day, granularity)}</text>
                )}
              </g>
            )
          })}
          <path className={css.trend} d={trendPath} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {trendTipPt && (
            <circle className={css.trendDot} cx={trendTipPt.x} cy={trendTipPt.y} r={4} />
          )}
          {rateTicks.map((p) => {
            const y = padT + plotH - (p / 100) * plotH
            return (
              <g key={`rate-${p}`}>
                <text className={clsx(css.axis, css.axisRate)} x={padL + (n - 1) * step + barW + 8} y={y + 3}>{p}%</text>
              </g>
            )
          })}
        </svg>
        {tip && (
          <ChartTip anchor={tip.anchor} panelRef={panelRef}>
            <div className={css.tipTitle}>{bucketTitle(tip.day, granularity)}</div>
            <div>{t('total')}: {formatTokens(tipTotal(tip))}</div>
            {legendModels.filter((m) => tip.byModel[m] !== undefined && !hidden.has(m)).map((m) => (
              <div key={m} className={css.tipRow}><i className={css.legendSwatch} style={{ background: colorForModel(m) }} />{m === OTHER_MODEL ? t('other') : labelForModel(m)}: {formatTokens(tip.byModel[m]!)}</div>
            ))}
            {tip.otherByModel && Object.entries(tip.otherByModel).sort((a, b) => b[1] - a[1]).map(([m, v]) => (
              <div key={m} className={clsx(css.tipRow, css.tipRowOther)}><i className={css.legendSwatch} style={{ background: OTHER_COLOR }} />{m}: {formatTokens(v)}</div>
            ))}
            <div>{t('cacheHitRate')}: {cacheRateText(tip.cacheHit, tip.cacheMiss)}</div>
          </ChartTip>
        )}
        {/* Every model legend entry is a toggle: clicking it hides/shows that
            model's stack. aria-pressed carries the state for keyboard and
            screen-reader users, and the tooltip says what a click does. */}
        <div className={css.legend}>
          {legendModels.map((model) => {
            const off = hidden.has(model)
            return (
              <button
                key={model}
                type="button"
                className={clsx(css.legendItem, css.legendToggle, off && css.legendOff)}
                aria-pressed={!off}
                title={off ? t('legendShowHint') : t('legendHideHint')}
                onClick={() => toggleHidden(model)}
                onMouseEnter={() => setHover(model)}
                onMouseLeave={() => setHover(null)}
              >
                <i className={css.legendSwatch} style={{ background: off ? 'transparent' : colorForModel(model), boxShadow: off ? `inset 0 0 0 1.5px ${colorForModel(model)}` : undefined }} />
                {model === OTHER_MODEL ? t('other') : labelForModel(model)}
              </button>
            )
          })}
          {hidden.size > 0 && (
            <button type="button" className={clsx(css.legendItem, css.legendReset)} onClick={() => setHidden(NO_KEYS)}>
              {t('legendShowAll')}
            </button>
          )}
          <span className={css.legendItem} aria-hidden="true">
            <i className={clsx(css.legendSwatch, css.legendTrend)} />
            {t('hitRateLegend')}
          </span>
        </div>
      </div>
    </section>
  )
}

// ── Section 6: per-model ring + list ────────────────────────────────────

function ModelUsage({ models, t, colorForModel, panelRef, labelForModel, estimate, currency }: {
  models: GroupedModel[]
  t: Translator
  colorForModel: (m: string) => string
  panelRef: RefObject<HTMLDivElement | null>
  labelForModel: (m: string) => string
  estimate: CostEstimate
  currency: string
}) {
  const [tip, setTip] = useState<{ model: string; tokens: number; percent: number; anchor: Element; items?: ModelTokenUsage[] } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [expandedOther, setExpandedOther] = useState(false)
  // The ring's diameter follows the row's width, so the list keeps its own
  // share of the space and expanding Other never stretches the chart.
  const rowRef = useRef<HTMLDivElement>(null)
  const size = useDonutSize(rowRef)

  if (models.length === 0) return null
  const other = models.find((m) => m.model === OTHER_MODEL)

  // Cost per model, keyed by ref: the estimate prices the RAW model rows, and
  // the displayed rows are the grouped ones (which fold the tail into Other),
  // so the lookup is by ref and a folded model keeps its own line in the tip.
  const costByModel = useMemo(() => {
    const map = new Map<string, CostLine>()
    for (const line of estimate.lines) map.set(line.model, line)
    return map
  }, [estimate])
  const hasAnyPrice = estimate.anyPriced

  // Ring order is the host's rank order, running clockwise from twelve
  // o'clock to match the list beside it: rank 1 leads, and the aggregated tail
  // (the gray Other bucket) closes the ring.
  const segments: DonutSegment[] = models.map((m) => ({
    key: m.model,
    tokens: m.tokens,
    color: colorForModel(m.model),
    label: `${m.model === OTHER_MODEL ? t('other') : labelForModel(m.model)}: ${formatTokens(m.tokens)} (${formatPercent(m.percent)})`,
  }))
  const total = models.reduce((sum, m) => sum + m.tokens, 0)

  // A ring segment and its list row drive the same highlight; only the
  // segment carries an anchor, so only it raises the tooltip.
  const highlight = (key: string | null, anchor?: Element): void => {
    setHover(key)
    const m = key === null ? undefined : models.find((x) => x.model === key)
    setTip(m !== undefined && anchor !== undefined
      ? { model: m.model, tokens: m.tokens, percent: m.percent, anchor, items: m.items }
      : null)
  }

  return (
    <section className={css.section}>
      <h3 className={css.sectionTitle}>{t('modelUsage')}</h3>
      <div className={css.models} ref={rowRef}>
        <div className={css.donutWrap}>
          <Donut
            segments={segments}
            size={size}
            ariaLabel={t('modelUsage')}
            centerValue={formatCompact(total)}
            centerCaption={t('tokens')}
            hovered={hover}
            onHover={highlight}
          />
          {tip && (
            <ChartTip anchor={tip.anchor} panelRef={panelRef}>
              <div className={css.tipTitle}>{tip.model === OTHER_MODEL ? t('other') : labelForModel(tip.model)}</div>
              <div>{t('total')}: {formatTokens(tip.tokens)}</div>
              <div>{t('percent')}: {formatPercent(tip.percent)}</div>
              {tip.model !== OTHER_MODEL && hasAnyPrice && (
                <div>{t('estimatedCost')}: {costByModel.has(tip.model) && !costByModel.get(tip.model)!.unpriced
                  ? formatCost(costByModel.get(tip.model)!.cost, currency)
                  : t('costNone')}</div>
              )}
              {tip.items && tip.items.length > 0 && (
                <div className={css.tipBreakdown}>
                  {tip.items.map((it) => (
                    <div key={it.model} className={clsx(css.tipRow, css.tipRowOther)}>
                      <i className={css.legendSwatch} style={{ background: OTHER_COLOR }} />
                      {labelForModel(it.model)}: {formatTokens(it.tokens)}
                      {hasAnyPrice && costByModel.has(it.model) && !costByModel.get(it.model)!.unpriced
                        ? ` · ${formatCost(costByModel.get(it.model)!.cost, currency)}`
                        : ''}
                    </div>
                  ))}
                </div>
              )}
            </ChartTip>
          )}
        </div>
        <ul className={css.modelList} data-dsh-usage-glass="list">
          {models.map((m, rank) => {
            const isOther = m.model === OTHER_MODEL
            return (
              <li
                key={m.model}
                className={clsx(css.modelRow, isOther && css.modelRowExpandable)}
                onMouseEnter={() => highlight(m.model)}
                onMouseLeave={() => highlight(null)}
                {...(isOther
                  ? {
                      // Mouse convenience only: the keyboard path is the real
                      // modelToggle button inside (aria-expanded + Enter/Space),
                      // so the row itself carries no role/tabIndex — a
                      // role=button li would nest two interactive elements.
                      onClick: () => setExpandedOther(!expandedOther),
                    }
                  : {})}
              >
                <span className={css.modelRank} aria-hidden="true">{isOther ? '' : rank + 1}</span>
                <i className={css.legendSwatch} style={{ background: colorForModel(m.model) }} />
                <div className={css.modelId}>
                  <span className={css.modelName}>
                    {isOther && (
                      <button
                        type="button"
                        className={css.modelToggle}
                        onClick={(e) => { e.stopPropagation(); setExpandedOther(!expandedOther) }}
                        aria-expanded={expandedOther}
                        aria-label={t('other')}
                      >
                        {expandedOther ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </button>
                    )}
                    {isOther ? t('other') : labelForModel(m.model)}
                  </span>
                  {!isOther && <span className={css.modelProvider}>{providerOf(m.model)}</span>}
                </div>
                <div className={css.modelValues}>
                  <span className={css.modelTokens}>{formatTokens(m.tokens)}</span>
                  <span className={css.modelPct}>{formatPercent(m.percent)}</span>
                  {hasAnyPrice && !isOther && (
                    <span className={css.modelCost}>
                      {costByModel.has(m.model) && !costByModel.get(m.model)!.unpriced
                        ? formatCost(costByModel.get(m.model)!.cost, currency)
                        : '—'}
                    </span>
                  )}
                </div>
              </li>
            )
          })}
          {other?.items && other.items.length > 0 && (
            <li className={clsx(css.modelOtherWrap, expandedOther && css.modelOtherOpen)}>
              <ul className={css.modelOtherList}>
                {other.items.map((it) => (
                  <li key={it.model} className={clsx(css.modelRow, css.modelRowSub)}>
                    <i className={css.legendSwatch} style={{ background: OTHER_COLOR }} />
                    <div className={css.modelId}>
                      <span className={css.modelName}>{labelForModel(it.model)}</span>
                      <span className={css.modelProvider}>{providerOf(it.model)}</span>
                    </div>
                    <div className={css.modelValues}>
                      <span className={css.modelTokens}>{formatTokens(it.tokens)}</span>
                      <span className={css.modelPct}>{formatPercent(it.percent)}</span>
                      {hasAnyPrice && (
                        <span className={css.modelCost}>
                          {costByModel.has(it.model) && !costByModel.get(it.model)!.unpriced
                            ? formatCost(costByModel.get(it.model)!.cost, currency)
                            : '—'}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          )}
        </ul>
      </div>
    </section>
  )
}

// ── Section 7: per-provider ring + list ─────────────────────────────────
//
// The same anatomy as the model section one dimension up: the ring on the
// left, the ranked list on the right, and one shared highlight so
// hovering either side lights the other. Every row opens a detail list of its
// own — a ranked provider opens the models it served, the Other bucket opens
// the providers it folded, and each of those opens ITS models (two levels).
// The hover tip carries the same breakdown for the bar's segments.

function ProviderUsage({ providers, t, colorForProvider, panelRef, labelForModel }: { providers: GroupedProvider[]; t: Translator; colorForProvider: (p: string) => string; panelRef: RefObject<HTMLDivElement | null>; labelForModel: (m: string) => string }) {
  const [tip, setTip] = useState<{ provider: string; tokens: number; percent: number; anchor: Element; models: ModelTokenUsage[] } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  // Two independent expand sets: `openRanked` holds ranked providers — and the
  // Other bucket — opening their own detail list, `openFolded` holds providers
  // folded inside Other opening theirs. Sets, not one key each, because several
  // rows may stand open at once and the two levels nest.
  const [openRanked, setOpenRanked] = useState<ReadonlySet<string>>(NO_KEYS)
  const [openFolded, setOpenFolded] = useState<ReadonlySet<string>>(NO_KEYS)
  // The ring's diameter follows the row's width, so the list keeps its own
  // share of the space and expanding a row at either level never stretches it.
  const rowRef = useRef<HTMLDivElement>(null)
  const size = useDonutSize(rowRef)

  if (providers.length === 0) return null

  const flipRanked = (key: string): void => { setOpenRanked((prev) => toggleIn(prev, key)) }
  const flipFolded = (key: string): void => { setOpenFolded((prev) => toggleIn(prev, key)) }

  const segments: DonutSegment[] = providers.map((p) => ({
    key: p.provider,
    tokens: p.tokens,
    color: colorForProvider(p.provider),
    label: `${p.provider === OTHER_PROVIDER ? t('other') : p.provider}: ${formatTokens(p.tokens)} (${formatPercent(p.percent)})`,
  }))
  const total = providers.reduce((sum, p) => sum + p.tokens, 0)

  const highlight = (key: string | null, anchor?: Element): void => {
    setHover(key)
    const p = key === null ? undefined : providers.find((x) => x.provider === key)
    setTip(p !== undefined && anchor !== undefined
      ? { provider: p.provider, tokens: p.tokens, percent: p.percent, anchor, models: p.models }
      : null)
  }

  return (
    <section className={css.section}>
      <h3 className={css.sectionTitle}>{t('providerUsage')}</h3>
      <div className={css.models} ref={rowRef}>
        <div className={css.donutWrap}>
          <Donut
            segments={segments}
            size={size}
            ariaLabel={t('providerUsage')}
            centerValue={formatCompact(total)}
            centerCaption={t('tokens')}
            hovered={hover}
            onHover={highlight}
          />
          {tip && (
            <ChartTip anchor={tip.anchor} panelRef={panelRef}>
              <div className={css.tipTitle}>{tip.provider === OTHER_PROVIDER ? t('other') : tip.provider}</div>
              <div>{t('total')}: {formatTokens(tip.tokens)}</div>
              <div>{t('percent')}: {formatPercent(tip.percent)}</div>
              {tip.models.length > 0 && (
                <div className={css.tipBreakdown}>
                  {tip.models.map((m) => (
                    <div key={m.model} className={clsx(css.tipRow, css.tipRowOther)}>
                      <i className={css.legendSwatch} style={{ background: OTHER_PROVIDER_COLOR }} />
                      {labelForModel(m.model)}: {formatTokens(m.tokens)}
                    </div>
                  ))}
                </div>
              )}
            </ChartTip>
          )}
        </div>
        <ul className={css.modelList} data-dsh-usage-glass="list">
          {providers.map((p, rank) => {
            const isOther = p.provider === OTHER_PROVIDER
            const folded = p.folded ?? []
            const open = openRanked.has(p.provider)
            const hasDetail = isOther ? folded.length > 0 : p.models.length > 0
            return (
              <Fragment key={p.provider}>
                {/* The ranked row (and the Other bucket): mouse convenience
                    only. The keyboard path is the real toggle button inside
                    (aria-expanded + Enter/Space), so the row carries no
                    role/tabIndex — a role=button li would nest two
                    interactive elements. */}
                <li
                  className={clsx(css.modelRow, css.modelRowExpandable)}
                  onMouseEnter={() => highlight(p.provider)}
                  onMouseLeave={() => highlight(null)}
                  onClick={() => flipRanked(p.provider)}
                >
                  <span className={css.modelRank} aria-hidden="true">{isOther ? '' : rank + 1}</span>
                  <i className={css.legendSwatch} style={{ background: colorForProvider(p.provider) }} />
                  <div className={css.modelId}>
                    <span className={css.modelName}>
                      <button
                        type="button"
                        className={css.modelToggle}
                        onClick={(e) => { e.stopPropagation(); flipRanked(p.provider) }}
                        aria-expanded={open}
                        aria-label={isOther ? t('other') : p.provider}
                      >
                        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </button>
                      {isOther ? t('other') : p.provider}
                    </span>
                    {!isOther && <span className={css.modelProvider}>{t('providerModels', { n: p.models.length })}</span>}
                  </div>
                  <div className={css.modelValues}>
                    <span className={css.modelTokens}>{formatTokens(p.tokens)}</span>
                    <span className={css.modelPct}>{formatPercent(p.percent)}</span>
                  </div>
                </li>
                {/* The detail list is a SIBLING of the row and never carries a
                    row class. The ring's diameter is solved from the ROW's own
                    width, never from the list's height, so opening a detail
                    list cannot resize the chart. It stays mounted (the
                    accordion animates a grid track) and is simply skipped when
                    the row has nothing to show. */}
                {hasDetail && (
                  <li className={clsx(css.modelOtherWrap, open && css.modelOtherOpen)}>
                    <ul className={css.modelOtherList}>
                      {isOther
                        ? folded.map((f) => {
                            const openSub = openFolded.has(f.provider)
                            return (
                              <Fragment key={f.provider}>
                                <li
                                  className={clsx(css.modelRow, css.modelRowSub, css.modelRowExpandable)}
                                  onClick={() => flipFolded(f.provider)}
                                >
                                  <i className={css.legendSwatch} style={{ background: OTHER_PROVIDER_COLOR }} />
                                  <div className={css.modelId}>
                                    <span className={css.modelName}>
                                      <button
                                        type="button"
                                        className={css.modelToggle}
                                        onClick={(e) => { e.stopPropagation(); flipFolded(f.provider) }}
                                        aria-expanded={openSub}
                                        aria-label={f.provider}
                                      >
                                        {openSub ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                      </button>
                                      {f.provider}
                                    </span>
                                    <span className={css.modelProvider}>{t('providerModels', { n: f.models.length })}</span>
                                  </div>
                                  <div className={css.modelValues}>
                                    <span className={css.modelTokens}>{formatTokens(f.tokens)}</span>
                                    <span className={css.modelPct}>{formatPercent(f.percent)}</span>
                                  </div>
                                </li>
                                {f.models.length > 0 && (
                                  <li className={clsx(css.modelOtherWrap, openSub && css.modelOtherOpen)}>
                                    <ul className={css.modelOtherList}>
                                      {f.models.map((m) => (
                                        <li key={m.model} className={clsx(css.modelRow, css.modelRowSub, css.modelRowDeep)}>
                                          <i className={css.legendSwatch} style={{ background: OTHER_PROVIDER_COLOR }} />
                                          <div className={css.modelId}>
                                            <span className={css.modelName}>{labelForModel(m.model)}</span>
                                          </div>
                                          <div className={css.modelValues}>
                                            <span className={css.modelTokens}>{formatTokens(m.tokens)}</span>
                                            <span className={css.modelPct}>{formatPercent(m.percent)}</span>
                                          </div>
                                        </li>
                                      ))}
                                    </ul>
                                  </li>
                                )}
                              </Fragment>
                            )
                          })
                        // A ranked provider opens the models it served, each
                        // wearing that provider's own hue so the row group reads
                        // as one block.
                        : p.models.map((m) => (
                            <li key={m.model} className={clsx(css.modelRow, css.modelRowSub)}>
                              <i className={css.legendSwatch} style={{ background: colorForProvider(p.provider) }} />
                              <div className={css.modelId}>
                                <span className={css.modelName}>{labelForModel(m.model)}</span>
                              </div>
                              <div className={css.modelValues}>
                                <span className={css.modelTokens}>{formatTokens(m.tokens)}</span>
                                <span className={css.modelPct}>{formatPercent(m.percent)}</span>
                              </div>
                            </li>
                          ))}
                    </ul>
                  </li>
                )}
              </Fragment>
            )
          })}
        </ul>
      </div>
    </section>
  )
}

// ── Section 8: model alias & unit-price editor ────────────────────────────

/** One editable row's draft state, seeded from the stored preference. */
interface PrefDraft {
  alias: string
  inputPerM: string
  outputPerM: string
  cacheReadPerM: string
  cacheWritePerM: string
}

/** Seed a row's draft from the stored preference (prices render without a
 *  trailing ".0" so the field reads like something a human typed). */
function draftOf(pref: ModelPreference | undefined): PrefDraft {
  const num = (n: number | undefined): string => (n === undefined || n === 0 ? '' : String(n))
  return {
    alias: pref?.alias ?? '',
    inputPerM: num(pref?.inputPerM),
    outputPerM: num(pref?.outputPerM),
    cacheReadPerM: num(pref?.cacheReadPerM),
    cacheWritePerM: num(pref?.cacheWritePerM),
  }
}

/** Parse one price field: blank means "no charge for this bucket". */
function parsePrice(value: string): number {
  const trimmed = value.trim()
  if (trimmed === '') return 0
  const n = Number(trimmed)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/**
 * The alias/price editor.
 *
 * Rows come from the host and are the UNION of the provider catalogue (the same
 * source Settings → Models lists) and every model the usage store has recorded,
 * so the editor stays in step with the settings page as providers are added.
 *
 * Editing is per row and explicit: a row's fields are a local draft until its
 * Save button is pressed, so a half-typed price never re-prices the whole
 * dashboard on every keystroke.
 */
function PrefEditor({ t, payload, error, onClose, onSave, onReset, onCurrency }: {
  t: Translator
  payload: UsagePrefsPayload
  error: string
  onClose: () => void
  onSave: (model: string, pref: ModelPreference | null) => Promise<void>
  onReset: (model: string) => Promise<void>
  onCurrency: (currency: string) => Promise<void>
}) {
  const prefIndex = useMemo(() => indexPrefs(payload.prefs), [payload.prefs])
  const [filter, setFilter] = useState('')
  const [drafts, setDrafts] = useState<Record<string, PrefDraft>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [aliasError, setAliasError] = useState('')
  const [currencyDraft, setCurrencyDraft] = useState(payload.currency)

  // The currency field follows the host's value whenever a save round-trips.
  useEffect(() => { setCurrencyDraft(payload.currency) }, [payload.currency])

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (needle === '') return payload.options
    return payload.options.filter((o) => o.model.toLowerCase().includes(needle) || o.name.toLowerCase().includes(needle))
  }, [payload.options, filter])

  /** The row's current draft, defaulting to its stored values. */
  const draftFor = useCallback(
    (option: UsageModelOption): PrefDraft => drafts[option.model] ?? draftOf(prefIndex.get(option.model)),
    [drafts, prefIndex],
  )

  const edit = (model: string, patch: Partial<PrefDraft>): void => {
    setAliasError('')
    setDrafts((prev) => ({ ...prev, [model]: { ...(prev[model] ?? draftOf(prefIndex.get(model))), ...patch } }))
  }

  const commit = async (option: UsageModelOption): Promise<void> => {
    const draft = draftFor(option)
    const alias = draft.alias.trim()
    if ([...alias].length > 24) {
      setAliasError(t('aliasInvalid'))
      return
    }
    const anyPrice = parsePrice(draft.inputPerM) > 0 || parsePrice(draft.outputPerM) > 0
      || parsePrice(draft.cacheReadPerM) > 0 || parsePrice(draft.cacheWritePerM) > 0
    setSaving(option.model)
    try {
      // An empty alias with no price at all is not a preference: store nothing
      // (and clear any previous row) instead of leaving a meaningless record.
      await onSave(option.model, alias === '' && !anyPrice
        ? null
        : {
            model: option.model,
            alias,
            inputPerM: parsePrice(draft.inputPerM),
            outputPerM: parsePrice(draft.outputPerM),
            cacheReadPerM: parsePrice(draft.cacheReadPerM),
            cacheWritePerM: parsePrice(draft.cacheWritePerM),
            updatedAt: Date.now(),
          })
      setDrafts((prev) => {
        const next = { ...prev }
        delete next[option.model]
        return next
      })
    } finally {
      setSaving(null)
    }
  }

  const reset = async (option: UsageModelOption): Promise<void> => {
    setSaving(option.model)
    try {
      await onReset(option.model)
      setDrafts((prev) => {
        const next = { ...prev }
        delete next[option.model]
        return next
      })
    } finally {
      setSaving(null)
    }
  }

  return (
    <section className={css.editor} data-dsh-usage-glass="editor" aria-label={t('priceEditor')}>
      <div className={css.editorHead}>
        <h3 className={css.editorTitle}>{t('priceEditor')}</h3>
        <div className={css.editorTools}>
          <label className={css.currencyField}>
            {t('currencyLabel')}
            <Input
              className={clsx(css.currencyInput)}
              value={currencyDraft}
              maxLength={4}
              aria-label={t('currencyLabel')}
              onChange={(e) => setCurrencyDraft(e.target.value)}
              onBlur={() => { if (currencyDraft !== payload.currency) void onCurrency(currencyDraft) }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur() } }}
            />
          </label>
          <Input
            className={css.editorFilter}
            placeholder={t('prefsSearch')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label={t('prefsSearch')}
          />
          <Button size="sm" variant="ghost" onClick={onClose}>{t('priceEditorClose')}</Button>
        </div>
      </div>
      <p className={css.editorHint}>{t('priceEditorHint')}</p>
      {(error !== '' || aliasError !== '') && <div className={css.editorError}>{aliasError || error}</div>}
      {visible.length === 0 ? (
        <div className={css.editorEmpty}>{t('prefsEmpty')}</div>
      ) : (
        <>
          <div className={css.editorCols} aria-hidden="true">
            <span>{t('modelColumn')}</span>
            <span>{t('aliasColumn')}</span>
            <span>{t('inputPrice')}</span>
            <span>{t('outputPrice')}</span>
            <span>{t('cacheReadPrice')}</span>
            <span>{t('cacheWritePrice')}</span>
            <span>{t('priceUnit')}</span>
          </div>
          <ul className={css.editorList}>
            {visible.map((option) => {
              const draft = draftFor(option)
              const stored = prefIndex.get(option.model)
              const busy = saving === option.model
              return (
                <li key={option.model} className={css.editorRow}>
                  <div className={css.editorModel}>
                    <span className={css.editorModelName} title={option.model}>
                      {option.name}
                      {option.seen && <span className={css.editorBadge}>{t('seenBadge')}</span>}
                    </span>
                    <span className={css.editorModelRef}>{option.provider}</span>
                  </div>
                  <Input
                    className={css.editorPrice}
                    value={draft.alias}
                    placeholder={t('aliasPlaceholder')}
                    aria-label={`${t('aliasColumn')} ${option.model}`}
                    onChange={(e) => edit(option.model, { alias: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') void commit(option) }}
                  />
                  <Input
                    className={css.editorPrice}
                    inputMode="decimal"
                    value={draft.inputPerM}
                    aria-label={`${t('inputPrice')} ${option.model}`}
                    onChange={(e) => edit(option.model, { inputPerM: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') void commit(option) }}
                  />
                  <Input
                    className={css.editorPrice}
                    inputMode="decimal"
                    value={draft.outputPerM}
                    aria-label={`${t('outputPrice')} ${option.model}`}
                    onChange={(e) => edit(option.model, { outputPerM: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') void commit(option) }}
                  />
                  <Input
                    className={css.editorPrice}
                    inputMode="decimal"
                    value={draft.cacheReadPerM}
                    aria-label={`${t('cacheReadPrice')} ${option.model}`}
                    onChange={(e) => edit(option.model, { cacheReadPerM: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') void commit(option) }}
                  />
                  <Input
                    className={css.editorPrice}
                    inputMode="decimal"
                    value={draft.cacheWritePerM}
                    aria-label={`${t('cacheWritePrice')} ${option.model}`}
                    onChange={(e) => edit(option.model, { cacheWritePerM: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') void commit(option) }}
                  />
                  <div className={css.editorActions}>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => { void commit(option) }}>
                      {busy ? `${t('savingRow')}…` : t('saveRow')}
                    </Button>
                    {stored !== undefined && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void reset(option) }}>
                        {t('resetRow')}
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}

// ── helpers ───────────────────────────────────────────────────────────────

/** Toggle one key in an immutable string set (a fresh Set every call, so React
 *  sees a state change and unrelated keys keep their state). */
function toggleIn(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

function aggregateByModel(daily: Array<{ byModel: Record<string, number> }>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const d of daily) {
    for (const [m, v] of Object.entries(d.byModel)) out[m] = (out[m] ?? 0) + v
  }
  return out
}

/** The legend model order follows the overall usage ranking, with the Other
 *  bucket pinned last (it sits on top of the stacks). */
function modelOrderOf(models: GroupedModel[], dailyAgg: Record<string, number>): string[] {
  const ranked = models
    .filter((m) => m.model !== OTHER_MODEL && dailyAgg[m.model] !== undefined)
    .map((m) => m.model)
  if (models.some((m) => m.model === OTHER_MODEL)) ranked.push(OTHER_MODEL)
  return ranked
}
