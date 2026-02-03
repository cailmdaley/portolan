// ConversationCard.ts - Map-pinned conversation card as CSS2DObject

import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import type { Session, ConversationMessage } from '../state/types'
import { escapeHtml, formatTimeAgo, renderMarkdown, highlightCodeBlocks } from './utils'

type FileClickCallback = (fullPath: string, originId: string, workerId: string) => void

interface CardOptions {
  onClose: () => void
  onFileClick?: FileClickCallback
  onDoubleClick?: () => void  // For focusing terminal
}

export class ConversationCard {
  readonly object: CSS2DObject
  private element: HTMLElement
  private contentEl: HTMLElement
  private session: Session
  private conversation: ConversationMessage[] = []
  private expandedMessages: Set<string> = new Set()
  private options: CardOptions
  private disposed = false

  // Loading state
  private loadingState: 'loading' | 'loaded' | 'error' = 'loading'
  private errorMessage = ''
  private fetchTimeout: ReturnType<typeof setTimeout> | null = null

  // Clickable tools for file viewer
  private readonly clickableTools = ['Read', 'Write', 'Edit']

  constructor(session: Session, options: CardOptions) {
    this.session = session
    this.options = options
    this.element = this.createCardElement()
    this.contentEl = this.element.querySelector('.card-content')!

    this.object = new CSS2DObject(this.element)
    // Position slightly to the right and below the ship
    this.object.position.set(0.5, 0.3, 0)

    this.setupEventListeners()
    this.fetchConversation()
  }

  private createCardElement(): HTMLElement {
    const card = document.createElement('div')
    card.className = 'conversation-card'
    card.innerHTML = `
      <div class="card-header">
        <span class="card-title">${escapeHtml(this.session.name)}</span>
        <button class="card-close" title="Close">&times;</button>
      </div>
      <div class="card-content">
        <div class="card-loading">Loading conversation...</div>
      </div>
    `
    return card
  }

  private setupEventListeners(): void {
    // Close button
    const closeBtn = this.element.querySelector('.card-close')!
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.options.onClose()
    })

    // Double-click to focus terminal
    this.element.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      this.options.onDoubleClick?.()
    })

    // Stop click propagation to prevent map interaction
    this.element.addEventListener('click', (e) => {
      e.stopPropagation()
    })

    // Prevent scroll from bubbling to map
    this.element.addEventListener('wheel', (e) => {
      e.stopPropagation()
    })
  }

  private async fetchConversation(): Promise<void> {
    if (this.disposed) return

    this.loadingState = 'loading'
    this.renderContent()

    // Set timeout for loading
    const TIMEOUT_MS = 5000
    this.fetchTimeout = setTimeout(() => {
      if (this.loadingState === 'loading') {
        this.loadingState = 'error'
        this.errorMessage = 'Request timed out'
        this.renderContent()
      }
    }, TIMEOUT_MS)

    try {
      const url = new URL('http://localhost:4004/conversation')
      url.searchParams.set('sessionId', this.session.id)
      url.searchParams.set('tmuxSession', this.session.tmuxSession)
      url.searchParams.set('limit', '100')

      const response = await fetch(url.toString())

      if (this.disposed) return

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const data = await response.json()
      this.clearFetchTimeout()

      this.conversation = Array.isArray(data.messages) ? data.messages : []
      this.loadingState = 'loaded'
      this.renderContent()
    } catch (error) {
      if (this.disposed) return
      this.clearFetchTimeout()

      this.loadingState = 'error'
      this.errorMessage = error instanceof Error ? error.message : 'Unknown error'
      this.renderContent()
    }
  }

  private clearFetchTimeout(): void {
    if (this.fetchTimeout) {
      clearTimeout(this.fetchTimeout)
      this.fetchTimeout = null
    }
  }

  /**
   * Handle WebSocket conversation update
   */
  handleMessage(tmuxSession: string, messages: ConversationMessage[]): void {
    if (this.disposed) return
    if (this.session.tmuxSession !== tmuxSession) return

    // Deduplicate by timestamp
    const existingTimestamps = new Set(this.conversation.map(m => m.timestamp))
    const toAdd = messages.filter(m => !existingTimestamps.has(m.timestamp))

    if (toAdd.length > 0) {
      this.conversation.push(...toAdd)
      // Keep last 100 messages
      if (this.conversation.length > 100) {
        this.conversation = this.conversation.slice(-100)
      }
      this.loadingState = 'loaded'
      this.renderContent()
    }
  }

  private renderContent(): void {
    if (this.disposed) return

    if (this.loadingState === 'loading') {
      this.contentEl.innerHTML = '<div class="card-loading">Loading conversation...</div>'
      return
    }

    if (this.loadingState === 'error') {
      this.contentEl.innerHTML = `
        <div class="card-error">
          <span>${escapeHtml(this.errorMessage)}</span>
          <button class="retry-btn">Retry</button>
        </div>
      `
      this.contentEl.querySelector('.retry-btn')?.addEventListener('click', (e) => {
        e.stopPropagation()
        this.fetchConversation()
      })
      return
    }

    if (this.conversation.length === 0) {
      this.contentEl.innerHTML = '<div class="card-empty">No conversation yet</div>'
      return
    }

    // Show last few exchanges (user + assistant pairs)
    const recentMessages = this.getRecentExchanges(3)

    // Build groups for tool calls
    const groups = this.buildMessageGroups(recentMessages)
    const html = groups.map(group => this.renderGroup(group)).join('')

    this.contentEl.innerHTML = html
    this.attachListeners()
    highlightCodeBlocks(this.contentEl)
  }

  /**
   * Get last N exchanges (user/assistant pairs, including tool groups between them)
   */
  private getRecentExchanges(count: number): ConversationMessage[] {
    // Walk backward, counting user messages as exchange boundaries
    const result: ConversationMessage[] = []
    let exchangeCount = 0

    for (let i = this.conversation.length - 1; i >= 0 && exchangeCount < count; i--) {
      const msg = this.conversation[i]
      result.unshift(msg)
      if (msg.type === 'user') {
        exchangeCount++
      }
    }

    return result
  }

  private buildMessageGroups(messages: ConversationMessage[]): MessageGroup[] {
    // Build tool_use_id -> tool_result map
    const toolResultMap = new Map<string, ConversationMessage>()
    for (const msg of messages) {
      if (msg.type === 'tool_result' && msg.toolUseId) {
        toolResultMap.set(msg.toolUseId, msg)
      }
    }

    const groups: MessageGroup[] = []
    let currentToolGroup: ToolGroup | null = null

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]

      if (msg.type === 'tool_result') continue // Rendered with tool_use

      if (msg.type === 'user' || msg.type === 'assistant') {
        if (currentToolGroup) {
          groups.push(currentToolGroup)
          currentToolGroup = null
        }
        groups.push({ type: 'message', msg })
      } else {
        // thinking, tool_use, system - add to tool group
        if (!currentToolGroup) {
          currentToolGroup = { type: 'tool_group', items: [], startIndex: i }
        }
        const result = msg.type === 'tool_use' && msg.toolUseId
          ? toolResultMap.get(msg.toolUseId)
          : undefined
        currentToolGroup.items.push({ msg, result })
      }
    }

    if (currentToolGroup) {
      groups.push(currentToolGroup)
    }

    return groups
  }

  private renderGroup(group: MessageGroup): string {
    return group.type === 'message'
      ? this.renderMessage(group.msg)
      : this.renderToolGroup(group)
  }

  private renderMessage(msg: ConversationMessage): string {
    if (msg.type !== 'user' && msg.type !== 'assistant') return ''

    const timeAgo = formatTimeAgo(new Date(msg.timestamp).getTime())
    const content = renderMarkdown(msg.content)
    const msgClass = msg.type === 'user' ? 'user-msg' : 'assistant-msg'

    return `
      <div class="card-msg ${msgClass}">
        <div class="msg-content markdown-content">${content}</div>
        <span class="msg-time">${timeAgo}</span>
      </div>
    `
  }

  private renderToolGroup(group: ToolGroup): string {
    const { items } = group

    // Single-item groups expand directly (per spec)
    if (items.length === 1) {
      const { msg, result } = items[0]
      return this.renderToolItem(msg, result, msg.timestamp)
    }

    // Multi-item groups get a collapsible header
    const summary = this.buildGroupSummary(items)
    const groupKey = `group-${items[0]?.msg.timestamp || group.startIndex}`
    const isExpanded = this.expandedMessages.has(groupKey)

    const itemsHtml = items.map(({ msg, result }) =>
      this.renderToolItem(msg, result, msg.timestamp)
    ).join('')

    return `
      <div class="card-tool-group ${isExpanded ? 'expanded' : ''}" data-group-key="${groupKey}">
        <div class="tool-group-header">
          <span class="expand-icon">▶</span>
          <span class="tool-group-summary">${items.length} steps (${escapeHtml(summary)})</span>
        </div>
        <div class="tool-group-content">${itemsHtml}</div>
      </div>
    `
  }

  private buildGroupSummary(items: ToolGroup['items']): string {
    const toolCounts = new Map<string, number>()
    let thinkingCount = 0

    for (const { msg } of items) {
      if (msg.type === 'thinking') {
        thinkingCount++
      } else if (msg.type === 'tool_use') {
        const name = msg.toolName || 'Tool'
        toolCounts.set(name, (toolCounts.get(name) || 0) + 1)
      }
    }

    const parts: string[] = []
    if (thinkingCount > 0) parts.push(`${thinkingCount} thinking`)
    for (const [name, count] of toolCounts) {
      parts.push(`${count} ${name}`)
    }
    return parts.join(', ')
  }

  private renderToolItem(msg: ConversationMessage, result?: ConversationMessage, key?: string): string {
    const timeAgo = formatTimeAgo(new Date(msg.timestamp).getTime())
    const msgKey = key || msg.timestamp
    const isExpanded = this.expandedMessages.has(msgKey)

    if (msg.type === 'thinking') {
      const preview = msg.preview || this.truncate(msg.content, 40)
      return `
        <div class="card-tool-item thinking ${isExpanded ? 'expanded' : ''}" data-msg-key="${msgKey}">
          <div class="tool-header">
            <span class="expand-icon">▶</span>
            <span class="tool-preview">${escapeHtml(preview)}</span>
          </div>
          <div class="tool-content">${escapeHtml(msg.content)}</div>
          <span class="msg-time">${timeAgo}</span>
        </div>
      `
    }

    if (msg.type === 'tool_use') {
      const toolName = msg.toolName || 'Tool'
      const summary = this.getToolSummary(msg)
      const fullInput = this.formatToolInput(msg.toolInput)
      const resultOutput = result?.content ?? ''
      const hasDetails = fullInput || resultOutput

      const isClickable = this.isClickableTool(msg)
      const openBtn = isClickable
        ? `<button class="tool-open-btn" data-tool-key="${msgKey}">Open</button>`
        : ''

      return `
        <div class="card-tool-item ${isExpanded ? 'expanded' : ''}" data-msg-key="${msgKey}">
          <div class="tool-header">
            ${hasDetails ? '<span class="expand-icon">▶</span>' : ''}
            <span class="tool-badge">${toolName}</span>
            <span class="tool-summary">${escapeHtml(summary)}</span>
            ${openBtn}
          </div>
          ${hasDetails ? `
          <div class="tool-content">
            ${fullInput ? `<div class="tool-input">${escapeHtml(fullInput)}</div>` : ''}
            ${resultOutput ? `
              <div class="tool-output-label">Output:</div>
              <div class="tool-output">${escapeHtml(resultOutput)}</div>
            ` : ''}
          </div>
          ` : ''}
          <span class="msg-time">${timeAgo}</span>
        </div>
      `
    }

    if (msg.type === 'system') {
      const preview = msg.preview || this.truncate(msg.content, 40)
      const badge = msg.systemType === 'skill' ? 'Skill' : 'System'
      return `
        <div class="card-tool-item system ${isExpanded ? 'expanded' : ''}" data-msg-key="${msgKey}">
          <div class="tool-header">
            <span class="expand-icon">▶</span>
            <span class="tool-badge">${badge}</span>
            <span class="tool-preview">${escapeHtml(preview)}</span>
          </div>
          <div class="tool-content">${escapeHtml(msg.content)}</div>
          <span class="msg-time">${timeAgo}</span>
        </div>
      `
    }

    return ''
  }

  private attachListeners(): void {
    // Tool group headers (multi-item groups)
    this.contentEl.querySelectorAll('[data-group-key]').forEach(el => {
      const header = el.querySelector('.tool-group-header')
      header?.addEventListener('click', (e) => {
        e.stopPropagation()
        const key = (el as HTMLElement).dataset.groupKey!
        this.toggleExpanded(key)
      })
    })

    // Individual expandable items
    this.contentEl.querySelectorAll('[data-msg-key]').forEach(el => {
      el.addEventListener('click', (e) => {
        // Don't expand if clicking open button
        if ((e.target as HTMLElement).classList.contains('tool-open-btn')) return
        e.stopPropagation()
        const key = (el as HTMLElement).dataset.msgKey!
        this.toggleExpanded(key)
      })
    })

    // File open buttons
    this.contentEl.querySelectorAll('[data-tool-key]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const key = (btn as HTMLElement).dataset.toolKey!
        const msg = this.conversation.find(m => m.timestamp === key)
        if (msg && this.options.onFileClick) {
          const filePath = this.getToolFilePath(msg)
          if (filePath) {
            this.options.onFileClick(filePath, this.session.originId, this.session.id)
          }
        }
      })
    })
  }

  private toggleExpanded(key: string): void {
    if (this.expandedMessages.has(key)) {
      this.expandedMessages.delete(key)
    } else {
      this.expandedMessages.add(key)
    }
    this.renderContent()
  }

  private getToolSummary(msg: ConversationMessage): string {
    const input = msg.toolInput
    if (!input) return msg.content

    const filePath = this.getToolFilePath(msg)
    if (filePath) return filePath
    if (input.command) return this.truncate(String(input.command), 40)
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

  private formatToolInput(input: ConversationMessage['toolInput']): string {
    if (!input) return ''
    if (typeof input === 'string') return input
    return Object.entries(input)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join('\n')
  }

  private truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen) + '...'
  }

  /**
   * Update scale based on camera distance (for zoom clamping)
   */
  setScale(scale: number): void {
    // Clamp scale for readability (card base width is 250px)
    const minScale = 0.72  // 250 * 0.72 = 180px at far zoom
    const maxScale = 1.2   // 250 * 1.2 = 300px at close zoom
    const clampedScale = Math.max(minScale, Math.min(maxScale, scale))
    this.element.style.transform = `scale(${clampedScale})`
  }

  get workerId(): string {
    return this.session.id
  }

  get tmuxSession(): string {
    return this.session.tmuxSession
  }

  dispose(): void {
    this.disposed = true
    this.clearFetchTimeout()
    this.element.remove()
  }
}

// Types for message grouping
type MessageGroup =
  | { type: 'message'; msg: ConversationMessage }
  | ToolGroup

interface ToolGroup {
  type: 'tool_group'
  items: Array<{ msg: ConversationMessage; result?: ConversationMessage }>
  startIndex: number
}
