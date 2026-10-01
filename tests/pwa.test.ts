/**
 * PWA 自检：manifest / Service Worker / 图标。
 *
 * 这几样东西错了不会有任何运行时异常 —— 浏览器只是悄悄不让你安装、
 * 或者离线打开时白屏。所以按规范逐项静态核对：
 * manifest 必填字段、图标尺寸与 maskable、SW 的三个事件、index.html 的引用。
 *
 *   npm run test:pwa
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n${title}`)
}

const read = (path: string): string => readFileSync(path, 'utf8')
const publicFile = (name: string): string => join('public', name)

/** 从 PNG 头里读宽高（IHDR 紧跟在 8 字节签名 + 4 字节长度 + 4 字节类型之后） */
function pngSize(path: string): { width: number; height: number } | null {
  const buf = readFileSync(path)
  const isPng = buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG'
  if (!isPng) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

const html = read('index.html')

section('index.html 的 PWA 引用')
{
  check('声明了 manifest', /<link[^>]+rel="manifest"[^>]+href="\.\/manifest\.webmanifest"/.test(html))
  check('声明了 apple-touch-icon', /<link[^>]+rel="apple-touch-icon"[^>]+href="\.\/apple-touch-icon\.png"/.test(html))
  check('声明了 theme-color', /<meta[^>]+name="theme-color"[^>]+content="#121212"/.test(html))
  check('声明了 favicon', /<link[^>]+rel="icon"[^>]+href="\.\/logo\.svg"/.test(html))
  // 路径都写成相对形式，部署到子目录或用 file 打开才不会 404
  check('引用路径都是相对路径', !/rel="(manifest|icon|apple-touch-icon)"[^>]+href="\//.test(html))
}

section('manifest.webmanifest')
{
  const raw = read(publicFile('manifest.webmanifest'))
  let manifest: Record<string, unknown> | null = null
  try {
    manifest = JSON.parse(raw) as Record<string, unknown>
  } catch (err) {
    check('是合法 JSON', false, err instanceof Error ? err.message : String(err))
  }

  if (manifest) {
    check('是合法 JSON', true)
    check('有 name', typeof manifest.name === 'string' && (manifest.name as string).length > 0)
    check('有 short_name（≤12 字符，桌面图标才不会被截断）', typeof manifest.short_name === 'string' && (manifest.short_name as string).length <= 12, String(manifest.short_name))
    check('start_url 是相对路径', manifest.start_url === './', String(manifest.start_url))
    check('scope 是相对路径', manifest.scope === './', String(manifest.scope))
    check('display 是 standalone', manifest.display === 'standalone', String(manifest.display))
    check('theme_color 与深色主题一致', manifest.theme_color === '#121212', String(manifest.theme_color))
    check('background_color 已设置', typeof manifest.background_color === 'string' && (manifest.background_color as string).startsWith('#'))
    check('声明了 lang', manifest.lang === 'zh-CN', String(manifest.lang))

    const icons = (manifest.icons ?? []) as { src: string; sizes: string; type: string; purpose?: string }[]
    check('icons 非空', Array.isArray(icons) && icons.length > 0)
    const sizes = icons.map((i) => i.sizes)
    check('含 192x192 图标', sizes.includes('192x192'))
    check('含 512x512 图标', sizes.includes('512x512'))
    check('含 maskable 图标（Android 自适应图标要有）', icons.some((i) => (i.purpose ?? '').includes('maskable')))

    for (const icon of icons) {
      const path = publicFile(icon.src.replace('./', ''))
      const exists = existsSync(path)
      check(`图标文件存在：${icon.src}`, exists)
      if (!exists) continue
      if (icon.type === 'image/png') {
        const size = pngSize(path)
        const [w, h] = icon.sizes.split('x').map(Number)
        check(`${icon.src} 实际是 ${icon.sizes}`, size?.width === w && size?.height === h, size ? `${size.width}x${size.height}` : '不是 PNG')
        check(`${icon.src} 不是空白占位（>1KB）`, statSync(path).size > 1024, `${statSync(path).size} 字节`)
      }
    }
  }
}

section('Service Worker')
{
  const path = publicFile('sw.js')
  check('sw.js 存在', existsSync(path))
  const sw = existsSync(path) ? read(path) : ''
  check('监听 install', sw.includes("addEventListener('install'"))
  check('监听 activate', sw.includes("addEventListener('activate'"))
  check('监听 fetch', sw.includes("addEventListener('fetch'"))
  check('install 时预缓存应用外壳', /const SHELL\s*=/.test(sw) && sw.includes('index.html'))
  check('只处理同源 GET', sw.includes("request.method !== 'GET'") && sw.includes('url.origin !== self.location.origin'))
  check('导航失败时回退到缓存外壳', sw.includes("request.mode === 'navigate'") && sw.includes('Response.error()'))
  check('换版本时清理旧缓存', sw.includes('caches.delete(key)') && /const CACHE = 'beads-studio-v\d+'/.test(sw))
  // 这条是实测踩出来的：vite preview / sirv 会给静态资源加 `Vary: Origin`，
  // 预缓存请求没有 Origin 头、页面请求有，按 Vary 比对就永远命不中 → 离线白屏。
  check('缓存匹配忽略 Vary（否则离线时 JS/CSS 取不到）', sw.includes('ignoreVary: true'))
  check('预缓存会解析 index.html 里带 hash 的资源', sw.includes('fromHtml') && sw.includes('index.html'))
  const main = read('src/main.tsx')
  check(
    '注册用相对路径（子目录部署也能用）',
    main.includes('import.meta.env.BASE_URL') && /\u0060\$\{import\.meta\.env\.BASE_URL\}sw\.js\u0060/.test(main),
    main.includes('import.meta.env.BASE_URL') ? '没有用 BASE_URL 拼 sw.js' : '没引用 BASE_URL',
  )
  check('只在构建产物里注册（开发时不注册，免得缓存住 Vite 模块）', main.includes('import.meta.env.PROD'))
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failures.length) console.log(`失败项：${failures.join('、')}`)
process.exit(failed > 0 ? 1 : 0)
