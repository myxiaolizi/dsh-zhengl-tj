/**
 * The panel speaks ONE unit vocabulary.
 *
 * The complaint this pins ("数字超过1000的用单位：K、W、M、B显示") was raised twice,
 * and the second time it was still visible in the UI even though
 * `formatCompact` existed. The reason: only six call sites used it (card
 * headline, chart axis, donut centre), while the surfaces the reader actually
 * scans — the model/provider ranked lists and every hover tooltip — still went
 * through `formatTokens`, which prints `716,363,131`.
 *
 * These tests scan the SOURCE for that leak, because a behaviour test only
 * covers the surfaces it happens to render. Any new surface that re-introduces
 * the exact form fails here.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const CLIENT_DIR = join(ROOT, 'src/client')

/** Client modules that render token counts. */
const RENDERERS = [
  'UsageStatsPanel.tsx',
  'StatCards.tsx',
  'Heatmap.tsx',
  'PrefEditor.tsx',
]

function sourceOf(file: string): string {
  return readFileSync(join(CLIENT_DIR, file), 'utf8')
}

describe('one unit vocabulary across the panel', () => {
  it('renders every token count through formatCompact, never the exact form', () => {
    for (const file of RENDERERS) {
      const source = sourceOf(file)
      expect(source, `${file} calls formatTokens`).not.toMatch(/\bformatTokens\s*\(/u)
      // ...and it must not import the exact formatter either, which would be a
      // dead import waiting to be used again.
      expect(source, `${file} imports formatTokens`).not.toMatch(/\bformatTokens\b/u)
    }
  })

  it('keeps formatCompact as the single formatter for token amounts', () => {
    // The ranked lists and the tooltips are the surfaces that regressed; assert
    // they route through the compact formatter explicitly.
    const panel = sourceOf('UsageStatsPanel.tsx')
    // Six ranked-list cells (model rows, the Other children, provider rows, the
    // folded provider rows, the two deep model lists).
    expect(panel.match(/\{formatCompact\(/gu)?.length ?? 0).toBeGreaterThanOrEqual(6)
    // Every tooltip total.
    expect(panel).toContain("{t('total')}: {formatCompact(")
  })

  it('leaves the conversation bottom bar on the exact count on purpose', () => {
    // The one exception is deliberate: the reader asked for the precise figure
    // there, not a rounded unit. If this ever flips, the exception was lost.
    const line = sourceOf('StatsLineEnhanced.tsx')
    expect(line).toMatch(/\bformatTokens\s*\(/u)
  })

  it('has no client module besides the bottom bar using formatTokens', () => {
    const offenders: string[] = []
    for (const entry of readdirSync(CLIENT_DIR)) {
      if (!/\.(ts|tsx)$/u.test(entry)) continue
      if (entry === 'StatsLineEnhanced.tsx' || entry === 'format.ts') continue
      if (/\bformatTokens\s*\(/u.test(readFileSync(join(CLIENT_DIR, entry), 'utf8'))) {
        offenders.push(entry)
      }
    }
    expect(offenders, 'these modules still print exact token counts').toEqual([])
  })
})
