// WorkerActivityPanel.ts - Left-side panel showing worker activity history

import type { Activity, Session } from '../state/types'
import { escapeHtml, formatTimeAgo } from './utils'

type FileClickCallback = (activity: Activity, originId: string, workerId: string) => void

export class WorkerActivityPanel {
  private panel: HTMLElement
  private closeBtn: HTMLElement
  private resizeHandle: HTMLElement
  private workerName: HTMLElement
  private workerInfo: HTMLElement
  private activityList: HTMLElement
  private currentSession: Session | null = null
  private currentActivities: Activity[] = []
  private ignoreNextClick = false
  private isResizing = false
  private minWidth = 280
  private maxWidth = 600
  private onFileClick: FileClickCallback | null = null

  constructor() {
    this.panel = this.createPanel()
    this.closeBtn = this.panel.querySelector('.close-btn')!
    this.resizeHandle = this.panel.querySelector('.resize-handle')!
    this.workerName = this.panel.querySelector('.worker-name')!
    this.workerInfo = this.panel.querySelector('.worker-info')!
    this.activityList = this.panel.querySelector('.activity-list')!

    this.setupEventListeners()
    this.setupResizeHandling()
    document.body.appendChild(this.panel)
  }

  private createPanel(): HTMLElement {
    const panel = document.createElement('div')
    panel.id = 'worker-panel'
    panel.className = 'panel'
    panel.innerHTML = `
      <div class="resize-handle"></div>
      <button class="close-btn">&times;</button>
      <h2 class="worker-name"></h2>
      <p class="worker-info"></p>
      <section class="activity-section">
        <h3>Activity Feed</h3>
        <ul class="activity-list"></ul>
      </section>
    `
    return panel
  }

  private setupEventListeners(): void {
    // Close button
    this.closeBtn.addEventListener('click', () => this.hide())

    // Click outside to close
    document.addEventListener('click', (e) => {
      if (this.ignoreNextClick) {
        this.ignoreNextClick = false
        return
      }
      if (this.panel.classList.contains('visible')) {
        const target = e.target as HTMLElement
        if (!this.panel.contains(target)) {
          this.hide()
        }
      }
    })

    // Escape key to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.panel.classList.contains('visible')) {
        this.hide()
      }
    })
  }

  private setupResizeHandling(): void {
    const onMouseMove = (e: MouseEvent) => {
      if (!this.isResizing) return
      const newWidth = e.clientX
      const clampedWidth = Math.min(this.maxWidth, Math.max(this.minWidth, newWidth))
      this.panel.style.width = `${clampedWidth}px`
    }

    const onMouseUp = () => {
      if (this.isResizing) {
        this.isResizing = false
        this.resizeHandle.classList.remove('dragging')
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }

    this.resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.isResizing = true
      this.resizeHandle.classList.add('dragging')
      document.body.style.cursor = 'ew-resize'
      document.body.style.userSelect = 'none'
    })

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  setOnFileClick(callback: FileClickCallback): void {
    this.onFileClick = callback
  }

  show(session: Session, activities: Activity[]): void {
    this.currentSession = session
    this.currentActivities = activities
    this.workerName.textContent = session.name
    this.workerInfo.textContent = `${session.tmuxSession} · ${session.originId === 'local' ? 'local' : session.originId}`

    // Render activities
    this.renderActivities(activities)

    // Ignore the click that triggered this show
    this.ignoreNextClick = true

    // Show panel
    this.panel.classList.add('visible')
  }

  updateActivities(tmuxSession: string, activities: Activity[]): void {
    if (this.currentSession?.tmuxSession === tmuxSession && this.panel.classList.contains('visible')) {
      this.currentActivities = activities
      this.renderActivities(activities)
    }
  }

  private renderActivities(activities: Activity[]): void {
    if (activities.length === 0) {
      this.activityList.innerHTML = '<li class="empty">No recent activity</li>'
      return
    }

    this.activityList.innerHTML = activities.map((a, i) => this.renderActivityItem(a, i)).join('')
    this.attachClickListeners()
  }

  private renderActivityItem(activity: Activity, index: number): string {
    const timeAgo = formatTimeAgo(activity.timestamp)
    const toolClass = this.getToolClass(activity.tool)
    const isClickable = activity.fullPath && ['Read', 'Write', 'Edit'].includes(activity.tool)
    const clickableClass = isClickable ? 'clickable' : ''

    return `
      <li class="activity-item ${clickableClass}" data-index="${index}" data-tool="${activity.tool}">
        <div class="activity-header">
          <span class="activity-time">${timeAgo}</span>
          <span class="activity-tool ${toolClass}">${activity.tool}</span>
        </div>
        <div class="activity-summary">${escapeHtml(activity.summary || '')}</div>
      </li>
    `
  }

  private attachClickListeners(): void {
    this.activityList.querySelectorAll('.activity-item.clickable').forEach(item => {
      item.addEventListener('click', () => {
        const indexStr = (item as HTMLElement).dataset.index
        if (indexStr && this.onFileClick && this.currentSession) {
          const index = parseInt(indexStr, 10)
          const activity = this.currentActivities[index]
          if (activity) {
            this.onFileClick(activity, this.currentSession.originId, this.currentSession.id)
          }
        }
      })
    })
  }

  private getToolClass(tool: string): string {
    const toolClasses: Record<string, string> = {
      'Read': 'tool-read',
      'Write': 'tool-write',
      'Edit': 'tool-edit',
      'Bash': 'tool-bash',
      'Glob': 'tool-search',
      'Grep': 'tool-search',
      'Task': 'tool-task',
    }
    return toolClasses[tool] || 'tool-other'
  }

  hide(): void {
    this.panel.classList.remove('visible')
    this.currentSession = null
  }

  isVisible(): boolean {
    return this.panel.classList.contains('visible')
  }
}
