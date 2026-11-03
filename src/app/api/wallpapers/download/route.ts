import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { isZhefengImageUrl, upstreamHeaders } from "@/lib/zhefeng"
import { zfCompleteUrl, zfUpstreamHeaders } from "@/lib/zf-login"


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

/** 从直链推断扩展名 */
function extOf(src: string) {
  const dot = src.lastIndexOf(".")
  const e = dot === -1 ? "" : src.slice(dot + 1).toLowerCase()
  return /^\w{2,5}$/.test(e) ? e : "png"
}

/** 从哲风直链提取 wtId（CDN 文件名去扩展名，与官网详情 id 一致） */
function wtIdOf(src: string) {
  const dot = src.lastIndexOf(".")
  const slash = src.lastIndexOf("/")
  if (dot === -1 || slash === -1 || dot < slash) return null
  const id = src.slice(slash + 1, dot)
  return /^[0-9A-Za-z_-]{1,64}$/.test(id) ? id : null
}

/** getCompleteUrl 响应里深挖原图直链 */
function digUrl(data: unknown, depth = 0): string | null {
  if (depth > 3) return null
  if (typeof data === "string") return /^https?:\/\//.test(data) ? data : null
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const obj = data as Record<string, unknown>
  for (const key of ["url", "completeUrl", "downUrl", "link"]) {
    if (typeof obj[key] === "string" && /^https?:\/\//.test(obj[key] as string)) {
      return obj[key] as string
    }
  }
  return digUrl(obj.data, depth + 1)
}

/**
 * GET /api/wallpapers/download?src=<img-url>&name=<文件名>&wtId=<id>
 *
 * - 本地已保存哲风令牌：走官网 getCompleteUrl 接口拿「与官网完全一致」的原图直链再代理下载
 * - 无令牌：直接代理直链（官网预览质量约 1100px）
 * - 无论哪种方式，都写入 Download 记录（下载过的图片不再显示）
 */
export async function GET(req: NextRequest) {
  const src = req.nextUrl.searchParams.get("src") ?? ""
  const name = req.nextUrl.searchParams.get("name") ?? ""
  const wtIdParam = req.nextUrl.searchParams.get("wtId") ?? ""

  if (!isZhefengImageUrl(src)) {
    return NextResponse.json({ error: "仅支持哲风壁纸图片直链" }, { status: 400 })
  }

  const ext = extOf(src)
  const filename = `${safeFilename(name)}.${ext}`
  const wtId = wtIdParam || wtIdOf(src) || ""

  // 记录下载（upsert：重复下载刷新时间与质量）
  const recordDownload = async (quality: "preview" | "original") => {
    if (!wtId) return
    try {
      await db.download.upsert({
        where: { wtId },
        create: { wtId, title: safeFilename(name), src, quality },
        update: { quality, downloadedAt: new Date() },
      })
    } catch (e) {
      console.error("record download error:", e)
    }
  }

  try {
    // ① 有令牌 → 官网原图直链
    let quality: "preview" | "original" = "preview"
    let target = src
    let extraHeaders: Record<string, string> = upstreamHeaders()

    if (wtId) {
      const tokenRow = await db.zfToken.findFirst({ orderBy: { createdAt: "desc" } })
      if (tokenRow) {
        try {
          const res = await fetch(zfCompleteUrl(wtId), {
            headers: zfUpstreamHeaders({ token: tokenRow.token }),
            signal: AbortSignal.timeout(15000),
            cache: "no-store",
          })
          if (res.ok) {
            const json = await res.json().catch(() => null)
            const url = json ? digUrl(json) : null
            if (url) {
              target = url
              quality = "original"
              extraHeaders = zfUpstreamHeaders({ token: tokenRow.token })
            }
          }
        } catch (e) {
          console.error("getCompleteUrl error:", e)
          // 回退预览质量
        }
      }
    }

    // ② 回源代理下载
    const upstream = await fetch(target, {
      headers: extraHeaders,
      signal: AbortSignal.timeout(60000),
      cache: "no-store",
    })
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json(
        { error: `原图下载失败（HTTP ${upstream.status}）` },
        { status: 502 }
      )
    }

    await recordDownload(quality)

    const headers = new Headers()
    headers.set("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream")
    headers.set(
      "Content-Disposition",
      `attachment; filename="wallpaper.${ext}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    )
    headers.set("X-Wallpaper-Quality", quality)
    const len = upstream.headers.get("content-length")
    if (len) headers.set("Content-Length", len)

    return new NextResponse(upstream.body, { status: 200, headers })
  } catch (e) {
    console.error("GET /api/wallpapers/download error:", e)
    return NextResponse.json({ error: "原图下载失败，请稍后重试" }, { status: 502 })
  }
}
