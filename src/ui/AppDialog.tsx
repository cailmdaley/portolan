/**
 * AppDialog — a thin Radix Dialog wrapper that should be the default surface
 * for *new* modals in portolan.
 *
 * Background: the surviving legacy modals in this codebase
 * (`NewWorkerDialog`, `PlaygroundViewer`, `KanbanModal`) are imperative
 * DOM-driven classes that share the hand-rolled `modalBackgroundLock`
 * helper for body-scroll/focus locking. They were not migrated to Radix
 * in Stage K because each one has idiosyncratic open-points scattered
 * across the codebase and the migration risk is much larger than the win
 * — see the constitution's "Lean on stable packages" decision (≥50 LOC
 * saved, headless / TS-typed / stable; opportunistic adoption only).
 * (The pre-Stage-I `GlobalSearchPalette` and `KanbanLaunchButton`
 * retired alongside the CityHUD overlay; `RecentWorkerBar` retired in
 * Stage H along with the legacy `t` hotkey.)
 *
 * What changes for *new* modals: instead of growing a fresh
 * `lockModalBackground`-style class, mount a React component that uses
 * `AppDialog` (or Radix's `Dialog.*` primitives directly). That gives us
 * focus trap, escape-to-close, accessible labelling, scroll lock, and
 * portal-to-body for free, and stays consistent with vellum's own internal
 * modals which already use Radix-style patterns.
 *
 * Where to hook in: any new component under `src/ui/` or `src/vellum/`
 * that needs to summon a modal. Import this module's `AppDialog` (preset
 * styling matched to portolan's surface tokens) or, when you need finer
 * control, import `@radix-ui/react-dialog` directly and reuse
 * `appDialogContentStyles` / `appDialogOverlayStyles` for visual
 * consistency.
 *
 * Usage:
 *   ```tsx
 *   <AppDialog
 *     open={open}
 *     onOpenChange={setOpen}
 *     title="Confirm something"
 *     description="Optional sub-line."
 *   >
 *     <p>Body content.</p>
 *     <button onClick={() => setOpen(false)}>Cancel</button>
 *   </AppDialog>
 *   ```
 *
 * `title` is required (Radix accessibility contract: every dialog must
 * have an accessible name); pass `descriptionVisuallyHidden` if the title
 * should be SR-only rather than rendered in the header.
 */

import * as Dialog from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'

export const appDialogOverlayStyles: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(20, 16, 12, 0.42)',
  backdropFilter: 'blur(2px)',
  zIndex: 200,
}

export const appDialogContentStyles: React.CSSProperties = {
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  background: 'var(--surface, #FBF8F3)',
  color: 'var(--text, #2A2118)',
  border: '1px solid var(--border-muted, #D8D2C8)',
  borderRadius: '6px',
  padding: '1.25rem 1.4rem',
  minWidth: '20rem',
  maxWidth: 'min(40rem, 92vw)',
  maxHeight: '85vh',
  overflow: 'auto',
  zIndex: 201,
  boxShadow: '0 12px 28px rgba(20, 16, 12, 0.18)',
}

export interface AppDialogProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  title: ReactNode
  description?: ReactNode
  /** Visually hide the title but keep it readable to screen readers. Default false. */
  titleVisuallyHidden?: boolean
  children: ReactNode
}

export function AppDialog({
  open,
  onOpenChange,
  title,
  description,
  titleVisuallyHidden = false,
  children,
}: AppDialogProps): JSX.Element {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay style={appDialogOverlayStyles} />
        <Dialog.Content style={appDialogContentStyles}>
          <Dialog.Title
            style={
              titleVisuallyHidden
                ? {
                    position: 'absolute',
                    width: 1,
                    height: 1,
                    padding: 0,
                    margin: -1,
                    overflow: 'hidden',
                    clip: 'rect(0, 0, 0, 0)',
                    whiteSpace: 'nowrap',
                    border: 0,
                  }
                : {
                    margin: 0,
                    fontSize: '1rem',
                    fontWeight: 500,
                    paddingBottom: '0.4rem',
                    borderBottom: '1px solid var(--border-muted, #E5DFD5)',
                  }
            }
          >
            {title}
          </Dialog.Title>
          {description && (
            <Dialog.Description
              style={{
                margin: '0.4rem 0 0.85rem',
                fontSize: '0.85rem',
                opacity: 0.7,
                lineHeight: 1.5,
              }}
            >
              {description}
            </Dialog.Description>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
