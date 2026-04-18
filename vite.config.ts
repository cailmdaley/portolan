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
    }
  },
  // Make .portolan accessible as static files
  publicDir: 'public',
})
