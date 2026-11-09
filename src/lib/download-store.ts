/**
 * 下载记录 · 本地永久存储（localStorage）
 *
 * 纯前端部署（GitHub Pages 等静态托管）没有服务端数据库，
 * 下载记录存 localStorage：同一浏览器 / PWA 安装 / Electron 桌面版
 * 的用户数据目录中永久保留 —— 重装应用、刷新页面都不丢，
 * 「隐藏已下载」过滤与计数均以此为准。
 *
 * 服务器版（沙箱 / Electron 桌面版）另有 SQLite 记录（API 过滤），
 * 两套记录互不影响：UI 数据层（workshop-source）会按运行模式自动选择。
 */

const STORAGE_KEY = "ww-downloads-v1"

export interface StoredDownload {
  /** 文件 id（CDN 文件名去扩展名，与卡片 id 一致） */
  id: string
  title: string
  src: string
  downloadedAt: number
}

function readAll(): StoredDownload[] {
  if (typeof window === "undefined") return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as StoredDownload[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeAll(items: StoredDownload[]) {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
  } catch {
    // 存储满 / 隐私模式：静默失败（记录不影响下载本身）
  }
}

/** 全部下载记录（新→旧） */
export function listLocalDownloads(): StoredDownload[] {
  return readAll().sort((a, b) => b.downloadedAt - a.downloadedAt)
}

/** 已下载文件 id 集合（用于「隐藏已下载」过滤） */
export function getLocalDownloadIds(): Set<string> {
  return new Set(readAll().map((d) => d.id))
}

/** 已下载数量 */
export function countLocalDownloads(): number {
  return readAll().length
}

/** 记录一次下载（同 id 覆盖刷新时间） */
export function recordLocalDownload(w: { id: string; title: string; src: string }) {
  const items = readAll().filter((d) => d.id !== w.id)
  items.push({ id: w.id, title: w.title, src: w.src, downloadedAt: Date.now() })
  writeAll(items)
}

/**
 * 全量替换（v1.3.3）：启动时与服务器三方合并后，用服务器返回的
 * 合并全集回写本层，保证 localStorage 镜像与 SQLite / JSON 档案一致。
 */
export function replaceLocalDownloads(
  items: { id: string; title: string; src: string; downloadedAt: number }[]
) {
  const clean = items
    .filter((i) => i && typeof i.id === "string" && i.id)
    .map((i) => ({
      id: i.id,
      title: typeof i.title === "string" ? i.title : "壁纸",
      src: typeof i.src === "string" ? i.src : "",
      downloadedAt:
        typeof i.downloadedAt === "number" && i.downloadedAt > 0
          ? i.downloadedAt
          : Date.now(),
    }))
  writeAll(clean)
}

/** 清空全部记录（被隐藏的壁纸恢复显示） */
export function clearLocalDownloads() {
  if (typeof window === "undefined") return
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 忽略
  }
}
