const API_BASE = `http://${window.location.hostname}:4004`

interface FileViewerTextActionsOptions {
  saveBtn: HTMLElement
  copyBtn: HTMLElement
  downloadBtn: HTMLElement
  scheduleDeferredUiTask: (task: () => void, delayMs: number) => number
  isVisible: () => boolean
}

interface SaveFileOptions {
  path: string
  content: string
  originId: string
}

interface TextPayload {
  content: string
  filename: string
}

export class FileViewerTextActions {
  private saveBtn: HTMLElement
  private copyBtn: HTMLElement
  private downloadBtn: HTMLElement
  private scheduleDeferredUiTask: FileViewerTextActionsOptions['scheduleDeferredUiTask']
  private isVisible: () => boolean

  constructor(options: FileViewerTextActionsOptions) {
    this.saveBtn = options.saveBtn
    this.copyBtn = options.copyBtn
    this.downloadBtn = options.downloadBtn
    this.scheduleDeferredUiTask = options.scheduleDeferredUiTask
    this.isVisible = options.isVisible
  }

  async saveFile(options: SaveFileOptions): Promise<boolean> {
    try {
      this.saveBtn.textContent = 'Saving...'
      this.saveBtn.setAttribute('disabled', 'true')

      const response = await fetch(`${API_BASE}/save-file`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(options),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to save file')
      }

      this.saveBtn.textContent = 'Saved!'
      this.scheduleDeferredUiTask(() => {
        if (!this.isVisible()) return
        this.saveBtn.textContent = 'Save'
        this.saveBtn.removeAttribute('disabled')
      }, 1500)
      return true
    } catch (error: any) {
      console.error('Failed to save file:', error)
      this.saveBtn.textContent = 'Save'
      this.saveBtn.removeAttribute('disabled')
      alert(`Failed to save: ${error.message}`)
      return false
    }
  }

  async copyText(content: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(content)
      const originalText = this.copyBtn.textContent
      this.copyBtn.textContent = 'Copied!'
      this.scheduleDeferredUiTask(() => {
        if (!this.isVisible()) return
        this.copyBtn.textContent = originalText
      }, 1500)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = content
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      this.copyBtn.textContent = 'Copied!'
      this.scheduleDeferredUiTask(() => {
        if (!this.isVisible()) return
        this.copyBtn.textContent = 'Copy'
      }, 1500)
    }
  }

  downloadText(payload: TextPayload): void {
    const blob = new Blob([payload.content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = payload.filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)

    const originalText = this.downloadBtn.textContent
    this.downloadBtn.textContent = 'Downloaded!'
    this.scheduleDeferredUiTask(() => {
      if (!this.isVisible()) return
      this.downloadBtn.textContent = originalText
    }, 1500)
  }
}
