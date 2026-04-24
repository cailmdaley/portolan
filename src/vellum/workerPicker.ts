/**
 * Tiny popover for choosing which worker to send annotations to. Anchored
 * below a trigger element (the chrome's "Send to worker" button).
 *
 * Lists every known worker — current-project workers first under no header,
 * then workers in other projects grouped under a divider with the city name
 * as a sub-label, then a terminal "+ New worker in {currentProject}" entry.
 * Returns the user's choice via callback; closes on outside click, Escape,
 * or selection.
 *
 * Vanilla DOM, no React — keeps the chrome path light and avoids a second
 * React root for a dropdown.
 */

export interface WorkerOption {
  id: string
  name: string
  status: 'idle' | 'working' | string
  /** Origin the worker lives on ('local' or 'remote-{host}'). Used by the
   *  caller to route the send request to the right tmux, possibly over ssh. */
  originId: string
  /** Nullable: sessions can exist without a resolved city. */
  cityId: string | null
  /** Display name of the worker's city. Shown as sub-label for other-project
   *  workers; omitted for current-project workers. */
  cityName: string | null
}

export type WorkerPickerChoice =
  | { kind: 'existing'; worker: WorkerOption }
  | { kind: 'new' }

export interface OpenWorkerPickerOptions {
  anchor: HTMLElement
  workers: WorkerOption[]
  /** The caller's current project — used to split the list and label the
   *  "new worker" action. `null` means the file isn't attached to a known
   *  city (rare); all workers render as "other." */
  currentCityId: string | null
  currentProjectLabel: string
  onPick: (choice: WorkerPickerChoice) => void
}

export function openWorkerPicker(options: OpenWorkerPickerOptions): void {
  const { anchor, workers, currentCityId, currentProjectLabel, onPick } = options

  const menu = document.createElement('div')
  menu.className = 'portolan-worker-picker'
  Object.assign(menu.style, {
    position: 'fixed',
    minWidth: '220px',
    maxWidth: '320px',
    maxHeight: '60vh',
    overflowY: 'auto',
    background: 'var(--bg-card, #EDE8E0)',
    border: '1px solid var(--border, #8B7355)',
    borderRadius: '4px',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
    zIndex: '10000',
    padding: '4px 0',
    fontFamily: "'EB Garamond', Garamond, serif",
    fontSize: '14px',
  })

  const addItem = (
    label: string,
    sub: string | null,
    onClick: () => void,
    emphasis: 'normal' | 'accent' = 'normal',
  ) => {
    const item = document.createElement('div')
    item.className = 'portolan-worker-picker__item'
    Object.assign(item.style, {
      padding: '6px 12px',
      cursor: 'pointer',
      color: emphasis === 'accent'
        ? 'var(--accent-gold, #9A7B35)'
        : 'var(--text-primary, #2E2A26)',
      transition: 'background 0.1s',
    })
    const title = document.createElement('div')
    title.textContent = label
    title.style.lineHeight = '1.3'
    item.appendChild(title)
    if (sub) {
      const subEl = document.createElement('div')
      subEl.textContent = sub
      Object.assign(subEl.style, {
        fontSize: '11px',
        color: 'var(--text-muted, #7A7368)',
        fontFamily: "'JetBrains Mono', monospace",
      })
      item.appendChild(subEl)
    }
    item.addEventListener('mouseenter', () => {
      item.style.background = 'var(--gold-faint, rgba(154,123,53,0.12))'
    })
    item.addEventListener('mouseleave', () => {
      item.style.background = ''
    })
    item.addEventListener('click', (e) => {
      e.stopPropagation()
      close()
      onClick()
    })
    menu.appendChild(item)
  }

  const addDivider = () => {
    const divider = document.createElement('div')
    Object.assign(divider.style, {
      height: '1px',
      margin: '4px 0',
      background: 'var(--border, #8B7355)',
      opacity: '0.3',
    })
    menu.appendChild(divider)
  }

  const statusDot = (status: string) => (status === 'working' ? '● ' : '○ ')
  const byName = (a: WorkerOption, b: WorkerOption) => a.name.localeCompare(b.name)

  const current = workers.filter((w) => w.cityId === currentCityId).sort(byName)
  const others = workers.filter((w) => w.cityId !== currentCityId).sort(byName)

  if (current.length === 0 && others.length === 0) {
    const empty = document.createElement('div')
    empty.textContent = 'No workers available'
    Object.assign(empty.style, {
      padding: '6px 12px',
      color: 'var(--text-muted, #7A7368)',
      fontStyle: 'italic',
      fontSize: '12px',
    })
    menu.appendChild(empty)
  } else {
    for (const w of current) {
      addItem(`${statusDot(w.status)}${w.name}`, null, () =>
        onPick({ kind: 'existing', worker: w }),
      )
    }
    if (current.length > 0 && others.length > 0) addDivider()
    for (const w of others) {
      addItem(
        `${statusDot(w.status)}${w.name}`,
        w.cityName ?? null,
        () => onPick({ kind: 'existing', worker: w }),
      )
    }
  }

  addDivider()
  addItem(
    `+ New worker in ${currentProjectLabel}`,
    null,
    () => onPick({ kind: 'new' }),
    'accent',
  )

  document.body.appendChild(menu)

  const rect = anchor.getBoundingClientRect()
  const menuRect = menu.getBoundingClientRect()
  let left = rect.left
  let top = rect.bottom + 4
  if (left + menuRect.width > window.innerWidth - 8) {
    left = window.innerWidth - menuRect.width - 8
  }
  if (top + menuRect.height > window.innerHeight - 8) {
    top = rect.top - menuRect.height - 4
  }
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    document.removeEventListener('mousedown', onOutside, true)
    document.removeEventListener('keydown', onKey, true)
    menu.remove()
  }
  const onOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node) && e.target !== anchor) close()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    }
  }
  // Defer so the click that opened the picker doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('mousedown', onOutside, true)
    document.addEventListener('keydown', onKey, true)
  }, 0)
}
