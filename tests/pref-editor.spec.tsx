/**
 * The alias/price editor's row isolation and its failure behaviour.
 *
 * These pin the two defects behind "model aliases and unit prices get mixed
 * up": a header whose seventh cell described a unit while the data under it
 * was the action buttons, and one shared draft map whose rows could overwrite
 * each other (and be overwritten by the host's own payload refresh mid-edit).
 *
 * The editor is rendered directly rather than through the panel so each
 * assertion reads one row's contract instead of a whole dashboard.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PrefEditor, ProviderRow } from '../src/client/PrefEditor.tsx'
import type { UsageStatsTranslator } from '../src/client/index.tsx'
import type {
  ModelPreference,
  ProviderPreference,
  UsageModelOption,
  UsagePrefsPayload,
  UsageProviderOption,
} from '../src/wire.ts'

/** Keys the editor renders with copy of their own; everything else passes the
 *  key through so an assertion can name the key it expects. The real
 *  dictionaries say the same thing: these two are whole sentences stating the
 *  draft was kept, with nothing interpolated. */
const DICT: Record<string, string> = {
  saveFailed: 'Could not save this row. Your input is kept — try again.',
  resetFailed: 'Could not reset this row.',
}

const t = ((key: string) => DICT[key] ?? key) as unknown as UsageStatsTranslator

/** Three models offered in a deliberately scrambled order: the editor's own
 *  sort must produce alpha/m1, alpha/m3, zed/m2. */
const OPTIONS: UsageModelOption[] = [
  { model: 'zed/m2', provider: 'zed', name: 'Zed Two', seen: true },
  { model: 'alpha/m1', provider: 'alpha', name: 'Alpha One', seen: false },
  { model: 'alpha/m3', provider: 'alpha', name: 'Alpha Three', seen: true },
]

const M1_PREF: ModelPreference = {
  model: 'alpha/m1',
  alias: 'A1',
  inputPerM: 1,
  outputPerM: 2,
  cacheReadPerM: 0,
  cacheWritePerM: 0,
  updatedAt: 1_700_000_000_000,
}

function payloadOf(prefs: ModelPreference[] = [M1_PREF], options: UsageModelOption[] = OPTIONS): UsagePrefsPayload {
  return { options, prefs, currency: '$' }
}

/** Every prop the editor needs, with the row callbacks stub-able per test. */
function editorProps(over: {
  payload?: UsagePrefsPayload
  onSave?: (model: string, pref: ModelPreference | null) => Promise<void>
  onReset?: (model: string) => Promise<void>
  onCurrency?: (currency: string) => Promise<void>
  onSaveProvider?: (provider: string, pref: ProviderPreference | null) => Promise<void>
  onResetProvider?: (provider: string) => Promise<void>
} = {}) {
  return {
    t,
    payload: over.payload ?? payloadOf(),
    error: '',
    onClose: () => {},
    onSave: over.onSave ?? vi.fn(async () => {}),
    onReset: over.onReset ?? vi.fn(async () => {}),
    onCurrency: over.onCurrency ?? vi.fn(async () => {}),
    onSaveProvider: over.onSaveProvider ?? vi.fn(async () => {}),
    onResetProvider: over.onResetProvider ?? vi.fn(async () => {}),
  }
}

/** Render the editor; `rerenderEditor` swaps in a new payload without losing
 *  the stubbed callbacks, which is how a save round-trip is simulated. */
function renderEditor(over: Parameters<typeof editorProps>[0] = {}) {
  const props = editorProps(over)
  const view = render(<PrefEditor {...props} />)
  return {
    ...view,
    props,
    rerenderEditor: (next: UsagePrefsPayload) => view.rerender(<PrefEditor {...props} payload={next} />),
    onSave: props.onSave,
    onReset: props.onReset,
    onCurrency: props.onCurrency,
  }
}

/** The field for one column of one model (the inputs carry the column label
 *  plus the model ref as their accessible name). */
function field(column: string, model: string): HTMLInputElement {
  return screen.getByLabelText(`${column} ${model}`) as HTMLInputElement
}

afterEach(() => {
  cleanup()
})

describe('PrefEditor table', () => {
  it('renders one row per model, in a fixed provider-then-model order', () => {
    renderEditor()
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    // Order comes from the editor, not from the order the host sent.
    expect(rows.map((row) => row.querySelector('[title]')?.getAttribute('title'))).toEqual([
      'alpha/m1',
      'alpha/m3',
      'zed/m2',
    ])
    // Every row carries all five editable fields.
    for (const option of OPTIONS) {
      expect(field('aliasColumn', option.model)).toBeTruthy()
      expect(field('inputPrice', option.model)).toBeTruthy()
      expect(field('outputPrice', option.model)).toBeTruthy()
      expect(field('cacheReadPrice', option.model)).toBeTruthy()
      expect(field('cacheWritePrice', option.model)).toBeTruthy()
    }
  })

  it('labels the seventh column as the action column and moves the unit into the hint', () => {
    const { container } = renderEditor()
    // The header grid is the only aria-hidden block in the section.
    const header = container.querySelector('[aria-hidden="true"]') as HTMLElement
    const captions = Array.from(header.children).map((el) => el.textContent)
    expect(captions).toEqual([
      'modelColumn',
      'aliasColumn',
      'inputPrice',
      'outputPrice',
      'cacheReadPrice',
      'cacheWritePrice',
      'actionsColumn',
    ])
    // "per 1M tokens" now lives beside the hint, outside the table.
    const unit = screen.getByText('priceUnit')
    expect(unit.closest('p')).toBeTruthy()
    expect(header.textContent).not.toContain('priceUnit')
  })

  it('seeds each row from its stored preference and leaves price fields blank-but-placeheld', () => {
    renderEditor()
    expect(field('aliasColumn', 'alpha/m1').value).toBe('A1')
    expect(field('inputPrice', 'alpha/m1').value).toBe('1')
    // An unset price renders as the "0" placeholder, not as a literal 0.
    expect(field('inputPrice', 'zed/m2').value).toBe('')
    expect(field('inputPrice', 'zed/m2').placeholder).toBe('0')
    // Only a model with a stored preference offers Reset.
    expect(screen.getAllByRole('button', { name: 'resetRow' })).toHaveLength(1)
  })
})

describe('PrefEditor row isolation', () => {
  it('keeps one row\'s draft out of another row', () => {
    renderEditor()
    const target = field('aliasColumn', 'alpha/m3')
    fireEvent.change(target, { target: { value: 'M3' } })

    expect(field('aliasColumn', 'alpha/m3').value).toBe('M3')
    // The neighbour is untouched, and it is the same DOM node (no remount).
    const neighbour = field('aliasColumn', 'zed/m2')
    expect(neighbour.value).toBe('')
    fireEvent.change(neighbour, { target: { value: 'M2' } })
    expect(field('aliasColumn', 'alpha/m3').value).toBe('M3')
    expect(field('aliasColumn', 'alpha/m1').value).toBe('A1')
  })

  it('edits the four prices independently within one row', () => {
    renderEditor()
    fireEvent.change(field('inputPrice', 'zed/m2'), { target: { value: '3' } })
    expect(field('inputPrice', 'zed/m2').value).toBe('3')
    expect(field('outputPrice', 'zed/m2').value).toBe('')
    fireEvent.change(field('outputPrice', 'zed/m2'), { target: { value: '7' } })
    expect(field('inputPrice', 'zed/m2').value).toBe('3')
    expect(field('outputPrice', 'zed/m2').value).toBe('7')
  })
})

describe('PrefEditor save failures', () => {
  it('keeps the typed draft and reports the failure inside the row', async () => {
    const onSave = vi.fn(async () => { throw new Error('boom') })
    renderEditor({ onSave })
    fireEvent.change(field('aliasColumn', 'zed/m2'), { target: { value: 'MyZed' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'saveRow' })[2]!)

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toBe('Could not save this row. Your input is kept — try again.')
    // The reader's text is the only copy of it, so a rejected save keeps it.
    expect(field('aliasColumn', 'zed/m2').value).toBe('MyZed')
    // And the row is no longer stuck in its busy state.
    expect(screen.getAllByRole('button', { name: 'saveRow' })).toHaveLength(3)
    expect(onSave).toHaveBeenCalledWith('zed/m2', expect.objectContaining({ alias: 'MyZed', inputPerM: 0 }))
  })

  it('keeps a failed reset\'s draft too', async () => {
    const onReset = vi.fn(async () => { throw new Error('nope') })
    renderEditor({ onReset })
    fireEvent.change(field('aliasColumn', 'alpha/m1'), { target: { value: 'Edited' } })
    fireEvent.click(screen.getByRole('button', { name: 'resetRow' }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toBe('Could not reset this row.')
    expect(field('aliasColumn', 'alpha/m1').value).toBe('Edited')
  })

  it('saves a row with no alias and no price as an explicit reset', async () => {
    const onSave = vi.fn(async () => {})
    renderEditor({ onSave })
    fireEvent.change(field('aliasColumn', 'alpha/m1'), { target: { value: '' } })
    fireEvent.change(field('inputPrice', 'alpha/m1'), { target: { value: '' } })
    fireEvent.change(field('outputPrice', 'alpha/m1'), { target: { value: '' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'saveRow' })[0]!)

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('alpha/m1', null))
  })
})

describe('PrefEditor payload refresh', () => {
  it('does not overwrite a dirty draft when the host replaces the payload', () => {
    const { rerenderEditor } = renderEditor()
    fireEvent.change(field('aliasColumn', 'zed/m2'), { target: { value: 'HalfTyped' } })

    // A save elsewhere replaced the whole payload: new arrays, new objects.
    rerenderEditor(payloadOf(
      [M1_PREF, { ...M1_PREF, model: 'alpha/m3', alias: 'A3' }],
      OPTIONS.map((o) => ({ ...o })),
    ))

    // The in-flight edit survives; the other rows do pick up the new values.
    expect(field('aliasColumn', 'zed/m2').value).toBe('HalfTyped')
    expect(field('aliasColumn', 'alpha/m3').value).toBe('A3')
  })

  it('accepts the host\'s values once the row is clean', () => {
    const { rerenderEditor } = renderEditor()
    expect(field('aliasColumn', 'zed/m2').value).toBe('')

    rerenderEditor(payloadOf([M1_PREF, { ...M1_PREF, model: 'zed/m2', alias: 'Z2', inputPerM: 5 }]))

    expect(field('aliasColumn', 'zed/m2').value).toBe('Z2')
    expect(field('inputPrice', 'zed/m2').value).toBe('5')
  })

  it('holds a submitted row\'s own values across the payload its save triggers', async () => {
    const onSave = vi.fn(async () => {})
    const { rerenderEditor } = renderEditor({ onSave })
    fireEvent.change(field('aliasColumn', 'zed/m2'), { target: { value: 'Z2' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'saveRow' })[2]!)
    await waitFor(() => expect(onSave).toHaveBeenCalled())

    // The host answers with the saved row echoed back: same values, new objects.
    const saved: ModelPreference = {
      model: 'zed/m2', alias: 'Z2', inputPerM: 0, outputPerM: 0,
      cacheReadPerM: 0, cacheWritePerM: 0, updatedAt: 1_700_000_000_001,
    }
    rerenderEditor(payloadOf([M1_PREF, saved]))

    expect(field('aliasColumn', 'zed/m2').value).toBe('Z2')
    // The row is clean now, so the saved model offers Reset.
    expect(screen.getAllByRole('button', { name: 'resetRow' })).toHaveLength(2)
  })

  it('filters rows without disturbing the drafts already typed', () => {
    renderEditor()
    fireEvent.change(field('aliasColumn', 'zed/m2'), { target: { value: 'Keep' } })
    fireEvent.change(screen.getByLabelText('prefsSearch'), { target: { value: 'alpha' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(2)

    fireEvent.change(screen.getByLabelText('prefsSearch'), { target: { value: '' } })
    expect(field('aliasColumn', 'zed/m2').value).toBe('Keep')
  })
})

describe('PrefEditor slow saves', () => {
  it('does not clobber keystrokes typed while a save is in flight', async () => {
    let release: () => void = () => {}
    const onSave = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    renderEditor({ onSave })
    const alias = field('aliasColumn', 'zed/m2')
    fireEvent.change(alias, { target: { value: 'First' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'saveRow' })[2]!)

    // The reader keeps typing before the host answers.
    fireEvent.change(alias, { target: { value: 'FirstAndMore' } })
    await act(async () => { release() })

    expect(onSave).toHaveBeenCalledTimes(1)
    // Newer input wins over the resolved save's own baseline.
    expect(field('aliasColumn', 'zed/m2').value).toBe('FirstAndMore')
  })
})

describe('PrefEditor tabs', () => {
  const PROVIDERS: UsageProviderOption[] = [
    { provider: 'zed', name: 'Zed', tokens: 10, seen: true },
    { provider: 'alpha', name: 'Alpha', tokens: 0, seen: false },
  ]

  function payloadWithProviders(): UsagePrefsPayload {
    return {
      ...payloadOf(),
      providerOptions: PROVIDERS,
      providerPrefs: [{ provider: 'zed', alias: 'Z', updatedAt: 1 }],
    }
  }

  it('starts on the model tab and shows the provider rows only after switching', () => {
    renderEditor({ payload: payloadWithProviders() })
    expect(screen.getByRole('tab', { name: 'modelTab' })).toHaveProperty('ariaSelected', 'true')
    expect(screen.getAllByRole('listitem')).toHaveLength(3)

    fireEvent.click(screen.getByRole('tab', { name: 'providerTab' }))

    // Two providers, in provider-name order, and the model rows are gone.
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.querySelector('[title]')?.getAttribute('title'))).toEqual(['alpha', 'zed'])
    // The provider table has three columns, not the model table's seven.
    const header = document.querySelector('[aria-hidden="true"]') as HTMLElement
    expect(Array.from(header.children).map((el) => el.textContent)).toEqual([
      'providerColumn',
      'aliasColumn',
      'actionsColumn',
    ])
  })

  it('keeps a model draft alive across a round trip through the provider tab', () => {
    renderEditor({ payload: payloadWithProviders() })
    fireEvent.change(field('aliasColumn', 'zed/m2'), { target: { value: 'StillHere' } })

    fireEvent.click(screen.getByRole('tab', { name: 'providerTab' }))
    fireEvent.click(screen.getByRole('tab', { name: 'modelTab' }))

    expect(field('aliasColumn', 'zed/m2').value).toBe('StillHere')
  })

  it('saves a provider alias through the provider callback, not the model one', async () => {
    const onSaveProvider = vi.fn(async () => {})
    const onSave = vi.fn(async () => {})
    renderEditor({ payload: payloadWithProviders(), onSaveProvider, onSave })
    fireEvent.click(screen.getByRole('tab', { name: 'providerTab' }))
    fireEvent.change(screen.getByLabelText('aliasColumn alpha'), { target: { value: 'A' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'saveRow' })[0]!)

    await waitFor(() => expect(onSaveProvider).toHaveBeenCalledWith('alpha', expect.objectContaining({ alias: 'A' })))
    expect(onSave).not.toHaveBeenCalled()
  })
})

describe('ProviderRow', () => {
  const PROVIDERS: UsageProviderOption[] = [
    { provider: 'zed', name: 'Zed', tokens: 10, seen: true },
    { provider: 'alpha', name: 'Alpha', tokens: 0, seen: false },
  ]

  /** One provider row, rendered on its own: the row is exported separately so
   *  the provider tab can mount it without the model table around it. */
  function renderProviderRow(over: {
    option?: UsageProviderOption
    stored?: ProviderPreference
    onSave?: (provider: string, pref: ProviderPreference | null) => Promise<void>
    onReset?: (provider: string) => Promise<void>
  } = {}) {
    const onSave = over.onSave ?? vi.fn(async () => {})
    const onReset = over.onReset ?? vi.fn(async () => {})
    const option = over.option ?? PROVIDERS[1]!
    const view = render(
      <ul>
        <ProviderRow
          t={t}
          option={option}
          stored={over.stored}
          onSave={onSave}
          onReset={onReset}
        />
      </ul>,
    )
    return { ...view, onSave, onReset }
  }

  function aliasField(provider: string): HTMLInputElement {
    return screen.getByLabelText(`aliasColumn ${provider}`) as HTMLInputElement
  }

  it('edits one alias and saves it as a provider preference', async () => {
    const { onSave } = renderProviderRow()
    fireEvent.change(aliasField('alpha'), { target: { value: 'BAC' } })
    expect(aliasField('alpha').placeholder).toBe('providerAliasPlaceholder')
    fireEvent.click(screen.getByRole('button', { name: 'saveRow' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith('alpha', expect.objectContaining({ provider: 'alpha', alias: 'BAC' }))
  })

  it('clears the row instead of storing an empty alias', async () => {
    const { onSave } = renderProviderRow({
      stored: { provider: 'alpha', alias: 'BAC', updatedAt: 1_700_000_000_000 },
    })
    fireEvent.change(aliasField('alpha'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'saveRow' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('alpha', null))
  })

  it('keeps the typed alias and reports a failed save in the row', async () => {
    const onSave = vi.fn(async () => { throw new Error('boom') })
    renderProviderRow({ onSave })
    fireEvent.change(aliasField('alpha'), { target: { value: 'Typed' } })
    fireEvent.click(screen.getByRole('button', { name: 'saveRow' }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toBe('Could not save this row. Your input is kept — try again.')
    expect(aliasField('alpha').value).toBe('Typed')
    expect(screen.getByRole('button', { name: 'saveRow' })).toBeTruthy()
  })

  it('does not overwrite a dirty alias when the payload refreshes', () => {
    const { rerender } = renderProviderRow()
    fireEvent.change(aliasField('alpha'), { target: { value: 'HalfTyped' } })

    rerender(
      <ul>
        <ProviderRow
          t={t}
          option={{ ...PROVIDERS[1]! }}
          stored={{ provider: 'alpha', alias: 'FromHost', updatedAt: 1 }}
          onSave={vi.fn(async () => {})}
          onReset={vi.fn(async () => {})}
        />
      </ul>,
    )
    expect(aliasField('alpha').value).toBe('HalfTyped')
  })

  it('accepts the host alias once the row is clean', () => {
    const { rerender } = renderProviderRow()
    expect(aliasField('alpha').value).toBe('')

    rerender(
      <ul>
        <ProviderRow
          t={t}
          option={{ ...PROVIDERS[1]! }}
          stored={{ provider: 'alpha', alias: 'FromHost', updatedAt: 1 }}
          onSave={vi.fn(async () => {})}
          onReset={vi.fn(async () => {})}
        />
      </ul>,
    )
    expect(aliasField('alpha').value).toBe('FromHost')
    // A stored alias means the row can be reset.
    expect(screen.getByRole('button', { name: 'resetRow' })).toBeTruthy()
  })

  it('seeds from the stored alias at mount', () => {
    renderProviderRow({
      option: PROVIDERS[0],
      stored: { provider: 'zed', alias: 'Z', updatedAt: 1 },
    })
    expect(aliasField('zed').value).toBe('Z')
  })
})
