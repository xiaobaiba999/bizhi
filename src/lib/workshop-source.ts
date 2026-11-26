/**
 * 壁纸工坊 · UI 数据层（服务器 / 静态双模式自动适配）
 *
 * 一套代码两种运行环境：
 * - server：dev / 桌面版 / 网页服务器版 —— 走 /api/*（服务端抓取 + SQLite 记录）
 * - static：GitHub Pages 等纯静态托管 —— 浏览器直连哲风源站抓取解析
 *   （源站 CORS 全开；图片直连 CDN，页面全局 no-referrer 绕过防盗链），
 *   下载记录 / 屏蔽记录走 localStorage（download-store / block-store）。
 *
 * v1.4.5 核心修复（游标分页，根治「图片经常不显示 / 刷新没用」）：
 * - loadWallpaperPage 改为「游标」驱动：返回 nextCursor，下次从它继续扫，
 *   不再依赖 app 页码 = 源站页码的旧映射（旧映射每页只看 4 页源站，
 *   下载一多整页被过滤 → 空列表 → 滚动卡死、刷新也没用）
 * - 两种模式共用 scanSourcePages 深度扫描（4 页一组并行，最多 40 页/轮）
 * - hasMore 只由「源站是否到底」决定，绝不因「本次收集 0 张」而终止
 *
 * v1.4.6：loadWallpaperPage 增加 fresh 选项（手动刷新绕过页缓存直接回源）
 */

import {
  fetchWallpapers,
  findCategory,
  scanSourcePages,
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

/** 静态导出构建标记（next.config env 注入；客户端包构建期固化） */
export const IS_STATIC_EXPORT = process.env.NEXT_PUBLIC_STATIC_EXPORT === "1"

/** 桌面版（Electron）构建标记：下载保存位置等提示文案用 */
export const IS_DESKTOP = process.env.NEXT_PUBLIC_DESKTOP === "1"

/** 一页数据（两种模式统一形状，与 /api/wallpapers 响应对齐） */
export interface WallpaperPage {
  items: ZhefengWallpaper[]
  /** 源站是否还有更多（与本次收集几张无关） */
  hasMore: boolean
  /** 下一轮扫描从源站第几页开始（0 = 到底） */
  nextCursor: number
  /** 本轮跳过的已下载/已屏蔽张数（刷新反馈用） */
  skipped: number
  downloadedCount: number
  blockedCount: number
}

/**
 * 加载一页壁纸（游标驱动）。
 * @param catKey 分类
 * @param cursor 从源站第几页开始扫（0 = 从第 1 页；上轮返回的 nextCursor）
 * @param hideDownloaded 是否过滤已下载
 * @param opts.fresh true = 绕过页缓存直接回源（手动刷新时用）
 * @param opts.knownIds 客户端已有的壁纸 id（滚动/填充链路传入；扫描端把它们
 *   当作「已过滤」不入列表 —— 配合「游标停在最后贡献页」语义，重扫该页时
 *   只收新面孔，既不重复也不漏图，每轮必然向前推进）
 */
export async function loadWallpaperPage(
  catKey: string,
  cursor: number,
  hideDownloaded: boolean,
  opts?: { fresh?: boolean; knownIds?: string[] }
): Promise<WallpaperPage> {
  const startPage = Math.max(1, cursor || 1)
  const fresh = opts?.fresh === true
  const knownList = (opts?.knownIds ?? [])
    .filter((id) => /^[\w.-]{1,80}$/.test(id))
    .slice(-250) // 截最近 250 个：贡献页上的是刚收的新 id，保尾不保头

  if (!IS_STATIC_EXPORT) {
    const qs = new URLSearchParams({
      cat: catKey,
      cursor: String(startPage),
      hideDownloaded: hideDownloaded ? "1" : "0",
    })
    if (fresh) qs.set("fresh", "1")
    if (knownList.length > 0) qs.set("known", knownList.join(","))
    const res = await fetch(`/api/wallpapers?${qs.toString()}`, { cache: "no-store" })
    if (!res.ok) {
      const msg = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(msg?.error ?? "抓取失败")
    }
    const data = (await res.json()) as {
      items: ZhefengWallpaper[]
      hasMore: boolean
      nextCursor: number
      skipped?: number
      downloadedCount?: number
      blockedCount?: number
    }
    return {
      items: data.items,
      hasMore: data.hasMore,
      nextCursor: data.nextCursor,
      skipped: data.skipped ?? 0,
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
    const batch = await fetchPageWithRetry(cat, startPage, fresh)
    const items = batch.filter((w) => !blocked.has(w.id))
    return {
      items,
      hasMore: batch.length > 0,
      nextCursor: batch.length > 0 ? startPage + 1 : 0,
      skipped: batch.length - items.length,
      downloadedCount,
      blockedCount,
    }
  }

  // 过滤已下载 + 已屏蔽 + 客户端已有：游标深度扫描（与服务器端同一实现）
  const known = new Set(knownList)
  const scan = await scanSourcePages(
    cat,
    startPage,
    PAGE_SIZE,
    (w) => !blocked.has(w.id) && !downloaded.has(w.id) && !known.has(w.id),
    40,
    { fresh }
  )

  return {
    items: scan.items,
    hasMore: scan.sourceHasMore,
    nextCursor: scan.nextCursor,
    skipped: scan.skipped,
    downloadedCount,
    blockedCount,
  }
}

/**
 * 抓一页（带一次自动重试）：浏览器与 CDN 常共用 HTTP/2 连接，
 * 快速滚动时大量缩略图流可能把 HTML 分页请求挤到排队超时
 * （AbortSignal 15s）；隔 1.2s 重试一次通常即可成功。
 */
async function fetchPageWithRetry(
  cat: Parameters<typeof fetchWallpapers>[0],
  p: number,
  fresh = false
): Promise<ZhefengWallpaper[]> {
  try {
    return await fetchWallpapers(cat, p, { fresh })
  } catch {
    await new Promise((r) => setTimeout(r, 1200))
    return fetchWallpapers(cat, p, { fresh })
  }
}

/**
 * 官网同步（v1.4.11）：只拉源站第 1 页最新壁纸（fresh），过滤已屏蔽
 * （及可选的已下载）后返回 —— 供「窗口聚焦 / 定时增量同步」用，
 * 不做深度扫描，开销极小（单页请求）。
 */
export async function fetchSiteFirstPage(
  catKey: string,
  hideDownloaded: boolean
): Promise<ZhefengWallpaper[]> {
  if (!IS_STATIC_EXPORT) {
    const res = await fetch(
      `/api/wallpapers?cat=${encodeURIComponent(catKey)}&cursor=1&hideDownloaded=${
        hideDownloaded ? 1 : 0
      }&fresh=1&sync=1`,
      { cache: "no-store" }
    )
    if (!res.ok) throw new Error("同步失败")
    const data = (await res.json()) as { items?: ZhefengWallpaper[] }
    return data.items ?? []
  }
  // —— static：浏览器直连源站第 1 页 + 本地记录过滤 ——
  const cat = findCategory(catKey)
  const blocked = getLocalBlockedIds()
  const downloaded = getLocalDownloadIds()
  const batch = await fetchPageWithRetry(cat, 1, true)
  return batch.filter((w) => !blocked.has(w.id) && (!hideDownloaded || !downloaded.has(w.id)))
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
    return recordLocalBlock({ id: w.id, title: w.title, src: w.src })
  }
  const res = await fetch("/api/wallpapers/block", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: w.id, src: w.src, title: w.title, wtId: w.wtId || w.id }),
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
 * 静态模式：直连 CDN 取原图 blob。返回待保存字节与推荐文件名；
 * 记录同时写入 localStorage（下载过的自动隐藏）。
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
