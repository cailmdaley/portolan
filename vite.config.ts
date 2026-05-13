import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'

// vellum-reader ships its TS source in the npm package, so resolve via
// node_modules in the standard way. If the package is npm-linked from a
// sibling checkout (common during local development of vellum itself),
// fs.allow still needs to cover the symlink's real path so Vite doesn't
// reject reads outside its default allowlist.
const vellumRealPath = realpathSync(fileURLToPath(new URL('./node_modules/vellum-reader', import.meta.url)))
const vellumPackageRoot = dirname(vellumRealPath)

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      // vellum-reader's internals import via `~/...` (alias for its own src/).
      // Mirror the alias so portolan's bundle resolves vellum-reader components
      // that rely on it. Points at the npm-installed package's src.
      '~': fileURLToPath(new URL('./node_modules/vellum-reader/src', import.meta.url)),
    },
  },
  server: {
    // Tauri expects this exact URL in `src-tauri/tauri.conf.json`.
    port: 5173,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || false,
    hmr: process.env.TAURI_DEV_HOST
      ? {
          protocol: 'ws',
          host: process.env.TAURI_DEV_HOST,
          port: 5173,
          overlay: false,
        }
      : { overlay: false },
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    // Disable the error overlay which uses an iframe
    // Serve .portolan directory for city sprites, and the real path of
    // node_modules/vellum-reader (which may be a symlink during local
    // development against a sibling checkout) so Vite doesn't reject those
    // files as outside the allow list.
    fs: {
      allow: ['.', '.portolan', vellumPackageRoot]
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
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
