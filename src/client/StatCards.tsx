/**
 * The numeric summary cards at the top of the usage panel.
 *
 * Split out of UsageStatsPanel.tsx so the card set (which cards exist, what
 * each one shows) can be edited without touching the chart code. Every card is
 * driven by the range aggregate the host returns; the only derived value is the
 * estimated spend, which arrives pre-computed as a `CostEstimate` so this file
 * never re-implements the pricing rules.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Activity, CalendarDays, Coins, MessageSquare, MessagesSquare, Receipt, SlidersHorizontal } from 'lucide-react'
import type { UsagePrefsPayload, UsageStatsRange } from '../wire.ts'
import { formatCost, type CostEstimate } from './pricing.ts'
import { formatCompact, formatTokens, cacheRateText } from './format.ts'
import type { UsageStatsTranslator } from './index.tsx'
import css from './UsageStatsPanel.module.css'

type Translator = UsageStatsTranslator

export function StatCards({ stats, t, estimate, prefs, pricedModels, onOpenEditor }: {
  stats: UsageStatsRange
  t: Translator
  estimate: CostEstimate
  prefs: UsagePrefsPayload
  pricedModels: number
  onOpenEditor: () => void
}) {
  const cards: Array<{ icon: typeof Coins; label: string; value: string; sm?: boolean; wrap?: boolean; hint?: string; sub?: string; cost?: boolean }> = [
    // The headline is provider-inclusive (uncached input + output + cached
    // tokens) — the number a provider dashboard reports for the same calls.
    // The headline is the compact K/W/M/B form (the number a provider dashboard
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
          {c.wrap ? (
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
