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

  function ensurePositionedParent(el) {
    const container = el.parentElement
    if (container && getComputedStyle(container).position === 'static') {
      container.style.position = 'relative'
    }
    return container
  }

  function addHoverFade(el) {
    el.style.opacity = '0.6'
    el.style.transition = 'opacity 150ms'
    el.addEventListener('mouseenter', () => { el.style.opacity = '1' })
    el.addEventListener('mouseleave', () => { el.style.opacity = '0.6' })
  }

  function clampToViewport(el) {
    requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect()
      if (rect.right > window.innerWidth - 10) {
        el.style.left = Math.max(10, window.innerWidth - rect.width - 10) + 'px'
      }
      if (rect.bottom > window.innerHeight - 10) {
        el.style.top = Math.max(10, window.innerHeight - rect.height - 10) + 'px'
      }
    })
  }

  function postAnnotationMessage(type, payload) {
    parent.postMessage({ type, ...payload }, '*')
  }

  function getClaimContext(el) {
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
      wrapper._saved = true
      removeActiveInput()
    })

    // Prevent clicks inside from propagating
    wrapper.addEventListener('mousedown', (e) => e.stopPropagation())
    wrapper.addEventListener('click', (e) => e.stopPropagation())

    document.body.appendChild(wrapper)
    activeInput = wrapper

    clampToViewport(wrapper)
    requestAnimationFrame(() => textarea.focus())
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
          postAnnotationMessage('claims-annotation-save', {
            claimId: claim.claimId,
            claimTitle: claim.claimTitle,
            selectedText,
            comment,
          })
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

    const container = ensurePositionedParent(img)
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
        postAnnotationMessage('claims-annotation-save', {
          claimId: claim.claimId,
          claimTitle: claim.claimTitle,
          artifact: img.dataset.artifact,
          x,
          y,
          comment,
        })
      },
    })

    // Remove pin only on cancel; on save, pin stays until permanent marker replaces it
    const inputRef = activeInput
    const observer = new MutationObserver(() => {
      if (!document.querySelector('.portolan-annotation-input')) {
        if (!inputRef || !inputRef._saved) pin.remove()
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
        // nodeType === 1 guarantees an Element with querySelectorAll
        const panels = node.dataset && node.dataset.claimId
          ? [node]
          : [...node.querySelectorAll('[data-claim-id]')]

        for (const panel of panels) {
          postAnnotationMessage('claims-annotation-load', {
            claimId: panel.dataset.claimId,
          })
        }
      }
    }
  })
  claimObserver.observe(document.body, { childList: true, subtree: true })

  // ── Receive annotation data from parent ───────────────────────────────

  window.addEventListener('message', (event) => {
    if (event.data.type === 'claims-annotation-loaded') {
      renderExistingAnnotations(event.data.claimId, event.data.annotations || [])
    } else if (event.data.type === 'claims-annotation-promoted') {
      showPromotedFeedback(event.data.annotationId)
    }
  })

  function showPromotedFeedback(annotationId) {
    if (!annotationId) return
    // Find the promote button by annotation ID and show checkmark
    const btn = document.querySelector(`.portolan-promote-btn[data-annotation-id="${annotationId}"]`)
    if (!btn) return
    btn.style.color = '#5A7B5A'
    btn.textContent = '\u2713'
    setTimeout(() => {
      btn.style.color = '#9A7B35'
      btn.textContent = '\u2B06'
    }, 2000)
  }

  function createPromoteBtn(annotation) {
    const btn = document.createElement('span')
    btn.className = 'portolan-promote-btn'
    btn.dataset.annotationId = annotation.id
    btn.textContent = '\u2B06'
    btn.title = 'Promote to felt'
    btn.style.cssText = `
      cursor: pointer; margin-left: 2px;
      color: #9A7B35; font-size: 12px; line-height: 1;
    `
    addHoverFade(btn)
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      postAnnotationMessage('claims-annotation-promote', {
        claimId: annotation.claimId,
        annotationId: annotation.id,
        comment: annotation.comment,
      })
    })
    return btn
  }

  function createDeleteBtn(annotationId, claimId) {
    const btn = document.createElement('span')
    btn.className = 'portolan-delete-btn'
    btn.textContent = '\u00d7'
    btn.title = 'Delete annotation'
    btn.style.cssText = `
      cursor: pointer; margin-left: 4px;
      color: #7A7368; font-size: 14px; line-height: 1;
    `
    addHoverFade(btn)
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      postAnnotationMessage('claims-annotation-delete', { annotationId, claimId })
    })
    return btn
  }

  function createPopoverActionBtn(label, borderColor, textColor, onClick) {
    const btn = document.createElement('button')
    btn.textContent = label
    btn.style.cssText = `
      padding: 2px 8px; border: 1px solid ${borderColor}; border-radius: 4px;
      background: transparent; color: ${textColor}; cursor: pointer;
      font-size: 11px; font-family: inherit;
    `
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      onClick()
    })
    return btn
  }

  function showPinPopover(marker, ann, claimId) {
    document.querySelectorAll('.portolan-pin-popover').forEach((p) => p.remove())

    const rect = marker.getBoundingClientRect()
    const popover = document.createElement('div')
    popover.className = 'portolan-pin-popover'
    popover.style.cssText = `
      position: fixed;
      left: ${rect.right + 8}px;
      top: ${rect.top - 4}px;
      background: #EDE8E0;
      border: 1px solid #C8B8A8;
      border-radius: 6px;
      padding: 8px 10px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      font-family: -apple-system, sans-serif;
      font-size: 12px;
      max-width: 260px;
      z-index: 99999;
    `

    const commentText = document.createElement('div')
    commentText.style.cssText = 'color: #2E2A26; margin-bottom: 6px; line-height: 1.4;'
    commentText.textContent = ann.comment

    const actions = document.createElement('div')
    actions.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;'

    actions.appendChild(createPopoverActionBtn('\u2B06 Felt', '#9A7B35', '#9A7B35', () => {
      postAnnotationMessage('claims-annotation-promote', {
        claimId: ann.claimId,
        annotationId: ann.id,
        comment: ann.comment,
      })
      popover.remove()
    }))

    actions.appendChild(createPopoverActionBtn('\u00d7 Delete', '#C8B8A8', '#7A7368', () => {
      postAnnotationMessage('claims-annotation-delete', {
        annotationId: ann.id,
        claimId,
      })
      popover.remove()
    }))

    popover.appendChild(commentText)
    popover.appendChild(actions)

    popover.addEventListener('mousedown', (e) => e.stopPropagation())
    popover.addEventListener('click', (e) => e.stopPropagation())

    document.body.appendChild(popover)

    // Clamp to viewport, flipping to left of marker if needed
    requestAnimationFrame(() => {
      const r = popover.getBoundingClientRect()
      if (r.right > window.innerWidth - 10) {
        popover.style.left = Math.max(10, rect.left - r.width - 8) + 'px'
      }
      if (r.bottom > window.innerHeight - 10) {
        popover.style.top = Math.max(10, window.innerHeight - r.height - 10) + 'px'
      }
    })

    // Dismiss on click outside
    const dismiss = (e) => {
      if (!popover.contains(e.target) && e.target !== marker) {
        popover.remove()
        document.removeEventListener('mousedown', dismiss)
      }
    }
    setTimeout(() => document.addEventListener('mousedown', dismiss), 0)
  }

  function renderExistingAnnotations(claimId, annotations) {
    const panel = document.querySelector(`[data-claim-id="${claimId}"]`)
    if (!panel) return

    // Clear old markers, temporary pins, and any open popovers
    panel.querySelectorAll('.portolan-existing-marker, .portolan-pin-marker').forEach((m) => m.remove())
    document.querySelectorAll('.portolan-pin-popover').forEach((p) => p.remove())

    // Add "Send to Worker" button if there are annotations
    if (annotations.length > 0) {
      const sendBar = document.createElement('div')
      sendBar.className = 'portolan-existing-marker portolan-send-bar'
      sendBar.style.cssText = `
        display: flex; align-items: center; gap: 8px;
        padding: 6px 10px; margin: 4px 0 8px;
        background: rgba(154,123,53,0.08);
        border-radius: 4px;
        font-size: 12px; color: #7A7368;
      `
      const sendBtn = document.createElement('button')
      sendBtn.textContent = `Send ${annotations.length} annotation${annotations.length === 1 ? '' : 's'} to worker`
      sendBtn.style.cssText = `
        padding: 4px 12px; border: none; border-radius: 4px;
        background: #9A7B35; color: #fff; cursor: pointer;
        font-size: 12px; font-family: inherit;
      `
      sendBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        postAnnotationMessage('claims-annotation-send', { claimId, cityId })
      })
      sendBar.appendChild(sendBtn)
      panel.insertBefore(sendBar, panel.firstChild)
    }

    annotations.forEach((ann, i) => {
      if (ann.artifact && ann.x !== undefined && ann.y !== undefined) {
        // Image pin — find the artifact image
        const img = panel.querySelector(`img[data-artifact="${ann.artifact}"]`)
        if (!img) return

        const container = ensurePositionedParent(img)

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
        marker.dataset.annotationId = ann.id
        // Click to show popover with comment, promote, delete
        marker.addEventListener('click', (e) => {
          e.stopPropagation()
          e.preventDefault()
          showPinPopover(marker, ann, claimId)
        })
        marker.addEventListener('contextmenu', (e) => {
          e.preventDefault()
          postAnnotationMessage('claims-annotation-delete', { annotationId: ann.id, claimId })
        })
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
        badge.dataset.annotationId = ann.id
        const textSpan = document.createElement('span')
        textSpan.textContent = `"${ann.selectedText.slice(0, 40)}${ann.selectedText.length > 40 ? '\u2026' : ''}" \u2014 ${ann.comment.slice(0, 40)}`
        badge.appendChild(textSpan)
        badge.appendChild(createPromoteBtn(ann))
        badge.appendChild(createDeleteBtn(ann.id, claimId))
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
