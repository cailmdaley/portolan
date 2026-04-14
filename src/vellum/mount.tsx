/**
 * mountVellumFileViewer — portolan's React seam.
 *
 * Mounts vellum's FileViewerPage inside a DOM node, wrapped in the
 * AdapterProvider with a PortolanAdapter. Returns an unmount handle so the
 * host (modal shell, panel, etc.) can tear the root down.
 *
 * The rest of the app stays vanilla TS/Three.js. React only lives inside the
 * node handed here — see vellum-in-portolan constitution for the seam rules.
 */

import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AdapterProvider, FileViewerPage } from 'vellum'
import { createPortolanAdapter } from './portolan-adapter'

export interface MountFileViewerOptions {
  container: HTMLElement
  path: string
  originId?: string
  cityId?: string
  cacheBust?: boolean
  editable?: boolean
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
