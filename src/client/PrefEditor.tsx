/**
 * The alias / unit-price editor.
 *
 * Split out of UsageStatsPanel.tsx so the editing surface can be reworked
 * without touching the charts.
 *
 * State ownership is the whole point of this file's shape:
 *  - the PARENT owns only the list (filter + a fixed order) and the currency
 *    field — nothing that a keystroke can disturb;
 *  - each ROW owns its own draft, its own `dirty` flag, its own in-flight flag
 *    and its own error message. A keystroke therefore re-renders one row, not
 *    the whole table, and two rows can never overwrite each other's text.
 *
 * The host replaces the ENTIRE prefs payload after every successful save (its
 * own row's or another row's), so a row must be able to tell "the host changed
 * the stored values" apart from "the reader is mid-edit". That is exactly what
 * `dirty` plus the `seededFrom` signature below do; without them a save
 * elsewhere in the table visibly rewinds the row being typed in.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ModelPreference,
  ProviderPreference,
  UsageModelOption,
  UsagePrefsPayload,
  UsageProviderOption,
} from '../wire.ts'
import { indexPrefs } from './pricing.ts'
import type { UsageStatsTranslator } from './index.tsx'
import css from './UsageStatsPanel.module.css'

type Translator = UsageStatsTranslator

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

/**
 * A preference's values as one comparable string.
 *
 * The row compares signatures rather than object identity because the host
 * hands over a freshly built `prefs` array after every save: identity always
 * differs, the values usually do not. Comparing values is what keeps a no-op
 * payload refresh from resetting a draft.
 */
function prefSignature(pref: ModelPreference | undefined): string {
  if (pref === undefined) return ''
  return [pref.alias, pref.inputPerM, pref.outputPerM, pref.cacheReadPerM, pref.cacheWritePerM].join('\u0001')
}

/** Parse one price field: blank means "no charge for this bucket". */
function parsePrice(value: string): number {
  const trimmed = value.trim()
  if (trimmed === '') return 0
  const n = Number(trimmed)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** The message a rejected save shows.
 *
 *  The dictionary's `saveFailed` / `resetFailed` are whole sentences that state
 *  the draft was kept, so nothing is interpolated into them: the host's raw
 *  error text belongs in the panel's top-level `error` line, not inline next to
 *  a field the reader is still fixing. */
function rejectionMessage(t: Translator, key: 'saveFailed' | 'resetFailed'): string {
  return t(key)
}

/**
 * Uncommitted drafts, kept OUTSIDE React's render cycle.
 *
 * A row holds its draft in its own state, which is what stops one row's
 * keystroke from re-rendering the table — but that state dies with the row, and
 * the filter unmounts rows. Without this cache, typing an alias and then
 * filtering the list loses the text. A `ref`-backed map survives unmounts while
 * still never triggering a render, so it costs nothing on the hot path.
 *
 * Every field is optional on the row, so a caller that simply renders rows
 * without the filter still gets a working row — it just does not survive an
 * unmount.
 */
export interface DraftCache<T> {
  get: (key: string) => T | undefined
  set: (key: string, draft: T) => void
  delete: (key: string) => void
}

/** The model row's draft cache. */
export type PrefDraftCache = DraftCache<PrefDraft>

/** A cache scoped to a single component, backed by a ref so writing to it
 *  never schedules a render. */
export function useDraftCache<T>(): DraftCache<T> {
  const store = useRef<Map<string, T>>(new Map())
  return useMemo<DraftCache<T>>(() => ({
    get: (key) => store.current.get(key),
    set: (key, draft) => { store.current.set(key, draft) },
    delete: (key) => { store.current.delete(key) },
  }), [])
}

/** The props of one editable row. */
export interface PrefRowProps {
  t: Translator
  /** The model this row edits, as the host offered it. */
  option: UsageModelOption
  /** The stored preference, or undefined when the model has none. */
  stored: ModelPreference | undefined
  /** Optional shared draft cache: see {@link DraftCache}. Omit to let the row
   *  keep its draft in state alone. */
  drafts?: PrefDraftCache
  onSave: (model: string, pref: ModelPreference | null) => Promise<void>
  onReset: (model: string) => Promise<void>
}

/**
 * One model's editable row: the alias field, the four unit prices, and that
 * row's Save / Reset.
 *
 * Every field is a local draft until Save is pressed, so a half-typed price
 * never re-prices the dashboard on each keystroke. A failed save KEEPS the
 * draft — the reader's text is the only copy of it — and reports the failure
 * in place; a successful one adopts the submitted values as the new baseline
 * so the payload refresh that follows is a no-op instead of a rewind.
 */
export function PrefRow({ t, option, stored, drafts, onSave, onReset }: PrefRowProps) {
  // A cached draft means this row was edited and then unmounted (the filter
  // hides rows): its text must come back, so it seeds from the cache instead.
  const [cachedAtMount] = useState(() => drafts?.get(option.model))
  const [draft, setDraft] = useState<PrefDraft>(() => cachedAtMount ?? draftOf(stored))
  /** True from the first keystroke until the host confirms the values: while
   *  it is set, an incoming payload must NOT overwrite the reader's text. */
  const [dirty, setDirty] = useState(() => cachedAtMount !== undefined)
  const [saving, setSaving] = useState(false)
  const [rowError, setRowError] = useState('')

  const storedSig = prefSignature(stored)
  // What the draft was last seeded from. Seeded with the mount value so the
  // first effect pass does not repeat the initial state, and re-pointed after
  // every successful save so that save's own payload refresh is skipped.
  const seededFrom = useRef<string>(storedSig)
  // The draft as of the latest render: a save resolves a tick or more later,
  // and by then the reader may have typed again. Comparing against this lets
  // the post-save step tell "nothing changed" from "there is newer input to
  // keep", so a slow save cannot swallow keystrokes either.
  const latestDraft = useRef<PrefDraft>(draft)
  latestDraft.current = draft

  useEffect(() => {
    if (dirty) return
    if (seededFrom.current === storedSig) return
    seededFrom.current = storedSig
    setDraft(draftOf(stored))
  }, [dirty, stored, storedSig])

  const edit = (patch: Partial<PrefDraft>): void => {
    setRowError('')
    setDirty(true)
    const next = { ...latestDraft.current, ...patch }
    // Point the ref at the new draft immediately: two fields edited inside one
    // tick (a paste, a test's two fireEvent calls) must build on each other
    // instead of both starting from the last rendered value.
    latestDraft.current = next
    // Mirror into the cache as well: this row may be filtered away before its
    // Save button is reached, and an unmount would otherwise drop the text.
    drafts?.set(option.model, next)
    setDraft(next)
  }

  const commit = async (): Promise<void> => {
    const alias = draft.alias.trim()
    if ([...alias].length > 24) {
      setRowError(t('aliasInvalid'))
      return
    }
    const anyPrice = parsePrice(draft.inputPerM) > 0 || parsePrice(draft.outputPerM) > 0
      || parsePrice(draft.cacheReadPerM) > 0 || parsePrice(draft.cacheWritePerM) > 0
    // An empty alias with no price at all is not a preference: store nothing
    // (and clear any previous row) instead of leaving a meaningless record.
    const next: ModelPreference | null = alias === '' && !anyPrice
      ? null
      : {
          model: option.model,
          alias,
          inputPerM: parsePrice(draft.inputPerM),
          outputPerM: parsePrice(draft.outputPerM),
          cacheReadPerM: parsePrice(draft.cacheReadPerM),
          cacheWritePerM: parsePrice(draft.cacheWritePerM),
          updatedAt: Date.now(),
        }
    setSaving(true)
    setRowError('')
    const submitted = draft
    try {
      await onSave(option.model, next)
    } catch {
      // Rejected: keep the draft (see the component note) and say so in place.
      setRowError(rejectionMessage(t, 'saveFailed'))
      setSaving(false)
      return
    }
    // Accepted: adopt what was submitted as the new baseline. The host's reply
    // arrives with the same values, so the sync effect below finds nothing to
    // do and the row does not flicker back to the pre-edit text.
    seededFrom.current = prefSignature(next ?? undefined)
    setSaving(false)
    if (latestDraft.current !== submitted) return // newer keystrokes win
    drafts?.delete(option.model)
    setDraft(draftOf(next ?? undefined))
    setDirty(false)
  }

  const reset = async (): Promise<void> => {
    setSaving(true)
    setRowError('')
    const submitted = draft
    try {
      await onReset(option.model)
    } catch {
      setRowError(rejectionMessage(t, 'resetFailed'))
      setSaving(false)
      return
    }
    seededFrom.current = prefSignature(undefined)
    setSaving(false)
    if (latestDraft.current !== submitted) return // newer keystrokes win
    drafts?.delete(option.model)
    setDraft(draftOf(undefined))
    setDirty(false)
  }

  const busy = saving
  return (
    <li className={css.editorRow}>
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
        onChange={(e) => edit({ alias: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Enter') void commit() }}
      />
      <Input
        className={css.editorPrice}
        inputMode="decimal"
        value={draft.inputPerM}
        placeholder="0"
        aria-label={`${t('inputPrice')} ${option.model}`}
        onChange={(e) => edit({ inputPerM: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Enter') void commit() }}
      />
      <Input
        className={css.editorPrice}
        inputMode="decimal"
        value={draft.outputPerM}
        placeholder="0"
        aria-label={`${t('outputPrice')} ${option.model}`}
        onChange={(e) => edit({ outputPerM: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Enter') void commit() }}
      />
      <Input
        className={css.editorPrice}
        inputMode="decimal"
        value={draft.cacheReadPerM}
        placeholder="0"
        aria-label={`${t('cacheReadPrice')} ${option.model}`}
        onChange={(e) => edit({ cacheReadPerM: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Enter') void commit() }}
      />
      <Input
        className={css.editorPrice}
        inputMode="decimal"
        value={draft.cacheWritePerM}
        placeholder="0"
        aria-label={`${t('cacheWritePrice')} ${option.model}`}
        onChange={(e) => edit({ cacheWritePerM: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Enter') void commit() }}
      />
      <div className={css.editorActions}>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { void commit() }}>
          {busy ? `${t('savingRow')}…` : t('saveRow')}
        </Button>
        {stored !== undefined && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void reset() }}>
            {t('resetRow')}
          </Button>
        )}
        {rowError !== '' && <span className={css.editorError} role="alert">{rowError}</span>}
      </div>
    </li>
  )
}

/** One provider row's draft: an alias and nothing else. Providers carry no
 *  prices — cost is a per-model property — so this is the model draft minus the
 *  four price fields. */
interface ProviderDraft {
  alias: string
}

/** Seed a provider row's draft from the stored alias. */
function providerDraftOf(pref: ProviderPreference | undefined): ProviderDraft {
  return { alias: pref?.alias ?? '' }
}

/** The props of one provider-alias row. Same shape as {@link PrefRowProps},
 *  one field instead of five. */
export interface ProviderRowProps {
  t: Translator
  /** The provider this row edits, as the host offered it. */
  option: UsageProviderOption
  /** The stored provider alias, or undefined when the provider has none. */
  stored: ProviderPreference | undefined
  /** Optional shared draft cache: see {@link DraftCache}. */
  drafts?: DraftCache<ProviderDraft>
  onSave: (provider: string, pref: ProviderPreference | null) => Promise<void>
  onReset: (provider: string) => Promise<void>
}

/**
 * One provider's alias row.
 *
 * The provider-alias half of the editor, deliberately shaped exactly like
 * {@link PrefRow}: a row owns its own draft, its own `dirty` flag, and its own
 * error, so the two editors behave the same way and can share one table frame.
 * A failed save keeps the typed alias; a successful one adopts it as the new
 * baseline so the host's payload refresh is a no-op.
 */
export function ProviderRow({ t, option, stored, drafts, onSave, onReset }: ProviderRowProps) {
  const [cachedAtMount] = useState(() => drafts?.get(option.provider))
  const [draft, setDraft] = useState<ProviderDraft>(() => cachedAtMount ?? providerDraftOf(stored))
  const [dirty, setDirty] = useState(() => cachedAtMount !== undefined)
  const [saving, setSaving] = useState(false)
  const [rowError, setRowError] = useState('')

  const storedSig = stored?.alias ?? ''
  const seededFrom = useRef<string>(storedSig)
  const latestDraft = useRef<ProviderDraft>(draft)
  latestDraft.current = draft

  useEffect(() => {
    if (dirty) return
    if (seededFrom.current === storedSig) return
    seededFrom.current = storedSig
    setDraft(providerDraftOf(stored))
  }, [dirty, stored, storedSig])

  const edit = (alias: string): void => {
    setRowError('')
    setDirty(true)
    const next: ProviderDraft = { alias }
    latestDraft.current = next
    drafts?.set(option.provider, next)
    setDraft(next)
  }

  const commit = async (): Promise<void> => {
    const alias = draft.alias.trim()
    if ([...alias].length > 24) {
      setRowError(t('aliasInvalid'))
      return
    }
    // An empty alias is not a preference: clear the row instead of storing one.
    const next: ProviderPreference | null = alias === ''
      ? null
      : { provider: option.provider, alias, updatedAt: Date.now() }
    setSaving(true)
    setRowError('')
    const submitted = draft
    try {
      await onSave(option.provider, next)
    } catch {
      setRowError(rejectionMessage(t, 'saveFailed'))
      setSaving(false)
      return
    }
    seededFrom.current = next?.alias ?? ''
    setSaving(false)
    if (latestDraft.current !== submitted) return // newer keystrokes win
    drafts?.delete(option.provider)
    setDraft(providerDraftOf(next ?? undefined))
    setDirty(false)
  }

  const reset = async (): Promise<void> => {
    setSaving(true)
    setRowError('')
    const submitted = draft
    try {
      await onReset(option.provider)
    } catch {
      setRowError(rejectionMessage(t, 'resetFailed'))
      setSaving(false)
      return
    }
    seededFrom.current = ''
    setSaving(false)
    if (latestDraft.current !== submitted) return // newer keystrokes win
    drafts?.delete(option.provider)
    setDraft(providerDraftOf(undefined))
    setDirty(false)
  }

  return (
    // A provider row has three columns, not seven. `.editorRow` sizes the grid
    // for the model table, so `providerRow` overrides its track list (the
    // stylesheet owns both, so neither side carries an inline style).
    <li className={clsx(css.editorRow, css.providerRow)}>
      <div className={css.editorModel}>
        <span className={css.editorModelName} title={option.provider}>
          {option.name}
          {option.seen && <span className={css.editorBadge}>{t('seenBadge')}</span>}
        </span>
        <span className={css.editorModelRef}>{option.provider}</span>
      </div>
      <Input
        className={css.editorPrice}
        value={draft.alias}
        placeholder={t('providerAliasPlaceholder')}
        aria-label={`${t('aliasColumn')} ${option.provider}`}
        onChange={(e) => edit(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void commit() }}
      />
      <div className={css.editorActions}>
        <Button size="sm" variant="outline" disabled={saving} onClick={() => { void commit() }}>
          {saving ? `${t('savingRow')}…` : t('saveRow')}
        </Button>
        {stored !== undefined && (
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => { void reset() }}>
            {t('resetRow')}
          </Button>
        )}
        {rowError !== '' && <span className={css.editorError} role="alert">{rowError}</span>}
      </div>
    </li>
  )
}

/**
 * The alias/price editor.
 *
 * Rows come from the host and are the UNION of the provider catalogue (the same
 * source Settings → Models lists) and every model the usage store has recorded,
 * so the editor stays in step with the settings page as providers are added.
 *
 * This component deliberately holds no per-row state: it filters, orders, and
 * renders rows. See {@link PrefRow} for why that split matters.
 */
export function PrefEditor({ t, payload, error, onClose, onSave, onReset, onCurrency, onSaveProvider, onResetProvider }: {
  t: Translator
  payload: UsagePrefsPayload
  error: string
  onClose: () => void
  onSave: (model: string, pref: ModelPreference | null) => Promise<void>
  onReset: (model: string) => Promise<void>
  onCurrency: (currency: string) => Promise<void>
  onSaveProvider: (provider: string, pref: ProviderPreference | null) => Promise<void>
  onResetProvider: (provider: string) => Promise<void>
}) {
  const prefIndex = useMemo(() => indexPrefs(payload.prefs), [payload.prefs])
  const [filter, setFilter] = useState('')
  const [currencyDraft, setCurrencyDraft] = useState(payload.currency)
  // Which half of the editor is showing. The two tables have different columns
  // (models carry four prices, providers only an alias), so they are separate
  // tabs rather than one table with empty cells.
  const [tab, setTab] = useState<'model' | 'provider'>('model')
  // One cache for the editor's lifetime, so a row the filter unmounts keeps the
  // text it was holding. See DraftCache.
  const drafts = useDraftCache<PrefDraft>()
  const providerDrafts = useDraftCache<ProviderDraft>()

  // The currency field follows the host's value whenever a save round-trips.
  useEffect(() => { setCurrencyDraft(payload.currency) }, [payload.currency])

  /**
   * A FIXED order, independent of whatever order the host happens to send.
   *
   * The rows used to follow `payload.options` verbatim, so a save round-trip
   * that returned the same models in another order visibly reshuffled the table
   * under the reader's cursor. Sorting here means the client is stable even if
   * the host's `buildPrefsPayload` ordering (catalogue first, then store, or
   * whatever it does next release) changes.
   */
  const ordered = useMemo(
    () => [...payload.options].sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
    ),
    [payload.options],
  )

  // Provider rows get the same treatment: a stable order that does not depend
  // on the host's payload ordering, so saving one alias never reorders the rest.
  const providerOrdered = useMemo(
    () => [...(payload.providerOptions ?? [])].sort(
      (a, b) => a.provider.localeCompare(b.provider),
    ),
    [payload.providerOptions],
  )

  const providerPrefIndex = useMemo(() => {
    const map = new Map<string, ProviderPreference>()
    for (const pref of payload.providerPrefs ?? []) map.set(pref.provider, pref)
    return map
  }, [payload.providerPrefs])

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (needle === '') return ordered
    return ordered.filter((o) => o.model.toLowerCase().includes(needle) || o.name.toLowerCase().includes(needle))
  }, [ordered, filter])

  const visibleProviders = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (needle === '') return providerOrdered
    return providerOrdered.filter((o) => o.provider.toLowerCase().includes(needle) || o.name.toLowerCase().includes(needle))
  }, [providerOrdered, filter])

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
      {/* The unit belongs here, beside the hint: it describes every price
          column at once. It used to sit in the table's SEVENTH header cell,
          which is the action column — that mismatch is what made the header
          look shifted one column left of the data. */}
      <p className={css.editorHint}>
        {t('priceEditorHint')}{' '}
        <span>{t('priceUnit')}</span>
      </p>
      {/* Two tabs: the model table carries four prices per row, the provider
          table only a short name. Splitting them keeps each row honest about
          what it edits instead of leaving most cells empty. */}
      <div className={css.editorTabs} role="tablist" aria-label={t('priceEditor')}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'model'}
          className={clsx(css.editorTab, tab === 'model' && css.editorTabActive)}
          onClick={() => setTab('model')}
        >
          {t('modelTab')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'provider'}
          className={clsx(css.editorTab, tab === 'provider' && css.editorTabActive)}
          onClick={() => setTab('provider')}
        >
          {t('providerTab')}
        </button>
      </div>
      {error !== '' && <div className={css.editorError}>{error}</div>}
      {tab === 'provider' ? (
        <>
          <p className={css.editorHint}>{t('providerAliasHint')}</p>
          {visibleProviders.length === 0 ? (
            <div className={css.editorEmpty}>{t('providerPrefsEmpty')}</div>
          ) : (
            <>
              <div className={css.editorColsProvider} aria-hidden="true">
                <span>{t('providerColumn')}</span>
                <span>{t('aliasColumn')}</span>
                <span>{t('actionsColumn')}</span>
              </div>
              <ul className={css.editorList}>
                {visibleProviders.map((option) => (
                  <ProviderRow
                    key={option.provider}
                    t={t}
                    option={option}
                    stored={providerPrefIndex.get(option.provider)}
                    drafts={providerDrafts}
                    onSave={onSaveProvider}
                    onReset={onResetProvider}
                  />
                ))}
              </ul>
            </>
          )}
        </>
      ) : visible.length === 0 ? (
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
            <span>{t('actionsColumn')}</span>
          </div>
          <ul className={css.editorList}>
            {visible.map((option) => (
              <PrefRow
                key={option.model}
                t={t}
                option={option}
                stored={prefIndex.get(option.model)}
                drafts={drafts}
                onSave={onSave}
                onReset={onReset}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
