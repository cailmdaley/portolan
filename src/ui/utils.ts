// Shared UI utilities
import { marked } from 'marked'

// Configure marked for safe rendering
marked.setOptions({
  gfm: true,        // GitHub Flavored Markdown
  breaks: true,     // Convert \n to <br>
})

// Custom renderer for code blocks to integrate with Prism
const renderer = new marked.Renderer()
renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
  const language = lang || 'plaintext'
  // Prism will highlight after DOM insertion
  const escapedCode = escapeHtml(text)
  return `<pre class="md-code-block language-${language}"><code class="language-${language}">${escapedCode}</code></pre>`
}

renderer.codespan = ({ text }: { text: string }) => {
  return `<code class="md-inline-code">${escapeHtml(text)}</code>`
}

renderer.link = ({ href, text }: { href: string; text: string }) => {
  return `<a href="${escapeHtml(href)}" class="md-link" target="_blank" rel="noopener">${text}</a>`
}

marked.use({ renderer })

/**
 * Escape HTML to prevent XSS
 */
export function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

/**
 * Render markdown to HTML with syntax highlighting
 * Uses marked library with Prism.js for code blocks
 */
export function renderMarkdown(text: string): string {
  try {
    const html = marked.parse(text) as string
    return html
  } catch (e) {
    console.error('Markdown render error:', e)
    return escapeHtml(text)
  }
}

/**
 * Apply Prism syntax highlighting to code blocks in a container
 * Call after inserting markdown HTML into the DOM
 */
export function highlightCodeBlocks(container: HTMLElement): void {
  if (typeof window !== 'undefined' && (window as unknown as { Prism?: { highlightAllUnder: (el: HTMLElement) => void } }).Prism) {
    (window as unknown as { Prism: { highlightAllUnder: (el: HTMLElement) => void } }).Prism.highlightAllUnder(container)
  }
}

/**
 * Format a timestamp as relative time (e.g., "5m ago", "2h ago")
 * Returns empty string for invalid timestamps
 */
export function formatTimeAgo(timestamp: number): string {
  // Handle NaN/invalid timestamps (e.g., from malformed date strings)
  if (!Number.isFinite(timestamp)) return ''

  const diffMs = Date.now() - timestamp
  const diffMins = Math.floor(diffMs / 60000)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`

  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d ago`

  return new Date(timestamp).toLocaleDateString()
}

/**
 * Show a toast notification
 */
export function showToast(message: string, type: 'success' | 'error' = 'success', duration = 3000): void {
  // Remove existing toasts
  const existing = document.querySelector('.portolan-toast')
  if (existing) existing.remove()

  const toast = document.createElement('div')
  toast.className = 'portolan-toast'
  toast.innerHTML = `
    <span class="toast-icon">${type === 'success' ? '✓' : '✕'}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
  `

  // Inject styles if not present
  if (!document.getElementById('portolan-toast-styles')) {
    const style = document.createElement('style')
    style.id = 'portolan-toast-styles'
    style.textContent = `
      .portolan-toast {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%) translateY(100px);
        background: #1a1a1a;
        color: #f5f5f0;
        padding: 12px 20px;
        border-radius: 8px;
        display: flex;
        align-items: center;
        gap: 10px;
        font-family: 'EB Garamond', Garamond, serif;
        font-size: 14px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        z-index: 10000;
        opacity: 0;
        animation: toast-in 0.3s ease forwards;
      }
      .portolan-toast.toast-out {
        animation: toast-out 0.3s ease forwards;
      }
      .portolan-toast .toast-icon {
        font-size: 16px;
        font-weight: bold;
      }
      .portolan-toast.success .toast-icon { color: #c9a959; }
      .portolan-toast.error .toast-icon { color: #d9534f; }
      @keyframes toast-in {
        from { opacity: 0; transform: translateX(-50%) translateY(100px); }
        to { opacity: 1; transform: translateX(-50%) translateY(0); }
      }
      @keyframes toast-out {
        from { opacity: 1; transform: translateX(-50%) translateY(0); }
        to { opacity: 0; transform: translateX(-50%) translateY(100px); }
      }
    `
    document.head.appendChild(style)
  }

  toast.classList.add(type)
  document.body.appendChild(toast)

  setTimeout(() => {
    toast.classList.add('toast-out')
    setTimeout(() => toast.remove(), 300)
  }, duration)
}
