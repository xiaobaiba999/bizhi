import { NextRequest, NextResponse } from "next/server"
import sharp from "sharp"
import { db } from "@/lib/db"
import { isZhefengImageUrl, upstreamHeaders } from "@/lib/zhefeng"
import { zfCompleteUrl, zfUpstreamHeaders } from "@/lib/zf-login"
import { ensureCertified, invalidateCertification } from "@/lib/zf-certify"
import { syncArchiveAfterDownload } from "@/lib/download-archive"

/** 存储统一格式：所有壁纸转存为 JPG（产品约定，动态内容已在抓取层剔除） */
const STORE_EXT = "jpg"

/**
 * 把上游图片字节统一转存为 JPG：
 * - PNG / WebP 透明区域衬白底（壁纸场景无透明需求）
 * - 质量 92、mozjpeg 编码（体积与观感的平衡点）
 * - 转换失败（意外格式等）返回 null，调用方回退原始字节流，保证下载不中断
 */
async function toJpeg(buf: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(buf, { failOn: "none", animated: false })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: "4:2:0" })
      .toBuffer()
  } catch (e) {
    console.warn("[download] JPG 转换失败，回退原始格式:", e)
    return null
  }
}


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

/** 从直链推断扩展名（仅作 JPG 转换失败时的回退后缀） */
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
 *   拿「与官网完全一致」分辨率的原图直链并代理下载
 * - 无令牌 / 验证失败：直接代理直链（官网预览质量约 1100px）
 * - 存储统一转存为 JPG（白底展平 + 质量 92），文件名一律 .jpg；
 *   转换失败时回退原始格式，保证下载永不中断
 * - 无论哪种方式，都写入 Download 记录（下载过的图片不再显示）
 */
export async function GET(req: NextRequest) {
  const src = req.nextUrl.searchParams.get("src") ?? ""
  const name = req.nextUrl.searchParams.get("name") ?? ""
  const wtIdParam = req.nextUrl.searchParams.get("wtId") ?? ""

  if (!isZhefengImageUrl(src)) {
    return NextResponse.json({ error: "仅支持哲风壁纸图片直链" }, { status: 400 })
  }

  const fallbackExt = extOf(src)
  // wtId：壁纸详情 id（getCompleteUrl 用；旧版传文件 id 时回退）
  const fileId = fileIdOf(src) ?? ""
  const wtId = wtIdParam || fileId

  // 记录下载（upsert：重复下载刷新时间与质量；键 = 文件 id，与列表过滤一致）。
  // v1.3.3：同时同步到 JSON 档案（与数据库同目录），三层保险让记录跨版本永久保留
  const recordDownload = async (quality: "preview" | "original") => {
    if (!fileId) return
    try {
      const downloadedAt = new Date()
      await db.download.upsert({
        where: { wtId: fileId },
        create: { wtId: fileId, title: safeFilename(name), src, quality, downloadedAt },
        update: { quality, downloadedAt },
      })
      await syncArchiveAfterDownload({
        wtId: fileId,
        title: safeFilename(name),
        src,
        quality,
        downloadedAt,
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

    // ② 回源代理下载（整段读入后统一转存 JPG）
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

    // 统一转存 JPG；失败回退原始字节（后缀用源格式，避免名不副实）
    const raw = Buffer.from(await upstream.arrayBuffer())
    const jpg = await toJpeg(raw)
    const out = jpg ?? raw
    const ext = jpg ? STORE_EXT : fallbackExt
    const filename = `${safeFilename(name)}.${ext}`

    const headers = new Headers()
    headers.set("Content-Type", jpg ? "image/jpeg" : (upstream.headers.get("content-type") ?? "application/octet-stream"))
    headers.set(
      "Content-Disposition",
      `attachment; filename="wallpaper.${ext}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    )
    headers.set("X-Wallpaper-Quality", quality)
    headers.set("X-Wallpaper-Format", ext)
    if (authExpired) headers.set("X-Auth-Expired", "1")
    headers.set("Content-Length", String(out.length))

    return new NextResponse(new Uint8Array(out), { status: 200, headers })
  } catch (e) {
    console.error("GET /api/wallpapers/download error:", e)
    return NextResponse.json({ error: "原图下载失败，请稍后重试" }, { status: 502 })
  }
}
