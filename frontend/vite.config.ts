import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Proxy backend calls so the browser talks to one origin; avoids CORS
      // entirely in dev and keeps the API base URL consistent.
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  // pdfjs-dist ships an ESM worker; let Vite handle it as an asset.
  optimizeDeps: {
    include: ['pdfjs-dist'],
  },
})
