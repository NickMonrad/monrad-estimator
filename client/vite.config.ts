import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/
const apiTarget = process.env.VITE_API_URL ?? process.env.API_URL ?? 'http://localhost:3001'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': apiTarget,
    },
  },
  preview: {
    proxy: {
      '/api': apiTarget,
    },
  },
})
