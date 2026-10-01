import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: './' 让构建产物可以放在任意目录、甚至用 file:// 直接打开
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    // 必须写死 127.0.0.1。默认的 host: 'localhost' 会解析到 IPv6 的 ::1，
    // 而浏览器打开 localhost 时走的是 IPv4 的 127.0.0.1，于是「终端显示 ready、
    // 浏览器却说拒绝连接」。（想用手机连同一局域网的地址，加 --host 参数。）
    host: '127.0.0.1',
    port: 5173,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
})
