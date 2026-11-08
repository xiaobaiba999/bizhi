import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { isZhefengImageUrl, upstreamHeaders } from "@/lib/zhefeng"
import { zfCompleteUrl, zfUpstreamHeaders } from "@/lib/zf-login"
import { ensureCertified, invalidateCertification } from "@/lib/zf-certify"


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

/** 从哲风直链提取文件 id（CDN 文件名去扩展名，作为下载记录的键，与列表过滤一致） */
function fileIdOf(src: string) {
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

/** 官网 getCompleteUrl 的 JSON 响应（用于识别 3004/3005 等业务错误码） */
interface CompleteUrlResponse {
  status?: number | string
  msg?: string
  data?: unknown
}

/**
 * 调用官网 getCompleteUrl（已带 __media=1&__responseCodec=aeg-v2 必需参数）。
 * 前置条件：先通过 ALTCHA 人机验证（ensureCertified），并把验证会话的
 * server_session Cookie 回放到请求头 —— 官网验证状态绑定在该 Cookie 上。
 *
 * 返回原图直链；令牌失效抛 "AUTH_EXPIRED"；其余异常抛普通 Error。
 */
async function fetchCompleteUrl(
  wtId: string,
  token: string,
  cookie: string | null
): Promise<string> {
  const res = await fetch(zfCompleteUrl(wtId), {
    headers: zfUpstreamHeaders({
      token,
      ...(cookie ? { Cookie: cookie } : {}),
    }),
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  })
  const json = (await res.json().catch(() => null)) as CompleteUrlResponse | null
  if (!json) throw new Error(`官网响应异常（HTTP ${res.status}）`)

  const url = digUrl(json)
  if (url) return url

  const status = Number(json.status ?? -1)
  const msg = typeof json.msg === "string" ? json.msg.trim() : ""
  // 401 未授权：令牌确实失效（未登录 / 已过期），与 3004「错误的请求」不同
  if (status === 401 || /未授权/.test(msg)) {
    throw new Error("AUTH_EXPIRED")
  }
  // 305 [错误的请求 -> 3004/3005]：人机验证缺失/过期 或 wtId 不对
  if (status === 305) {
    throw new Error(`CERTIFY_OR_PARAM_ERROR:${msg || status}`)
  }
  throw new Error(msg || `官网接口异常（HTTP ${res.status}）`)
}

/**
 * GET /api/wallpapers/download?src=<img-url>&name=<文件名>&wtId=<壁纸详情id>
 *
 * - 本地已保存哲风令牌：先过官网 ALTCHA 人机验证，再走 getCompleteUrl
 *   拿「与官网完全一致」的原图直链并代理下载
 * - 无令牌 / 验证失败：直接代理直链（官网预览质量约 1100px）
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
  // wtId：壁纸详情 id（getCompleteUrl 用；旧版传文件 id 时回退）
  const fileId = fileIdOf(src) ?? ""
  const wtId = wtIdParam || fileId

  // 记录下载（upsert：重复下载刷新时间与质量；键 = 文件 id，与列表过滤一致）
  const recordDownload = async (quality: "preview" | "original") => {
    if (!fileId) return
    try {
      await db.download.upsert({
        where: { wtId: fileId },
        create: { wtId: fileId, title: safeFilename(name), src, quality },
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
    let authExpired = false

    if (wtId) {
      const tokenRow = await db.zfToken.findFirst({ orderBy: { createdAt: "desc" } })
      if (tokenRow) {
        try {
          // 官网要求先过「我不是机器人」ALTCHA 人机验证，
          // 否则 getCompleteUrl 一律 305 [错误的请求 -> 3004]
          let cookie = await ensureCertified()
          try {
            const url = await fetchCompleteUrl(wtId, tokenRow.token, cookie)
            target = url
            quality = "original"
            extraHeaders = zfUpstreamHeaders({ token: tokenRow.token })
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            if (msg === "AUTH_EXPIRED") throw e
            // 3004：人机验证可能过期 → 强制重新验证后重试一次
            if (msg.startsWith("CERTIFY_OR_PARAM_ERROR")) {
              invalidateCertification()
              cookie = await ensureCertified(true)
              const url = await fetchCompleteUrl(wtId, tokenRow.token, cookie)
              target = url
              quality = "original"
              extraHeaders = zfUpstreamHeaders({ token: tokenRow.token })
            } else {
              throw e
            }
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg === "AUTH_EXPIRED") {
            // 令牌确实失效：回退预览质量（前端会提示重新登录）
            authExpired = true
          } else {
            console.error("getCompleteUrl error:", e)
            // 其他异常：回退预览质量
          }
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
    if (authExpired) headers.set("X-Auth-Expired", "1")
    const len = upstream.headers.get("content-length")
    if (len) headers.set("Content-Length", len)

    return new NextResponse(upstream.body, { status: 200, headers })
  } catch (e) {
    console.error("GET /api/wallpapers/download error:", e)
    return NextResponse.json({ error: "原图下载失败，请稍后重试" }, { status: 502 })
  }
}
