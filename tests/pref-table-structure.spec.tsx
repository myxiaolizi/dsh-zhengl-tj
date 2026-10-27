/**
 * DOM-level structure of the alias table.
 *
 * `pref-table-alignment.spec.ts` proves the CAPTION and DATA grids share one
 * track list. That only helps if each row actually puts one element in each
 * track: a row that renders six cells under a seven-track grid shifts every
 * cell after the gap, which reads as the same misalignment (and is how the
 * original table looked before the action column was fixed).
 *
 * These tests count real rendered cells, so adding or dropping a field in
 * `PrefRow` / `ProviderRow` without updating the caption row fails here.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PrefEditor, PrefRow, ProviderRow } from '../src/client/PrefEditor.tsx'
import type { ModelPreference, ProviderPreference, UsageModelOption, UsagePrefsPayload, UsageProviderOption } from '../src/wire.ts'
import type { UsageStatsTranslator } from '../src/client/index.tsx'

const t = ((key: string) => key) as unknown as UsageStatsTranslator

const MODELS: UsageModelOption[] = [
  { model: 'alpha/one', provider: 'alpha', name: 'One', seen: true },
  { model: 'alpha/two', provider: 'alpha', name: 'Two', seen: false },
]

const PROVIDERS: UsageProviderOption[] = [
  { provider: 'alpha', name: 'Alpha', tokens: 10, seen: true },
  { provider: 'beta', name: 'Beta', tokens: 0, seen: false },
]

function payloadOf(over: Partial<UsagePrefsPayload> = {}): UsagePrefsPayload {
  return {
    options: MODELS,
    prefs: [],
    currency: '$',
    providerOptions: PROVIDERS,
    providerPrefs: [],
    ...over,
  }
}

function renderEditor(payload: UsagePrefsPayload = payloadOf()) {
  return render(
    <PrefEditor
      t={t}
      payload={payload}
      error=""
      onClose={() => {}}
      onSave={vi.fn(async () => {})}
      onReset={vi.fn(async () => {})}
      onCurrency={vi.fn(async () => {})}
      onSaveProvider={vi.fn(async () => {})}
      onResetProvider={vi.fn(async () => {})}
    />,
  )
}

/** Direct children of an element (the grid items of a row). */
const cellsOf = (el: Element): Element[] => Array.from(el.children)

/** The caption row element, found by its first caption text. */
function captionRow(container: HTMLElement, firstCaption: string): HTMLElement {
  const row = Array.from(container.querySelectorAll('div')).find(
    (el) => el.children.length > 0 && el.children[0]?.textContent === firstCaption,
  )
  if (row === undefined) throw new Error(`caption row starting with ${firstCaption} not found`)
  return row
}

afterEach(cleanup)

describe('alias table cell counts', () => {
  it('renders exactly as many cells per model row as the caption has', () => {
    const { container } = renderEditor()
    // model, alias, input, output, cache-read, cache-write, actions
    const caption = captionRow(container, 'modelColumn')
    expect(cellsOf(caption)).toHaveLength(7)

    const rows = container.querySelectorAll('li')
    expect(rows.length).toBe(MODELS.length)
    for (const row of Array.from(rows)) {
      expect(cellsOf(row), 'a model row must fill every caption column').toHaveLength(7)
    }
  })

  it('renders exactly as many cells per provider row as the provider caption has', () => {
    const { container } = renderEditor()
    // fireEvent, not a native .click(): the tab is a React onClick handler and
    // needs the synthetic event to schedule the re-render.
    fireEvent.click(screen.getByRole('tab', { name: 'providerTab' }))
    const caption = captionRow(container, 'providerColumn')
    expect(cellsOf(caption)).toHaveLength(3)

    const rows = container.querySelectorAll('li')
    expect(rows.length).toBe(PROVIDERS.length)
    for (const row of Array.from(rows)) {
      expect(cellsOf(row)).toHaveLength(3)
    }
  })

  it('keeps the action cell to the buttons only', () => {
    // A message inside the fixed-width action track would widen it and shift
    // the row; the error has its own full-width line instead.
    const option = MODELS[0]!
    const stored: ModelPreference = {
      model: option.model, alias: 'A', inputPerM: 1, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, updatedAt: 1,
    }
    render(
      <ul>
        <PrefRow t={t} option={option} stored={stored} onSave={vi.fn(async () => {})} onReset={vi.fn(async () => {})} />
      </ul>,
    )
    const row = screen.getByRole('listitem')
    const actionCell = cellsOf(row).at(-1)!
    // Only buttons (and a possible in-flight label), never the error text node.
    for (const child of cellsOf(actionCell)) {
      expect(child.tagName.toLowerCase(), 'action cell holds only controls').toMatch(/^(button|div)$/u)
    }
  })

  it('keeps the provider action cell to the buttons only', () => {
    const stored: ProviderPreference = { provider: 'alpha', alias: 'ALPHA', updatedAt: 1 }
    render(
      <ul>
        <ProviderRow t={t} option={PROVIDERS[0]!} stored={stored} onSave={vi.fn(async () => {})} onReset={vi.fn(async () => {})} />
      </ul>,
    )
    const row = screen.getByRole('listitem')
    const actionCell = cellsOf(row).at(-1)!
    for (const child of cellsOf(actionCell)) {
      expect(child.tagName.toLowerCase()).toMatch(/^(button|div)$/u)
    }
  })
})
