import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In dev, the Python server (port 7860) handles /api: signalling, data and live events.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': { target: 'http://localhost:7860', changeOrigin: true } },
  },
})
