/**
 * 壁纸工坊 · UI 数据层（服务器 / 静态双模式自动适配）
 *
 * 一套代码两种运行环境：
 * - server：沙箱 dev / Electron 桌面版 —— 走 /api/*（服务端抓取 + SQLite 记录）
 * - static：GitHub Pages 等纯静态托管 —— 浏览器直连哲风源站抓取解析
 *   （源站 CORS 全开 access-control-allow-origin: *，实测可跨域读取 HTML；
 *   图片直连 CDN + 页面全局 no-referrer 绕过防盗链），
 *   下载记录走 localStorage（download-store）。
 *
 * 模式探测：请求 /api/wallpapers，200 且 JSON → server；404 / 非 JSON / 网络错 → static。
 * 探测结果模块级缓存（同会话恒定），UI 用 detectWorkshopMode() 感知。
 */

import {
  fetchWallpapers,
  PAGE_SIZE,
  type ZhefengWallpaper,
} from "@/lib/zhefeng"
import {
  getLocalDownloadIds,
  clearLocalDownloads,
} from "@/lib/download-store"

/** 静态导出子路径（GitHub Pages 项目页如 /bizhi；根路径 / dev / 桌面版为空串） */
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || ""

export type WorkshopMode = "server" | "static"

let modeCache: WorkshopMode | null = null
let modePromise: Promise<WorkshopMode> | null = null

/** 探测运行模式（模块级缓存；同会话只探一次） */
export function detectWorkshopMode(): Promise<WorkshopMode> {
  if (modeCache) return Promise.resolve(modeCache)
  if (modePromise) return modePromise
  modePromise = (async () => {
    let mode: WorkshopMode = "static"
    if (typeof window !== "undefined") {
      try {
        const res = await fetch(
          `${BASE_PATH}/api/wallpapers?cat=desktop&page=1&hideDownloaded=0`,
          {
            cache: "no-store",
          }
        )
        const ct = res.headers.get("content-type") ?? ""
        // 200 且确实是 JSON 接口 → 服务器版；静态托管的 404 HTML / 其他 → 静态版
        if (res.ok && ct.includes("application/json")) mode = "server"
      } catch {
        mode = "static"
      }
    }
    modeCache = mode
    return mode
  })()
  return modePromise
}

/** 一页数据（两种模式统一形状） */
export interface WallpaperPage {
  items: ZhefengWallpaper[]
  hasMore: boolean
  hidden: number
  downloadedCount: number
}

/**
 * 加载某个分类的一页壁纸（含「隐藏已下载」过滤与自动补抓）。
 * server 模式复用 API（服务端 lookahead 过滤）；
 * static 模式在浏览器内抓源站页面 + localStorage 过滤，逻辑与 API 完全对齐
 * （终点判定：源站空页才算结束 —— 手机壁纸每页 13 张，不能用「页内 <12」判终点）。
 */
export async function loadWallpaperPage(
  catKey: string,
  page: number,
  hideDownloaded: boolean
): Promise<WallpaperPage> {
  const mode = await detectWorkshopMode()
  const page_ = Math.max(1, page)

  if (mode === "server") {
    const res = await fetch(
      `/api/wallpapers?cat=${encodeURIComponent(catKey)}&page=${page_}&hideDownloaded=${hideDownloaded ? 1 : 0}`,
      { cache: "no-store" }
    )
    if (!res.ok) {
      const msg = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(msg?.error ?? "抓取失败")
    }
    const data = (await res.json()) as {
      items: ZhefengWallpaper[]
      hasMore: boolean
      hidden?: number
      downloadedCount?: number
    }
    return {
      items: data.items,
      hasMore: data.hasMore && data.items.length > 0,
      hidden: data.hidden ?? 0,
      downloadedCount: data.downloadedCount ?? 0,
    }
  }

  // —— static：浏览器直连源站抓取 + 本地记录过滤（与 API 逻辑对齐） ——
  const { findCategory } = await import("@/lib/zhefeng")
  const cat = findCategory(catKey)
  const downloaded = getLocalDownloadIds()
  const MAX_LOOKAHEAD = 3
  let sourcePage = page_
  let collected = 0
  let hidden = 0
  let sourceHasMore = true
  const items: ZhefengWallpaper[] = []

  /**
   * 抓一页（带一次自动重试）：浏览器与 CDN 常共用 HTTP/2 连接，
   * 快速滚动时大量缩略图流可能把 HTML 分页请求挤到排队超时
   * （AbortSignal 15s）；隔 1.2s 重试一次通常即可成功。
   */
  const fetchPageWithRetry = async (p: number) => {
    try {
      return await fetchWallpapers(cat, p)
    } catch {
      await new Promise((r) => setTimeout(r, 1200))
      return fetchWallpapers(cat, p)
    }
  }

  while (collected < PAGE_SIZE && sourcePage <= page_ + MAX_LOOKAHEAD && sourceHasMore) {
    const batch = await fetchPageWithRetry(sourcePage)
    if (batch.length === 0) {
      sourceHasMore = false
      break
    }
    for (const w of batch) {
      if (hideDownloaded && downloaded.has(w.id)) {
        hidden += 1
        continue
      }
      if (collected < PAGE_SIZE) {
        items.push(w)
        collected += 1
      }
    }
    sourcePage += 1
  }

  return {
    items,
    hasMore: sourceHasMore || collected >= PAGE_SIZE,
    hidden,
    downloadedCount: downloaded.size,
  }
}

/** 清空下载记录（被隐藏的壁纸恢复显示）——按模式分流 */
export async function clearAllDownloads(): Promise<void> {
  const mode = await detectWorkshopMode()
  if (mode === "static") {
    clearLocalDownloads()
    return
  }
  const res = await fetch("/api/wallpapers/downloads", { method: "DELETE" })
  if (!res.ok) throw new Error("清空失败")
}

/* ------------------------- 静态模式下载（blob → JPG） ------------------------- */

/** 清洗文件名：Windows / macOS 非法字符（与服务端 safeFilename 一致） */
export function safeClientName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "wallpaper"
  )
}

/** 从直链推断扩展名 */
function extOfSrc(src: string): string {
  const dot = src.lastIndexOf(".")
  const e = dot === -1 ? "" : src.slice(dot + 1).toLowerCase()
  return /^\w{2,5}$/.test(e) ? e : "png"
}

/**
 * 图片 blob 统一转存 JPG（白底展平 + 质量 0.92，与服务端策略一致）。
 * 画布创建 / 编码失败（超大图、内存受限等）返回 null → 调用方回退原始字节。
 */
export async function blobToJpeg(blob: Blob): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(blob)
    const canvas = document.createElement("canvas")
    canvas.width = bmp.width
    canvas.height = bmp.height
    const ctx = canvas.getContext("2d")
    if (!ctx) return null
    // PNG / WebP 透明区域衬白底（与服务端 sharp flatten 一致）
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bmp, 0, 0)
    const out = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.92)
    )
    bmp.close?.()
    return out
  } catch {
    return null
  }
}

/**
 * 静态模式：直连 CDN 取原图并统一转存 JPG（白底展平 + 质量 0.92，与服务端策略一致）。
 * 返回待保存字节与推荐文件名；记录同时写入 localStorage（下载过的自动隐藏）。
 */
export async function prepareWallpaperBlob(
  w: ZhefengWallpaper
): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(w.src, { cache: "no-store" })
  if (!res.ok) throw new Error(`CDN 下载失败（HTTP ${res.status}）`)
  const raw = await res.blob()
  const jpg = await blobToJpeg(raw)
  const out = jpg ?? raw
  const ext = jpg ? "jpg" : extOfSrc(w.src)
  recordLocalDownloadSafe(w)
  return { blob: out, filename: `${safeClientName(w.title)}.${ext}` }
}

/** 浏览器另存（object URL + <a download>；blob 同源无跨域限制，60s 后回收） */
export function saveBlobViaAnchor(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** 记录下载（静态模式）；id 缺失时静默跳过 */
async function recordLocalDownloadSafe(w: ZhefengWallpaper) {
  try {
    const { recordLocalDownload } = await import("@/lib/download-store")
    if (w.id) recordLocalDownload({ id: w.id, title: w.title, src: w.src })
  } catch {
    // 忽略
  }
}
