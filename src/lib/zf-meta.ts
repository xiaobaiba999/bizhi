/**
 * 壁纸工坊 · 官网原图元数据（服务器版，TS）
 * ============================================================
 * 与 desktop/zf-meta.js（桌面版 CommonJS 孪生）逐行对齐，
 * 改一处必须同步另一处。
 *
 * 官网详情页 /homeViewLook/<wtId> 内嵌 schema.org JSON-LD（ImageObject），
 * 公开给出官方原图 width / height / contentUrl / contentSize —— 这是
 * 「期望宽高」的唯一权威来源（不硬编码任何固定尺寸）。
 * 元数据公开可取，但原图字节仍仅登录令牌 + getCompleteUrl 可得
 * （contentUrl 直链未登录只回 1100px webp 预览，实测取证见测试脚本）。
 */

const API_BASE = "https://haowallpaper.com"
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

/** 成功缓存的 TTL（详情页元数据不频繁变化） */
const META_TTL_MS = 10 * 60 * 1000
/** 失败负缓存：避免元数据接口抖动时每张下载都重复打详情页 */
const META_FAIL_TTL_MS = 60 * 1000
/** 详情页 HTML 上限（实测约 230KB，防异常大响应拖垮内存） */
const META_HTML_LIMIT = 4 * 1024 * 1024

export interface OfficialOriginalMeta {
  /** 官方原图宽度（px） */
  width: number
  /** 官方原图高度（px） */
  height: number
  /** 官方原图 URL（pre_cache_file 直链；未登录只回预览） */
  contentUrl: string
  /** 官方声明的内容大小（字节，近似）；解析不出为 null */
  contentSizeBytes: number | null
  title: string | null
}

const metaCache = new Map<string, { ts: number; meta: OfficialOriginalMeta | null }>()

/**
 * 解析 "8.32 MB" / "1,024 KB" / "3.5M" 这类 contentSize → 字节数（近似值）。
 * 无法解析返回 null。MB 按 1024² 保守解释（用作下限基准时略偏大无害）。
 */
export function parseContentSizeBytes(text: unknown): number | null {
  if (typeof text !== "string") return null
  const m = /([\d.,]+)\s*(KB|MB|GB|K|M|G|B)/i.exec(text.replace(/,/g, ""))
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = m[2].toUpperCase()
  const mult = unit.startsWith("G") ? 1024 ** 3 : unit.startsWith("M") ? 1024 ** 2 : unit.startsWith("K") ? 1024 : 1
  return Math.round(n * mult)
}

/**
 * 从详情页 HTML 提取 JSON-LD ImageObject 的官方原图元数据。
 */
export function extractMetaFromDetailHtml(html: string): OfficialOriginalMeta | null {
  if (typeof html !== "string" || html.length === 0) return null
  const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    let obj: Record<string, unknown> | null = null
    try {
      obj = JSON.parse(m[1]) as Record<string, unknown>
    } catch {
      continue
    }
    if (!obj || typeof obj !== "object") continue
    const w = Number(obj.width)
    const h = Number(obj.height)
    const cu = typeof obj.contentUrl === "string" ? obj.contentUrl : ""
    if (Number.isInteger(w) && w > 0 && Number.isInteger(h) && h > 0 && cu.includes("haowallpaper.com")) {
      return {
        width: w,
        height: h,
        contentUrl: cu,
        contentSizeBytes: parseContentSizeBytes(obj.contentSize),
        title: typeof obj.name === "string" ? obj.name.slice(0, 120) : null,
      }
    }
  }
  // 兜底：JSON.parse 全失败时按正则直取（页面结构微调时的保险）
  const w2 = /"width"\s*:\s*(\d+)\s*,\s*"height"\s*:\s*(\d+)/.exec(html)
  const cu2 = /"contentUrl"\s*:\s*"([^"]*img\.haowallpaper\.com[^"]*)"/.exec(html)
  if (w2 && cu2) {
    return {
      width: Number(w2[1]),
      height: Number(w2[2]),
      contentUrl: cu2[1],
      contentSizeBytes: null,
      title: null,
    }
  }
  return null
}

/**
 * 抓取官网详情页，取官方原图元数据（10 分钟内存缓存 + 60s 负缓存）。
 * 任何失败都返回 null（调用方继续走 v1.4.13 的预览兜底闸门，绝不因
 * 元数据不可用而阻断或放行下载）。
 * @param wtId 壁纸详情 id（卡片 /homeViewLook/<id>）
 */
export async function fetchOfficialOriginalMeta(wtId: string): Promise<OfficialOriginalMeta | null> {
  const id = String(wtId ?? "").trim()
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(id)) return null

  const hit = metaCache.get(id)
  const now = Date.now()
  if (hit) {
    if (hit.meta) {
      if (now - hit.ts < META_TTL_MS) return hit.meta
    } else if (now - hit.ts < META_FAIL_TTL_MS) {
      return null // 负缓存：短时间内不重试
    }
  }

  try {
    const res = await fetch(`${API_BASE}/homeViewLook/${encodeURIComponent(id)}`, {
      headers: { "User-Agent": UA, Referer: `${API_BASE}/`, Accept: "text/html,*/*" },
      signal: AbortSignal.timeout(12000),
      cache: "no-store",
    })
    if (!res.ok) {
      metaCache.set(id, { ts: now, meta: null })
      return null
    }
    const html = (await res.text()).slice(0, META_HTML_LIMIT)
    const meta = extractMetaFromDetailHtml(html)
    metaCache.set(id, { ts: now, meta })
    // 缓存条目有界：超过 512 条清最旧的一半
    if (metaCache.size > 512) {
      const keys = [...metaCache.keys()].slice(0, 256)
      for (const k of keys) metaCache.delete(k)
    }
    return meta
  } catch {
    metaCache.set(id, { ts: now, meta: null })
    return null
  }
}
