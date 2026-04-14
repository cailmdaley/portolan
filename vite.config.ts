import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
