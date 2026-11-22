/**
 * 壁纸工坊 · 下载记录本地存储
 *
 * 双模式（v1.4.8）：
 * - 桌面版（Electron）：文件真源 userData/ww-store.json（升级换版不丢），
 *   localStorage 降级为镜像；首次运行自动迁移 v1.4.7 旧记录；
 * - 网页版（GitHub Pages）：localStorage 主存储（原行为不变），
 *   「隐藏已下载」过滤与「清空记录」都直接操作这一份。
 */

import { desktopBridge, desktopRead, desktopWrite } from "@/lib/desktop-store"

const KEY = "ww-downloads-v1"

export interface DownloadRecord {
  /** 壁纸文件 id（与源站 CDN 文件名去扩展名一致，作唯一键） */
  id: string
  title: string
  src: string
  downloadedAt: number
}

function read(): DownloadRecord[] {
  // 桌面版：文件真源（内存镜像，由 desktop-store 统一懒加载/迁移）
  if (desktopBridge) return (desktopRead("downloads") as DownloadRecord[]) ?? []
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
  const trimmed = items.slice(-5000)
  if (desktopBridge) {
    // 文件真源 + localStorage 镜像（desktopWrite 内部双写）
    desktopWrite("downloads", trimmed)
    return
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(trimmed))
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
  if (desktopBridge) {
    desktopWrite("downloads", []) // 文件真源同步清空
    try {
      localStorage.removeItem(KEY)
    } catch {
      // 忽略
    }
    return
  }
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
