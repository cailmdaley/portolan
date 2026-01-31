import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    // Disable the error overlay which uses an iframe
    hmr: {
      overlay: false
    }
  }
})
