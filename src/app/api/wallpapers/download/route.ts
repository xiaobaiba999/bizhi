import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { isZhefengImageUrl, upstreamHeaders } from "@/lib/zhefeng"

/**
 * GET /api/wallpapers/download?src=<img-url>&name=<title>&id=<file-id>
 * 原图下载代理：服务端带 Referer 回源 CDN 取原图字节，以附件形式返回。
 * 成功出流时落一条下载记录（SQLite），驱动「下载过的自动隐藏」。
 */
function safeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
  return cleaned || "wallpaper"
}

export async function GET(req: NextRequest) {
  const src = req.nextUrl.searchParams.get("src") ?? ""
  const name = req.nextUrl.searchParams.get("name") ?? ""
  const id = req.nextUrl.searchParams.get("id") ?? ""

  if (!isZhefengImageUrl(src)) {
    return NextResponse.json({ error: "仅支持哲风壁纸图片直链" }, { status: 400 })
  }

  try {
    const upstream = await fetch(src, {
      headers: upstreamHeaders(),
      signal: AbortSignal.timeout(120_000),
      cache: "no-store",
    })
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json(
        { error: `CDN 下载失败（HTTP ${upstream.status}）` },
        { status: 502 }
      )
    }

    // 成功出流前落库下载记录（失败不影响下载本身）
    if (id) {
      const dot = src.lastIndexOf(".")
      const ext = dot === -1 ? "png" : src.slice(dot + 1)
      await db.download
        .upsert({
          where: { id },
          create: { id, title: name || safeFilename(name), src },
          update: {},
        })
        .catch(() => undefined)
      void ext // 扩展名由 URL 自带，无需在此使用
    }

    const contentType = (upstream.headers.get("content-type") ?? "").split(";")[0].trim()
    const dot = src.lastIndexOf(".")
    const ext = dot === -1 ? "png" : src.slice(dot + 1)
    const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(
      `${safeFilename(name)}.${ext}`
    )}`

    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": contentType || "application/octet-stream",
        "Content-Disposition": disposition,
        "Cache-Control": "no-store",
      },
    })
  } catch (e) {
    console.error("GET /api/wallpapers/download error:", e)
    return NextResponse.json({ error: "下载失败，请稍后重试" }, { status: 502 })
  }
}
