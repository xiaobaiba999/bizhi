/**
 * 哲风壁纸（haowallpaper.com）数据源
 * 服务端 / 浏览器（静态导出）双端抓取 /homeView 页面并解析出结构化壁纸列表。
 *
 * v1.4.6 优化要点（本文件）：
 * - fetchWallpapers / scanSourcePages 支持 fresh 选项：手动刷新时绕过
 *   10 分钟内存缓存直接回源，确保能拿到源站刚刚更新的内容
 */

const API_BASE = "https://haowallpaper.com"
const IMG_HOST = "img.haowallpaper.com"

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

export interface ZhefengWallpaper {
  /** 图片文件 id（CDN 文件名去扩展名，与官网详情 id 一致） */
  id: string
  /** 壁纸详情 id（卡片 /homeViewLook/<id> 链接） */
  wtId: string
  /** 清洗后的标题（去掉「哲风壁纸」后缀） */
  title: string
  /** 分辨率标识：4K / 7K / 2K … */
  resolution: string
  /** 原图直链（PNG 等，最大分辨率） */
  src: string
  /** 网格缩略图（s320 webp） */
  thumb: string
  /** 标签 */
  tags: string[]
}

export interface ZhefengCategory {
  key: string
  name: string
  typeId: string
  wpType: 1 | 2
}

/** 分类导航：仅保留 电脑壁纸 / 手机壁纸 两类 */
export const ZHEFENG_CATEGORIES: ZhefengCategory[] = [
  { key: "desktop", name: "电脑壁纸", typeId: "", wpType: 1 },
  { key: "phone", name: "手机壁纸", typeId: "", wpType: 2 },
]

export function findCategory(key: string): ZhefengCategory {
  return ZHEFENG_CATEGORIES.find((c) => c.key === key) ?? ZHEFENG_CATEGORIES[0]
}

/** 每页张数（源站固定返回 12） */
export const PAGE_SIZE = 12

/** 校验是否为哲风壁纸 CDN 图片直链 */
export function isZhefengImageUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.hostname === IMG_HOST && u.pathname.startsWith("/cache_file/")
  } catch {
    return false
  }
}

/**
 * 哲风壁纸图片展示链接：
 * - 静态导出构建：CDN 直链（页面全局 no-referrer 绕过防盗链；CDN CORS 全开）
 * - 服务器模式：走服务端代理（/api/wallpapers/img，绕过 CDN Referer 防盗链）
 * 其他来源（本地素材 / dataURL）原样返回。
 */
export function proxyImageUrl(src: string): string {
  if (process.env.NEXT_PUBLIC_STATIC_EXPORT === "1") return src
  if (!isZhefengImageUrl(src)) return src
  return `/api/wallpapers/img?src=${encodeURIComponent(src)}`
}

/** 原图 URL 的 s240 缩略变体（srcset 缺失时源站实际存在的兜底缩略图） */
export function s240VariantOf(src: string): string {
  const dot = src.lastIndexOf(".")
  return dot === -1 ? src : `${src.slice(0, dot)}_s240q80.webp`
}

/**
 * 网格显示回退链：缩略图 → s240 兜底缩略图 → 原图（去重保序）。
 * 缩略图 404 / 网络抖动时逐级回退，全部失败才用原图兜底。
 */
export function displayFallbackChain(w: { thumb: string; src: string }): string[] {
  return Array.from(new Set([w.thumb, s240VariantOf(w.src), w.src].filter(Boolean)))
}

/* ------------------------------ HTML 解析 ------------------------------ */

function cleanTitle(alt: string): string {
  return alt
    .replace(/「哲风壁纸」/g, "")
    .replace(/\\/g, "")
    .trim()
}

function parseResolution(alt: string): string {
  const m = /^(\d+)k/i.exec(alt.trim())
  return m ? `${m[1].toUpperCase()}K` : "HD"
}

function parseWallpapers(html: string): ZhefengWallpaper[] {
  const items: ZhefengWallpaper[] = []
  const seen = new Set<string>()

  // 按卡片切块：每张壁纸一个 <div class="card" ...> 块
  const chunks = html.split('<div class="card"')
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i]
    if (!chunk.includes("img.haowallpaper.com")) continue

    const imgMatch = /<img[^>]*src="(https:\/\/img\.haowallpaper\.com\/cache_file\/[^"?]+)"[^>]*alt="([^"]*)"/.exec(
      chunk
    )
    if (!imgMatch) continue

    const src = imgMatch[1]
    const alt = imgMatch[2]

    const dot = src.lastIndexOf(".")
    if (dot === -1) continue
    const id = src.slice(src.lastIndexOf("/") + 1, dot)
    if (seen.has(id)) continue
    seen.add(id)

    // 壁纸详情 id（卡片内 /homeViewLook/<id> 链接），缺失时回退文件 id
    const lookMatch = /href="\/homeViewLook\/([0-9]{6,32})"/.exec(chunk)
    const wtId = lookMatch ? lookMatch[1] : id

    // 缩略图：优先取 srcset 里实际存在的最大变体（s320 并非全量存在，s240 才有）
    const srcsetMatch = /<img[^>]*srcset="([^"]+)"/.exec(chunk)
    let thumb = ""
    if (srcsetMatch) {
      const variants = srcsetMatch[1]
        .split(",")
        .map((e) => e.trim().split(/\s+/))
        .filter((p) => p.length === 2 && p[0] !== src && /^\/\d+$/.test(p[1]))
      if (variants.length > 0) {
        thumb = variants.reduce((a, b) =>
          parseInt(b[1], 10) > parseInt(a[1], 10) ? b : a
        )[0]
      }
    }
    if (!thumb) thumb = `${src.slice(0, dot)}_s240q80.webp`

    // 标签
    const tagMatch = /<div class="labelDiv"[^>]*>([\s\S]*?)<\/div>/.exec(chunk)
    const tags = tagMatch
      ? Array.from(tagMatch[1].matchAll(/<span[^>]*>([^<]+)<\/span>/g))
          .map((m) => m[1].trim())
          .filter(Boolean)
          .slice(0, 12)
      : []

    items.push({
      id,
      wtId,
      title: cleanTitle(alt) || `壁纸 ${id.slice(-6)}`,
      resolution: parseResolution(alt),
      src,
      thumb,
      tags,
    })
  }
  return items
}

/* ------------------------------ 抓取 + 缓存 ------------------------------ */

interface CacheEntry {
  ts: number
  items: ZhefengWallpaper[]
}

const cache = new Map<string, CacheEntry>()
const CACHE_TTL = 10 * 60 * 1000

/**
 * 抓取哲风壁纸某个分类的一页壁纸（10 分钟 TTL 内存缓存 + 一次快速重试）。
 * 浏览器（静态版）与服务端（代理版）共用：浏览器会忽略受限请求头，不影响抓取。
 * @param cat 分类配置
 * @param page 页码（从 1 开始）
 * @param opts.fresh true = 绕过缓存读直接回源（手动刷新用；结果仍写回缓存）
 */
export async function fetchWallpapers(
  cat: ZhefengCategory,
  page: number,
  opts?: { fresh?: boolean }
): Promise<ZhefengWallpaper[]> {
  const key = `${cat.key}|${page}`
  if (!opts?.fresh) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.items
  }

  const params = new URLSearchParams({
    page: String(page),
    sortType: "3",
    rows: "30",
    wpType: String(cat.wpType),
  })
  if (cat.typeId) params.set("typeId", cat.typeId)

  const doFetch = () =>
    fetch(`${API_BASE}/homeView?${params.toString()}`, {
      headers: { "User-Agent": UA, Referer: `${API_BASE}/` },
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    })

  let res: Response
  try {
    res = await doFetch()
  } catch {
    // 网络抖动 / 连接排队超时：隔 1.2s 重试一次
    await new Promise((r) => setTimeout(r, 1200))
    res = await doFetch()
  }
  if (!res.ok) throw new Error(`源站响应异常（HTTP ${res.status}）`)

  const html = await res.text()
  const items = parseWallpapers(html)
  cache.set(key, { ts: Date.now(), items })
  return items
}

/* --------------------- v1.4.5 核心：游标深度扫描 --------------------- */

export interface ScanResult {
  /** 过滤后收集到的壁纸（最多 limit 张） */
  items: ZhefengWallpaper[]
  /** 下一轮扫描应从源站第几页开始（0 = 源站已到底） */
  nextCursor: number
  /** 源站是否还有更多内容 */
  sourceHasMore: boolean
  /** 本轮扫描中被过滤（已下载/已屏蔽）的张数 */
  skipped: number
  /** 本轮实际扫描的源站页数 */
  scannedPages: number
}

/**
 * 从 startPage 起按 4 页一组「并行」向前扫描源站，直到：
 * - 收满 limit 张未过滤壁纸；或
 * - 源站到底（空页 / 短页）；或
 * - 达到单轮扫描页数上限 maxPages（防极端情况无限扫描）。
 *
 * 这是「下载了一两百张后整页被过滤、刷新也没用」的根治方案：
 * 旧逻辑每轮只看 4 页（48 张），一旦连续过滤超过 48 张就返回空列表，
 * 客户端 hasMore 又被误杀成 false，滚动彻底卡死。
 * 现在返回 nextCursor 游标，客户端拿着游标继续扫，永远能扫到未下载的内容。
 *
 * @param keep 过滤谓词：返回 true 的壁纸才会被收集
 * @param opts.fresh true = 绕过页缓存直接回源（手动刷新时用）
 */
export async function scanSourcePages(
  cat: ZhefengCategory,
  startPage: number,
  limit: number,
  keep: (w: ZhefengWallpaper) => boolean,
  maxPages = 40,
  opts?: { fresh?: boolean }
): Promise<ScanResult> {
  const items: ZhefengWallpaper[] = []
  const seen = new Set<string>()
  let skipped = 0
  let scannedPages = 0
  let sourceHasMore = true
  let page = Math.max(1, startPage)

  while (items.length < limit && scannedPages < maxPages && sourceHasMore) {
    // 4 页一组并行抓取：单页 ~300ms，并行后扫描 40 页也只要几秒
    const batchSize = Math.min(4, maxPages - scannedPages)
    const batch = await Promise.allSettled(
      Array.from({ length: batchSize }, (_, i) => fetchWallpapers(cat, page + i, opts))
    )

    let gotAny = false
    let shortPage = false
    for (const r of batch) {
      if (r.status !== "fulfilled") continue // 单页失败：组内其余页照常处理
      gotAny = true
      scannedPages += 1
      if (r.value.length === 0) {
        sourceHasMore = false // 空页 = 源站到底
        break
      }
      if (r.value.length < PAGE_SIZE) shortPage = true
      for (const w of r.value) {
        if (seen.has(w.id)) continue
        seen.add(w.id)
        if (!keep(w)) {
          skipped += 1
          continue
        }
        if (items.length < limit) items.push(w)
      }
      if (items.length >= limit) break
    }
    if (!gotAny) {
      // 整组失败（网络问题）：抛出让上层重试，而不是误判「到底」
      throw new Error("源站暂时无法访问，请稍后重试")
    }
    if (shortPage && items.length < limit) sourceHasMore = false
    if (!sourceHasMore) break
    page += batchSize
  }

  return {
    items,
    nextCursor: sourceHasMore ? page : 0,
    sourceHasMore,
    skipped,
    scannedPages,
  }
}

/** 下载原图 / 回源代理时使用的请求头 */
export const upstreamHeaders = () => ({
  "User-Agent": UA,
  Referer: `${API_BASE}/`,
})
