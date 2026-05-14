export interface WorkspaceModalActionsOptions {
  onClose: () => void
  showDuplicateCurrentWindow?: boolean
  onDuplicateCurrentWindow?: () => void | Promise<void>
}

export interface WorkspaceModalActions {
  container: HTMLDivElement
  closeButton: HTMLButtonElement
  duplicateButton: HTMLButtonElement | null
}

function createActionButton(args: {
  className: string
  ariaLabel: string
  title: string
  textContent?: string
  innerHTML?: string
  onClick: () => void | Promise<void>
}): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = args.className
  button.setAttribute('aria-label', args.ariaLabel)
  button.title = args.title
  if (args.textContent) button.textContent = args.textContent
  if (args.innerHTML) button.innerHTML = args.innerHTML

  let busy = false
  button.addEventListener('click', () => {
    if (busy) return
    busy = true
    button.disabled = true
    const finish = () => {
      busy = false
      button.disabled = false
    }
    try {
      Promise.resolve(args.onClick()).finally(finish)
    } catch (error) {
      finish()
      throw error
    }
  })

  return button
}

export function createWorkspaceModalActions(
  options: WorkspaceModalActionsOptions,
): WorkspaceModalActions {
  const container = document.createElement('div')
  container.className = 'vellum-workspace-modal-actions'

  const closeButton = createActionButton({
    className: 'vellum-workspace-modal-action vellum-workspace-modal-action--close',
    ariaLabel: 'Close vellum workspace (Esc)',
    title: 'Close (Esc)',
    textContent: '×',
    onClick: options.onClose,
  })
  container.appendChild(closeButton)

  const duplicateButton = options.showDuplicateCurrentWindow && options.onDuplicateCurrentWindow
    ? createActionButton({
        className: 'vellum-workspace-modal-action vellum-workspace-modal-action--duplicate',
        ariaLabel: 'Open this workspace in a new window',
        title: 'New window (⌘N)',
        innerHTML:
          '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
          + '<rect x="2.25" y="4.25" width="8.5" height="8.5" rx="1.25" />'
          + '<path d="M5.25 1.75 H12.75 V9.25" />'
          + '<path d="M12.75 1.75 L8.75 1.75" />'
          + '<path d="M12.75 1.75 L12.75 5.75" />'
          + '</svg>',
        onClick: options.onDuplicateCurrentWindow,
      })
    : null

  if (duplicateButton) container.appendChild(duplicateButton)

  return { container, closeButton, duplicateButton }
}
