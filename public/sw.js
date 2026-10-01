/**
 * Beads Studio 的 Service Worker。
 *
 * 应用本身没有后端，所有计算都在本地，所以只要把「外壳」（HTML / JS / CSS / 字体 / 图标）
 * 缓存下来，第二次打开就能完全离线使用。
 *
 * 策略：
 * - 导航请求：网络优先，失败时回退到缓存里的 index.html（离线也能进应用）
 * - 其它同源 GET：缓存优先 + 后台更新（构建产物带 hash，内容变了 URL 就变了，不会读到旧文件）
 */
const CACHE = 'beads-studio-v3'

/** 固定资源：install 时先抓一遍 */
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './logo.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
]

/**
 * 预缓存应用外壳。
 *
 * 构建产物带 hash（index-a1b2c3.js），文件名改一次就变，所以没法写死在这里。
 * 做法：先抓 index.html，把里面引用的 JS / CSS 解析出来一起缓存；
 * 再顺着 CSS 里的 url(...) 把字体也带上。这样一个都不缺，离线就是完整的应用。
 */
async function precache(cache) {
  const indexResponse = await fetch('./index.html', { cache: 'reload' })
  const html = await indexResponse.clone().text()
  await cache.put('./index.html', indexResponse)

  const fromHtml = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((url) => !/^(?:[a-z]+:)?\/\//i.test(url) && !url.startsWith('data:'))

  const cssUrls = fromHtml.filter((url) => url.endsWith('.css'))
  const fromCss = []
  for (const cssUrl of cssUrls) {
    const cssResponse = await fetch(cssUrl, { cache: 'reload' })
    if (!cssResponse.ok) continue
    const css = await cssResponse.clone().text()
    await cache.put(cssUrl, cssResponse)
    fromCss.push(
      ...[...css.matchAll(/url\(([^)'"]+)\)/g)]
        .map((m) => m[1].trim())
        .filter((url) => !/^(?:[a-z]+:)?\/\//i.test(url) && !url.startsWith('data:'))
        .map((url) => new URL(url, new URL(cssUrl, self.registration.scope)).href),
    )
  }

  const targets = [...SHELL, ...fromHtml, ...fromCss]
  await Promise.allSettled(targets.map((url) => cache.add(new Request(url, { cache: 'reload' }))))
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // 单个文件失败不影响整体（比如某个图标被删了）
      await precache(cache)
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // 进应用：网络优先，离线回退到缓存的外壳
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request)
          if (fresh && fresh.ok) {
            const cache = await caches.open(CACHE)
            void cache.put('./index.html', fresh.clone())
          }
          return fresh
        } catch {
          const cache = await caches.open(CACHE)
          return (await cache.match('./index.html')) ?? (await cache.match('./')) ?? Response.error()
        }
      })(),
    )
    return
  }

  // 静态资源：缓存优先 + 后台更新
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      // ignoreVary 是必须的：vite preview / sirv 会给静态资源发 `Vary: Origin`，
      // 而预缓存时 Worker 里造出来的请求没有 Origin 头、页面的模块脚本请求有，
      // 按 Vary 比对就永远命不中，离线时就会 ERR_FAILED（白屏）。
      // 资源名自带内容 hash，本来就不需要按头部区分版本。
      const hit = await cache.match(request, { ignoreVary: true })
      if (hit) {
        void fetch(request)
          .then((response) => {
            if (response && response.ok) void cache.put(request, response.clone())
          })
          .catch(() => undefined)
        return hit
      }
      try {
        const response = await fetch(request)
        if (response && response.ok && response.type === 'basic') void cache.put(request, response.clone())
        return response
      } catch (err) {
        return (await cache.match(request, { ignoreVary: true })) ?? Response.error()
      }
    })(),
  )
})
