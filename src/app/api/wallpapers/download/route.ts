import { NextRequest, NextResponse } from "next/server"
import { isZhefengImageUrl, upstreamHeaders } from "@/lib/zhefeng"


/** 清洗文件名：去掉 Windows / macOS 非法字符 */
function safeFilename(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "wallpaper"
  )
}

/**
 * GET /api/wallpapers/download?src=<img-url>&name=<文件名>
 * 代理哲风壁纸原图下载（回源带上 Referer，浏览器侧触发「另存为」）。
 */
export async function GET(req: NextRequest) {
  const src = req.nextUrl.searchParams.get("src") ?? ""
  const name = req.nextUrl.searchParams.get("name") ?? ""

  if (!isZhefengImageUrl(src)) {
    return NextResponse.json({ error: "仅支持哲风壁纸图片直链" }, { status: 400 })
  }

  try {
    const ext = (() => {
      const dot = src.lastIndexOf(".")
      const e = dot === -1 ? "" : src.slice(dot + 1).toLowerCase()
      return /^\w{2,5}$/.test(e) ? e : "png"
    })()

    const upstream = await fetch(src, {
      headers: upstreamHeaders(),
      signal: AbortSignal.timeout(60000),
      cache: "no-store",
    })
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json(
        { error: `原图下载失败（HTTP ${upstream.status}）` },
        { status: 502 }
      )
    }

    const filename = `${safeFilename(name)}.${ext}`
    const headers = new Headers()
    headers.set("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream")
    headers.set(
      "Content-Disposition",
      `attachment; filename="wallpaper.${ext}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    )
    const len = upstream.headers.get("content-length")
    if (len) headers.set("Content-Length", len)

    return new NextResponse(upstream.body, { status: 200, headers })
  } catch (e) {
    console.error("GET /api/wallpapers/download error:", e)
    return NextResponse.json({ error: "原图下载失败，请稍后重试" }, { status: 502 })
  }
}
