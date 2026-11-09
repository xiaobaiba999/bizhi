/**
 * 下载记录 · JSON 档案（服务器版专用，随数据库文件同目录）
 *
 * 目标：下载记录跨「版本升级 / 卸载重装 / 数据库重建」永久保留。
 *
 * 三层保险（服务器模式）：
 *   ① SQLite（wallpaper.db，用户数据目录，卸载不删）—— 主存储
 *   ② downloads.json 档案（与数据库同目录，纯文本）—— 数据库结构升级
 *      被 ensureDatabase() 重建时，本档案可整表还原
 *   ③ localStorage 镜像（浏览器端，workshop-source 写入）—— 经
 *      /api/wallpapers/downloads/sync 在启动时并回服务器
 *
 * 三方在每次读取 / 同步 / 落库时做并集合并（键 = 哲风文件 id，时间取最新），
 * 任何一层存活即可恢复全部记录 —— 旧版本卸载器误删用户数据、数据库结构
 * 变更重建、端口漂移导致 localStorage 换源等场景都不再丢记录。
 */

import fs from "node:fs"
import path from "node:path"
import { db } from "@/lib/db"

export interface ArchiveItem {
  /** 哲风文件 id（= Download.wtId = CDN 文件名去扩展名） */
  wtId: string
  title: string
  src: string
  quality: string
  downloadedAt: string // ISO
}

const ARCHIVE_NAME = "downloads.json"
/** 档案条目上限（防御性：异常膨胀时截断保留最新） */
const ARCHIVE_MAX = 5000

/** 档案文件路径：与数据库同目录（桌面版 = %APPDATA%\壁纸工坊） */
function archivePath(): string | null {
  try {
    const url = process.env.DATABASE_URL || ""
    const m = /^file:(.+)$/.exec(url.trim())
    if (!m) return null
    const dbFile = path.resolve(m[1].replace(/^\/([A-Za-z]:)/, "$1"))
    return path.join(path.dirname(dbFile), ARCHIVE_NAME)
  } catch {
    return null
  }
}

function readArchive(): ArchiveItem[] {
  const file = archivePath()
  if (!file) return []
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      items?: ArchiveItem[]
    }
    if (!parsed || !Array.isArray(parsed.items)) return []
    return parsed.items.filter(
      (i) => i && typeof i.wtId === "string" && i.wtId.length > 0
    )
  } catch {
    return [] // 不存在 / 损坏：视为空档案
  }
}

function writeArchive(items: ArchiveItem[]): void {
  const file = archivePath()
  if (!file) return
  try {
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true })
    // 超上限时保留最新的 ARCHIVE_MAX 条
    const trimmed =
      items.length > ARCHIVE_MAX
        ? [...items]
            .sort((a, b) => (a.downloadedAt < b.downloadedAt ? 1 : -1))
            .slice(0, ARCHIVE_MAX)
        : items
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), items: trimmed }))
    fs.renameSync(tmp, file) // 原子替换，避免写一半损坏
  } catch (e) {
    console.warn("[archive] 写入下载档案失败（不影响主记录）:", e)
  }
}

/** Download 行 → 档案条目 */
function toItems(rows: { wtId: string; title: string; src: string; quality: string; downloadedAt: Date }[]): ArchiveItem[] {
  return rows.map((r) => ({
    wtId: r.wtId,
    title: r.title,
    src: r.src,
    quality: r.quality,
    downloadedAt: r.downloadedAt.toISOString(),
  }))
}

/** 并集合并（键 wtId 去重，时间取最新） */
function mergeItems(...groups: ArchiveItem[][]): ArchiveItem[] {
  const map = new Map<string, ArchiveItem>()
  for (const group of groups) {
    for (const it of group) {
      const prev = map.get(it.wtId)
      if (!prev || (it.downloadedAt || "") > (prev.downloadedAt || "")) {
        map.set(it.wtId, {
          wtId: it.wtId,
          title: it.title || prev?.title || "壁纸",
          src: it.src || prev?.src || "",
          quality: it.quality || prev?.quality || "preview",
          downloadedAt: it.downloadedAt || new Date().toISOString(),
        })
      }
    }
  }
  return Array.from(map.values())
}

/** 进程内只执行一次的「档案 → 数据库」回灌合并 */
let mergedOnce: Promise<void> | null = null

/**
 * 懒合并（每个进程首次触达下载记录时执行一次）：
 * 档案 ∪ SQLite → 双写回两层。数据库被重建（版本升级结构变更）或
 * 换库时，档案把记录整表还原回 SQLite。
 */
export function ensureArchiveMerged(): Promise<void> {
  if (mergedOnce) return mergedOnce
  mergedOnce = (async () => {
    try {
      const archive = readArchive()
      const rows = await db.download.findMany()
      if (archive.length === 0) return // 无档案：无可回灌
      const known = new Set(rows.map((r) => r.wtId))
      const missing = archive.filter((a) => !known.has(a.wtId))
      if (missing.length === 0) {
        // 数据库齐全：只需确保档案与库同步（库为准）
        writeArchive(mergeItems(archive, toItems(rows)))
        return
      }
      // 档案里有、库里没有 → 回灌（数据库重建 / 清库后恢复场景）
      for (const it of missing) {
        await db.download.upsert({
          where: { wtId: it.wtId },
          create: {
            wtId: it.wtId,
            title: it.title || "壁纸",
            src: it.src,
            quality: it.quality || "preview",
            downloadedAt: new Date(it.downloadedAt || Date.now()),
          },
          update: { downloadedAt: new Date(it.downloadedAt || Date.now()) },
        })
      }
      console.log(`[archive] 已从档案恢复 ${missing.length} 条下载记录`)
      writeArchive(mergeItems(readArchive(), toItems(await db.download.findMany())))
    } catch (e) {
      console.warn("[archive] 档案合并失败（不影响主流程）:", e)
    }
  })()
  return mergedOnce
}

/** 记录一次下载后的三层同步：SQLite 已 upsert，这里把档案写齐（并集） */
export async function syncArchiveAfterDownload(input: {
  wtId: string
  title: string
  src: string
  quality: string
  downloadedAt: Date
}): Promise<void> {
  try {
    const rows = await db.download.findMany()
    writeArchive(mergeItems(readArchive(), toItems(rows), [toItems([input])[0]]))
  } catch (e) {
    console.warn("[archive] 同步档案失败（不影响下载本身）:", e)
  }
}

/** 删除记录后同步档案（单条 / 全部清空都要同步，避免档案复活已删记录） */
export async function syncArchiveAfterDelete(wtId?: string): Promise<void> {
  try {
    if (wtId) {
      writeArchive(readArchive().filter((i) => i.wtId !== wtId))
    } else {
      writeArchive([])
    }
  } catch (e) {
    console.warn("[archive] 清理档案失败:", e)
  }
}

/** 外部记录并进来（localStorage 镜像 → 服务器）并返回合并后的全集 */
export async function mergeExternalItems(
  items: { id?: string; title?: string; src?: string; downloadedAt?: number }[]
): Promise<{ added: number; all: ArchiveItem[] }> {
  await ensureArchiveMerged()
  const external: ArchiveItem[] = []
  for (const it of items) {
    if (!it || typeof it.id !== "string" || !it.id) continue
    external.push({
      wtId: it.id,
      title: typeof it.title === "string" && it.title ? it.title : "壁纸",
      src: typeof it.src === "string" ? it.src : "",
      quality: "preview",
      downloadedAt:
        typeof it.downloadedAt === "number" && it.downloadedAt > 0
          ? new Date(it.downloadedAt).toISOString()
          : new Date().toISOString(),
    })
  }
  const before = await db.download.findMany()
  const known = new Set(before.map((r) => r.wtId))
  const fresh = external.filter((e) => !known.has(e.wtId))
  for (const it of fresh) {
    await db.download.upsert({
      where: { wtId: it.wtId },
      create: {
        wtId: it.wtId,
        title: it.title,
        src: it.src,
        quality: it.quality,
        downloadedAt: new Date(it.downloadedAt),
      },
      update: { downloadedAt: new Date(it.downloadedAt) },
    })
  }
  const rows = await db.download.findMany()
  const all = mergeItems(readArchive(), toItems(rows), external)
  writeArchive(all)
  return { added: fresh.length, all }
}
