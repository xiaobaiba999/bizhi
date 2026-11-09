/* 壁纸工坊 Service Worker —— v1.3.3
 * - 离线外壳：页面导航网络优先，失败回退缓存
 * - /_next 构建产物：网络优先 + 离线回退（开发模式 chunk URL 无内容哈希，缓存优先会永远命中旧代码）
 * - 不可变静态资源（图标/字体/manifest）：缓存优先
 * - 壁纸图片代理（/api/wallpapers/img）内容不可变，缓存优先离线可用
 * - 【v1.3.3】哲风 CDN 图片（img.haowallpaper.com）持久缓存：
 *   · 跨域请求同样拦截，走「CORS 模式抓取 + cache-first」——CDN 已开
 *     access-control-allow-origin: *，非 opaque 响应无配额膨胀；
 *   · 缓存名 ww-img-cdn 不带版本号：应用升级（换 SW 版本）时只换血
 *     shell/assets，图片缓存永久保留 → 装新版本后已看过的壁纸秒开，
 *     彻底解决「每次更新都要重新慢慢加载」；
 *   · LRU 上限 600 条（约 10~20MB），超出删最旧，存储不失控；
 *   · Range 请求 / 非 GET / 非 cache_file 图片路径一律放行不缓存。
 * - 其余 API（数据/下载/令牌）永不缓存，永远走网络
 * - 激活时清理旧版本缓存（仅版本化缓存；ww-img-cdn 永不清）
 * - v1.3.1-1：BASE 自适应——由 sw.js 自身路径推导前缀，
 *   根路径托管（dev / username.github.io / 桌面版）与子路径托管
 *   （GitHub Pages 项目页 /bizhi 等）同一份文件通吃，无需构建期区分
 */
const VERSION = "v1.3.3"
const SHELL_CACHE = `ww-shell-${VERSION}`
const ASSET_CACHE = `ww-assets-${VERSION}`
const IMG_CACHE = `ww-img-${VERSION}`
/** CDN 图片持久缓存：名字刻意不带版本号，升级时 activate() 永不清除 */
const IMG_CDN_CACHE = "ww-img-cdn"
/** CDN 图片缓存条目上限（LRU；超出删最旧的 100 条） */
const IMG_CDN_MAX_ENTRIES = 600

/** 部署基路径：本文件被托管在 <BASE>/sw.js，去掉文件名即得前缀（根路径为空串） */
const BASE = self.location.pathname.replace(/\/sw\.js$/, "")

/** 哲风壁纸图片 CDN 域名（缩略图与原图直链均在此） */
const IMG_CDN_HOST = "img.haowallpaper.com"

const SHELL_URLS = [
  `${BASE}/`,
  `${BASE}/manifest.webmanifest`,
  `${BASE}/favicon.ico`,
  `${BASE}/icons/icon-192.png`,
  `${BASE}/icons/icon-512.png`,
  `${BASE}/icons/apple-touch-icon.png`,
]

self.addEventListener("install", (event) => {
  // 立即让位（不等预缓存完成）—— 避免新版本 SW 卡在 waiting，
  // 老版本继续服务旧代码（升级延迟/缓存行为不生效）
  void self.skipWaiting()
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      // 单条失败不影响整体安装（best-effort 预缓存）；
      // 整体限时 8s —— 个别请求悬挂时不阻塞激活
      await Promise.race([
        Promise.allSettled(SHELL_URLS.map((url) => cache.add(url))),
        new Promise((r) => setTimeout(r, 8000)),
      ])
    })()
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      // 只清「版本化」缓存（shell/assets/img 代理）；ww-img-cdn 持久保留
      await Promise.all(
        keys
          .filter((k) => k !== IMG_CDN_CACHE && k.startsWith("ww-") && !k.endsWith(VERSION))
          .map((k) => caches.delete(k))
      )
      await trimImgCdn()
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

/* ---------------- 哲风 CDN 图片：持久 cache-first ---------------- */

/** LRU 收尾：超出上限时删最旧的一批（cache.keys() 按插入序） */
let trimCounter = 0
async function trimImgCdn() {
  try {
    const cache = await caches.open(IMG_CDN_CACHE)
    const keys = await cache.keys()
    if (keys.length > IMG_CDN_MAX_ENTRIES) {
      await Promise.all(keys.slice(0, keys.length - IMG_CDN_MAX_ENTRIES + 100).map((k) => cache.delete(k)))
    }
  } catch {
    /* 缓存不可用：忽略 */
  }
}

/**
 * CDN 图片 cache-first：
 * 1. 命中缓存 → 直接返回（0 网络，秒开）
 * 2. 未命中 → 以 CORS 模式重新发起并写入持久缓存。
 *    —— 关键：referrerPolicy 必须显式 no-referrer：SW 里 new Request 的
 *    referrer 默认 "about:client"，会带上页面 Refer（http://localhost:3000/）
 *    被哲风 CDN 防盗链直接 403（实测带任何第三方 Referer 一律 403；
 *    空 Referer 200）。页面 <img> 因全局 no-referrer 元数据天然不受影响。
 *    CORS 模式拿到的是非 opaque 响应（无配额膨胀），且真实状态码可见，
 *    404 等异常响应不缓存。
 * 3. CORS 抓取失败（网络异常等）→ 放行原始 no-cors 请求兜底，不缓存。
 */
async function cdnImageFirst(request) {
  const cache = await caches.open(IMG_CDN_CACHE)
  const cached = await cache.match(request, { ignoreVary: true })
  if (cached) return cached

  try {
    const response = await fetch(
      new Request(request.url, {
        mode: "cors",
        credentials: "omit",
        redirect: "follow",
        referrerPolicy: "no-referrer",
      })
    )
    if (response && response.ok) {
      cache.put(request.url, response.clone()).catch(() => {})
      // 每 25 次写入收尾一次 LRU（摊薄开销）
      if (++trimCounter % 25 === 0) void trimImgCdn()
    }
    return response
  } catch {
    // 兜底：按原始请求放行（原请求自带 no-referrer 策略，不受防盗链影响）
    try {
      return await fetch(request)
    } catch {
      return new Response("", { status: 504, statusText: "Offline" })
    }
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event
  if (request.method !== "GET") return

  const url = new URL(request.url)

  // 哲风 CDN 图片：持久缓存优先（跨域也拦截；Range 请求放行）
  if (url.hostname === IMG_CDN_HOST && !request.headers.has("range")) {
    event.respondWith(cdnImageFirst(request))
    return
  }

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
