import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api/bcart': {
        target: 'https://api.bcart.jp/api/v1',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/bcart/, ''),
      },
    },
  },
})
