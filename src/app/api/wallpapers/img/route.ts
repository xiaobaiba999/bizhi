import { NextRequest, NextResponse } from "next/server"
import { isZhefengImageUrl, upstreamHeaders } from "@/lib/zhefeng"

/**
 * GET /api/wallpapers/img?src=<img-url>
 * 哲风壁纸图片代理：绕过 CDN 的 Referer 防盗链（源站仅允许本站或空 Referer）。
 *
 * 可靠性设计（图片「经常不显示」的服务端对策）：
 * - 内存 LRU 缓存（200 条 / 64MB 上限）：重复浏览零回源
 * - 并发回源去重：同一 src 同时被 N 个 <img> 请求 → 只回源一次
 * - 回源「瞬时」失败（网络抖动 / 5xx / 超时）1s 后原地再试一次
 * - 响应带 7 天 immutable 缓存头：浏览器磁盘缓存二次访问 0ms
 *
 * v1.4.6 优化（源自 dev.log 实证）：CDN 上部分 _s240q80.webp 缩略图是
 * 「永久 404」（源站根本没生成这个变体）。旧版对它照样等 1s 重试 →
 * 再次 404 → 502，每张死链白等 ~1.9s、回源两次，还拖慢同一批的
 * 健康图片。现在：
 * - 404 / 410 / 403 判定为永久失败：不重试，直接透传状态码给浏览器，
 *   客户端回退链（缩略图 → s240 → 原图）立刻前进到下一级
 * - 永久失败进 5 分钟负缓存：后续请求 0ms 出 404，不再骚扰 CDN
 * - 只有瞬时失败（5xx / 网络 / 超时）才走 1s 重试自愈
 */

interface UpstreamResult {
  buffer: Buffer
  contentType: string
}

/** 内存 LRU（Map 天然保序：get 时重插即刷新热度） */
const MAX_ENTRIES = 200
const MAX_BYTES = 64 * 1024 * 1024
const lru = new Map<string, UpstreamResult>()
let lruBytes = 0

function cachePut(key: string, v: UpstreamResult) {
  if (lru.has(key)) {
    const old = lru.get(key)!
    lruBytes -= old.buffer.length
  }
  lru.set(key, v)
  lruBytes += v.buffer.length
  // 超限逐出最旧条目
  while ((lru.size > MAX_ENTRIES || lruBytes > MAX_BYTES) && lru.size > 0) {
    const oldest = lru.keys().next().value as string
    const old = lru.get(oldest)
    if (old) lruBytes -= old.buffer.length
    lru.delete(oldest)
  }
}

/**
 * 永久失败负缓存：src → 过期时间戳。
 * CDN 某个缩略图变体 404 后短时间内不会凭空出现（源站生成是永久的），
 * 记住它可以让同批 / 后续请求 0ms 失败，把机会立即让给回退链。
 */
const NEGATIVE_TTL = 5 * 60 * 1000
const negative = new Map<string, number>()

function negativeHit(src: string): boolean {
  const exp = negative.get(src)
  if (exp === undefined) return false
  if (Date.now() >= exp) {
    negative.delete(src)
    return false
  }
  return true
}

function negativePut(src: string) {
  // 简单上限保护：超过 2000 条清掉最早一半（正常场景远达不到）
  if (negative.size > 2000) {
    const half = Array.from(negative.keys()).slice(0, 1000)
    for (const k of half) negative.delete(k)
  }
  negative.set(src, Date.now() + NEGATIVE_TTL)
}

/** CDN 返回这些状态码 = 重试也注定失败（变体不存在 / 被删 / 禁止访问） */
function isPermanentStatus(status: number): boolean {
  return status === 404 || status === 410 || status === 403
}

/** 并发回源去重：同一 src 同时只回源一次 */
const inflight = new Map<string, Promise<UpstreamResult | null>>()

async function fetchUpstream(src: string): Promise<UpstreamResult | null> {
  const p = (async (): Promise<UpstreamResult | null> => {
    try {
      const upstream = await fetch(src, {
        headers: upstreamHeaders(),
        // 15s：缩略图小文件，健康链路 <1s；超时快速失败把机会留给
        // 客户端回退链 / 自动重试
        signal: AbortSignal.timeout(15000),
        cache: "no-store",
      })
      if (!upstream.ok) {
        if (isPermanentStatus(upstream.status)) {
          // 永久失败：负缓存 + 不重试（v1.4.6）
          negativePut(src)
          console.warn(`[img] 永久失败 HTTP ${upstream.status}（已负缓存 5 分钟）: ${src.slice(0, 96)}`)
        } else {
          console.warn(`[img] 回源失败 HTTP ${upstream.status}: ${src.slice(0, 96)}`)
        }
        return null
      }
      const contentType = (upstream.headers.get("content-type") ?? "").split(";")[0].trim()
      if (!contentType.startsWith("image/")) {
        // 非图片内容也按永久失败处理（重试拿到的还是它）
        negativePut(src)
        return null
      }
      const buffer = Buffer.from(await upstream.arrayBuffer())
      if (buffer.length === 0) return null
      const result = { buffer, contentType }
      cachePut(src, result)
      return result
    } catch (e) {
      console.warn("[img] 回源异常:", (e as Error).message)
      return null
    }
  })()

  inflight.set(src, p)
  try {
    return await p
  } finally {
    inflight.delete(src)
  }
}

function imgResponse(buffer: Buffer, contentType: string, cacheLayer: string): NextResponse {
  const headers = new Headers()
  headers.set("Content-Type", contentType)
  headers.set("Content-Length", String(buffer.length))
  // 壁纸内容不可变：浏览器磁盘缓存 7 天，服务端缓存命中则是 0ms
  headers.set("Cache-Control", "public, max-age=604800, immutable")
  headers.set("X-Img-Cache", cacheLayer)
  return new NextResponse(new Uint8Array(buffer), { status: 200, headers })
}

export async function GET(req: NextRequest) {
  const src = req.nextUrl.searchParams.get("src") ?? ""

  if (!isZhefengImageUrl(src)) {
    return NextResponse.json({ error: "仅支持哲风壁纸图片直链" }, { status: 400 })
  }

  // 0) 永久失败负缓存命中：0ms 出 404，客户端回退链立即前进
  if (negativeHit(src)) {
    return new NextResponse(null, {
      status: 404,
      headers: { "Cache-Control": "no-store", "X-Img-Cache": "negative" },
    })
  }

  // 1) 内存缓存命中：不再回源
  const hit = lru.get(src)
  if (hit) {
    // 刷新 LRU 热度
    lru.delete(src)
    lru.set(src, hit)
    return imgResponse(hit.buffer, hit.contentType, "memory")
  }

  // 2) 未命中 → 回源（并发去重；瞬时失败 1s 后原地再试一次）
  let fresh = await (inflight.get(src) ?? fetchUpstream(src))
  if (!fresh && !negativeHit(src)) {
    // 只有「非永久失败」才值得等 1s 重试；刚判定为永久失败的直接短路
    await new Promise((r) => setTimeout(r, 1000))
    if (!negativeHit(src)) {
      fresh = await (inflight.get(src) ?? fetchUpstream(src))
    }
  }
  if (!fresh) {
    // 永久失败透传 404（客户端立刻走回退链）；瞬时失败 502（客户端可重试）
    return new NextResponse(null, {
      status: negativeHit(src) ? 404 : 502,
      headers: { "Cache-Control": "no-store" },
    })
  }

  return imgResponse(fresh.buffer, fresh.contentType, "miss")
}
