/**
 * 壁纸工坊 · 下载记录访问层（v2.0）
 * ============================================================
 * 三模式职责（v2.0 单写者原则）：
 * - 桌面版（Electron）：下载历史由主进程 SQLite（userData/ww-history.db）
 *   唯一写入（OriginalDownloadService 在文件落盘+校验通过后写入），
 *   渲染层通过 preload 桥只读（ids / count / list）；
 * - 服务器版：下载记录由 /api/wallpapers/download 成功后写 Prisma SQLite，
 *   列表过滤服务端完成，渲染层只读计数；
 * - Pages 在线版：无法下载原图（只引导桌面版），本地仅保留旧版
 *   localStorage 镜像用于兼容展示，不再写入。
 */

import { desktopBridge, type DownloadHistoryRecord } from "@/lib/desktop-store"

const LEGACY_KEY = "ww-downloads-v1"

/** 旧版（v1.x）记录形状：仅用于 Pages 兼容展示 */
interface LegacyDownloadRecord {
  id: string
  title: string
  src: string
  downloadedAt: number
}

function readLegacy(): LegacyDownloadRecord[] {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (i): i is LegacyDownloadRecord =>
        i && typeof i.id === "string" && typeof i.title === "string" && typeof i.src === "string"
    )
  } catch {
    return []
  }
}

/**
 * 已下载的壁纸 id 集合。
 * - 桌面版：主进程 SQLite（真实下载记录，「隐藏已下载」的判定源）
 * - 其他模式：旧版 localStorage 镜像（兼容展示）
 */
export async function getDownloadIdSet(): Promise<Set<string>> {
  if (desktopBridge) {
    try {
      return await desktopBridge.historyIds()
    } catch {
      return new Set()
    }
  }
  return new Set(readLegacy().map((i) => i.id))
}

/** 下载记录条数 */
export async function getDownloadedCount(): Promise<number> {
  if (desktopBridge) {
    try {
      return await desktopBridge.historyCount()
    } catch {
      return 0
    }
  }
  return readLegacy().length
}

/**
 * 下载历史列表（下载历史视图用）。
 * - 桌面版：SQLite 完整记录（含宽高/格式/大小/SHA-256/路径/文件存在检测）
 * - 服务器版：由调用方走 /api/wallpapers/downloads（Prisma）
 * - Pages 版：旧版记录映射（字段缺失按 null）
 */
export async function listLocalDownloadRecords(): Promise<DownloadHistoryRecord[]> {
  if (desktopBridge) {
    try {
      return await desktopBridge.historyList()
    } catch {
      return []
    }
  }
  return readLegacy()
    .slice()
    .reverse()
    .map((i) => ({
      id: i.id,
      wtId: null,
      title: i.title,
      category: null,
      width: null,
      height: null,
      format: null,
      bytes: null,
      sha256: null,
      savedPath: null,
      downloadedAt: i.downloadedAt,
      fileExists: null,
    }))
}

/**
 * 记录一次下载 —— v2.0 起为兼容空操作：
 * 桌面版由主进程 OriginalDownloadService 写 SQLite（单写者），
 * 服务器版由 /api 路由写 Prisma，Pages 版无法下载。保留此函数仅为
 * 兼容旧调用点，避免双写。
 */
export function recordLocalDownload(_w: { id: string; title: string; src: string }): void {
  /* v2.0：单写者原则，渲染层不再写下载记录 */
}
