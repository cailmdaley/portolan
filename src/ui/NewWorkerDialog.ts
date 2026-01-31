// NewWorkerDialog.ts - In-game dialog for creating new workers

export interface NewWorkerOptions {
  name: string
  chrome: boolean
  continue: boolean
}

export class NewWorkerDialog {
  private overlay: HTMLElement
  private dialog: HTMLElement
  private nameInput: HTMLInputElement
  private chromeCheckbox: HTMLInputElement
  private continueCheckbox: HTMLInputElement
  private resolvePromise: ((result: NewWorkerOptions | null) => void) | null = null

  constructor() {
    this.overlay = this.createOverlay()
    this.dialog = this.createDialog()
    this.nameInput = this.dialog.querySelector('.worker-name-input') as HTMLInputElement
    this.chromeCheckbox = this.dialog.querySelector('.chrome-checkbox') as HTMLInputElement
    this.continueCheckbox = this.dialog.querySelector('.continue-checkbox') as HTMLInputElement

    this.overlay.appendChild(this.dialog)
    document.body.appendChild(this.overlay)

    // Handle escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.overlay.style.display !== 'none') {
        this.cancel()
      }
    })
  }

  private createOverlay(): HTMLElement {
    const overlay = document.createElement('div')
    overlay.className = 'new-worker-overlay'
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 2000;
    `
    // Click outside to cancel
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        this.cancel()
      }
    })
    return overlay
  }

  private createDialog(): HTMLElement {
    const dialog = document.createElement('div')
    dialog.className = 'new-worker-dialog'
    dialog.style.cssText = `
      background: var(--bg-card, #EDE8E0);
      border: 1px solid var(--border, #8B7355);
      border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
      padding: 20px 28px;
      width: 400px;
      font-family: 'EB Garamond', Garamond, serif;
    `

    dialog.innerHTML = `
      <h3 style="
        margin: 0 0 20px 0;
        font-size: 18px;
        font-weight: 500;
        color: var(--text-primary, #2E2A26);
      ">New Worker</h3>

      <div style="margin-bottom: 16px;">
        <label style="
          display: block;
          margin-bottom: 6px;
          font-size: 14px;
          color: var(--text-muted, #7A7368);
        ">Name (optional)</label>
        <input type="text" class="worker-name-input" placeholder="Auto-generated if empty" style="
          width: 100%;
          padding: 10px 12px;
          font-family: inherit;
          font-size: 15px;
          border: 1px solid var(--border, #8B7355);
          border-radius: 4px;
          background: var(--bg-elevated, #FAF8F5);
          color: var(--text-primary, #2E2A26);
          box-sizing: border-box;
          outline: none;
          transition: border-color 0.15s;
        " />
      </div>

      <div style="margin-bottom: 16px;">
        <label style="
          display: flex;
          align-items: center;
          gap: 10px;
          cursor: pointer;
          font-size: 14px;
          color: var(--text-primary, #2E2A26);
        ">
          <span class="checkbox-wrapper" style="
            position: relative;
            width: 20px;
            height: 20px;
          ">
            <input type="checkbox" class="continue-checkbox" style="
              position: absolute;
              opacity: 0;
              width: 100%;
              height: 100%;
              cursor: pointer;
              margin: 0;
            " />
            <span class="continue-checkbox-visual" style="
              display: block;
              width: 20px;
              height: 20px;
              border: 2px solid var(--border, #8B7355);
              border-radius: 4px;
              background: var(--bg-elevated, #FAF8F5);
              transition: all 0.15s;
            "></span>
          </span>
          <span>Continue last conversation (-c)</span>
        </label>
      </div>

      <div style="margin-bottom: 24px;">
        <label style="
          display: flex;
          align-items: center;
          gap: 10px;
          cursor: pointer;
          font-size: 14px;
          color: var(--text-primary, #2E2A26);
        ">
          <span class="checkbox-wrapper" style="
            position: relative;
            width: 20px;
            height: 20px;
          ">
            <input type="checkbox" class="chrome-checkbox" style="
              position: absolute;
              opacity: 0;
              width: 100%;
              height: 100%;
              cursor: pointer;
              margin: 0;
            " />
            <span class="chrome-checkbox-visual" style="
              display: block;
              width: 20px;
              height: 20px;
              border: 2px solid var(--border, #8B7355);
              border-radius: 4px;
              background: var(--bg-elevated, #FAF8F5);
              transition: all 0.15s;
            "></span>
          </span>
          <span>Enable browser automation (--chrome)</span>
        </label>
      </div>

      <div style="display: flex; gap: 12px; justify-content: flex-end;">
        <button class="cancel-btn" style="
          padding: 10px 20px;
          font-family: inherit;
          font-size: 14px;
          border: 1px solid var(--border, #8B7355);
          border-radius: 4px;
          background: transparent;
          color: var(--text-primary, #2E2A26);
          cursor: pointer;
          transition: background 0.15s;
        ">Cancel</button>
        <button class="create-btn" style="
          padding: 10px 20px;
          font-family: inherit;
          font-size: 14px;
          border: none;
          border-radius: 4px;
          background: var(--gold, #9A7B35);
          color: white;
          cursor: pointer;
          transition: background 0.15s;
        ">Create</button>
      </div>
    `

    // Style checkboxes when checked
    const setupCheckbox = (checkboxClass: string, visualClass: string) => {
      const checkbox = dialog.querySelector(`.${checkboxClass}`) as HTMLInputElement
      const visual = dialog.querySelector(`.${visualClass}`) as HTMLElement
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          visual.style.background = 'var(--gold, #9A7B35)'
          visual.style.borderColor = 'var(--gold, #9A7B35)'
          visual.innerHTML = `<svg viewBox="0 0 16 16" style="width: 16px; height: 16px; display: block;"><path fill="white" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>`
        } else {
          visual.style.background = 'var(--bg-elevated, #FAF8F5)'
          visual.style.borderColor = 'var(--border, #8B7355)'
          visual.innerHTML = ''
        }
      })
    }
    setupCheckbox('continue-checkbox', 'continue-checkbox-visual')
    setupCheckbox('chrome-checkbox', 'chrome-checkbox-visual')

    // Input focus styles
    const input = dialog.querySelector('.worker-name-input') as HTMLInputElement
    input.addEventListener('focus', () => {
      input.style.borderColor = 'var(--gold, #9A7B35)'
    })
    input.addEventListener('blur', () => {
      input.style.borderColor = 'var(--border, #8B7355)'
    })

    // Button hover effects
    const cancelBtn = dialog.querySelector('.cancel-btn') as HTMLButtonElement
    const createBtn = dialog.querySelector('.create-btn') as HTMLButtonElement

    cancelBtn.addEventListener('mouseenter', () => {
      cancelBtn.style.background = 'rgba(0, 0, 0, 0.05)'
    })
    cancelBtn.addEventListener('mouseleave', () => {
      cancelBtn.style.background = 'transparent'
    })
    cancelBtn.addEventListener('click', () => this.cancel())

    createBtn.addEventListener('mouseenter', () => {
      createBtn.style.background = '#7A6228'
    })
    createBtn.addEventListener('mouseleave', () => {
      createBtn.style.background = 'var(--gold, #9A7B35)'
    })
    createBtn.addEventListener('click', () => this.confirm())

    // Enter key to confirm
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.confirm()
      }
    })

    return dialog
  }

  show(cityName: string): Promise<NewWorkerOptions | null> {
    // Update title with city name
    const title = this.dialog.querySelector('h3')
    if (title) {
      title.textContent = `New Worker in ${cityName}`
    }

    // Reset form
    this.nameInput.value = ''
    this.continueCheckbox.checked = false
    this.chromeCheckbox.checked = false
    const resetCheckboxVisual = (className: string) => {
      const visual = this.dialog.querySelector(`.${className}`) as HTMLElement
      visual.style.background = 'var(--bg-elevated, #FAF8F5)'
      visual.style.borderColor = 'var(--border, #8B7355)'
      visual.innerHTML = ''
    }
    resetCheckboxVisual('continue-checkbox-visual')
    resetCheckboxVisual('chrome-checkbox-visual')

    // Show dialog
    this.overlay.style.display = 'flex'

    // Focus input after a tick (for animation)
    setTimeout(() => this.nameInput.focus(), 50)

    return new Promise((resolve) => {
      this.resolvePromise = resolve
    })
  }

  private confirm(): void {
    const result: NewWorkerOptions = {
      name: this.nameInput.value.trim(),
      chrome: this.chromeCheckbox.checked,
      continue: this.continueCheckbox.checked,
    }
    this.hide()
    this.resolvePromise?.(result)
    this.resolvePromise = null
  }

  private cancel(): void {
    this.hide()
    this.resolvePromise?.(null)
    this.resolvePromise = null
  }

  private hide(): void {
    this.overlay.style.display = 'none'
  }
}
