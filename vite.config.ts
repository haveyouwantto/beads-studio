import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: './' 让构建产物可以放在任意目录、甚至用 file:// 直接打开
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
})
