/**
 * Token-count display units.
 *
 * Two contracts live here and they must not be confused:
 *  - `formatCompact` is the DEFAULT reading — K / W / M / B. Every surface the
 *    reader scans (card values, ranked-list columns, chart axis, every tooltip)
 *    uses it, so one number never appears as "716,363,131" in one place and
 *    "716.4M" in another.
 *  - `formatTokens` is the exact, thousands-separated form, kept for the
 *    conversation bottom bar where the reader wants the precise count.
 *
 * The tier ladder is 10^3 (K) → 10^4 (万, "W") → 10^6 (M) → 10^9 (B). The 万 tier
 * is what makes five-digit counts readable in Chinese: 15000 → "1.5W" instead of
 * "15K".
 */
import { describe, expect, it } from 'vitest'
import { formatCompact, formatTokens } from '../src/client/format.ts'

describe('formatCompact unit ladder', () => {
  it('leaves anything under a thousand as a plain integer', () => {
    expect(formatCompact(0)).toBe('0')
    expect(formatCompact(1)).toBe('1')
    expect(formatCompact(999)).toBe('999')
  })

  it('uses K from one thousand', () => {
    expect(formatCompact(1000)).toBe('1K')
    expect(formatCompact(1200)).toBe('1.2K')
    expect(formatCompact(9999)).toBe('10K')
  })

  it('uses W (万) from ten thousand', () => {
    // The five-digit band where K would read badly: 15000 is 1.5万.
    expect(formatCompact(10_000)).toBe('1W')
    expect(formatCompact(15_000)).toBe('1.5W')
    expect(formatCompact(99_999)).toBe('10W')
    expect(formatCompact(123_456)).toBe('12.3W')
    expect(formatCompact(999_999)).toBe('100W')
  })

  it('uses M from a million', () => {
    expect(formatCompact(1_000_000)).toBe('1M')
    expect(formatCompact(1_234_567)).toBe('1.2M')
    expect(formatCompact(12_345_678)).toBe('12.3M')
    expect(formatCompact(123_456_789)).toBe('123.5M')
  })

  it('uses B from a billion', () => {
    expect(formatCompact(1_000_000_000)).toBe('1B')
    expect(formatCompact(2_500_000_000)).toBe('2.5B')
  })

  it('carries a value that would round up to 1000 in its own tier into the next one', () => {
    // The regression this pins: 999,999,999 used to render as "1000M" — four
    // digits plus a suffix, which is wider than the tier it belongs to and reads
    // as a mistake next to the neighbouring "999.9M". A rounded value at the top
    // of a tier must escalate, exactly like 9999.6 escalates from K to W.
    expect(formatCompact(999_999_999)).toBe('1B')
    expect(formatCompact(9999.6)).toBe('1W')
    expect(formatCompact(999_999.6)).toBe('1M')
    // Just below the escalation point the tier keeps its own label: 999.94M
    // still rounds to 999.9M, so nothing escalates early.
    expect(formatCompact(999_940_000)).toBe('999.9M')
  })

  it('drops a meaningless trailing .0', () => {
    expect(formatCompact(2000)).toBe('2K')
    expect(formatCompact(20_000)).toBe('2W')
    expect(formatCompact(2_000_000)).toBe('2M')
  })

  it('compacts negatives by magnitude and never prints "-0"', () => {
    expect(formatCompact(-15_000)).toBe('-1.5W')
    expect(formatCompact(-2_500_000)).toBe('-2.5M')
    expect(formatCompact(-0)).toBe('0')
  })

  it('degrades non-finite input to a printable placeholder', () => {
    // Never "NaNK" / "InfinityB": those would leak into the UI.
    expect(formatCompact(Number.NaN)).toBe('—')
    expect(formatCompact(Number.POSITIVE_INFINITY)).toBe('∞')
    expect(formatCompact(Number.NEGATIVE_INFINITY)).toBe('-∞')
  })

  it('keeps the exact form available for the conversation bar', () => {
    // formatTokens is deliberately NOT compacted: the bottom bar shows the
    // precise count.
    expect(formatTokens(716_363_131)).toBe('716,363,131')
    expect(formatTokens(1000)).toBe('1,000')
  })
})
