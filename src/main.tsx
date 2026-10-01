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
