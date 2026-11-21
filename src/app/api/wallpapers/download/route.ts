import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { isZhefengImageUrl, upstreamHeaders } from "@/lib/zhefeng"
import { zfCompleteUrl, zfUpstreamHeaders } from "@/lib/zf-login"
import { ensureCertified, invalidateCertification } from "@/lib/zf-certify"
import { createSemaphore } from "@/lib/semaphore"

/**
 * 回源并发上限（v1.4.4）：同一时刻最多 3 个原图回源，其余 FIFO 排队。
 * 之前批量下载 18 张时全部并发回源，挤占带宽 + 触发 CDN 限流，
 * 导致缩略图代理集体超时——网格图片「下载后直接不显示」的元凶。
 * 限流后大文件 3 张一批排队走，图片代理与列表接口始终保持秒开。
 * 排队等待上限 8 分钟（覆盖 18 张 × 单张 60s 超时的最坏队列等待）。
 */
const dlSlots = createSemaphore(3, 8 * 60_000)


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
    // ① 占用回源槽位（最多 3 张并发，其余排队；排队超时抛 DOWNLOAD_QUEUE_TIMEOUT）
    await dlSlots.acquire()

    try {
      // 令牌流程（人机验证 + getCompleteUrl）也在槽位内：拿到原图直链
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

      // ② 回源下载：整段读入内存后再响应（拿到完整字节即释放槽位，
      //    流式响应会一直占用到客户端收完，排队就失去意义）
      const upstream = await fetch(target, {
        headers: extraHeaders,
        signal: AbortSignal.timeout(60000),
        cache: "no-store",
      })
      if (!upstream.ok) {
        return NextResponse.json(
          { error: `原图下载失败（HTTP ${upstream.status}）` },
          { status: 502 }
        )
      }
      const contentType = upstream.headers.get("content-type") ?? "application/octet-stream"
      const buffer = Buffer.from(await upstream.arrayBuffer())
      if (buffer.length === 0) {
        return NextResponse.json({ error: "原图内容为空" }, { status: 502 })
      }

      await recordDownload(quality)

      const headers = new Headers()
      headers.set("Content-Type", contentType)
      headers.set(
        "Content-Disposition",
        `attachment; filename="wallpaper.${ext}"; filename*=UTF-8''${encodeURIComponent(filename)}`
      )
      headers.set("Content-Length", String(buffer.length))
      headers.set("X-Wallpaper-Quality", quality)
      if (authExpired) headers.set("X-Auth-Expired", "1")

      return new NextResponse(new Uint8Array(buffer), { status: 200, headers })
    } finally {
      // 释放槽位：下一张排队中的下载立即开始
      dlSlots.release()
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // 排队超时（罕见：前一批占满 8 分钟）：给出可重试的明确提示
    if (msg.startsWith("DOWNLOAD_QUEUE_TIMEOUT")) {
      const secs = msg.split(":")[1] ?? "?"
      return NextResponse.json(
        { error: `下载排队超过 ${secs} 秒，请稍后重试` },
        { status: 503 }
      )
    }
    console.error("GET /api/wallpapers/download error:", e)
    return NextResponse.json({ error: "原图下载失败，请稍后重试" }, { status: 502 })
  }
}
