// WorkerActivityPanel.ts - Left-side panel showing worker conversation

import type { Activity, Session, ConversationMessage } from '../state/types'
import { escapeHtml, formatTimeAgo, renderMarkdown, highlightCodeBlocks } from './utils'

type FileClickCallback = (activity: Activity, originId: string, workerId: string) => void

export class WorkerActivityPanel {
  private panel: HTMLElement
  private closeBtn: HTMLElement
  private resizeHandle: HTMLElement
  private workerName: HTMLElement
  private workerInfo: HTMLElement
  private conversationList: HTMLElement
  private currentSession: Session | null = null
  private currentActivities: Activity[] = []
  private currentConversation: ConversationMessage[] = []
  private ignoreNextClick = false
  private isResizing = false
  private minWidth = 400
  private maxWidth = 900
  private onFileClick: FileClickCallback | null = null
  private conversationPollInterval: ReturnType<typeof setInterval> | null = null
  private expandedMessages: Set<number> = new Set()
  private isInitialRender = true

  constructor() {
    this.panel = this.createPanel()
    this.closeBtn = this.panel.querySelector('.close-btn')!
    this.resizeHandle = this.panel.querySelector('.resize-handle')!
    this.workerName = this.panel.querySelector('.worker-name')!
    this.workerInfo = this.panel.querySelector('.worker-info')!
    this.conversationList = this.panel.querySelector('.conversation-list')!

    this.setupEventListeners()
    this.setupResizeHandling()
    this.setupScrollHandling()
    document.body.appendChild(this.panel)
  }

  private setupScrollHandling(): void {
    // Safari fix: ensure wheel events are passive to allow smooth scrolling
    const section = this.panel.querySelector('.conversation-section')
    if (section) {
      // Passive wheel listener helps Safari not block scroll
      section.addEventListener('wheel', () => {}, { passive: true })
      // Also handle touchmove for trackpad gestures
      section.addEventListener('touchmove', () => {}, { passive: true })
    }
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
      <section class="conversation-section">
        <h3>Conversation</h3>
        <div class="conversation-list"></div>
      </section>
    `
    return panel
  }

  private setupEventListeners(): void {
    // Close button
    this.closeBtn.addEventListener('click', () => this.hide())

    // Click outside to close (but not if clicking in file viewer)
    document.addEventListener('click', (e) => {
      if (this.ignoreNextClick) {
        this.ignoreNextClick = false
        return
      }
      if (this.panel.classList.contains('visible')) {
        const target = e.target as HTMLElement
        // Don't close if file viewer modal is open and click is inside it
        const fileViewer = document.querySelector('.file-viewer-modal.visible')
        if (fileViewer?.contains(target)) return
        const fileViewerBackdrop = document.querySelector('.file-viewer-backdrop.visible')
        if (fileViewerBackdrop?.contains(target)) return
        if (!this.panel.contains(target)) {
          this.hide()
        }
      }
    })

    // Escape key to close (but not if file viewer is open)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.panel.classList.contains('visible')) {
        // Don't close if file viewer modal is open - it handles its own Escape
        const fileViewer = document.querySelector('.file-viewer-modal.visible')
        if (fileViewer) return
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

  /**
   * Get file paths from current activities for navigation
   */
  getFilePaths(): string[] {
    return this.currentActivities
      .filter(a => a.fullPath)
      .map(a => a.fullPath!)
  }

  /**
   * Get index of a file in the current activities list
   */
  getFileIndex(fullPath: string): number {
    return this.currentActivities.findIndex(a => a.fullPath === fullPath)
  }

  show(session: Session, activities: Activity[]): void {
    this.currentSession = session
    this.currentActivities = activities
    this.expandedMessages.clear()
    this.isInitialRender = true  // Reset for new session
    this.workerName.textContent = session.name
    this.workerInfo.textContent = `${session.tmuxSession} · ${session.originId === 'local' ? 'local' : session.originId}`

    // Show panel immediately with loading state
    this.conversationList.innerHTML = '<div class="conv-loading">Loading conversation...</div>'
    this.ignoreNextClick = true
    this.panel.classList.add('visible')

    // Fetch and render conversation
    this.fetchConversation(session.id)

    // Start polling for updates
    this.startConversationPolling(session.id)
  }

  private async fetchConversation(sessionId: string): Promise<void> {
    try {
      const response = await fetch(`http://localhost:4004/conversation?sessionId=${encodeURIComponent(sessionId)}&limit=100`)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const data = await response.json()
      if (data.messages) {
        this.currentConversation = data.messages
        this.renderConversation()
      }
    } catch (error) {
      console.error('Failed to fetch conversation:', error)
      // Fall back to activity view if conversation unavailable
      this.renderActivitiesFallback()
    }
  }

  private startConversationPolling(sessionId: string): void {
    this.stopConversationPolling()
    // Poll every 3 seconds for conversation updates
    this.conversationPollInterval = setInterval(() => {
      if (this.panel.classList.contains('visible') && this.currentSession?.id === sessionId) {
        this.fetchConversation(sessionId)
      }
    }, 3000)
  }

  private stopConversationPolling(): void {
    if (this.conversationPollInterval) {
      clearInterval(this.conversationPollInterval)
      this.conversationPollInterval = null
    }
  }

  updateActivities(tmuxSession: string, activities: Activity[]): void {
    if (this.currentSession?.tmuxSession === tmuxSession && this.panel.classList.contains('visible')) {
      this.currentActivities = activities
      // Activities are now secondary - conversation is primary
    }
  }

  private renderConversation(): void {
    if (this.currentConversation.length === 0) {
      this.conversationList.innerHTML = '<div class="conv-empty">No conversation yet</div>'
      return
    }

    // Pre-process: build a map of tool_use_id -> tool_result
    const toolResultMap = new Map<string, ConversationMessage>()
    for (const msg of this.currentConversation) {
      if (msg.type === 'tool_result' && msg.toolUseId) {
        toolResultMap.set(msg.toolUseId, msg)
      }
    }

    // Render, skipping tool_result (they'll be shown with their tool_use)
    const html = this.currentConversation
      .map((msg, i) => {
        if (msg.type === 'tool_result') return '' // Skip, rendered with tool_use
        if (msg.type === 'tool_use') {
          const result = msg.toolUseId ? toolResultMap.get(msg.toolUseId) : undefined
          return this.renderToolUse(msg, i, formatTimeAgo(new Date(msg.timestamp).getTime()), result)
        }
        return this.renderConversationItem(msg, i)
      })
      .join('')
    this.conversationList.innerHTML = html
    this.attachConversationListeners()

    // Apply syntax highlighting to code blocks
    highlightCodeBlocks(this.conversationList)

    // Auto-scroll to bottom on initial render, or if user is already near the bottom
    // This prevents interrupting reading when polling updates the conversation
    const section = this.conversationList.parentElement
    if (section) {
      const isNearBottom = section.scrollHeight - section.scrollTop - section.clientHeight < 100
      if (this.isInitialRender || isNearBottom) {
        section.scrollTop = section.scrollHeight
        this.isInitialRender = false
      }
    }
  }

  private renderConversationItem(msg: ConversationMessage, index: number): string {
    const timeAgo = formatTimeAgo(new Date(msg.timestamp).getTime())
    const isExpanded = this.expandedMessages.has(index)

    switch (msg.type) {
      case 'user':
        return this.renderUserMessage(msg, index, timeAgo, isExpanded)
      case 'assistant':
        return this.renderAssistantMessage(msg, index, timeAgo, isExpanded)
      case 'thinking':
        return this.renderThinkingBlock(msg, index, timeAgo, isExpanded)
      case 'tool_use':
        // Rendered in renderConversation with result
        return this.renderToolUse(msg, index, timeAgo, undefined)
      case 'tool_result':
        // Rendered inline with tool_use, skip
        return ''
      default:
        return ''
    }
  }

  private renderUserMessage(msg: ConversationMessage, index: number, timeAgo: string, isExpanded: boolean): string {
    const truncated = this.truncateText(msg.content, 200)
    const needsTruncation = truncated.length < msg.content.length
    // Use markdown for expanded, escaped for truncated (avoid broken markdown)
    const displayText = isExpanded ? renderMarkdown(msg.content) : escapeHtml(truncated)
    const wrapperClass = needsTruncation && !isExpanded ? 'msg-wrapper truncated' : 'msg-wrapper'
    const expandAttr = needsTruncation ? `data-expand-idx="${index}"` : ''

    return `
      <div class="conv-item user-msg">
        <span class="timestamp">${timeAgo}</span>
        <div class="${wrapperClass}" ${expandAttr}>
          <div class="msg-content markdown-content">${displayText}</div>
        </div>
      </div>
    `
  }

  private renderAssistantMessage(msg: ConversationMessage, index: number, timeAgo: string, isExpanded: boolean): string {
    const truncated = this.truncateText(msg.content, 200)
    const needsTruncation = truncated.length < msg.content.length
    // Use markdown for expanded, escaped for truncated (avoid broken markdown)
    const displayText = isExpanded ? renderMarkdown(msg.content) : escapeHtml(truncated)
    const wrapperClass = needsTruncation && !isExpanded ? 'msg-wrapper truncated' : 'msg-wrapper'
    const expandAttr = needsTruncation ? `data-expand-idx="${index}"` : ''

    return `
      <div class="conv-item assistant-msg">
        <span class="timestamp">${timeAgo}</span>
        <div class="${wrapperClass}" ${expandAttr}>
          <div class="msg-content markdown-content">${displayText}</div>
        </div>
      </div>
    `
  }

  private renderThinkingBlock(msg: ConversationMessage, index: number, timeAgo: string, isExpanded: boolean): string {
    const preview = msg.preview || this.truncateText(msg.content, 50)
    const expandedClass = isExpanded ? 'expanded' : ''

    return `
      <div class="conv-item thinking-block ${expandedClass}" data-thinking-idx="${index}">
        <div class="thinking-header">
          <span class="thinking-icon">▶</span>
          <span class="thinking-preview">${escapeHtml(preview)}</span>
        </div>
        <div class="thinking-content">${escapeHtml(msg.content)}</div>
        <span class="timestamp">${timeAgo}</span>
      </div>
    `
  }

  private renderToolUse(msg: ConversationMessage, index: number, timeAgo: string, result?: ConversationMessage): string {
    const toolName = msg.toolName || 'Tool'
    const summary = this.getToolSummary(msg)
    const isExpanded = this.expandedMessages.has(index)
    const expandedClass = isExpanded ? 'expanded' : ''
    const isFileTool = this.isClickableTool(msg)

    // Format full input for expanded view
    let fullInput = ''
    if (msg.toolInput) {
      if (typeof msg.toolInput === 'string') {
        fullInput = msg.toolInput
      } else {
        // Format object input nicely
        fullInput = Object.entries(msg.toolInput)
          .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join('\n')
      }
    }

    // Format result output
    const resultOutput = result?.content || ''
    const hasDetails = fullInput || resultOutput

    // File tools get an "open" button
    const openButton = isFileTool
      ? `<button class="tool-open-btn" data-tool-file-idx="${index}" title="Open in viewer">↗</button>`
      : ''

    return `
      <div class="conv-item tool-item ${expandedClass}" data-tool-expand-idx="${index}">
        <div class="tool-header">
          ${hasDetails ? '<span class="tool-expand-icon">▶</span>' : ''}
          <span class="tool-badge">${toolName}</span>
          <span class="tool-summary">${escapeHtml(summary)}</span>
          ${openButton}
          <span class="timestamp">${timeAgo}</span>
        </div>
        ${hasDetails ? `
        <div class="tool-details">
          ${fullInput ? `<div class="tool-input-full">${escapeHtml(fullInput)}</div>` : ''}
          ${resultOutput ? `
            <div class="tool-output-label">Output:</div>
            <div class="tool-output">${escapeHtml(resultOutput)}</div>
          ` : ''}
        </div>
        ` : ''}
      </div>
    `
  }

  // Tool results are now rendered inline with tool_use, no separate rendering needed

  private getToolSummary(msg: ConversationMessage): string {
    if (!msg.toolInput) return msg.content

    // Extract file path from common tools
    const input = msg.toolInput
    if (input.file_path) return input.file_path
    if (input.path) return input.path
    if (input.command) return this.truncateText(input.command, 50)
    if (input.pattern) return input.pattern

    return msg.content || msg.toolName || 'tool'
  }

  private isClickableTool(msg: ConversationMessage): boolean {
    const clickableTools = ['Read', 'Write', 'Edit']
    if (!msg.toolName || !clickableTools.includes(msg.toolName)) return false
    const input = msg.toolInput
    return input && (input.file_path || input.path)
  }

  private getToolFilePath(msg: ConversationMessage): string | null {
    const input = msg.toolInput
    if (!input) return null
    return input.file_path || input.path || null
  }

  private truncateText(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen) + '...'
  }

  private attachConversationListeners(): void {
    // Expandable messages (user/assistant)
    this.conversationList.querySelectorAll('[data-expand-idx]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation() // Prevent panel close during re-render
        const idx = parseInt((el as HTMLElement).dataset.expandIdx!, 10)
        if (this.expandedMessages.has(idx)) {
          this.expandedMessages.delete(idx)
        } else {
          this.expandedMessages.add(idx)
        }
        this.renderConversation()
      })
    })

    // Thinking block toggle
    this.conversationList.querySelectorAll('[data-thinking-idx]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation() // Prevent panel close during re-render
        const idx = parseInt((el as HTMLElement).dataset.thinkingIdx!, 10)
        if (this.expandedMessages.has(idx)) {
          this.expandedMessages.delete(idx)
        } else {
          this.expandedMessages.add(idx)
        }
        this.renderConversation()
      })
    })

    // Tool item expand/collapse
    this.conversationList.querySelectorAll('[data-tool-expand-idx]').forEach(el => {
      el.addEventListener('click', (e) => {
        // Don't expand if clicking the open button
        if ((e.target as HTMLElement).classList.contains('tool-open-btn')) return

        e.stopPropagation() // Prevent panel close during re-render
        const idx = parseInt((el as HTMLElement).dataset.toolExpandIdx!, 10)

        // Single click always expands/collapses
        if (this.expandedMessages.has(idx)) {
          this.expandedMessages.delete(idx)
        } else {
          this.expandedMessages.add(idx)
        }
        this.renderConversation()
      })
    })

    // File tool open buttons
    this.conversationList.querySelectorAll('[data-tool-file-idx]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const idx = parseInt((btn as HTMLElement).dataset.toolFileIdx!, 10)
        const msg = this.currentConversation[idx]
        if (msg && this.onFileClick && this.currentSession) {
          const filePath = this.getToolFilePath(msg)
          if (filePath) {
            const activity: Activity = {
              tool: msg.toolName || 'Read',
              fullPath: filePath,
              summary: filePath,
              timestamp: new Date(msg.timestamp).getTime()
            }
            this.onFileClick(activity, this.currentSession.originId, this.currentSession.id)
          }
        }
      })
    })
  }

  private renderActivitiesFallback(): void {
    // Fallback to showing activities if conversation fetch fails
    if (this.currentActivities.length === 0) {
      this.conversationList.innerHTML = '<div class="conv-empty">No activity yet</div>'
      return
    }

    const html = this.currentActivities.map((a, i) => this.renderActivityItem(a, i)).join('')
    this.conversationList.innerHTML = html
    this.attachActivityClickListeners()
  }

  private renderActivityItem(activity: Activity, index: number): string {
    const timeAgo = formatTimeAgo(activity.timestamp)
    const toolClass = this.getToolClass(activity.tool)
    const isClickable = activity.fullPath && ['Read', 'Write', 'Edit'].includes(activity.tool)
    const clickableClass = isClickable ? 'clickable' : ''
    const displayTool = activity.tool === 'UserPrompt' ? 'You' : activity.tool

    return `
      <div class="conv-item tool-item ${clickableClass}" data-activity-idx="${index}" data-tool="${activity.tool}">
        <span class="tool-badge ${toolClass}">${displayTool}</span>
        <span class="tool-summary">${escapeHtml(activity.summary || '')}</span>
        <span class="timestamp">${timeAgo}</span>
      </div>
    `
  }

  private attachActivityClickListeners(): void {
    this.conversationList.querySelectorAll('.tool-item.clickable').forEach(item => {
      item.addEventListener('click', () => {
        const indexStr = (item as HTMLElement).dataset.activityIdx
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
      'UserPrompt': 'tool-user',
    }
    return toolClasses[tool] || 'tool-other'
  }

  hide(): void {
    this.stopConversationPolling()
    this.panel.classList.remove('visible')
    this.currentSession = null
  }

  isVisible(): boolean {
    return this.panel.classList.contains('visible')
  }
}
