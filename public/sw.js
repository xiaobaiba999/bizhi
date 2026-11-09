/* 壁纸工坊 Service Worker —— v1.3.1-1
 * - 离线外壳：页面导航网络优先，失败回退缓存
 * - /_next 构建产物：网络优先 + 离线回退（开发模式 chunk URL 无内容哈希，缓存优先会永远命中旧代码）
 * - 不可变静态资源（图标/字体/manifest）：缓存优先
 * - 壁纸图片代理（/api/wallpapers/img）内容不可变，缓存优先离线可用
 * - 其余 API（数据/下载/令牌）永不缓存，永远走网络
 * - 激活时清理旧版本缓存（缓存名带版本号，升级自动换血）
 * - 卸载应用时，系统会连同这些缓存一起清除，无残留
 * - v1.3.1-1：BASE 自适应——由 sw.js 自身路径推导前缀，
 *   根路径托管（dev / username.github.io / 桌面版）与子路径托管
 *   （GitHub Pages 项目页 /bizhi 等）同一份文件通吃，无需构建期区分
 */
const VERSION = "v1.3.1-1"
const SHELL_CACHE = `ww-shell-${VERSION}`
const ASSET_CACHE = `ww-assets-${VERSION}`
const IMG_CACHE = `ww-img-${VERSION}`

/** 部署基路径：本文件被托管在 <BASE>/sw.js，去掉文件名即得前缀（根路径为空串） */
const BASE = self.location.pathname.replace(/\/sw\.js$/, "")

const SHELL_URLS = [
  `${BASE}/`,
  `${BASE}/manifest.webmanifest`,
  `${BASE}/favicon.ico`,
  `${BASE}/icons/icon-192.png`,
  `${BASE}/icons/icon-512.png`,
  `${BASE}/icons/apple-touch-icon.png`,
]

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      // 单条失败不影响整体安装（best-effort 预缓存）
      await Promise.allSettled(SHELL_URLS.map((url) => cache.add(url)))
      await self.skipWaiting()
    })()
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k))
      )
      await self.clients.claim()
    })()
  )
})

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting()
})

function isStaticAsset(pathname) {
  return (
    pathname.startsWith(`${BASE}/icons/`) ||
    pathname === `${BASE}/manifest.webmanifest` ||
    pathname === `${BASE}/favicon.ico` ||
    /\.(png|jpe?g|webp|gif|svg|ico|woff2?|ttf)$/i.test(pathname)
  )
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request)
  if (cached) return cached
  try {
    const response = await fetch(request)
    if (response && response.ok && response.type === "basic") {
      const cache = await caches.open(cacheName)
      cache.put(request, response.clone()).catch(() => {})
    }
    return response
  } catch {
    return new Response("", { status: 504, statusText: "Offline" })
  }
}

/** 网络优先 + 离线回退缓存（构建产物需保证新鲜，离线时才用缓存） */
async function networkFirst(request, cacheName) {
  try {
    const fresh = await fetch(request)
    if (fresh && fresh.ok && fresh.type === "basic") {
      const cache = await caches.open(cacheName)
      cache.put(request, fresh.clone()).catch(() => {})
    }
    return fresh
  } catch {
    const cached = await caches.match(request)
    if (cached) return cached
    return new Response("", { status: 504, statusText: "Offline" })
  }
}

async function navigationFirst(request) {
  try {
    const fresh = await fetch(request)
    if (fresh && fresh.ok && fresh.type === "basic") {
      const cache = await caches.open(SHELL_CACHE)
      cache.put(`${BASE}/`, fresh.clone()).catch(() => {})
    }
    return fresh
  } catch {
    const cached =
      (await caches.match(request)) || (await caches.match(`${BASE}/`))
    if (cached) return cached
    return new Response("当前处于离线状态，且暂无缓存页面。联网后重试即可。", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    })
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event
  if (request.method !== "GET") return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // 页面导航：网络优先（保证总是最新），离线回退缓存外壳
  if (request.mode === "navigate") {
    event.respondWith(navigationFirst(request))
    return
  }

  // 构建产物：网络优先 + 离线回退（dev 下 chunk URL 无哈希，缓存优先会锁死旧版本）
  if (url.pathname.startsWith(`${BASE}/_next/`)) {
    event.respondWith(networkFirst(request, ASSET_CACHE))
    return
  }

  // 壁纸图片代理：内容不可变，缓存优先（离线也能浏览已看过的壁纸）
  if (url.pathname === `${BASE}/api/wallpapers/img`) {
    event.respondWith(cacheFirst(request, IMG_CACHE))
    return
  }

  // 其余 API（列表/下载/令牌）永不缓存
  if (url.pathname.startsWith(`${BASE}/api/`)) return

  // 不可变静态资源（图标 / manifest / 字体 / 图片）：缓存优先
  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE))
  }
  // 其余请求放行，走浏览器默认行为
})
