import { describe, expect, it, vi } from 'vitest'

import { createWorkspaceModalActions } from './workspaceModalActions'

describe('createWorkspaceModalActions', () => {
  it('always renders a close button that invokes onClose', () => {
    const onClose = vi.fn()
    const { container, closeButton, duplicateButton } = createWorkspaceModalActions({ onClose })

    expect(container.querySelector('.vellum-workspace-modal-action--close')).toBe(closeButton)
    expect(closeButton.title).toBe('Close (Esc)')
    expect(duplicateButton).toBeNull()

    closeButton.click()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders a duplicate-window button only when native duplication is enabled', () => {
    const onClose = vi.fn()
    const onDuplicateCurrentWindow = vi.fn()
    const { container, duplicateButton } = createWorkspaceModalActions({
      onClose,
      showDuplicateCurrentWindow: true,
      onDuplicateCurrentWindow,
    })

    expect(container.querySelector('.vellum-workspace-modal-action--duplicate')).toBe(duplicateButton)
    expect(duplicateButton?.getAttribute('aria-label')).toBe('Open this workspace in a new window')
    expect(duplicateButton?.title).toBe('New window (⌘N)')

    duplicateButton?.click()
    expect(onDuplicateCurrentWindow).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('serializes duplicate-window clicks while the action is in flight', async () => {
    let resolveDuplicate!: () => void
    const onDuplicateCurrentWindow = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveDuplicate = resolve
      }),
    )
    const { duplicateButton } = createWorkspaceModalActions({
      onClose: vi.fn(),
      showDuplicateCurrentWindow: true,
      onDuplicateCurrentWindow,
    })
    if (!duplicateButton) throw new Error('duplicate button missing')

    duplicateButton.click()
    duplicateButton.click()

    expect(onDuplicateCurrentWindow).toHaveBeenCalledTimes(1)
    expect(duplicateButton.disabled).toBe(true)

    resolveDuplicate()
    await Promise.resolve()
    await Promise.resolve()

    expect(duplicateButton.disabled).toBe(false)
  })
})
