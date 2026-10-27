/**
 * The alias/price table's column alignment.
 *
 * The bug this pins (visible in a screenshot before the fix): the caption row
 * (`.editorCols`) and every data row (`li.editorRow`) are SEPARATE grid
 * containers, and the last track used to be `auto`. An `auto` track sizes itself
 * from its content, so a row carrying a Reset button computed different track
 * widths than the caption row — and different widths from its neighbours that
 * had no Reset button. The result was a table whose header sat one column off
 * the data and whose price fields drifted left/right row by row.
 *
 * The fix is a set of DETERMINISTIC tracks shared by both grids, with a fixed
 * width for the action column. These tests read the built rules out of the
 * stylesheet and assert that contract, so a future "just use auto" edit fails
 * here instead of in the user's screenshot.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const css = readFileSync(join(ROOT, 'src/client/UsageStatsPanel.module.css'), 'utf8')

interface Rule {
  selector: string
  body: string
}

/**
 * Every flat rule in the stylesheet, comments stripped.
 *
 * Nested at-rule bodies (`@media { .x { } }`) still contain readable inner
 * rules, so a plain brace scan finds them; the selector text carries the at-rule
 * prefix, which is harmless because lookups match on a class appearing in the
 * selector LIST.
 */
function parseRules(source: string): Rule[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//gu, '')
  const rules: Rule[] = []
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    rules.push({ selector: match[1]!.trim(), body: match[2]! })
  }
  return rules
}

const RULES = parseRules(css)

/** Bodies of every rule whose selector list names this exact class. */
function rulesFor(className: string): string[] {
  const needle = `.${className}`
  return RULES
    .filter((rule) => rule.selector.split(',').some((part) => part.trim() === needle))
    .map((rule) => rule.body)
}

/** One declaration value from the rules naming this class (last writer wins). */
function declOf(className: string, property: string): string | undefined {
  const pattern = new RegExp(`${property}:\\s*([^;]+);`, 'u')
  let found: string | undefined
  for (const body of rulesFor(className)) {
    const match = pattern.exec(body)
    if (match !== null) found = match[1]!.trim().replace(/\s+/gu, ' ')
  }
  return found
}

/**
 * Split a `grid-template-columns` value into its tracks.
 *
 * Whitespace splits tracks, but `minmax(112px, 1.5fr)` and `repeat(4, …)` carry
 * their own spaces, so the scan tracks parenthesis depth instead of splitting on
 * spaces blindly. `repeat(n, X)` is expanded, because the grid ends up with n
 * real tracks and the count is what these tests assert.
 */
function splitTracks(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const char of value) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (/\s/u.test(char) && depth === 0) {
      if (current !== '') out.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current !== '') out.push(current)

  return out.flatMap((track) => {
    const repeat = /^repeat\(\s*(\d+)\s*,\s*([\s\S]+)\)$/u.exec(track)
    if (repeat === null) return [track]
    const count = Number(repeat[1])
    const inner = splitTracks(repeat[2]!.trim())
    return Array.from({ length: count }, () => inner).flat()
  })
}

/** The declared track list of a class. */
function tracksOf(className: string): string[] {
  const value = declOf(className, 'grid-template-columns')
  if (value === undefined) throw new Error(`.${className} declares no grid-template-columns`)
  return splitTracks(value)
}

describe('alias table column alignment', () => {
  it('gives the caption row and the data rows the SAME tracks', () => {
    // This is the whole contract: two identical track lists, or the header
    // cannot line up with the data no matter what the content is.
    expect(tracksOf('editorCols')).toEqual(tracksOf('editorRow'))
  })

  it('reserves a FIXED width for the action column', () => {
    // `auto` is what broke it: the track must be the same width whether the row
    // renders one button (Save) or two (Save + Reset).
    const tracks = tracksOf('editorRow')
    expect(tracks.join(' ')).not.toMatch(/\bauto\b/u)
    expect(tracks.at(-1)).toMatch(/^\d+px$/u)
  })

  it('declares seven tracks: model, alias, four prices, actions', () => {
    expect(tracksOf('editorRow')).toHaveLength(7)
  })

  it('never uses an auto track anywhere in the stylesheet', () => {
    // A blanket guard: an `auto` grid track anywhere in this file reintroduces
    // the same class of drift, in this table or the provider one.
    for (const rule of RULES) {
      const match = /grid-template-columns:\s*([^;]+);/u.exec(rule.body)
      if (match === null) continue
      expect(match[1]!.trim()).not.toMatch(/\bauto\b/u)
    }
  })

  it('keeps the provider table on matching fixed tracks too', () => {
    expect(tracksOf('editorColsProvider')).toEqual(tracksOf('providerRow'))
    expect(tracksOf('providerRow').join(' ')).not.toMatch(/\bauto\b/u)
    expect(tracksOf('providerRow')).toHaveLength(3)
  })

  it('lets a narrow panel scroll sideways instead of reflowing the table', () => {
    // Stacking a 7-column record into 2 columns separates every price from its
    // caption — the same misalignment in another shape. The list and the caption
    // keep a shared floor, and the editor scrolls on both axes.
    expect(declOf('editorList', 'min-width')).toBe('680px')
    expect(declOf('editorCols', 'min-width')).toBe('680px')
    expect(declOf('editor', 'overflow')).toBe('auto')
  })

  it('keeps the action buttons on one line inside their fixed track', () => {
    expect(declOf('editorActions', 'flex-wrap')).toBe('nowrap')
    expect(declOf('editorActions', 'min-width')).toBe('0')
  })

  it('parks a row error on its own full-width line, not in the action cell', () => {
    // A message inside the fixed action track would widen it and shift the row.
    expect(declOf('editorRowError', 'grid-column')).toBe('1 / -1')
  })

  it('boxes the price inputs so a default-width input cannot overflow its track', () => {
    expect(declOf('editorPrice', 'box-sizing')).toBe('border-box')
  })
})
