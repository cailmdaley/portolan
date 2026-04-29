import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Vellum's internals import via `~/...` (alias for vellum's own src/).
      // Mirror the alias so portolan's bundle resolves vellum components that
      // rely on the alias. Points at the symlinked vellum package's src.
      '~': fileURLToPath(new URL('./node_modules/vellum/src', import.meta.url)),
    },
  },
  server: {
    // Disable the error overlay which uses an iframe
    hmr: {
      overlay: false
    },
    // Serve .portolan directory for city sprites
    fs: {
      allow: ['.', '.portolan']
    },
    // Proxy server-side asset routes (project-file artifacts, paper PDFs,
    // astra view templates, and friends) to the portolan backend on :4004.
    // Without this proxy, relative URLs in a server-rewritten Bundle (e.g.
    // figure thumbnails like `/project-file/...png`, the paper-modal PDF at
    // `/papers/<cache_key>/paper.pdf`) hit Vite, get the SPA index.html, and
    // either render as a broken image or — in the PdfReader's case — error
    // with "Invalid PDF structure". The bundle's rewriter intentionally emits
    // *relative* URLs so the same paths resolve in both the iframe paper-view
    // (origin :4004) and the vellum-native render (origin :5173).
    // See `vellum-reader/vellum-native-astra-renderer`.
    //
    // `/static` proxies fiber-embedded image assets — markdown like
    // `![alt](/static/.felt/<rest>)` resolves through the backend's
    // `handleStaticFeltAsset` to `<projectRoot>/.felt/<rest>`. Restored
    // after commit 5755034 retired the static viewer; see the
    // `vellum-reader/constitution-restore-static-felt-route` fiber +
    // `gotchas/static-felt-route-fragility`.
    proxy: {
      '/project-file': 'http://localhost:4004',
      '/papers': 'http://localhost:4004',
      '/astra-paper-view': 'http://localhost:4004',
      '/astra-bundle': 'http://localhost:4004',
      '/astra/asset': 'http://localhost:4004',
      '/static': 'http://localhost:4004',
    },
  },
  // Make .portolan accessible as static files
  publicDir: 'public',
})
