import { NextRequest, NextResponse } from "next/server"
import { isZhefengImageUrl, upstreamHeaders } from "@/lib/zhefeng"
import { cacheKeyFor, readImgCache, writeImgCache } from "@/lib/img-cache"

/**
 * GET /api/wallpapers/img?src=<img-url>
 * 哲风壁纸图片代理：绕过 CDN 的 Referer 防盗链（源站仅允许本站或空 Referer）。
 *
 * v1.4.3 起三级缓存（详见 src/lib/img-cache.ts）：
 *   内存 LRU → 磁盘缓存（用户数据目录，跨重启）→ 回源 CDN（写回缓存）。
 * 同一图片的并发请求合并为一次回源（in-flight 去重），
 * 响应头 X-Img-Cache 标注命中层级（memory / disk / miss）便于验证。
 */

/** 回源结果 */
interface UpstreamResult {
  buffer: Buffer
  contentType: string
}

/** 并发回源去重：同一 src 同时被 N 个 <img> 请求 → 只回源一次 */
const inflight = new Map<string, Promise<UpstreamResult | null>>()

async function fetchUpstream(src: string, key: string): Promise<UpstreamResult | null> {
  const p = (async (): Promise<UpstreamResult | null> => {
    try {
      const upstream = await fetch(src, {
        headers: upstreamHeaders(),
        signal: AbortSignal.timeout(30000),
        cache: "no-store",
      })
      if (!upstream.ok) {
        console.warn(`[img] 回源失败 HTTP ${upstream.status}: ${src.slice(0, 96)}`)
        return null
      }
      const contentType = (upstream.headers.get("content-type") ?? "").split(";")[0].trim()
      if (!contentType.startsWith("image/")) return null
      const buffer = Buffer.from(await upstream.arrayBuffer())
      if (buffer.length === 0) return null
      // 落盘缓存（失败无害：仅本次之后的请求需再回源）
      void writeImgCache(key, buffer, contentType)
      return { buffer, contentType }
    } catch (e) {
      console.warn("[img] 回源异常:", (e as Error).message)
      return null
    }
  })()

  inflight.set(key, p)
  try {
    return await p
  } finally {
    inflight.delete(key)
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

  const key = cacheKeyFor(src)

  // 1) 内存 / 磁盘缓存命中：不再回源
  const hit = await readImgCache(key)
  if (hit) return imgResponse(hit.buffer, hit.contentType, hit.source)

  // 2) 未命中 → 回源（并发去重）
  const fresh = await (inflight.get(key) ?? fetchUpstream(src, key))
  if (!fresh) return new NextResponse(null, { status: 502 })

  return imgResponse(fresh.buffer, fresh.contentType, "miss")
}
