/**
 * 壁纸工坊 · UI 数据层（服务器 / 静态双模式自动适配）
 *
 * 一套代码两种运行环境：
 * - server：沙箱 dev / Electron 桌面版 / 网页服务器版 —— 走 /api/*（服务端抓取 + SQLite 记录）
 * - static：GitHub Pages 等纯静态托管 —— 浏览器直连哲风源站抓取解析
 *   （源站 CORS 全开 access-control-allow-origin: *，实测可跨域读取 HTML；
 *   图片直连 CDN，页面全局 no-referrer 绕过防盗链），
 *   下载记录 / 屏蔽记录走 localStorage（download-store / block-store）。
 *
 * 模式判定：构建期注入（NEXT_PUBLIC_STATIC_EXPORT，仅静态导出构建为 "1"）。
 * dev / 桌面 standalone 构建无此变量 → 服务器模式，恒定无闪烁。
 */

import {
  fetchWallpapers,
  findCategory,
  PAGE_SIZE,
  type ZhefengWallpaper,
} from "@/lib/zhefeng"
import {
  getLocalDownloadIds,
  clearLocalDownloads,
  recordLocalDownload,
  countLocalDownloads,
} from "@/lib/download-store"
import {
  getLocalBlockedIds,
  recordLocalBlock,
  clearLocalBlocked,
  countLocalBlocked,
} from "@/lib/block-store"
import type { FsDirHandleLike } from "@/lib/web-download-dir"

/** 静态导出构建标记（next.config env 注入；客户端包构建期固化） */
export const IS_STATIC_EXPORT = process.env.NEXT_PUBLIC_STATIC_EXPORT === "1"

/** 一页数据（两种模式统一形状，与 /api/wallpapers 响应对齐） */
export interface WallpaperPage {
  items: ZhefengWallpaper[]
  hasMore: boolean
  downloadedCount: number
  blockedCount: number
}

/**
 * 加载某个分类的一页壁纸（含屏蔽永久过滤 + 「隐藏已下载」过滤与自动补抓）。
 * server 模式复用 API（服务端 lookahead 过滤）；
 * static 模式在浏览器内抓源站页面 + localStorage 过滤，逻辑与 API 完全对齐：
 * - 屏蔽过的无条件过滤（不受 hideDownloaded 影响）
 * - hideDownloaded 时已下载的一并过滤，从当前源站页向后最多补抓 3 页填满一页
 * - 终点判定：源站空页才算结束（手机壁纸每页张数与 PAGE_SIZE 不必相等，不能用「页内 <12」判终点）
 */
export async function loadWallpaperPage(
  catKey: string,
  page: number,
  hideDownloaded: boolean
): Promise<WallpaperPage> {
  const page_ = Math.max(1, page)

  if (!IS_STATIC_EXPORT) {
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
      downloadedCount?: number
      blockedCount?: number
    }
    return {
      items: data.items,
      hasMore: data.hasMore && data.items.length > 0,
      downloadedCount: data.downloadedCount ?? 0,
      blockedCount: data.blockedCount ?? 0,
    }
  }

  // —— static：浏览器直连源站抓取 + 本地记录过滤（与 API 逻辑对齐） ——
  const cat = findCategory(catKey)
  const downloaded = getLocalDownloadIds()
  const blocked = getLocalBlockedIds()
  const downloadedCount = countLocalDownloads()
  const blockedCount = countLocalBlocked()

  if (!hideDownloaded) {
    // 显示已下载，但屏蔽过的仍然永久过滤
    const batch = await fetchPageWithRetry(cat, page_)
    const items = batch.filter((w) => !blocked.has(w.id))
    return { items, hasMore: items.length > 0, downloadedCount, blockedCount }
  }

  // 过滤已下载 + 已屏蔽：从当前页向后最多多抓 3 页源站数据补齐
  const MAX_LOOKAHEAD = 3
  let sourcePage = page_
  let collected = 0
  let sourceHasMore = true
  const items: ZhefengWallpaper[] = []

  while (collected < PAGE_SIZE && sourcePage <= page_ + MAX_LOOKAHEAD && sourceHasMore) {
    const batch = await fetchPageWithRetry(cat, sourcePage)
    if (batch.length === 0) {
      sourceHasMore = false
      break
    }
    if (batch.length < PAGE_SIZE) sourceHasMore = false

    for (const w of batch) {
      if (blocked.has(w.id) || downloaded.has(w.id)) continue
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
    downloadedCount,
    blockedCount,
  }
}

/**
 * 抓一页（带一次自动重试）：浏览器与 CDN 常共用 HTTP/2 连接，
 * 快速滚动时大量缩略图流可能把 HTML 分页请求挤到排队超时
 * （AbortSignal 15s）；隔 1.2s 重试一次通常即可成功。
 */
async function fetchPageWithRetry(cat: Parameters<typeof fetchWallpapers>[0], p: number) {
  try {
    return await fetchWallpapers(cat, p)
  } catch {
    await new Promise((r) => setTimeout(r, 1200))
    return fetchWallpapers(cat, p)
  }
}

/* ------------------------------ 记录操作（双模式） ------------------------------ */

/** 清空下载记录（被隐藏的壁纸恢复显示） */
export async function clearAllDownloads(): Promise<void> {
  if (IS_STATIC_EXPORT) {
    clearLocalDownloads()
    return
  }
  const res = await fetch("/api/wallpapers/downloads", { method: "DELETE" })
  if (!res.ok) throw new Error("清空失败")
}

/**
 * 屏蔽一张壁纸（永久不再显示）。
 * 返回屏蔽总数（两种模式都会写自己的主存储；服务器模式失败由调用方回滚 UI）。
 */
export async function blockWallpaper(w: ZhefengWallpaper): Promise<number> {
  if (IS_STATIC_EXPORT) {
    return recordLocalBlock({ id: w.id, wtId: w.wtId || w.id, title: w.title, src: w.src })
  }
  const res = await fetch("/api/wallpapers/block", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ src: w.src, title: w.title, wtId: w.wtId || w.id }),
  })
  if (!res.ok) throw new Error("屏蔽失败")
  const data = (await res.json().catch(() => ({}))) as { blockedCount?: number }
  return typeof data.blockedCount === "number" ? data.blockedCount : 0
}

/** 清空屏蔽记录（被屏蔽的壁纸恢复显示）。返回清空后的屏蔽总数（0）。 */
export async function clearAllBlocked(): Promise<number> {
  if (IS_STATIC_EXPORT) {
    clearLocalBlocked()
    return 0
  }
  const res = await fetch("/api/wallpapers/block", { method: "DELETE" })
  if (!res.ok) throw new Error("清空屏蔽记录失败")
  const data = (await res.json().catch(() => ({}))) as { blockedCount?: number }
  return typeof data.blockedCount === "number" ? data.blockedCount : 0
}

/* ------------------------- 静态模式下载（CDN 直链 blob） ------------------------- */

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
 * 静态模式：直连 CDN 取原图 blob（页面全局 no-referrer 绕过防盗链，
 * CDN CORS 全开，跨域可读）。返回待保存字节与推荐文件名；
 * 记录同时写入 localStorage（下载过的自动隐藏）。
 * 与服务器版下载策略一致：原图字节直转存（预览级分辨率，高清原图需令牌的服务端环境）。
 */
export async function prepareWallpaperBlob(
  w: ZhefengWallpaper
): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(w.src, { cache: "no-store" })
  if (!res.ok) throw new Error(`CDN 下载失败（HTTP ${res.status}）`)
  const blob = await res.blob()
  recordLocalDownload({ id: w.id, title: w.title, src: w.src })
  return { blob, filename: `${safeClientName(w.title)}.${extOfSrc(w.src)}` }
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

/**
 * 静态模式经自选目录直写 blob（File System Access）。
 * 成功 true；权限丢失 / 失败 false → 调用方回退浏览器另存。
 */
export async function saveBlobToDirectory(
  dir: FsDirHandleLike,
  filename: string,
  blob: Blob
): Promise<boolean> {
  try {
    if (dir.queryPermission) {
      const p = await dir.queryPermission({ mode: "readwrite" })
      if (p !== "granted" && dir.requestPermission) {
        const r = await dir.requestPermission({ mode: "readwrite" })
        if (r !== "granted") return false
      }
    }
    const fh = await dir.getFileHandle(await uniqueFsName(dir, filename), { create: true })
    const stream = await fh.createWritable()
    await stream.write(blob)
    await stream.close()
    return true
  } catch (e) {
    console.warn("[workshop] 静态模式写入自选目录失败，回退浏览器另存:", e)
    return false
  }
}

/** 目录内重名自动追加序号：name (1).ext */
async function uniqueFsName(dir: FsDirHandleLike, filename: string): Promise<string> {
  const dot = filename.lastIndexOf(".")
  const stem = dot === -1 ? filename : filename.slice(0, dot)
  const ext = dot === -1 ? "" : filename.slice(dot)
  let candidate = filename
  for (let i = 0; i < 999; i++) {
    try {
      await dir.getFileHandle(candidate, { create: false }) // 已存在 → 试下一个
      candidate = i === 0 ? `${stem} (1)${ext}` : `${stem} (${i + 1})${ext}`
    } catch {
      return candidate // 不存在 → 可用
    }
  }
  return `${stem}-${Date.now()}${ext}`
}
