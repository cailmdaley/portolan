/**
 * claims-annotate.js — Injected into claims dashboard when viewed inside portolan iframe.
 * Adds inline text and image annotation affordances.
 * Communicates with parent via postMessage.
 */
;(function () {
  // Only activate inside an iframe (portolan embeds the dashboard)
  if (window === window.top) return

  const cityId = window.CLAIMS_CITY_ID || ''
  let activeInput = null // current annotation input element

  // ── Helpers ───────────────────────────────────────────────────────────

  function removeActiveInput() {
    if (activeInput) {
      activeInput.remove()
      activeInput = null
    }
  }

  function getClaimContext(el) {
    // Walk up to find the claim container with data attributes
    let node = el
    while (node && node !== document.body) {
      if (node.dataset && node.dataset.claimId) {
        return {
          claimId: node.dataset.claimId,
          claimTitle: node.dataset.claimTitle || '',
        }
      }
      node = node.parentElement
    }
    return null
  }

  function createAnnotationInput(opts) {
    removeActiveInput()

    const wrapper = document.createElement('div')
    wrapper.className = 'portolan-annotation-input'
    wrapper.style.cssText = `
      position: fixed;
      z-index: 99999;
      left: ${opts.screenX}px;
      top: ${opts.screenY}px;
      background: #EDE8E0;
      border: 1px solid #C8B8A8;
      border-radius: 6px;
      padding: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      font-family: -apple-system, sans-serif;
      font-size: 13px;
      min-width: 240px;
      max-width: 320px;
    `

    const preview = opts.previewHtml || ''
    wrapper.innerHTML = `
      ${preview}
      <textarea style="
        width: 100%; min-height: 60px; margin-top: 4px;
        border: 1px solid #C8B8A8; border-radius: 4px;
        padding: 6px; font-size: 13px; font-family: inherit;
        background: #fff; resize: vertical;
      " placeholder="Add annotation..."></textarea>
      <div style="display: flex; gap: 6px; margin-top: 6px; justify-content: flex-end;">
        <button class="pa-cancel" style="
          padding: 4px 10px; border: 1px solid #C8B8A8; border-radius: 4px;
          background: #fff; cursor: pointer; font-size: 12px;
        ">Cancel</button>
        <button class="pa-save" style="
          padding: 4px 10px; border: none; border-radius: 4px;
          background: #9A7B35; color: #fff; cursor: pointer; font-size: 12px;
        ">Save</button>
      </div>
    `

    const textarea = wrapper.querySelector('textarea')
    const saveBtn = wrapper.querySelector('.pa-save')
    const cancelBtn = wrapper.querySelector('.pa-cancel')

    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      removeActiveInput()
    })

    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const comment = textarea.value.trim()
      if (!comment) return
      opts.onSave(comment)
      removeActiveInput()
    })

    // Prevent clicks inside from propagating
    wrapper.addEventListener('mousedown', (e) => e.stopPropagation())
    wrapper.addEventListener('click', (e) => e.stopPropagation())

    document.body.appendChild(wrapper)
    activeInput = wrapper

    // Clamp to viewport
    requestAnimationFrame(() => {
      const rect = wrapper.getBoundingClientRect()
      if (rect.right > window.innerWidth - 10) {
        wrapper.style.left = Math.max(10, window.innerWidth - rect.width - 10) + 'px'
      }
      if (rect.bottom > window.innerHeight - 10) {
        wrapper.style.top = Math.max(10, window.innerHeight - rect.height - 10) + 'px'
      }
      textarea.focus()
    })
  }

  // ── Text Annotation (mouseup on claim content) ────────────────────────

  document.addEventListener('mouseup', (e) => {
    // Small delay so selection finalizes
    setTimeout(() => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.toString().trim()) return

      const selectedText = sel.toString().trim()
      const range = sel.getRangeAt(0)
      const claim = getClaimContext(range.startContainer)
      if (!claim) return

      const rect = range.getBoundingClientRect()

      createAnnotationInput({
        screenX: Math.min(rect.left, window.innerWidth - 280),
        screenY: rect.bottom + 6,
        previewHtml: `<div style="
          padding: 4px 8px; background: rgba(154,123,53,0.1);
          border-left: 3px solid #9A7B35; font-size: 12px;
          color: #2E2A26; max-height: 60px; overflow: hidden;
          margin-bottom: 4px; border-radius: 0 4px 4px 0;
        ">"${selectedText.slice(0, 80)}${selectedText.length > 80 ? '…' : ''}"</div>`,
        onSave(comment) {
          parent.postMessage({
            type: 'claims-annotation-save',
            claimId: claim.claimId,
            claimTitle: claim.claimTitle,
            selectedText: selectedText,
            comment: comment,
          }, '*')
        },
      })
    }, 10)
  })

  // ── Image Annotation (click on artifact images) ───────────────────────

  document.addEventListener('click', (e) => {
    const img = e.target
    if (img.tagName !== 'IMG' || !img.dataset.artifact) return

    const claim = getClaimContext(img)
    if (!claim) return

    e.preventDefault()
    e.stopPropagation()

    const imgRect = img.getBoundingClientRect()
    const x = ((e.clientX - imgRect.left) / imgRect.width) * 100
    const y = ((e.clientY - imgRect.top) / imgRect.height) * 100

    // Place a temporary pin marker
    const pin = document.createElement('div')
    pin.className = 'portolan-pin-marker'
    pin.style.cssText = `
      position: absolute;
      left: ${x}%;
      top: ${y}%;
      transform: translate(-50%, -50%);
      width: 16px; height: 16px;
      border-radius: 50%;
      background: #9A7B35;
      border: 2px solid #EDE8E0;
      box-shadow: 0 2px 4px rgba(0,0,0,0.3);
      pointer-events: none;
      z-index: 99998;
    `

    // Image needs a positioned parent
    const container = img.parentElement
    if (container && getComputedStyle(container).position === 'static') {
      container.style.position = 'relative'
    }
    if (container) container.appendChild(pin)

    createAnnotationInput({
      screenX: e.clientX + 12,
      screenY: e.clientY - 20,
      previewHtml: `<div style="
        display: flex; align-items: center; gap: 6px;
        font-size: 12px; color: #7A7368; margin-bottom: 4px;
      "><span style="
        width: 10px; height: 10px; border-radius: 50%;
        background: #9A7B35; display: inline-block;
      "></span> Pin on ${img.dataset.artifact}</div>`,
      onSave(comment) {
        parent.postMessage({
          type: 'claims-annotation-save',
          claimId: claim.claimId,
          claimTitle: claim.claimTitle,
          artifact: img.dataset.artifact,
          x: x,
          y: y,
          comment: comment,
        }, '*')
      },
    })

    // Remove pin if cancelled (input removed but pin stays)
    const observer = new MutationObserver(() => {
      if (!document.querySelector('.portolan-annotation-input')) {
        pin.remove()
        observer.disconnect()
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }, true) // capture phase to fire before dashboard handlers

  // ── Load existing annotations on claim open ───────────────────────────

  // Watch for claim modals appearing (MutationObserver on body)
  const claimObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue
        // Check if this is or contains a claim panel
        const panels = node.dataset && node.dataset.claimId
          ? [node]
          : (node.querySelectorAll ? [...node.querySelectorAll('[data-claim-id]')] : [])

        for (const panel of panels) {
          parent.postMessage({
            type: 'claims-annotation-load',
            claimId: panel.dataset.claimId,
          }, '*')
        }
      }
    }
  })
  claimObserver.observe(document.body, { childList: true, subtree: true })

  // ── Receive annotation data from parent ───────────────────────────────

  window.addEventListener('message', (event) => {
    if (event.data.type === 'claims-annotation-loaded') {
      renderExistingAnnotations(event.data.claimId, event.data.annotations || [])
    }
  })

  function renderExistingAnnotations(claimId, annotations) {
    // Find the claim panel
    const panel = document.querySelector(`[data-claim-id="${claimId}"]`)
    if (!panel) return

    // Clear old markers
    panel.querySelectorAll('.portolan-existing-marker').forEach((m) => m.remove())

    annotations.forEach((ann, i) => {
      if (ann.artifact && ann.x !== undefined && ann.y !== undefined) {
        // Image pin — find the artifact image
        const img = panel.querySelector(`img[data-artifact="${ann.artifact}"]`)
        if (!img) return

        const container = img.parentElement
        if (container && getComputedStyle(container).position === 'static') {
          container.style.position = 'relative'
        }

        const marker = document.createElement('div')
        marker.className = 'portolan-existing-marker'
        marker.style.cssText = `
          position: absolute;
          left: ${ann.x}%; top: ${ann.y}%;
          transform: translate(-50%, -50%);
          width: 20px; height: 20px;
          border-radius: 50%;
          background: #9A7B35;
          border: 2px solid #EDE8E0;
          color: #fff; font-size: 10px;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer; z-index: 99997;
        `
        marker.textContent = String(i + 1)
        marker.title = ann.comment
        if (container) container.appendChild(marker)
      } else if (ann.selectedText) {
        // Text annotation — show as a small badge near the panel header
        const badge = document.createElement('div')
        badge.className = 'portolan-existing-marker'
        badge.style.cssText = `
          display: inline-flex; align-items: center; gap: 4px;
          padding: 2px 8px; margin: 2px 4px;
          background: rgba(154,123,53,0.12);
          border-left: 3px solid #9A7B35;
          font-size: 11px; color: #2E2A26;
          border-radius: 0 4px 4px 0;
          cursor: default;
        `
        badge.title = ann.comment
        badge.textContent = `"${ann.selectedText.slice(0, 40)}${ann.selectedText.length > 40 ? '…' : ''}" — ${ann.comment.slice(0, 40)}`
        panel.insertBefore(badge, panel.firstChild)
      }
    })
  }

  // ── Dismiss on Escape ─────────────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') removeActiveInput()
  })

  // ── Visual indicator that annotations are active ──────────────────────

  const style = document.createElement('style')
  style.textContent = `
    [data-claim-id] { cursor: text; }
    img[data-artifact] { cursor: crosshair !important; }
    .portolan-annotation-input textarea:focus {
      outline: 2px solid #9A7B35;
      outline-offset: -1px;
    }
  `
  document.head.appendChild(style)
})()
