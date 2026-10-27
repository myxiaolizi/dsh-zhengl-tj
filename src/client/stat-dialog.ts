/**
 * One trigger-anchored stat dialog seat for the composer-dock pills.
 * Replicates the official ui-chat stat-dialog.ts: open state (optionally
 * controlled so sibling dialogs share one exclusive slot), viewport-clamped
 * placement above the trigger, outside-pointer close, and Escape close.
 *
 * The document-level capture-phase `click` close is what keeps at most one
 * dialog open once each pill owns its own state (DSH 0.2.1-alpha.1 split the
 * dock row into one entry per pill, so the shared controlled slot is only
 * reachable from the pre-split single-entry row). A mouse click on a sibling
 * pill is outside this trigger AND this panel, so this listener closes the
 * incumbent during the capture phase — before the sibling's own onClick
 * bubble handler opens it. Keyboard activation of a sibling pill never
 * stacks a second dialog either, because the sibling's root is outside this
 * one. All imports are platform externals (react + primitives), so the
 * client-bundle purity gate accepts this module.
 */
import { useEffect, useRef, useState, type CSSProperties, type MutableRefObject } from 'react'
import { useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'

/** Viewport margin the placement clamp keeps (the Menu portal margin). */
const PANEL_MARGIN = 12

/** Distance between the trigger's top edge and the panel's bottom. */
const PANEL_GAP = 8

/**
 * Unplaced portal panel: hidden but laid out so the clamp measures real
 * dimensions (the `useAnchoredPosition` measure pass).
 */
export const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/** Open state, refs, and clamped placement for one stat dialog. */
export interface StatDialogSeat {
  open: boolean
  setOpen: (open: boolean) => void
  rootRef: MutableRefObject<HTMLSpanElement | null>
  panelRef: MutableRefObject<HTMLDivElement | null>
  pos: CSSProperties | null
}

/**
 * One trigger-anchored dialog seat: open state, viewport-clamped placement,
 * outside-close.
 * @param controlled - external open state; when given the seat reads and
 *   writes it instead of owning its own, letting sibling dialogs share one
 *   exclusive slot (the pre-split single-entry row).
 */
export function useStatDialog(controlled?: Pick<StatDialogSeat, 'open' | 'setOpen'>): StatDialogSeat {
  const [ownOpen, setOwnOpen] = useState(false)
  const open = controlled?.open ?? ownOpen
  const setOpen = controlled?.setOpen ?? setOwnOpen
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const pos = useAnchoredPosition({
    open,
    anchorRef: rootRef,
    panelRef,
    side: 'top',
    gap: PANEL_GAP,
    margin: PANEL_MARGIN,
  })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onClick = (e: MouseEvent): void => {
      const target = e.target as Node
      if (rootRef.current?.contains(target) !== true && panelRef.current?.contains(target) !== true) setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('click', onClick, true)
    }
  }, [open, setOpen])
  return { open, setOpen, rootRef, panelRef, pos }
}
