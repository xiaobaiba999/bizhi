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
  /**
   * 源站 2026-10 改版：手机壁纸从 homeView?wpType=2（已 502）迁到独立的 /mobileView 页面。
   * homeView = 电脑壁纸；mobileView = 手机壁纸（卡片 DOM 与详情链接均不同）。
   */
  endpoint: "homeView" | "mobileView"
}

/**
 * 分类导航（与源站一致：电脑壁纸 / 手机壁纸两大顶栏）。
 * 历史下线记录：「程序·代码」（源站返回空）；「推荐」混合位（v1.2.7）；
 * 「魅力·迷人 / 自制·艺术 / 安逸·自由 / 科幻·星云 / 动漫·二次元」（v1.2.9）；
 * 「自然·风景 / 游戏·玩具」（v1.2.10）——至此电脑壁纸下不再有任何子分类，
 * 电脑壁纸 = homeView 默认混合信息流（不带 typeId），手机壁纸 = mobileView 信息流。
 */
export const ZHEFENG_CATEGORIES: ZhefengCategory[] = [
  // —— 电脑壁纸（/homeView 默认混合信息流）——
  { key: "desktop", name: "电脑壁纸", typeId: "", wpType: 1, endpoint: "homeView" },
  // —— 手机壁纸（/mobileView，竖版）——
  { key: "phone", name: "手机壁纸", typeId: "", wpType: 2, endpoint: "mobileView" },
]

export function findCategory(key: string): ZhefengCategory {
  return ZHEFENG_CATEGORIES.find((c) => c.key === key) ?? ZHEFENG_CATEGORIES[0]
}

/** 每页张数（homeView 固定 12；mobileView 约 13 —— 取 12 作补抓阈值即可） */
export const PAGE_SIZE = 12

/**
 * 动态壁纸判定（剔除策略）：
 * 卡片内含视频（<video> 标签 / video_reduce_file 直链 / .mp4 .webm .mov）
 * 或动图（.gif）一律不收录 —— 本应用只提供静态壁纸，
 * 且存储时统一转存为 JPG（视频/动图无法也不应转存）。源站动态壁纸走
 * homeView?wpType=3 独立频道，本应用分类未引用；此处再作卡片级防御，
 * 保证任何混合列表也不会混进动态内容。
 */
function isDynamicCard(chunk: string, src: string): boolean {
  if (/<video[\s>]/i.test(chunk)) return true
  if (/video_reduce_file/i.test(chunk)) return true
  if (/\.(mp4|webm|mov|gif)(?:["'?&\s]|$)/i.test(chunk)) return true
  if (/\.gif(?:["'?&\s]|$)/i.test(src)) return true
  return false
}

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
 * 哲风壁纸图片直连展示：页面全局 no-referrer 绕过 CDN 防盗链
 * （实测无 Referer → 200；携带第三方 Referer → 403），
 * 缩略变体缺失由前端 imgFallback 回退原图。此函数保留直链语义。
 */
export function proxyImageUrl(src: string): string {
  return src
}

/**
 * <img> 加载失败自动回退原图直链（缩略变体 404 / 网络抖动）。
 * 页面全局 no-referrer（见 layout metadata.referrer），CDN 直连无防盗链问题；
 * 首次失败换原图，二次失败追加 r=1 破缓存重试一次。
 * 用法：onError={imgFallback(w.src)}
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
    el.src = originalSrc
  }
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

    // 剔除动态壁纸（视频卡片 / 动图）
    if (isDynamicCard(chunk, src)) continue

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

    // 缩略图统一走 _s240q80.webp 变体（尺寸最小、CDN 覆盖率最高）。
    // 注意：CDN 上部分图片的缩略变体并不存在（404），srcset 声明并不可信 ——
    // 该场景由 /api/wallpapers/img 代理自动回落原图直链，无需在此判断。
    const thumb = `${src.slice(0, dot)}_s240q80.webp`

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

/* ------------------------------ 手机壁纸解析（/mobileView，源站 2026-10 改版后新结构） ------------------------------ */

/**
 * /mobileView 卡片结构与 homeView 不同：
 * <a href="/mobileViewLook/<wtId>" class="mobile-virtual-card ...">
 *   <img srcset="..._s240q80.webp 160w, ....png 4096w"
 *        src="https://img.haowallpaper.com/cache_file/....png"
 *        alt="4k围巾壁纸 - 忧郁 - 手绘 - 清冷「哲风壁纸」">
 * </a>
 * —— 无 labelDiv 标签（从 alt「标题 - 标签1 - 标签2」拆出），无 s320 变体，
 *    详情链接为 /mobileViewLook/<id>（getCompleteUrl 同样用它）。
 */
function parseMobileWallpapers(html: string): ZhefengWallpaper[] {
  const items: ZhefengWallpaper[] = []
  const seen = new Set<string>()

  const cardRe = /<a\s+href="\/mobileViewLook\/([0-9]{6,32})"[^>]*>([\s\S]*?)<\/a>/g
  for (const m of html.matchAll(cardRe)) {
    const wtId = m[1]
    const chunk = m[2]
    if (!chunk.includes("img.haowallpaper.com")) continue

    const imgMatch =
      /<img[^>]*src="(https:\/\/img\.haowallpaper\.com\/cache_file\/[^"]+)"[^>]*alt="([^"]*)"/.exec(
        chunk
      )
    if (!imgMatch) continue

    const src = imgMatch[1] // 手机卡片 src 即原图直链（png 最大分辨率）
    const alt = imgMatch[2]

    // 剔除动态壁纸（视频卡片 / 动图）
    if (isDynamicCard(chunk, src)) continue

    const dot = src.lastIndexOf(".")
    if (dot === -1) continue
    const id = src.slice(src.lastIndexOf("/") + 1, dot)
    if (seen.has(id)) continue
    seen.add(id)

    // 缩略图：手机卡片仅 s240q80.webp 一个缩略变体
    const thumb = `${src.slice(0, dot)}_s240q80.webp`

    // 标题与标签：手机卡片无 labelDiv，从 alt「标题 - 标签1 - 标签2」拆出
    const parts = cleanTitle(alt)
      .split(/\s*-\s*/)
      .map((p) => p.trim())
      .filter(Boolean)
    const title = (parts.shift() ?? "").trim() || `壁纸 ${id.slice(-6)}`
    const tags = parts.slice(0, 12)

    items.push({
      id,
      wtId,
      title,
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

/** 电脑壁纸（/homeView，typeId 子分类）一页 */
async function fetchHomeView(cat: ZhefengCategory, page: number): Promise<ZhefengWallpaper[]> {
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
  return parseWallpapers(await res.text())
}

/** 手机壁纸（/mobileView，源站改版后独立页面，每页约 13 张）一页 */
async function fetchMobileView(page: number): Promise<ZhefengWallpaper[]> {
  const res = await fetch(`${API_BASE}/mobileView?page=${page}`, {
    headers: { "User-Agent": UA, Referer: `${API_BASE}/` },
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`源站响应异常（HTTP ${res.status}）`)
  return parseMobileWallpapers(await res.text())
}

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

  const items =
    cat.endpoint === "mobileView"
      ? await fetchMobileView(page)
      : await fetchHomeView(cat, page)
  cache.set(key, { ts: Date.now(), items })
  return items
}

/** 下载原图时回源使用的请求头 */
export const upstreamHeaders = () => ({
  "User-Agent": UA,
  Referer: `${API_BASE}/`,
})
