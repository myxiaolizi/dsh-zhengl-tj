/**
 * The hourly heatmap's height contract.
 *
 * The chart this replaced was a 7-row GitHub-style week grid: its SVG alone was
 * 7*(14+3)+3 = 122px tall, and with the section title it pushed everything
 * below it down far enough that the layout read as broken. The dot matrix must
 * stay under ~90px no matter how much data it is given, which is what these
 * tests measure — on the rendered SVG's own height attribute, not on a helper's
 * arithmetic.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { createRef } from 'react'
import { HourlyHeatmap } from '../src/client/Heatmap.tsx'
import type { DailyTokenUsage } from '../src/wire.ts'
import type { UsageStatsTranslator } from '../src/client/index.tsx'

const t = ((key: string) => key) as unknown as UsageStatsTranslator

/** One hourly bucket, keyed the way the host emits hour mode. */
function hour(day: string, h: number, total = 500): DailyTokenUsage {
  return {
    day: `${day}T${String(h).padStart(2, '0')}`,
    total,
    byModel: { 'p/m': total },
    byProvider: { p: total },
    requests: 1,
    turns: 0,
    cacheHit: total / 2,
    cacheMiss: total / 2,
  }
}

/** N consecutive hours from an arbitrary start day. */
function hours(n: number): DailyTokenUsage[] {
  const out: DailyTokenUsage[] = []
  for (let i = 0; i < n; i++) out.push(hour('2026-10-20', i, 100 + i))
  return out
}

function renderDots(data: DailyTokenUsage[]) {
  const ref = createRef<HTMLDivElement>()
  const { container } = render(<HourlyHeatmap hourly={data} t={t} panelRef={ref} />)
  return { container, svg: container.querySelector('svg[aria-label="heatmap"]') as SVGSVGElement | null }
}

const heightOf = (svg: SVGSVGElement | null): number => Number(svg?.getAttribute('height') ?? 0)
const rectsOf = (container: HTMLElement): Element[] =>
  [...container.querySelectorAll('svg[aria-label="heatmap"] rect')]

afterEach(cleanup)

describe('hourly heatmap height budget', () => {
  it('draws one rect per hour bucket', () => {
    const { container } = renderDots(hours(24))
    expect(rectsOf(container)).toHaveLength(24)
  })

  it('stays well under the 122px week grid it replaced, even with a full day of hours', () => {
    // 24 dots at 72 fallback columns land on ONE row: 8px tall.
    const { svg } = renderDots(hours(24))
    expect(heightOf(svg)).toBe(8)
    expect(heightOf(svg)).toBeLessThan(122)
  })

  it('never exceeds the documented ceiling (6 rows = 63px) whatever the data size', () => {
    // A 90-day range in hour mode is 2160 buckets; the matrix must still be
    // bounded by its row cap, not grow with the data.
    const { container, svg } = renderDots(hours(2160))
    expect(heightOf(svg)).toBeLessThanOrEqual(63)
    // 6 rows × 8px + 5 gutters × 3px
    expect(heightOf(svg)).toBe(6 * 8 + 5 * 3)
    // ...and the overflow is trimmed to the newest buckets, not all drawn.
    expect(rectsOf(container).length).toBeLessThanOrEqual(72 * 6)
  })

  it('drops the whole section when there is no data, leaving no empty box', () => {
    const { container } = renderDots([])
    expect(container.querySelector('svg[aria-label="heatmap"]')).toBeNull()
    expect(container.innerHTML).toBe('')
  })

  it('accepts day keys too, so a day-granularity range still paints', () => {
    // Long presets return "YYYY-MM-DD"; the matrix renders one dot per day.
    const days: DailyTokenUsage[] = ['2026-10-18', '2026-10-19', '2026-10-20'].map((day) => ({
      day,
      total: 400,
      byModel: { 'p/m': 400 },
      byProvider: { p: 400 },
      requests: 1,
      turns: 0,
      cacheHit: 200,
      cacheMiss: 200,
    }))
    const { container, svg } = renderDots(days)
    expect(rectsOf(container)).toHaveLength(3)
    expect(heightOf(svg)).toBe(8)
  })

  it('maps token volume onto the five intensity steps, with zero staying blank', () => {
    const data = [
      hour('2026-10-20', 0, 0),    // no traffic -> level 0
      hour('2026-10-20', 1, 1000), // the window max -> warmest step
      hour('2026-10-20', 2, 10),
    ]
    const { container } = renderDots(data)
    const classes = rectsOf(container).map((el) => el.getAttribute('class') ?? '')
    expect(classes[0]).toContain('heatLevel0')
    expect(classes[1]).toContain('heatLevel5')
    // A token trickle is still visibly non-empty.
    expect(classes[2]).not.toContain('heatLevel0')
  })
})
