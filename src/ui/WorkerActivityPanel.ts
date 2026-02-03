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
  private chatInput: HTMLTextAreaElement
  private sendBtn: HTMLElement
  private currentSession: Session | null = null
  private currentActivities: Activity[] = []
  private currentConversation: ConversationMessage[] = []
  private ignoreNextClick = false
  private isResizing = false
  private readonly minWidth = 400
  private readonly maxWidth = 900
  private readonly clickableTools = ['Read', 'Write', 'Edit']
  private onFileClick: FileClickCallback | null = null
  private expandedMessages: Set<string> = new Set()  // Uses timestamp as stable key
  private isInitialRender = true
  private isSending = false

  // Stored listener refs for HMR-safe cleanup
  private clickOutsideHandler: ((e: MouseEvent) => void) | null = null
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null
  private resizeMoveHandler: ((e: MouseEvent) => void) | null = null
  private resizeUpHandler: (() => void) | null = null

  constructor() {
    this.panel = this.createPanel()
    this.closeBtn = this.panel.querySelector('.close-btn')!
    this.resizeHandle = this.panel.querySelector('.resize-handle')!
    this.workerName = this.panel.querySelector('.worker-name')!
    this.workerInfo = this.panel.querySelector('.worker-info')!
    this.conversationList = this.panel.querySelector('.conversation-list')!
    this.chatInput = this.panel.querySelector('.chat-input')!
    this.sendBtn = this.panel.querySelector('.chat-send-btn')!

    this.setupEventListeners()
    this.setupChatInput()
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
      <section class="conversation-section">
        <h3>Conversation</h3>
        <div class="conversation-list"></div>
      </section>
      <div class="chat-input-container">
        <textarea class="chat-input" placeholder="Send a message..."></textarea>
        <button class="chat-send-btn">Send</button>
      </div>
    `
    return panel
  }

  private setupEventListeners(): void {
    // Close button
    this.closeBtn.addEventListener('click', () => this.hide())

    // Define handlers (attached/detached dynamically to avoid HMR stacking)
    this.clickOutsideHandler = (e: MouseEvent) => {
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
    }

    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.panel.classList.contains('visible')) {
        // Don't close if file viewer modal is open - it handles its own Escape
        const fileViewer = document.querySelector('.file-viewer-modal.visible')
        if (fileViewer) return
        this.hide()
      }
    }
  }

  private attachDocumentListeners(): void {
    if (this.clickOutsideHandler) {
      document.addEventListener('click', this.clickOutsideHandler)
    }
    if (this.escapeHandler) {
      document.addEventListener('keydown', this.escapeHandler)
    }
  }

  private detachDocumentListeners(): void {
    if (this.clickOutsideHandler) {
      document.removeEventListener('click', this.clickOutsideHandler)
    }
    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler)
    }
  }

  private setupResizeHandling(): void {
    // Store handlers for cleanup
    this.resizeMoveHandler = (e: MouseEvent) => {
      if (!this.isResizing) return
      const newWidth = e.clientX
      const clampedWidth = Math.min(this.maxWidth, Math.max(this.minWidth, newWidth))
      this.panel.style.width = `${clampedWidth}px`
    }

    this.resizeUpHandler = () => {
      if (this.isResizing) {
        this.isResizing = false
        this.resizeHandle.classList.remove('dragging')
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        this.detachResizeListeners()
      }
    }

    this.resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.isResizing = true
      this.resizeHandle.classList.add('dragging')
      document.body.style.cursor = 'ew-resize'
      document.body.style.userSelect = 'none'
      this.attachResizeListeners()
    })
  }

  private attachResizeListeners(): void {
    if (this.resizeMoveHandler) {
      document.addEventListener('mousemove', this.resizeMoveHandler)
    }
    if (this.resizeUpHandler) {
      document.addEventListener('mouseup', this.resizeUpHandler)
    }
  }

  private detachResizeListeners(): void {
    if (this.resizeMoveHandler) {
      document.removeEventListener('mousemove', this.resizeMoveHandler)
    }
    if (this.resizeUpHandler) {
      document.removeEventListener('mouseup', this.resizeUpHandler)
    }
  }

  private setupChatInput(): void {
    // Send on button click
    this.sendBtn.addEventListener('click', () => this.sendMessage())

    // Send on Enter, newline on Shift+Enter
    this.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        this.sendMessage()
      }
    })

    // Auto-grow textarea as content changes
    this.chatInput.addEventListener('input', () => this.autoGrowTextarea())

    // Prevent panel close when clicking in chat area
    this.chatInput.addEventListener('click', (e) => e.stopPropagation())
  }

  private autoGrowTextarea(): void {
    const textarea = this.chatInput
    // Reset height to auto to get correct scrollHeight
    textarea.style.height = 'auto'
    // Set to scrollHeight, capped at max height (e.g., 200px)
    const maxHeight = 200
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
    // Show scrollbar if content exceeds max
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }

  private async sendMessage(): Promise<void> {
    const message = this.chatInput.value.trim()
    if (!message || !this.currentSession || this.isSending) return

    this.isSending = true
    this.sendBtn.textContent = 'Sending...'
    this.chatInput.disabled = true

    try {
      const response = await fetch('http://localhost:4004/send-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: this.currentSession.id,
          message,
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || `HTTP ${response.status}`)
      }

      // Clear input on success and reset height
      this.chatInput.value = ''
      this.chatInput.style.height = 'auto'
      // Immediately fetch updated conversation
      await this.fetchConversation(this.currentSession.id)
    } catch (error) {
      console.error('Failed to send message:', error)
      alert(`Failed to send: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      this.isSending = false
      this.sendBtn.textContent = 'Send'
      this.chatInput.disabled = false
      this.chatInput.focus()
    }
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

    // Attach document listeners (dynamically to avoid HMR stacking)
    this.attachDocumentListeners()

    this.panel.classList.add('visible')

    // Fetch initial conversation (once, then rely on WebSocket updates)
    this.fetchConversation(session.id, session.tmuxSession)
  }

  private async fetchConversation(sessionId: string, tmuxSession?: string): Promise<void> {
    try {
      let url = `http://localhost:4004/conversation?sessionId=${encodeURIComponent(sessionId)}&limit=100`
      if (tmuxSession) {
        url += `&tmuxSession=${encodeURIComponent(tmuxSession)}`
      }
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const data = await response.json()
      if (!data.messages) return

      const merged = this.mergeMessages(data.messages, this.currentConversation)

      // Skip re-render if nothing changed
      if (this.messagesUnchanged(this.currentConversation, merged)) return

      this.currentConversation = merged.slice(-100)
      this.renderConversation()
    } catch (error) {
      console.error('Failed to fetch conversation:', error)
      this.renderActivitiesFallback()
    }
  }

  /**
   * Merge fetched messages with existing WebSocket messages
   */
  private mergeMessages(fetched: ConversationMessage[], existing: ConversationMessage[]): ConversationMessage[] {
    const fetchedTimestamps = new Set(fetched.map(m => m.timestamp))
    const wsOnlyMessages = existing.filter(m => !fetchedTimestamps.has(m.timestamp))
    const merged = [...fetched, ...wsOnlyMessages]
    merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    return merged
  }

  /**
   * Check if message arrays are effectively the same (same length and last timestamp)
   */
  private messagesUnchanged(oldMessages: ConversationMessage[], newMessages: ConversationMessage[]): boolean {
    if (oldMessages.length !== newMessages.length) return false
    const oldLast = oldMessages[oldMessages.length - 1]?.timestamp
    const newLast = newMessages[newMessages.length - 1]?.timestamp
    return oldLast === newLast
  }

  /**
   * Handle WebSocket message - returns true if handled
   */
  handleMessage(message: unknown): boolean {
    const msg = message as { type?: string; tmuxSession?: string; messages?: ConversationMessage[] }
    if (msg.type !== 'conversation' || !msg.messages) return false

    // Match by tmuxSession (stable) since Claude's sessionId changes each restart
    if (this.isVisible() && this.currentSession?.tmuxSession === msg.tmuxSession) {
      this.appendMessages(msg.messages)
    }
    return true
  }

  // Max messages kept in memory (matches backend ConversationCache limit)
  private readonly maxMessages = 100

  /**
   * Append new messages from WebSocket update
   */
  private appendMessages(newMessages: ConversationMessage[]): void {
    if (newMessages.length === 0) return

    // Deduplicate by timestamp
    const existingTimestamps = new Set(this.currentConversation.map(m => m.timestamp))
    const toAdd = newMessages.filter(m => !existingTimestamps.has(m.timestamp))
    if (toAdd.length === 0) return

    this.currentConversation.push(...toAdd)

    // Trim to max to prevent unbounded growth
    if (this.currentConversation.length > this.maxMessages) {
      this.currentConversation = this.currentConversation.slice(-this.maxMessages)
    }

    this.renderConversation()
  }

  updateActivities(tmuxSession: string, activities: Activity[]): void {
    if (this.isVisible() && this.currentSession?.tmuxSession === tmuxSession) {
      this.currentActivities = activities
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

    // Group messages: user/assistant are standalone, thinking/tool_use get grouped
    type MessageGroup = {
      type: 'message'
      msg: ConversationMessage
    } | {
      type: 'tool_group'
      messages: Array<{ msg: ConversationMessage; result?: ConversationMessage }>
      startIndex: number
    }

    const groups: MessageGroup[] = []
    let currentToolGroup: Extract<MessageGroup, { type: 'tool_group' }> | null = null

    for (let i = 0; i < this.currentConversation.length; i++) {
      const msg = this.currentConversation[i]

      if (msg.type === 'tool_result') continue // Skip, rendered with tool_use

      if (msg.type === 'user' || msg.type === 'assistant') {
        // Flush any pending tool group
        if (currentToolGroup) {
          groups.push(currentToolGroup)
          currentToolGroup = null
        }
        groups.push({ type: 'message', msg })
      } else {
        // thinking, tool_use, or system - add to current group
        if (!currentToolGroup) {
          currentToolGroup = { type: 'tool_group', messages: [], startIndex: i }
        }
        const result = msg.type === 'tool_use' && msg.toolUseId
          ? toolResultMap.get(msg.toolUseId)
          : undefined
        currentToolGroup.messages.push({ msg, result })
      }
    }
    // Flush final tool group
    if (currentToolGroup) {
      groups.push(currentToolGroup)
    }

    // Render groups
    const html = groups.map(group => {
      if (group.type === 'message') {
        return this.renderConversationItem(group.msg)
      } else {
        return this.renderToolGroup(group.messages, group.startIndex)
      }
    }).join('')

    this.conversationList.innerHTML = html
    this.attachConversationListeners()

    // Apply syntax highlighting to code blocks
    highlightCodeBlocks(this.conversationList)

    // Auto-scroll to bottom only on initial render or if user was already at bottom
    const section = this.conversationList.parentElement
    if (section) {
      if (this.isInitialRender) {
        section.scrollTop = section.scrollHeight
        this.isInitialRender = false
      }
      // Don't auto-scroll on updates - let user control their scroll position
    }
  }

  private renderToolGroup(
    messages: Array<{ msg: ConversationMessage; result?: ConversationMessage }>,
    groupIndex: number
  ): string {
    // Count tool types
    const toolCounts = new Map<string, number>()
    let thinkingCount = 0
    let skillCount = 0
    for (const { msg } of messages) {
      if (msg.type === 'thinking') {
        thinkingCount++
      } else if (msg.type === 'tool_use') {
        const name = msg.toolName || 'Tool'
        toolCounts.set(name, (toolCounts.get(name) || 0) + 1)
      } else if (msg.type === 'system' && msg.systemType === 'skill') {
        skillCount++
      }
    }

    // Build summary: "5 steps (2 Read, 1 Bash, 2 Edit)"
    const parts: string[] = []
    if (thinkingCount > 0) parts.push(`${thinkingCount} thinking`)
    if (skillCount > 0) parts.push(`${skillCount} skill`)
    for (const [name, count] of toolCounts) {
      parts.push(`${count} ${name}`)
    }
    const summary = parts.join(', ')
    const stepCount = messages.length

    // Use first message timestamp as stable group key
    const groupKey = `group-${messages[0]?.msg.timestamp || groupIndex}`
    const isExpanded = this.expandedMessages.has(groupKey)
    const expandedClass = isExpanded ? 'expanded' : ''

    // Render individual items for expanded view
    const itemsHtml = messages.map(({ msg, result }) => {
      const timeAgo = formatTimeAgo(new Date(msg.timestamp).getTime())
      if (msg.type === 'thinking') {
        const isItemExpanded = this.expandedMessages.has(msg.timestamp)
        return this.renderThinkingBlock(msg, msg.timestamp, timeAgo, isItemExpanded)
      } else if (msg.type === 'system') {
        const isItemExpanded = this.expandedMessages.has(msg.timestamp)
        return this.renderSystemMessage(msg, msg.timestamp, timeAgo, isItemExpanded)
      } else {
        return this.renderToolUse(msg, msg.timestamp, timeAgo, result)
      }
    }).join('')

    return `
      <div class="tool-group ${expandedClass}" data-group-key="${groupKey}">
        <div class="tool-group-header">
          <span class="tool-group-icon">▶</span>
          <span class="tool-group-summary">${stepCount} steps (${escapeHtml(summary)})</span>
        </div>
        <div class="tool-group-content">
          ${itemsHtml}
        </div>
      </div>
    `
  }

  private renderConversationItem(msg: ConversationMessage): string {
    const timeAgo = formatTimeAgo(new Date(msg.timestamp).getTime())
    const isExpanded = this.expandedMessages.has(msg.timestamp)
    const key = msg.timestamp

    if (msg.type === 'user') return this.renderUserMessage(msg, timeAgo)
    if (msg.type === 'assistant') return this.renderAssistantMessage(msg, timeAgo)
    if (msg.type === 'thinking') return this.renderThinkingBlock(msg, key, timeAgo, isExpanded)
    if (msg.type === 'tool_use') return this.renderToolUse(msg, key, timeAgo, undefined)

    // tool_result rendered inline with tool_use, other types skipped
    return ''
  }

  private renderUserMessage(msg: ConversationMessage, timeAgo: string): string {
    return this.renderChatMessage(msg, timeAgo, 'user-msg')
  }

  private renderAssistantMessage(msg: ConversationMessage, timeAgo: string): string {
    return this.renderChatMessage(msg, timeAgo, 'assistant-msg')
  }

  private renderChatMessage(msg: ConversationMessage, timeAgo: string, className: string): string {
    const displayText = renderMarkdown(msg.content)
    return `
      <div class="conv-item ${className}">
        <span class="timestamp">${timeAgo}</span>
        <div class="msg-wrapper">
          <div class="msg-content markdown-content">${displayText}</div>
        </div>
      </div>
    `
  }

  private renderThinkingBlock(msg: ConversationMessage, key: string, timeAgo: string, isExpanded: boolean): string {
    const preview = msg.preview || this.truncateText(msg.content, 50)
    const expandedClass = isExpanded ? 'expanded' : ''

    return `
      <div class="conv-item thinking-block ${expandedClass}" data-msg-key="${key}">
        <div class="thinking-header">
          <span class="thinking-icon">▶</span>
          <span class="thinking-preview">${escapeHtml(preview)}</span>
        </div>
        <div class="thinking-content">${escapeHtml(msg.content)}</div>
        <span class="timestamp">${timeAgo}</span>
      </div>
    `
  }

  private renderSystemMessage(msg: ConversationMessage, key: string, timeAgo: string, isExpanded: boolean): string {
    const preview = msg.preview || this.truncateText(msg.content, 60)
    const expandedClass = isExpanded ? 'expanded' : ''
    const badge = msg.systemType === 'skill' ? 'Skill' : 'System'

    return `
      <div class="conv-item system-block ${expandedClass}" data-msg-key="${key}">
        <div class="system-header">
          <span class="system-icon">▶</span>
          <span class="tool-badge">${badge}</span>
          <span class="system-preview">${escapeHtml(preview)}</span>
        </div>
        <div class="system-content">${escapeHtml(msg.content)}</div>
        <span class="timestamp">${timeAgo}</span>
      </div>
    `
  }

  private renderToolUse(msg: ConversationMessage, key: string, timeAgo: string, result?: ConversationMessage): string {
    const toolName = msg.toolName || 'Tool'
    const summary = this.getToolSummary(msg)
    const expandedClass = this.expandedMessages.has(key) ? 'expanded' : ''
    const fullInput = this.formatToolInput(msg.toolInput)
    const resultOutput = result?.content ?? ''
    const hasDetails = fullInput || resultOutput

    const openButton = this.isClickableTool(msg)
      ? `<button class="tool-open-btn" data-tool-file-key="${key}" title="Open in viewer">Open</button>`
      : ''

    return `
      <div class="conv-item tool-item ${expandedClass}" data-msg-key="${key}">
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

  private formatToolInput(input: ConversationMessage['toolInput']): string {
    if (!input) return ''
    if (typeof input === 'string') return input
    return Object.entries(input)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join('\n')
  }

  // Tool results are now rendered inline with tool_use, no separate rendering needed

  private getToolSummary(msg: ConversationMessage): string {
    const input = msg.toolInput
    if (!input) return msg.content

    const filePath = this.getToolFilePath(msg)
    if (filePath) return filePath
    if (input.command) return this.truncateText(String(input.command), 50)
    if (input.pattern) return String(input.pattern)

    return msg.content || msg.toolName || 'tool'
  }

  private isClickableTool(msg: ConversationMessage): boolean {
    if (!msg.toolName || !this.clickableTools.includes(msg.toolName)) return false
    return !!this.getToolFilePath(msg)
  }

  private getToolFilePath(msg: ConversationMessage): string | undefined {
    return msg.toolInput?.file_path ?? msg.toolInput?.path
  }

  private truncateText(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen) + '...'
  }

  private toggleExpanded(key: string): void {
    if (this.expandedMessages.has(key)) {
      this.expandedMessages.delete(key)
    } else {
      this.expandedMessages.add(key)
    }
    this.renderConversation()
  }

  private attachConversationListeners(): void {
    // Tool group expand/collapse (uses data-group-key)
    this.conversationList.querySelectorAll('[data-group-key]').forEach(el => {
      const header = el.querySelector('.tool-group-header')
      if (header) {
        header.addEventListener('click', (e) => {
          e.stopPropagation()
          const groupKey = (el as HTMLElement).dataset.groupKey!
          this.toggleExpanded(groupKey)
        })
      }
    })

    // All expandable items use data-msg-key (thinking, system, tool)
    this.conversationList.querySelectorAll('[data-msg-key]').forEach(el => {
      el.addEventListener('click', (e) => {
        // Don't expand if clicking the open button
        if ((e.target as HTMLElement).classList.contains('tool-open-btn')) return

        e.stopPropagation()
        const key = (el as HTMLElement).dataset.msgKey!
        this.toggleExpanded(key)
      })
    })

    // File tool open buttons (uses data-tool-file-key which is timestamp)
    this.conversationList.querySelectorAll('[data-tool-file-key]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const key = (btn as HTMLElement).dataset.toolFileKey!
        const msg = this.currentConversation.find(m => m.timestamp === key)
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
    this.panel.classList.remove('visible')
    this.currentSession = null
    this.detachDocumentListeners()
    this.detachResizeListeners()
  }

  isVisible(): boolean {
    return this.panel.classList.contains('visible')
  }

  /**
   * Dispose panel (call during HMR to prevent leaks)
   */
  dispose(): void {
    this.hide()
    this.panel.remove()
  }
}
