import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'

// Materialize（MD2）+ Roboto + Material Icons，按 Google 的用法先铺基础层，
// 再让 styles.css 覆盖成深色主题。
import 'materialize-css/dist/css/materialize.min.css'
// 只用 filled 一套图标字体；material-icons.css 会把 5 套变体全部打包进来
import 'material-icons/iconfont/filled.css'
import '@fontsource/roboto/300.css'
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'
import '@fontsource/roboto/700.css'
import './styles.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// PWA：把应用外壳缓存进 Service Worker，装到桌面/主屏后可以完全离线用。
// 只在构建产物里注册 —— 开发时注册会缓存 Vite 的模块，改代码看不到效果。
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined)
  })
}
