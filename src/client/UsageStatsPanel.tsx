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
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import clsx from 'clsx'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button, Input, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DailyTokenUsage, ModelPreference, ModelTokenUsage, ProviderPreference, ProviderTokenUsage, UsagePrefsPayload, UsageStatsRange, UsageStatsRequest } from '../wire.ts'
import { fetchPrefs, fetchRange, rebuildStats, resetPref, resetProviderAlias, saveCurrency, savePref, saveProviderAlias, UsageApiError } from './api.ts'
import { ChartTip } from './ChartTip.tsx'
import { Donut, useDonutSize, type DonutSegment } from './Donut.tsx'
import { estimateCost, formatCost, indexPrefs, indexProviderAliases, isPriced, modelLabel, normalizePrefsPayload, providerLabel, type CostEstimate, type CostLine } from './pricing.ts'
import { formatCompact, formatPercent, cacheRate, cacheRateText, localDay, bucketAxisLabel, bucketTitle, providerOf, modelNameOf, smoothPath, niceTicks } from './format.ts'
import type { UsageStatsKey } from './locales.ts'
import type { UsageStatsTranslator } from './index.tsx'
import { statsLineState } from './stats-line-state.ts'
import { StatCards } from './StatCards.tsx'
import { PrefEditor } from './PrefEditor.tsx'
import { HourlyHeatmap } from './Heatmap.tsx'
import css from './UsageStatsPanel.module.css'

/** The prefs payload before the first fetch: no aliases, no prices. */
const EMPTY_PREFS: UsagePrefsPayload = { options: [], prefs: [], currency: '$' }

type Translator = UsageStatsTranslator

const RANGE_PRESETS = ['today', '3', '7', '14', '30', '90'] as const

/** How long the rebuild button stays armed without a second press. */
const REBUILD_ARM_MS = 5000

// The heatmap's own components (and the legacy week-grid geometry solver) live
// in ./Heatmap.tsx; the panel no longer tracks a heatmap-only data window.
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

  // The heatmap rides the SAME aggregate as every other section. It used to
  // fire its own custom-range request for a fixed year-long day window; once
  // the grid became an HOURLY dot matrix that request was working against the
  // feature — the short presets (today / 3 days) already return hour keys in
  // `stats.daily`, which is exactly the granularity the dots want, while the
  // long presets return day keys and simply paint one dot per day.
  //
  // Dropping the second request also removed a whole failure surface: there is
  // no longer a heatmap-only fetch that can die while the rest of the panel
  // heals, because there is no heatmap-only fetch.

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
    } catch (e) {
      if (generationRef.current !== generation) return
      setError(e instanceof UsageApiError ? e.message : String(e))
    } finally {
      if (generationRef.current === generation) setLoading(false)
    }
  }, [range, customFrom, customTo])

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
  //
  // These RETHROW. Swallowing the failure here would make every row believe its
  // save succeeded — PrefRow only keeps the typed text when the promise
  // rejects, so a swallowed error silently discarded the edit and left the row
  // showing stale stored values. The banner carries the message; the rejection
  // is what tells the row to stay dirty.
  const savePrefRow = useCallback(async (model: string, pref: ModelPreference | null) => {
    try {
      setPrefs(normalizePrefsPayload(await savePref(model, pref)))
      setPrefsError('')
    } catch (e) {
      setPrefsError(e instanceof UsageApiError ? e.message : String(e))
      throw e
    }
  }, [])

  const resetPrefRow = useCallback(async (model: string) => {
    try {
      setPrefs(normalizePrefsPayload(await resetPref(model)))
      setPrefsError('')
    } catch (e) {
      setPrefsError(e instanceof UsageApiError ? e.message : String(e))
      throw e
    }
  }, [])

  const saveCurrencySymbol = useCallback(async (currency: string) => {
    try {
      setPrefs(normalizePrefsPayload(await saveCurrency(currency)))
      setPrefsError('')
    } catch (e) {
      setPrefsError(e instanceof UsageApiError ? e.message : String(e))
      throw e
    }
  }, [])

  // Provider short names ride the same contract as the model rows: persist,
  // fold the host's reply back, and rethrow so the row keeps the typed value
  // when the write fails.
  const saveProviderPrefRow = useCallback(async (provider: string, pref: ProviderPreference | null) => {
    try {
      setPrefs(normalizePrefsPayload(await saveProviderAlias(provider, pref?.alias ?? '')))
      setPrefsError('')
    } catch (e) {
      setPrefsError(e instanceof UsageApiError ? e.message : String(e))
      throw e
    }
  }, [])

  const resetProviderPrefRow = useCallback(async (provider: string) => {
    try {
      setPrefs(normalizePrefsPayload(await resetProviderAlias(provider)))
      setPrefsError('')
    } catch (e) {
      setPrefsError(e instanceof UsageApiError ? e.message : String(e))
      throw e
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
  // up in the legend, the ring's tooltip, the ranked list and the cost
  // breakdown alike.
  const labelForModel = useCallback(
    (model: string): string => (model === OTHER_MODEL ? t('other') : modelLabel(model, prefIndex, modelNameOf(model))),
    [prefIndex, t],
  )

  // A provider's display label, the same contract one level up: the stored
  // short name when set, otherwise the provider id. Provider rows in both the
  // ring and the ranked list run through this, so a provider alias typed once
  // shows up everywhere a provider is named.
  const providerAliases = useMemo(
    () => indexProviderAliases(prefs.providerPrefs),
    [prefs.providerPrefs],
  )
  const labelForProvider = useCallback(
    (provider: string): string => (provider === OTHER_PROVIDER
      ? t('other')
      : providerLabel(provider, providerAliases)),
    [providerAliases, t],
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
          <StatCards stats={stats} t={t} estimate={estimate} prefs={prefs} pricedModels={pricedModels} onOpenEditor={() => setShowPriceEditor(true)} />
          <HourlyHeatmap hourly={stats.daily} t={t} panelRef={panelRef} />
          <DailyTrend models={trendModels} daily={trendDaily} granularity={stats?.granularity ?? 'day'} t={t} colorForModel={colorForModel} panelRef={panelRef} labelForModel={labelForModel} />
          <ModelUsage models={trendModels} t={t} colorForModel={colorForModel} panelRef={panelRef} labelForModel={labelForModel} estimate={estimate} currency={prefs.currency} />
          <ProviderUsage providers={groupedProviders ?? []} t={t} colorForProvider={colorForProvider} panelRef={panelRef} labelForModel={labelForModel} labelForProvider={labelForProvider} />
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
          onSaveProvider={saveProviderPrefRow}
          onResetProvider={resetProviderPrefRow}
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

// ── Section 4: activity heatmap ──────────────────────────────────────────
//
// The grid renderer and its geometry solver now live in ./Heatmap.tsx so the
// heatmap strategy can be reworked without touching the rest of the panel.
// These re-exports keep this module's public surface — and the tests that
// import heatGeometry / HEAT_MAX_WEEKS from it — unchanged.
export { HEAT_MAX_WEEKS, HourlyHeatmap, heatGeometry, type HeatGeometry } from './Heatmap.tsx'

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
            <div>{t('total')}: {formatCompact(tipTotal(tip))}</div>
            {legendModels.filter((m) => tip.byModel[m] !== undefined && !hidden.has(m)).map((m) => (
              <div key={m} className={css.tipRow}><i className={css.legendSwatch} style={{ background: colorForModel(m) }} />{m === OTHER_MODEL ? t('other') : labelForModel(m)}: {formatCompact(tip.byModel[m]!)}</div>
            ))}
            {tip.otherByModel && Object.entries(tip.otherByModel).sort((a, b) => b[1] - a[1]).map(([m, v]) => (
              <div key={m} className={clsx(css.tipRow, css.tipRowOther)}><i className={css.legendSwatch} style={{ background: OTHER_COLOR }} />{m}: {formatCompact(v)}</div>
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
    label: `${m.model === OTHER_MODEL ? t('other') : labelForModel(m.model)}: ${formatCompact(m.tokens)} (${formatPercent(m.percent)})`,
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
              <div>{t('total')}: {formatCompact(tip.tokens)}</div>
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
                      {labelForModel(it.model)}: {formatCompact(it.tokens)}
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
                  <span className={css.modelTokens}>{formatCompact(m.tokens)}</span>
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
                      <span className={css.modelTokens}>{formatCompact(it.tokens)}</span>
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

function ProviderUsage({ providers, t, colorForProvider, panelRef, labelForModel, labelForProvider }: { providers: GroupedProvider[]; t: Translator; colorForProvider: (p: string) => string; panelRef: RefObject<HTMLDivElement | null>; labelForModel: (m: string) => string; labelForProvider: (p: string) => string }) {
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
    label: `${labelForProvider(p.provider)}: ${formatCompact(p.tokens)} (${formatPercent(p.percent)})`,
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
              <div className={css.tipTitle}>{labelForProvider(tip.provider)}</div>
              <div>{t('total')}: {formatCompact(tip.tokens)}</div>
              <div>{t('percent')}: {formatPercent(tip.percent)}</div>
              {tip.models.length > 0 && (
                <div className={css.tipBreakdown}>
                  {tip.models.map((m) => (
                    <div key={m.model} className={clsx(css.tipRow, css.tipRowOther)}>
                      <i className={css.legendSwatch} style={{ background: OTHER_PROVIDER_COLOR }} />
                      {labelForModel(m.model)}: {formatCompact(m.tokens)}
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
                        aria-label={labelForProvider(p.provider)}
                      >
                        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </button>
                      {labelForProvider(p.provider)}
                    </span>
                    {!isOther && <span className={css.modelProvider}>{t('providerModels', { n: p.models.length })}</span>}
                  </div>
                  <div className={css.modelValues}>
                    <span className={css.modelTokens}>{formatCompact(p.tokens)}</span>
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
                                    <span className={css.modelTokens}>{formatCompact(f.tokens)}</span>
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
                                            <span className={css.modelTokens}>{formatCompact(m.tokens)}</span>
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
                                <span className={css.modelTokens}>{formatCompact(m.tokens)}</span>
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
