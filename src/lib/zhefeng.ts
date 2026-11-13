/**
 * 哲风壁纸（haowallpaper.com）数据源
 * 服务端抓取 /homeView 页面并解析出结构化壁纸列表。
 * 壁纸工坊主页面展示的数据全部来自该站点。
 */

const API_BASE = "https://haowallpaper.com"
const IMG_HOST = "img.haowallpaper.com"

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

export interface ZhefengWallpaper {
  /** 图片文件 id（CDN 文件名去扩展名，与官网详情 id 一致） */
  id: string
  /** 壁纸详情 id（卡片 /homeViewLook/<id> 链接，getCompleteUrl 必须用它而非文件 id） */
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

/** 分类导航：仅保留 电脑壁纸 / 手机壁纸 两类（wpType 决定源站返回的壁纸类型） */
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

/**
 * <img> 加载失败自动回退原图（缩略变体 404 / 网络抖动）。
 * 首次失败换原图（两种模式都过 proxyImageUrl，静态直连 / 服务器代理各自正确）；
 * 二次失败追加 r=1 破缓存重试一次。
 * 用法：onError={imgFallback(w.src)}
 * v1.4.3：网格/面板已改用 WallpaperImage 组件（完整回退链 + 占位骨架），
 * 此函数仅保留给预览弹窗等直连原图场景。
 */
export function imgFallback(originalSrc: string) {
  return (e: { currentTarget: HTMLImageElement }) => {
    const el = e.currentTarget
    if (el.dataset.wwOriginal === "1") {
      if (!el.dataset.wwRetried) {
        el.dataset.wwRetried = "1"
        el.src = `${el.src}${el.src.includes("?") ? "&" : "?"}r=1`
      }
      return
    }
    el.dataset.wwOriginal = "1"
    el.src = proxyImageUrl(originalSrc)
  }
}

/** 原图 URL 的 s240 缩略变体（srcset 缺失时源站实际存在的兜底缩略图） */
export function s240VariantOf(src: string): string {
  const dot = src.lastIndexOf(".")
  return dot === -1 ? src : `${src.slice(0, dot)}_s240q80.webp`
}

/**
 * 网格显示回退链：缩略图 → s240 兜底缩略图 → 原图（去重保序）。
 * 之前缩略图 404 直接跳原图（2K/4K 巨图当缩略图加载 → 「部分图片显示太慢」的元凶），
 * 现在先落到真实存在的 s240 小图，只有全部失败才用原图兜底。
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

    // 图片 id（文件 id：下载记录的键，与图片直链一一对应）
    const dot = src.lastIndexOf(".")
    if (dot === -1) continue
    const id = src.slice(src.lastIndexOf("/") + 1, dot)
    if (seen.has(id)) continue
    seen.add(id)

    // 壁纸详情 id（卡片内 /homeViewLook/<id> 链接）。
    // 官网 getCompleteUrl 必须用这个 id（它与文件 id 是两个不同的数字），
    // 否则返回 305 [错误的请求 -> 3005]；缺失时回退文件 id
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
 * 抓取哲风壁纸某个分类的一页壁纸。
 * @param cat 分类配置
 * @param page 页码（从 1 开始）
 */
export async function fetchWallpapers(
  cat: ZhefengCategory,
  page: number
): Promise<ZhefengWallpaper[]> {
  const key = `${cat.key}|${page}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.items

  const params = new URLSearchParams({
    page: String(page),
    sortType: "3",
    rows: "30",
    wpType: String(cat.wpType),
  })
  if (cat.typeId) params.set("typeId", cat.typeId)

  const res = await fetch(`${API_BASE}/homeView?${params.toString()}`, {
    headers: { "User-Agent": UA, Referer: `${API_BASE}/` },
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`源站响应异常（HTTP ${res.status}）`)

  const html = await res.text()
  const items = parseWallpapers(html)
  cache.set(key, { ts: Date.now(), items })
  return items
}

/** 下载原图时回源使用的请求头 */
export const upstreamHeaders = () => ({
  "User-Agent": UA,
  Referer: `${API_BASE}/`,
})
