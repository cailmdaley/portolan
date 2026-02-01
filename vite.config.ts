import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    // Disable the error overlay which uses an iframe
    hmr: {
      overlay: false
    },
    // Serve .hexarchy directory for city sprites
    fs: {
      allow: ['.', '.hexarchy']
    }
  },
  // Make .hexarchy accessible as static files
  publicDir: 'public',
})
