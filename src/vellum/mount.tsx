/**
 * Vellum mount seams for portolan.
 *
 * Two entry points:
 *
 *   - mountVellumFileViewer(container, …) — raw page mount, used when the
 *     host already owns a container and wants FileViewerPage inside it
 *     (e.g. inline panels, debug surfaces).
 *   - openVellumFileModal({ path, … }) — full-viewport modal: creates a scrim
 *     container, mounts vellum's FileViewerModal inside, and returns a close
 *     handle. Replaces the hand-rolled overlay main.ts used to roll itself.
 *
 * Everything outside this file stays vanilla TS/Three.js. React only lives
 * inside the React root this file creates — see vellum-in-portolan.
 */

import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AdapterProvider, FileViewerModal, FileViewerPage } from 'vellum'
import 'vellum/css'
import { createPortolanAdapter } from './portolan-adapter'

export interface MountFileViewerOptions {
  container: HTMLElement
  path: string
  originId?: string
  cityId?: string
  cacheBust?: boolean
  editable?: boolean
  jumpToLine?: number
}

export interface VellumMountHandle {
  update(options: Omit<MountFileViewerOptions, 'container'>): void
  unmount(): void
}

export function mountVellumFileViewer(options: MountFileViewerOptions): VellumMountHandle {
  const root: Root = createRoot(options.container)

  const render = (opts: Omit<MountFileViewerOptions, 'container'>) => {
    const adapter = createPortolanAdapter({
      cityId: opts.cityId,
      defaultOriginId: opts.originId,
    })
    root.render(
      <StrictMode>
        <AdapterProvider adapter={adapter}>
          <FileViewerPage
            path={opts.path}
            originId={opts.originId}
            cacheBust={opts.cacheBust}
            editable={opts.editable}
            jumpToLine={opts.jumpToLine}
          />
        </AdapterProvider>
      </StrictMode>,
    )
  }

  render(options)

  return {
    update(opts) {
      render(opts)
    },
    unmount() {
      root.unmount()
    },
  }
}

export interface OpenFileModalOptions {
  path: string
  originId?: string
  cityId?: string
  editable?: boolean
  jumpToLine?: number
}

export interface VellumModalHandle {
  close(): void
}

/**
 * Full-viewport vellum file modal. Creates its own container, mounts
 * FileViewerModal with an AdapterProvider, and tears down on close.
 */
export function openVellumFileModal(opts: OpenFileModalOptions): VellumModalHandle {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const adapter = createPortolanAdapter({
    cityId: opts.cityId,
    defaultOriginId: opts.originId,
  })

  const close = () => {
    root.unmount()
    container.remove()
  }

  root.render(
    <StrictMode>
      <AdapterProvider adapter={adapter}>
        <FileViewerModal
          path={opts.path}
          originId={opts.originId}
          cityId={opts.cityId}
          editable={opts.editable}
          jumpToLine={opts.jumpToLine}
          onClose={close}
        />
      </AdapterProvider>
    </StrictMode>,
  )

  return { close }
}
