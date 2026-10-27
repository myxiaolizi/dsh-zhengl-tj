/**
 * `formatCompact` unit tiers (task-1 / T5): B / M / 万=W / K, one decimal with
 * a meaningless trailing ".0" dropped, plus the non-finite guards.
 *
 * `formatTokens` is asserted here too — deliberately, as a regression fence:
 * it is the exact-value counterpart and must NOT pick up units while
 * `formatCompact` gains the 万 tier.
 */
import { describe, expect, it } from 'vitest'
import { formatCompact, formatTokens } from '../src/client/format.ts'

describe('formatCompact — tier boundaries', () => {
  it('keeps values under 1000 as plain integers', () => {
    expect(formatCompact(0)).toBe('0')
    expect(formatCompact(1)).toBe('1')
    expect(formatCompact(999)).toBe('999')
  })

  it('uses K from 1000 up to just under 万', () => {
    expect(formatCompact(1000)).toBe('1K')
    expect(formatCompact(1024)).toBe('1K')
    expect(formatCompact(1200)).toBe('1.2K')
    // 9999 is still below the 1e4 tier, so it renders as a rounded 10K.
    expect(formatCompact(9999)).toBe('10K')
  })

  it('uses W (万) from 10000 up to just under 1e6', () => {
    expect(formatCompact(10000)).toBe('1W')
    expect(formatCompact(15000)).toBe('1.5W')
    expect(formatCompact(99999)).toBe('10W')
    expect(formatCompact(999999)).toBe('100W')
  })

  it('moves the panel fixture value 12345 from the old "12.3K" to "1.2W"', () => {
    // This is the value `tests/panel.spec.tsx` feeds the Tokens card
    // (`tokens: 12_345`), so it is the authoritative reading for that spec:
    // the 万 tier now claims five-digit counts, and "12.3K" is superseded.
    expect(formatCompact(12_345)).toBe('1.2W')
  })

  it('uses M from 1e6 up to just under 1e9', () => {
    expect(formatCompact(1000000)).toBe('1M')
    expect(formatCompact(1234567)).toBe('1.2M')
    expect(formatCompact(1500000)).toBe('1.5M')
    // 999,999,999 rounds up to 1000M, which belongs to the B tier: escalation
    // keeps the suffix honest instead of printing four digits under M.
    expect(formatCompact(999999999)).toBe('1B')
  })

  it('uses B from 1e9 upward', () => {
    expect(formatCompact(1e9)).toBe('1B')
    expect(formatCompact(2.5e9)).toBe('2.5B')
    expect(formatCompact(1e12)).toBe('1000B')
  })
})

describe('formatCompact — trailing ".0" is dropped', () => {
  it('renders a whole tier without a decimal', () => {
    expect(formatCompact(2000)).toBe('2K')
    expect(formatCompact(20000)).toBe('2W')
    expect(formatCompact(2e6)).toBe('2M')
    expect(formatCompact(2e9)).toBe('2B')
  })

  it('keeps a decimal that carries information', () => {
    expect(formatCompact(1500)).toBe('1.5K')
    expect(formatCompact(15000)).toBe('1.5W')
    expect(formatCompact(1.5e6)).toBe('1.5M')
    expect(formatCompact(1.5e9)).toBe('1.5B')
  })
})

describe('formatCompact — negatives compact by magnitude', () => {
  it('keeps the sign in front of the unit', () => {
    expect(formatCompact(-1)).toBe('-1')
    expect(formatCompact(-999)).toBe('-999')
    expect(formatCompact(-1000)).toBe('-1K')
    expect(formatCompact(-15000)).toBe('-1.5W')
    expect(formatCompact(-1500000)).toBe('-1.5M')
    expect(formatCompact(-1e9)).toBe('-1B')
  })

  it('does not print a signed zero', () => {
    expect(formatCompact(-0)).toBe('0')
  })
})

describe('formatCompact — non-finite input is safe', () => {
  it('never leaks NaN or Infinity into a unit string', () => {
    expect(formatCompact(NaN)).toBe('—')
    expect(formatCompact(Infinity)).toBe('∞')
    expect(formatCompact(-Infinity)).toBe('-∞')
  })

  it('returns a printable string with no NaN/Infinity substring', () => {
    for (const bad of [NaN, Infinity, -Infinity, 0, -0, 999, 1e12]) {
      const out = formatCompact(bad)
      expect(typeof out).toBe('string')
      expect(out.length).toBeGreaterThan(0)
      expect(out).not.toContain('NaN')
      expect(out).not.toContain('Infinity')
    }
  })
})

describe('formatCompact — fractional input rounds before tiering', () => {
  it('promotes a value that rounds up into the next tier', () => {
    expect(formatCompact(999.6)).toBe('1K')
    expect(formatCompact(9999.6)).toBe('1W')
  })

  it('rounds within its own tier', () => {
    expect(formatCompact(1500.5)).toBe('1.5K')
  })
})

describe('formatTokens — unchanged exact thousands separators', () => {
  it('keeps the precise number with no units at any magnitude', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1000)).toBe('1,000')
    expect(formatTokens(1024)).toBe('1,024')
    expect(formatTokens(10000)).toBe('10,000')
    expect(formatTokens(15000)).toBe('15,000')
    expect(formatTokens(999999)).toBe('999,999')
    expect(formatTokens(1000000)).toBe('1,000,000')
    expect(formatTokens(1500000)).toBe('1,500,000')
    expect(formatTokens(1e9)).toBe('1,000,000,000')
    expect(formatTokens(1e12)).toBe('1,000,000,000,000')
  })

  it('keeps the sign for negatives', () => {
    expect(formatTokens(-15000)).toBe('-15,000')
  })
})
