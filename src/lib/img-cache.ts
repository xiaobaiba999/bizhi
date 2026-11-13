import { createHash } from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

/**
 * 壁纸图片服务端缓存（v1.4.3）
 *
 * 解决「部分图片显示太慢」：/api/wallpapers/img 代理之前每次都回源 CDN，
 * 首次加载慢、重启后又要重新拉。现在三级缓存：
 *   1. 内存 LRU（小缩略图，进程内即时命中）
 *   2. 磁盘缓存（用户数据目录，跨进程重启永久命中）
 *   3. 回源 CDN（写入前两级，并发请求自动合并为单次回源）
 *
 * 磁盘文件格式：首行 ASCII 头 `wwimg1 <contentType>\n` + 原始图片字节，
 * 自包含、无需扩展名约定；写入走临时文件 + rename 原子落盘，中断不会留半截。
 * 目录容量超上限按 mtime 从旧到新淘汰（壁纸内容不可变，淘汰即删除即可）。
 *
 * 桌面版缓存目录由 desktop/main.js 注入（WF_IMG_CACHE_DIR =
 * %APPDATA%\壁纸工坊\img-cache，随用户数据目录在升级护送中一并保留）；
 * 未注入时（开发 / 普通服务器模式）落在项目 db/img-cache。
 */

/* ------------------------------ 配置 ------------------------------ */

/** 磁盘缓存目录总容量上限（512MB；缩略图 ~50KB，足够存上万张） */
const DISK_MAX_BYTES = 512 * 1024 * 1024
/** 单张超过该大小不入磁盘缓存（超大 7K 原图直接透传，避免占满磁盘） */
const DISK_MAX_ENTRY_BYTES = 64 * 1024 * 1024
/** 内存 LRU 总字节上限（32MB：只进缩略图级小文件） */
const MEM_MAX_BYTES = 32 * 1024 * 1024
/** 单张超过该大小不进内存（原图走磁盘层） */
const MEM_MAX_ENTRY_BYTES = 1024 * 1024
/** 淘汰扫描最小间隔（写盘后异步触发，节流避免每次请求都扫目录） */
const EVICT_INTERVAL_MS = 30_000
/** 文件头魔数（版本化，便于将来格式升级时旧缓存自动失效） */
const MAGIC = "wwimg1"

/* ------------------------------ 目录解析 ------------------------------ */

let dirEnsured: string | null = null

/** 缓存目录（桌面版 env 注入；否则项目 db/img-cache） */
export function imgCacheDir(): string {
  const injected = process.env.WF_IMG_CACHE_DIR
  if (injected && injected.trim()) return injected.trim()
  return path.join(process.cwd(), "db", "img-cache")
}

async function ensureDir(): Promise<string> {
  const dir = imgCacheDir()
  if (dirEnsured !== dir) {
    await fsp.mkdir(dir, { recursive: true })
    dirEnsured = dir
  }
  return dir
}

/* ------------------------------ 内存 LRU ------------------------------ */

interface MemEntry {
  buf: Buffer
  contentType: string
}

const mem = new Map<string, MemEntry>()
let memBytes = 0

function memSet(key: string, buf: Buffer, contentType: string) {
  if (buf.length > MEM_MAX_ENTRY_BYTES) return
  const old = mem.get(key)
  if (old) memBytes -= old.buf.length
  mem.delete(key)
  mem.set(key, { buf, contentType })
  memBytes += buf.length
  while (memBytes > MEM_MAX_BYTES && mem.size > 1) {
    const oldest = mem.keys().next().value as string
    const e = mem.get(oldest)
    if (!e) break
    memBytes -= e.buf.length
    mem.delete(oldest)
  }
}

function memGet(key: string): MemEntry | null {
  const hit = mem.get(key)
  if (!hit) return null
  // 触摸刷新 LRU 顺序
  mem.delete(key)
  mem.set(key, hit)
  return hit
}

/* ------------------------------ 磁盘层 ------------------------------ */

/** 缓存键：源 URL 的 sha256 前 24 位十六进制 */
export function cacheKeyFor(src: string): string {
  return createHash("sha256").update(src).digest("hex").slice(0, 24)
}

function cacheFilePath(dir: string, key: string): string {
  return path.join(dir, `${key}.wwimg`)
}

export interface ImgCacheHit {
  buffer: Buffer
  contentType: string
  source: "memory" | "disk"
}

/**
 * 读缓存：内存 → 磁盘（读到则回填内存层）。
 * 文件损坏 / 头部不合法按未命中处理并顺手清理。
 */
export async function readImgCache(key: string): Promise<ImgCacheHit | null> {
  const memHit = memGet(key)
  if (memHit) return { buffer: memHit.buf, contentType: memHit.contentType, source: "memory" }

  let file: Buffer
  try {
    const dir = await ensureDir()
    file = await fsp.readFile(cacheFilePath(dir, key))
  } catch {
    return null // 不存在 / 不可读 → 未命中
  }

  const nl = file.indexOf(0x0a)
  if (nl === -1) return null
  const header = file.subarray(0, nl).toString("latin1").trim()
  const m = /^wwimg1 (\S+)$/.exec(header)
  if (!m || !m[1].startsWith("image/")) return null
  const contentType = m[1]
  const buffer = file.subarray(nl + 1)
  if (buffer.length === 0) return null

  memSet(key, buffer, contentType)
  return { buffer, contentType, source: "disk" }
}

let evictRunning = false
let lastEvict = 0

/** 容量淘汰：总字节超上限时按 mtime 从旧到新删除（节流 + 单飞） */
async function evictIfNeeded(): Promise<void> {
  if (evictRunning) return
  if (Date.now() - lastEvict < EVICT_INTERVAL_MS) return
  evictRunning = true
  try {
    const dir = imgCacheDir()
    const names = await fsp.readdir(dir)
    const stats: { name: string; size: number; mtimeMs: number }[] = []
    for (const name of names) {
      if (!name.endsWith(".wwimg")) continue
      try {
        const full = path.join(dir, name)
        const st = await fsp.stat(full)
        stats.push({ name: full, size: st.size, mtimeMs: st.mtimeMs })
      } catch {
        /* 淘汰瞬间被删的文件，忽略 */
      }
    }
    let total = stats.reduce((s, e) => s + e.size, 0)
    if (total > DISK_MAX_BYTES) {
      stats.sort((a, b) => a.mtimeMs - b.mtimeMs) // 旧的先删
      for (const e of stats) {
        if (total <= DISK_MAX_BYTES) break
        await fsp.rm(e.name, { force: true }).catch(() => {})
        total -= e.size
      }
      console.log(
        `[img-cache] 磁盘缓存已淘汰至 ${(DISK_MAX_BYTES / 1024 / 1024).toFixed(0)}MB 上限内`
      )
    }
    // 顺手清理中断遗留的临时文件（>1 小时的 .tmp）
    const hourAgo = Date.now() - 3_600_000
    for (const name of names) {
      if (!name.includes(".tmp-")) continue
      try {
        const full = path.join(dir, name)
        const st = await fsp.stat(full)
        if (st.mtimeMs < hourAgo) await fsp.rm(full, { force: true })
      } catch {
        /* 忽略 */
      }
    }
  } catch {
    /* 淘汰失败不影响主流程 */
  } finally {
    lastEvict = Date.now()
    evictRunning = false
  }
}

/**
 * 写磁盘缓存（原子：临时文件 + rename）并回填内存层。
 * 不会抛错——缓存写失败只意味着下次还要回源，不影响本次响应。
 */
export async function writeImgCache(
  key: string,
  buffer: Buffer,
  contentType: string
): Promise<boolean> {
  if (buffer.length === 0 || buffer.length > DISK_MAX_ENTRY_BYTES) return false
  if (!contentType.startsWith("image/")) return false
  try {
    const dir = await ensureDir()
    const head = Buffer.from(`${MAGIC} ${contentType}\n`, "latin1")
    const payload = Buffer.concat([head, buffer])
    const finalPath = cacheFilePath(dir, key)
    // 已存在（并发写）则跳过
    if (fs.existsSync(finalPath)) {
      memSet(key, buffer, contentType)
      return true
    }
    const tmp = path.join(dir, `${key}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await fsp.writeFile(tmp, payload)
    await fsp.rename(tmp, finalPath)
    memSet(key, buffer, contentType)
    void evictIfNeeded()
    return true
  } catch (e) {
    console.warn("[img-cache] 写入失败（忽略，下次重新回源）:", (e as Error).message)
    return false
  }
}

/** 清空磁盘缓存目录（调试/维护用；不存在时静默成功） */
export async function purgeImgCache(): Promise<void> {
  try {
    await fsp.rm(imgCacheDir(), { recursive: true, force: true })
    dirEnsured = null
  } catch {
    /* 忽略 */
  }
  mem.clear()
  memBytes = 0
}
