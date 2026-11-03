import { NextRequest, NextResponse } from "next/server"
import { isZhefengImageUrl, upstreamHeaders } from "@/lib/zhefeng"

/**
 * GET /api/wallpapers/img?src=<img-url>
 * 哲风壁纸图片代理：绕过 CDN 的 Referer 防盗链（源站仅允许本站或空 Referer）。
 * 用于页面内 <img> 展示，响应带长缓存。
 */
export async function GET(req: NextRequest) {
  const src = req.nextUrl.searchParams.get("src") ?? ""

  if (!isZhefengImageUrl(src)) {
    return NextResponse.json({ error: "仅支持哲风壁纸图片直链" }, { status: 400 })
  }

  try {
    const upstream = await fetch(src, {
      headers: upstreamHeaders(),
      signal: AbortSignal.timeout(30000),
      cache: "no-store",
    })
    if (!upstream.ok || !upstream.body) {
      return new NextResponse(null, { status: 502 })
    }

    const headers = new Headers()
    headers.set("Content-Type", upstream.headers.get("content-type") ?? "image/webp")
    const len = upstream.headers.get("content-length")
    if (len) headers.set("Content-Length", len)
    // 壁纸内容不变，允许浏览器长缓存
    headers.set("Cache-Control", "public, max-age=86400, immutable")

    return new NextResponse(upstream.body, { status: 200, headers })
  } catch (e) {
    console.error("GET /api/wallpapers/img error:", e)
    return new NextResponse(null, { status: 502 })
  }
}
