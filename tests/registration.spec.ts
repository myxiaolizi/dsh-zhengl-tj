/**
 * Client-half registration surface: the panel must be reachable from two
 * places — the Plugins page (`plugins.bundle.config`, keyed by this bundle's
 * npm name) and its own sidebar row (`sidebar.panellist` plus the global main
 * panel that row selects) — and the retired seats must stay retired. A fake
 * ctx records every registration, so a future edit that silently re-adds a
 * Settings section, or moves the entry back into the shared footer row, fails
 * here instead of in the browser.
 *
 * The composer-dock takeover is host-line dependent (see the dock block), so
 * the fake also carries the dock's entry ledger: what a host REGISTERED is
 * what decides which ids this build shadows.
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, BUNDLE_NAME, PANEL_ID } from '../src/client/index.tsx'
import type { Context, UsageSlotEntrySpec } from '../src/context-types.ts'

/** The dock ledger both host lines are faked through: the split host shows the
 *  official activity/usage pair, the pre-split host the single stats entry. */
const SPLIT_DOCK = ['activity', 'usage']
const PRE_SPLIT_DOCK = ['stats']

function fakeCtx(dockIds: string[] = SPLIT_DOCK): {
  ctx: Context
  recorded: UsageSlotEntrySpec[]
  /** Publish a new dock ledger, notifying the injected subscription. */
  publishDock: (ids: string[]) => void
} {
  const recorded: UsageSlotEntrySpec[] = []
  const dockListeners = new Set<() => void>()
  let ledger = [...dockIds]
  const ctx = {
    effect: (fn: () => void | (() => void)) => { fn() },
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
    },
    slots: {
      // The framework defers the factory until the slot is declared; the fake
      // declares every slot immediately, which is the steady state.
      inject: (_name: string, callback: () => void | (() => void)) => { callback() },
      register: (spec: UsageSlotEntrySpec) => { recorded.push(spec); return () => {} },
      // Only the dock is probed; every other key reports an empty ledger.
      entries: (name: string) => (name === 'conversation.composer.dock'
        ? ledger.map((id) => ({ options: { id } }))
        : []),
      subscribe: (name: string, listener: () => void) => {
        if (name !== 'conversation.composer.dock') return () => {}
        dockListeners.add(listener)
        return () => { dockListeners.delete(listener) }
      },
    },
    // The back control's history source; this spec is about the registration
    // surface, so the panel never moves here.
    layout: {
      panelInfo: {
        getSnapshot: () => ({ activePanelId: null }),
        subscribe: () => () => {},
      },
      selectPanel: () => {},
    },
  } as unknown as Context
  return {
    ctx,
    recorded,
    publishDock: (ids: string[]) => {
      ledger = [...ids]
      for (const listener of [...dockListeners]) listener()
    },
  }
}

/** The ids of every composer-dock registration, in registration order. */
function dockIds(recorded: UsageSlotEntrySpec[]): Array<string | undefined> {
  return recorded.filter((r) => r.name === 'conversation.composer.dock').map((r) => r.id)
}

afterEach(() => { vi.unstubAllGlobals() })

describe('client registration surface', () => {
  it('registers the panel on the Plugins page, keyed by the bundle name', () => {
    const { ctx, recorded } = fakeCtx()
    apply(ctx)
    const panel = recorded.find((r) => r.name === 'plugins.bundle.config')
    expect(panel).toBeDefined()
    expect(panel!.key).toBe(BUNDLE_NAME)
    expect(BUNDLE_NAME).toBe('dsh-zhengl-tj')
  })

  it('registers a global main panel and the sidebar row that selects it', () => {
    const { ctx, recorded } = fakeCtx()
    apply(ctx)
    const main = recorded.find((r) => r.name === 'main')
    const row = recorded.find((r) => r.name === 'sidebar.panellist')
    expect(main).toBeDefined()
    expect(row).toBeDefined()
    // The row addresses the panel by the same key the main slot declares.
    expect(main!.key).toBe(PANEL_ID)
    expect(row!.id).toBe(PANEL_ID)
  })

  it('keys the Plugins-page entry by the package name, not a copied literal', () => {
    // The page renders a bundle's own entry only when the registration key
    // EQUALS the bundle's npm package name, so a rename in package.json that
    // misses BUNDLE_NAME would silently drop the panel from the Plugins page.
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { name: string }
    expect(BUNDLE_NAME).toBe(pkg.name)
  })

  it('orders the sidebar row after the shipped panel rows, labelled from the dictionary', () => {
    const { ctx, recorded } = fakeCtx()
    apply(ctx)
    const row = recorded.find((r) => r.name === 'sidebar.panellist')!
    // The shipped Plugins page row registers at order 0 (ui-plugin-manager);
    // ours must sort after it, and its label must resolve through the bound
    // locale dictionary (the fake t returns the key verbatim).
    expect(row.order).toBe(30)
    expect(row.locale).toBe('usageStats')
    expect(row.label?.()).toBe('nav')
  })

  it('does not register into the shared footer row', () => {
    // That seat is one flex row shared with every other plugin's action, where
    // an entry competes for width instead of getting a row of its own.
    const { ctx, recorded } = fakeCtx()
    apply(ctx)
    expect(recorded.some((r) => r.name === 'sidebar.footer.action')).toBe(false)
  })

  it('no longer registers a Settings section', () => {
    const { ctx, recorded } = fakeCtx()
    apply(ctx)
    expect(recorded.some((r) => r.name === 'settings.section')).toBe(false)
  })

  it('keeps the composer-dock takeover', () => {
    const { ctx, recorded } = fakeCtx()
    apply(ctx)
    expect(recorded.some((r) => r.name === 'conversation.composer.dock')).toBe(true)
  })
})

/**
 * The dock takeover must shadow whichever ids the host actually publishes:
 * DSH 0.2.1-alpha.1 split the single `stats` entry into `activity` + `usage`
 * (official release notes: plugins replacing the former `stats` row must
 * update their registered IDs). Registering the wrong shape is the bug itself:
 * a non-matching id does not shadow, it renders an extra entry beside the
 * official row.
 */
describe('composer-dock takeover host contract', () => {
  it('shadows the split activity and usage entries on DSH >= 0.2.1-alpha.1', () => {
    const { ctx, recorded } = fakeCtx(SPLIT_DOCK)
    apply(ctx)
    const dock = recorded.filter((r) => r.name === 'conversation.composer.dock')
    expect(dock.map((r) => r.id)).toEqual(['activity', 'usage'])
    // Below the official priority 0 (lowest live entry renders => shadows) and
    // in the official display order.
    expect(dock.map((r) => r.priority)).toEqual([-1, -1])
    expect(dock.map((r) => r.order)).toEqual([0, 1])
    expect(dock.map((r) => r.locale)).toEqual(['usageStats', 'usageStats'])
  })

  it('shadows the single stats entry on the pre-split host', () => {
    const { ctx, recorded } = fakeCtx(PRE_SPLIT_DOCK)
    apply(ctx)
    expect(dockIds(recorded)).toEqual(['stats'])
    expect(recorded.find((r) => r.name === 'conversation.composer.dock')!.priority).toBe(-1)
  })

  it('never registers both shapes at once', () => {
    // Either id set on the wrong host renders extra pills instead of shadowing,
    // so the two shapes must stay mutually exclusive.
    for (const ledger of [SPLIT_DOCK, PRE_SPLIT_DOCK]) {
      const { ctx, recorded } = fakeCtx(ledger)
      apply(ctx)
      const ids = dockIds(recorded)
      expect(ids.includes('stats') && (ids.includes('activity') || ids.includes('usage'))).toBe(false)
    }
  })

  it('waits for the official entries instead of guessing when the ledger is still empty', () => {
    // ui-chat may register after this plugin; the takeover must then follow the
    // first shape the dock publishes rather than defaulting to either contract.
    const { ctx, recorded, publishDock } = fakeCtx([])
    apply(ctx)
    expect(dockIds(recorded)).toEqual([])
    publishDock(PRE_SPLIT_DOCK)
    expect(dockIds(recorded)).toEqual(['stats'])
  })

  it('decides once: a later ledger change cannot add the other shape', () => {
    const { ctx, recorded, publishDock } = fakeCtx([])
    apply(ctx)
    publishDock(SPLIT_DOCK)
    expect(dockIds(recorded)).toEqual(['activity', 'usage'])
    // Our own registrations mutate the same ledger; a re-decision would stack
    // the pre-split row on top of the split pair.
    publishDock([...SPLIT_DOCK, 'stats'])
    publishDock(SPLIT_DOCK)
    expect(dockIds(recorded)).toEqual(['activity', 'usage'])
  })
})
