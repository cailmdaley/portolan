import type { Session } from '../state/types'

interface RecentFileTooltipEntry {
  toolName: string
  fullPath: string
  basename: string
  timestamp: number
}

export class ZoneRendererWorkerTooltip {
  private onWorkerFileClick: ((fullPath: string, originId: string, workerId: string) => void) | null = null
  private readonly tooltipEl: HTMLDivElement
  private hoverTimerId: number | null = null
  private hideTimerId: number | null = null
  private requestId = 0
  private targetWorkerId: string | null = null
  private hovered = false

  constructor() {
    this.tooltipEl = document.createElement('div')
    this.tooltipEl.className = 'worker-file-tooltip'
    this.tooltipEl.style.display = 'none'
    this.tooltipEl.addEventListener('mouseenter', this.onTooltipMouseEnter)
    this.tooltipEl.addEventListener('mouseleave', this.onTooltipMouseLeave)
    document.body.appendChild(this.tooltipEl)
  }

  setWorkerFileClickHandler(handler: (fullPath: string, originId: string, workerId: string) => void): void {
    this.onWorkerFileClick = handler
  }

  updateHover(session: Session | null, anchor: { x: number; y: number } | null): void {
    if (!session || !anchor) {
      this.targetWorkerId = null
      this.clearHoverTimer()
      this.scheduleHide()
      return
    }

    if (this.targetWorkerId === session.id) {
      if (this.hoverTimerId !== null) return
      if (this.tooltipEl.style.display !== 'none') return
    }

    this.hide(false)
    this.targetWorkerId = session.id
    this.clearHideTimer()
    this.clearHoverTimer()

    const hoverAnchor = { x: anchor.x, y: anchor.y }
    this.hoverTimerId = window.setTimeout(() => {
      this.hoverTimerId = null
      if (this.targetWorkerId !== session.id) return
      void this.show(session, hoverAnchor)
    }, 300)
  }

  clearHover(force = false): void {
    this.targetWorkerId = null
    this.clearHoverTimer()
    if (force) {
      this.hide()
      return
    }
    this.scheduleHide()
  }

  clearIfWorkerMissing(currentWorkerIds: Set<string>): void {
    if (this.targetWorkerId && !currentWorkerIds.has(this.targetWorkerId)) {
      this.hide()
    }
  }

  getRuntimeStats(): {
    visible: boolean
    hoverTimerPending: boolean
    targetWorkerId: string | null
  } {
    return {
      visible: this.tooltipEl.style.display !== 'none',
      hoverTimerPending: this.hoverTimerId !== null,
      targetWorkerId: this.targetWorkerId,
    }
  }

  dispose(): void {
    this.clearHoverTimer()
    this.clearHideTimer()
    this.tooltipEl.removeEventListener('mouseenter', this.onTooltipMouseEnter)
    this.tooltipEl.removeEventListener('mouseleave', this.onTooltipMouseLeave)
    this.tooltipEl.remove()
    this.onWorkerFileClick = null
    this.targetWorkerId = null
    this.requestId++
  }

  private onTooltipMouseEnter = (): void => {
    this.hovered = true
    this.clearHideTimer()
  }

  private onTooltipMouseLeave = (): void => {
    this.hovered = false
    this.hide()
  }

  private async show(session: Session, anchor: { x: number; y: number }): Promise<void> {
    const requestId = ++this.requestId

    const headerEl = document.createElement('div')
    headerEl.className = 'worker-file-tooltip-header'
    headerEl.textContent = session.name
    const loadingEl = document.createElement('div')
    loadingEl.className = 'worker-file-tooltip-empty'
    loadingEl.textContent = 'Loading recent files...'
    this.tooltipEl.replaceChildren(headerEl, loadingEl)
    this.tooltipEl.style.display = 'block'
    this.position(anchor)

    try {
      const response = await fetch(
        `http://${window.location.hostname}:4004/recent-files?sessionId=${encodeURIComponent(session.id)}&limit=5`
      )
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const data = await response.json() as { files?: RecentFileTooltipEntry[] }
      const files = Array.isArray(data.files)
        ? data.files.filter((entry): entry is RecentFileTooltipEntry =>
          !!entry &&
          typeof entry.fullPath === 'string' &&
          typeof entry.basename === 'string' &&
          typeof entry.toolName === 'string'
        )
        : []

      if (requestId !== this.requestId || this.targetWorkerId !== session.id) {
        return
      }
      this.render(session, files, anchor)
    } catch {
      if (requestId !== this.requestId || this.targetWorkerId !== session.id) {
        return
      }
      this.render(session, [], anchor, 'Failed to load recent files')
    }
  }

  private render(
    session: Session,
    files: RecentFileTooltipEntry[],
    anchor: { x: number; y: number },
    errorMessage?: string
  ): void {
    const headerEl = document.createElement('div')
    headerEl.className = 'worker-file-tooltip-header'
    headerEl.textContent = session.name
    this.tooltipEl.replaceChildren(headerEl)

    if (errorMessage) {
      const errorEl = document.createElement('div')
      errorEl.className = 'worker-file-tooltip-empty error'
      errorEl.textContent = errorMessage
      this.tooltipEl.appendChild(errorEl)
    } else if (files.length === 0) {
      const emptyEl = document.createElement('div')
      emptyEl.className = 'worker-file-tooltip-empty'
      emptyEl.textContent = 'No recent file touches'
      this.tooltipEl.appendChild(emptyEl)
    } else {
      const listEl = document.createElement('div')
      listEl.className = 'worker-file-tooltip-list'
      for (const entry of files.slice(0, 5)) {
        listEl.appendChild(this.createItem(session, entry))
      }
      this.tooltipEl.appendChild(listEl)
    }

    this.tooltipEl.style.display = 'block'
    this.position(anchor)
  }

  private createItem(session: Session, entry: RecentFileTooltipEntry): HTMLButtonElement {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'worker-file-tooltip-item'
    item.title = entry.fullPath

    const basenameEl = document.createElement('span')
    basenameEl.className = 'worker-file-tooltip-basename'
    basenameEl.textContent = entry.basename

    const metaEl = document.createElement('span')
    metaEl.className = 'worker-file-tooltip-meta'
    metaEl.textContent = entry.toolName

    const pathEl = document.createElement('span')
    pathEl.className = 'worker-file-tooltip-path'
    pathEl.textContent = entry.fullPath

    item.appendChild(basenameEl)
    item.appendChild(metaEl)
    item.appendChild(pathEl)

    item.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.onWorkerFileClick?.(entry.fullPath, session.originId, session.id)
      this.hide()
    })

    return item
  }

  private position(anchor: { x: number; y: number }): void {
    const margin = 12
    const rect = this.tooltipEl.getBoundingClientRect()

    let left = anchor.x + 14
    let top = anchor.y - rect.height - 14
    if (top < margin) {
      top = anchor.y + 14
    }
    if (left + rect.width > window.innerWidth - margin) {
      left = window.innerWidth - rect.width - margin
    }
    if (left < margin) {
      left = margin
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = window.innerHeight - rect.height - margin
    }
    if (top < margin) {
      top = margin
    }

    this.tooltipEl.style.left = `${Math.round(left)}px`
    this.tooltipEl.style.top = `${Math.round(top)}px`
  }

  private clearHoverTimer(): void {
    if (this.hoverTimerId !== null) {
      window.clearTimeout(this.hoverTimerId)
      this.hoverTimerId = null
    }
  }

  private clearHideTimer(): void {
    if (this.hideTimerId !== null) {
      window.clearTimeout(this.hideTimerId)
      this.hideTimerId = null
    }
  }

  private scheduleHide(): void {
    if (this.tooltipEl.style.display === 'none') return
    if (this.hovered) return

    this.clearHideTimer()
    this.hideTimerId = window.setTimeout(() => {
      this.hideTimerId = null
      if (this.hovered) return
      this.hide()
    }, 120)
  }

  private hide(resetTarget = true): void {
    this.clearHoverTimer()
    this.clearHideTimer()
    this.requestId++
    this.hovered = false
    this.tooltipEl.style.display = 'none'
    this.tooltipEl.replaceChildren()
    if (resetTarget) {
      this.targetWorkerId = null
    }
  }
}
