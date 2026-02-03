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
  private minWidth = 400
  private maxWidth = 900
  private onFileClick: FileClickCallback | null = null
  private expandedMessages: Set<string> = new Set()  // Uses timestamp as stable key
  private isInitialRender = true
  private isSending = false

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
    this.panel.classList.add('visible')

    // Fetch initial conversation (once, then rely on WebSocket updates)
    this.fetchConversation(session.id)
  }

  private async fetchConversation(sessionId: string): Promise<void> {
    try {
      const response = await fetch(`http://localhost:4004/conversation?sessionId=${encodeURIComponent(sessionId)}&limit=100`)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const data = await response.json()
      if (data.messages) {
        const fetchedMessages: ConversationMessage[] = data.messages

        // Merge with any messages that arrived via WebSocket during fetch
        // (prevents race condition where WebSocket message arrives before HTTP response)
        const existingTimestamps = new Set(fetchedMessages.map(m => m.timestamp))
        const wsOnlyMessages = this.currentConversation.filter(m => !existingTimestamps.has(m.timestamp))

        // Combine: fetched messages + any WebSocket-only messages, then dedupe and sort
        const merged = [...fetchedMessages, ...wsOnlyMessages]
        merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

        // Skip re-render if nothing changed
        const oldLen = this.currentConversation.length
        const oldLast = this.currentConversation[oldLen - 1]?.timestamp
        const newLast = merged[merged.length - 1]?.timestamp

        if (oldLen === merged.length && oldLast === newLast) {
          return
        }

        this.currentConversation = merged.slice(-100)
        this.renderConversation()
      }
    } catch (error) {
      console.error('Failed to fetch conversation:', error)
      // Fall back to activity view if conversation unavailable
      this.renderActivitiesFallback()
    }
  }

  /**
   * Handle WebSocket message - returns true if handled
   */
  handleMessage(message: unknown): boolean {
    const msg = message as { type?: string; tmuxSession?: string; messages?: ConversationMessage[] }
    if (msg.type !== 'conversation' || !msg.messages) return false

    // Match by tmuxSession (stable) since Claude's sessionId changes each restart
    if (this.panel.classList.contains('visible') &&
        this.currentSession?.tmuxSession === msg.tmuxSession) {
      this.appendMessages(msg.messages)
    }
    return true
  }

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

    // Keep last 100 messages to match backend limit and prevent unbounded growth
    const maxMessages = 100
    if (this.currentConversation.length > maxMessages) {
      this.currentConversation = this.currentConversation.slice(-maxMessages)
    }

    this.renderConversation()
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

    // Group messages: user/assistant are standalone, thinking/tool_use get grouped
    type MessageGroup = {
      type: 'message'
      msg: ConversationMessage
      index: number
    } | {
      type: 'tool_group'
      messages: Array<{ msg: ConversationMessage; index: number; result?: ConversationMessage }>
      startIndex: number
    }

    const groups: MessageGroup[] = []
    let currentToolGroup: Extract<MessageGroup, { type: 'tool_group' }> | null = null

    for (let i = 0; i < this.currentConversation.length; i++) {
      const msg = this.currentConversation[i]

      if (msg.type === 'tool_result') continue // Skip, rendered with tool_use

      if (msg.type === 'user' || msg.type === 'assistant') {
        // Flush any pending tool group
        if (currentToolGroup && currentToolGroup.type === 'tool_group') {
          groups.push(currentToolGroup)
          currentToolGroup = null
        }
        groups.push({ type: 'message', msg, index: i })
      } else {
        // thinking, tool_use, or system - add to current group
        if (!currentToolGroup) {
          currentToolGroup = { type: 'tool_group', messages: [], startIndex: i }
        }
        if (currentToolGroup.type === 'tool_group') {
          const result = msg.type === 'tool_use' && msg.toolUseId
            ? toolResultMap.get(msg.toolUseId)
            : undefined
          currentToolGroup.messages.push({ msg, index: i, result })
        }
      }
    }
    // Flush final tool group
    if (currentToolGroup && currentToolGroup.type === 'tool_group') {
      groups.push(currentToolGroup)
    }

    // Render groups
    const html = groups.map(group => {
      if (group.type === 'message') {
        return this.renderConversationItem(group.msg, group.index)
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
    messages: Array<{ msg: ConversationMessage; index: number; result?: ConversationMessage }>,
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

  private renderConversationItem(msg: ConversationMessage, _index: number): string {
    const timeAgo = formatTimeAgo(new Date(msg.timestamp).getTime())
    const isExpanded = this.expandedMessages.has(msg.timestamp)

    switch (msg.type) {
      case 'user':
        return this.renderUserMessage(msg, msg.timestamp, timeAgo, isExpanded)
      case 'assistant':
        return this.renderAssistantMessage(msg, msg.timestamp, timeAgo, isExpanded)
      case 'thinking':
        return this.renderThinkingBlock(msg, msg.timestamp, timeAgo, isExpanded)
      case 'tool_use':
        // Rendered in renderConversation with result
        return this.renderToolUse(msg, msg.timestamp, timeAgo, undefined)
      case 'tool_result':
        // Rendered inline with tool_use, skip
        return ''
      default:
        return ''
    }
  }

  private renderUserMessage(msg: ConversationMessage, _key: string, timeAgo: string, _isExpanded: boolean): string {
    // Always show full content with markdown rendering
    const displayText = renderMarkdown(msg.content)

    return `
      <div class="conv-item user-msg">
        <span class="timestamp">${timeAgo}</span>
        <div class="msg-wrapper">
          <div class="msg-content markdown-content">${displayText}</div>
        </div>
      </div>
    `
  }

  private renderAssistantMessage(msg: ConversationMessage, _key: string, timeAgo: string, _isExpanded: boolean): string {
    // Always show full content with markdown rendering
    const displayText = renderMarkdown(msg.content)

    return `
      <div class="conv-item assistant-msg">
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
    const isExpanded = this.expandedMessages.has(key)
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
    // Tool group expand/collapse (uses data-group-key)
    this.conversationList.querySelectorAll('[data-group-key]').forEach(el => {
      const header = el.querySelector('.tool-group-header')
      if (header) {
        header.addEventListener('click', (e) => {
          e.stopPropagation()
          const groupKey = (el as HTMLElement).dataset.groupKey!
          if (this.expandedMessages.has(groupKey)) {
            this.expandedMessages.delete(groupKey)
          } else {
            this.expandedMessages.add(groupKey)
          }
          this.renderConversation()
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
        if (this.expandedMessages.has(key)) {
          this.expandedMessages.delete(key)
        } else {
          this.expandedMessages.add(key)
        }
        this.renderConversation()
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
  }

  isVisible(): boolean {
    return this.panel.classList.contains('visible')
  }
}
