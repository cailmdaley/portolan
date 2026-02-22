import { defineConfig } from 'vite'
import fs from 'node:fs'
import path from 'node:path'

export default defineConfig({
  root: 'src/static',
  base: '/tapestries/',
  build: {
    outDir: '../../docs',
    emptyOutDir: false,
  },
  publicDir: './public',
  plugins: [
    {
      name: 'copy-404',
      closeBundle() {
        const docsDir = path.resolve(__dirname, 'docs')
        const index = path.join(docsDir, 'index.html')
        const fourOhFour = path.join(docsDir, '404.html')
        if (fs.existsSync(index)) {
          fs.copyFileSync(index, fourOhFour)
          console.log('Copied index.html → 404.html for SPA routing')
        }
      },
    },
  ],
})
