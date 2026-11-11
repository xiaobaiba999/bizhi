/**
 * 壁纸工坊 · 下载记录本地存储（localStorage）
 *
 * 静态版（GitHub Pages 纯静态托管）的主存储：
 * 下载过的壁纸 id 永久记在本浏览器（同一浏览器 / PWA 安装内跨会话保留），
 * 「隐藏已下载」过滤与「清空记录」都直接操作这一份。
 * 与桌面版 / 网页服务器版的 SQLite 记录相互独立（不同运行环境）。
 */

const KEY = "ww-downloads-v1"

export interface DownloadRecord {
  /** 壁纸文件 id（与源站 CDN 文件名去扩展名一致，作唯一键） */
  id: string
  title: string
  src: string
  downloadedAt: number
}

function read(): DownloadRecord[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (i): i is DownloadRecord =>
        i && typeof i.id === "string" && typeof i.title === "string" && typeof i.src === "string"
    )
  } catch {
    return []
  }
}

function write(items: DownloadRecord[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items.slice(-5000)))
  } catch {
    // 存储满等异常：忽略（过滤功能退化为当次会话，不影响下载本身）
  }
}

/** 全部下载记录（新→旧） */
export function listLocalDownloads(): DownloadRecord[] {
  return read()
}

/** 已下载的壁纸 id 集合（过滤用） */
export function getLocalDownloadIds(): Set<string> {
  return new Set(read().map((i) => i.id))
}

/** 记录一次下载（已存在则刷新时间） */
export function recordLocalDownload(w: { id: string; title: string; src: string }) {
  if (!w.id) return
  const items = read().filter((i) => i.id !== w.id)
  items.push({ id: w.id, title: w.title, src: w.src, downloadedAt: Date.now() })
  write(items)
}

/** 清空全部下载记录（被隐藏的壁纸恢复显示） */
export function clearLocalDownloads() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // 忽略
  }
}

/** 记录条数 */
export function countLocalDownloads(): number {
  return read().length
}
