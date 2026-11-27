import { NextRequest, NextResponse } from "next/server"
import { createHash } from "node:crypto"
import { db } from "@/lib/db"
import { isZhefengImageUrl } from "@/lib/zhefeng"
import { zfCompleteUrl, zfUpstreamHeaders } from "@/lib/zf-login"
import { ensureCertified, invalidateCertification } from "@/lib/zf-certify"
import { createSemaphore } from "@/lib/semaphore"
import { validateOriginalImage, type OriginalExpect } from "@/lib/image-quality"
import { fetchOfficialOriginalMeta, metaIsStaticImage, type OfficialOriginalMeta } from "@/lib/zf-meta"

/**
 * GET /api/wallpapers/download?src=<img-url>&name=<title>&id=<file-id>&wtId=<详情id>&cat=<computer|phone>
 *
 * v2.0 OriginalDownloadService（服务器版，与桌面版 original-download.js 同构）：
 *   本地记录检查（重复 409）→ 令牌检查（无 401）→ 官网元数据（期望宽高 +
 *   动态壁纸拒绝）→ ALTCHA → getCompleteUrl 签名直链 → 原始字节 →
 *   字节级质量硬校验（v1.4.13/14 防线全保留）→ 原始字节直传 → 写完整记录
 *   （含 SHA-256/宽高/格式/大小/分类）。
 *
 * 统一错误码（v2.0 阶段七）：
 * - 401 NEED_LOGIN / AUTH_EXPIRED：未登录 / 令牌失效
 * - 409 DOWNLOAD_ALREADY：已下载过（msg 带原记录信息）
 * - 429 DOWNLOAD_RESTRICTED / DOWNLOAD_RATE_LIMITED：官网风控 / 限流
 *   （Retry-After 识别 + 恢复时间 90 天可信窗口，异常日期不回传具体时间）
 * - 502 DOWNLOAD_DYNAMIC：动态壁纸（仅支持静态）
 * - 502 DOWNLOAD_NOT_FOUND：原图不存在
 * - 502 DOWNLOAD_RESOLUTION/FORMAT/SIZE/SHA/QUALITY_MISMATCH：质量防线拦截
 *
 * 成功响应头：X-Wallpaper-Quality: original + X-Image-Dimensions: WxH。
 */
const dlSlots = createSemaphore(3, 8 * 60_000)

/* ---------------- v2.0 阶段七：限流/恢复时间解析与防御 ---------------- */

const RESTRICTED_RE = /受限|恢复时间|禁止下载|封禁|联系客服/
/** 恢复时间可信窗口：超出视为「官网返回了异常日期」，不回传具体时间 */
const RECOVER_SANITY_MS = 90 * 24 * 60 * 60 * 1000
const RESTRICTED_PROBE_MS = 60_000
const RATE_LIMIT_FALLBACK_MS = 60_000

let restrictedUntil = 0
let restrictedMsg = ""
let restrictedProbeAt = 0
let restrictedAbsurd = false

/** 解析「恢复时间：YYYY-MM-DD HH:mm[:ss]」→ epoch ms（本地时区） */
function parseRestrictedUntil(msg: string): number {
  const m = msg.match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/)
  if (!m) return 0
  const t = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] || 0)
  ).getTime()
  return Number.isFinite(t) ? t : 0
}

/** Retry-After 解析（秒数或 HTTP 日期；异常值 → 0） */
function parseRetryAfterMs(headerValue: string | null): number {
  const v = String(headerValue ?? "").trim()
  if (!v) return 0
  if (/^\d+$/.test(v)) {
    const ms = Number(v) * 1000
    return ms > 0 && ms <= RECOVER_SANITY_MS ? ms : 0
  }
  const t = Date.parse(v)
  const ms = Number.isFinite(t) ? t - Date.now() : 0
  return ms > 0 && ms <= RECOVER_SANITY_MS ? ms : 0
}

function markRestricted(msg: string, fallbackMs = 10 * 60_000) {
  restrictedMsg = msg
  const until = parseRestrictedUntil(msg)
  restrictedAbsurd = until > 0 && until - Date.now() > RECOVER_SANITY_MS
  restrictedUntil = until > Date.now() ? until : Date.now() + fallbackMs
  restrictedProbeAt = Date.now()
  console.warn(
    `[DOWNLOAD_RESTRICTED] 官网风控受限熔断至 ${new Date(restrictedUntil).toLocaleString()}：${msg}` +
      (restrictedAbsurd ? "［恢复时间超出 90 天可信窗口，不回传具体日期］" : "")
  )
}

function restrictedResponse() {
  return NextResponse.json(
    {
      error: "DOWNLOAD_RESTRICTED",
      msg: restrictedMsg || "官网下载功能暂时受限，请稍后重试",
      ...(restrictedAbsurd ? { recoverUnknown: true } : { recoverAt: restrictedUntil }),
    },
    { status: 429 }
  )
}

/** 清洗文件名 */
function safeFilename(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "wallpaper"
  )
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

interface CompleteUrlResponse {
  status?: number | string
  msg?: string
  data?: unknown
}

/**
 * 调用官网 getCompleteUrl（已带必需参数），前置 ALTCHA 验证。
 * 抛出标记错误："AUTH_EXPIRED" / "__RESTRICTED__" / "__RATE_LIMITED__" /
 * "__NOT_FOUND__"（404）；其余抛普通 Error。
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
  if (res.status === 429) throw new Error(`__RATE_LIMITED__:${res.headers.get("retry-after") ?? ""}`)
  if (res.status === 404) throw new Error("__NOT_FOUND__")
  const json = (await res.json().catch(() => null)) as CompleteUrlResponse | null
  if (!json) throw new Error(`官网响应异常（HTTP ${res.status}）`)

  const url = digUrl(json)
  if (url) return url

  const status = Number(json.status ?? -1)
  const msg = typeof json.msg === "string" ? json.msg.trim() : ""
  if (status === 401 || /未授权/.test(msg)) {
    throw new Error("AUTH_EXPIRED")
  }
  if (status === 305) {
    throw new Error(`CERTIFY_OR_PARAM_ERROR:${msg || status}`)
  }
  if (RESTRICTED_RE.test(msg)) {
    markRestricted(msg)
    throw new Error("__RESTRICTED__")
  }
  if (status === 404) throw new Error("__NOT_FOUND__")
  throw new Error(msg || `官网接口异常（HTTP ${res.status}）`)
}

export async function GET(req: NextRequest) {
  const src = req.nextUrl.searchParams.get("src") ?? ""
  const name = req.nextUrl.searchParams.get("name") ?? ""
  const id = req.nextUrl.searchParams.get("id") ?? ""
  const wtId = req.nextUrl.searchParams.get("wtId") ?? ""
  const cat = req.nextUrl.searchParams.get("cat") ?? ""

  if (!isZhefengImageUrl(src)) {
    return NextResponse.json({ error: "仅支持哲风壁纸图片直链" }, { status: 400 })
  }

  try {
    await dlSlots.acquire()

    try {
      // ① 本地下载记录检查：重复下载明确提示（不重复请求官网）
      if (id) {
        const existing = await db.download.findUnique({ where: { id } })
        if (existing) {
          return NextResponse.json(
            {
              error: "DOWNLOAD_ALREADY",
              msg:
                `「${existing.title || name}」已于 ${existing.createdAt.toLocaleString()} 下载过` +
                (existing.width && existing.height ? `（${existing.width}×${existing.height}）` : ""),
            },
            { status: 409 }
          )
        }
      }

      // ② 令牌检查：无令牌直接 401 引导登录（绝不回退 CDN 预览）
      const tokenRow = await db.zfToken.findFirst({ orderBy: { createdAt: "desc" } })
      if (!tokenRow) {
        return NextResponse.json(
          { error: "NEED_LOGIN", msg: "下载高清原图需先扫码登录（官网原图仅对登录用户开放）" },
          { status: 401, headers: { "X-Auth-Required": "1" } }
        )
      }

      // ②' 风控熔断：受限期内快速失败（零官网请求），探测窗口放行一次
      if (restrictedUntil > Date.now()) {
        if (Date.now() - restrictedProbeAt < RESTRICTED_PROBE_MS) return restrictedResponse()
        restrictedProbeAt = Date.now()
      }

      // ③ 官网详情页元数据（期望宽高唯一权威来源 + 动态壁纸权威判定）
      let meta: OfficialOriginalMeta | null = null
      try {
        meta = await fetchOfficialOriginalMeta(wtId || id)
      } catch {
        meta = null
      }
      if (meta && !metaIsStaticImage(meta)) {
        return NextResponse.json(
          {
            error: "DOWNLOAD_DYNAMIC",
            msg: "该内容是动态壁纸（官网元数据非静态图片），仅支持静态壁纸下载",
          },
          { status: 502 }
        )
      }
      const expect: OriginalExpect | undefined = meta
        ? {
            width: meta.width,
            height: meta.height,
            ...(meta.contentSizeBytes ? { minBytes: Math.floor(meta.contentSizeBytes * 0.5) } : {}),
          }
        : undefined

      // ④⑤ ALTCHA + getCompleteUrl 签名直链（305 时重验一次）
      let target: string
      try {
        let cookie = await ensureCertified()
        try {
          target = await fetchCompleteUrl(wtId || id, tokenRow.token, cookie)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg === "AUTH_EXPIRED" || msg.startsWith("__")) throw e
          if (msg.startsWith("CERTIFY_OR_PARAM_ERROR")) {
            invalidateCertification()
            cookie = await ensureCertified(true)
            target = await fetchCompleteUrl(wtId || id, tokenRow.token, cookie)
          } else {
            throw e
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg === "AUTH_EXPIRED") {
          return NextResponse.json(
            { error: "AUTH_EXPIRED", msg: "登录令牌已失效，请重新扫码" },
            { status: 401, headers: { "X-Auth-Expired": "1" } }
          )
        }
        if (msg === "__RESTRICTED__") return restrictedResponse()
        if (msg.startsWith("__RATE_LIMITED__")) {
          const retryMs = parseRetryAfterMs(msg.split(":")[1] ?? "")
          if (restrictedUntil < Date.now()) markRestricted("官网限流（429）", retryMs || RATE_LIMIT_FALLBACK_MS)
          return NextResponse.json(
            {
              error: "DOWNLOAD_RATE_LIMITED",
              msg: restrictedMsg || "操作太快被官网限流，请稍后重试",
              ...(restrictedAbsurd ? { recoverUnknown: true } : { recoverAt: restrictedUntil }),
            },
            { status: 429 }
          )
        }
        if (msg === "__NOT_FOUND__") {
          return NextResponse.json({ error: "DOWNLOAD_NOT_FOUND", msg: "原图资源不存在（404）" }, { status: 502 })
        }
        console.error("getCompleteUrl error:", e)
        return NextResponse.json({ error: msg || "原图获取失败，请稍后重试" }, { status: 502 })
      }

      // ⑥ 下载原图字节（整段读入内存）
      const upstream = await fetch(target, {
        headers: zfUpstreamHeaders({ token: tokenRow.token }),
        signal: AbortSignal.timeout(120000),
        cache: "no-store",
      })
      if (upstream.status === 429) {
        const retryMs = parseRetryAfterMs(upstream.headers.get("retry-after"))
        markRestricted("官网限流（429）", retryMs || RATE_LIMIT_FALLBACK_MS)
        return NextResponse.json(
          {
            error: "DOWNLOAD_RATE_LIMITED",
            msg: restrictedMsg,
            ...(restrictedAbsurd ? { recoverUnknown: true } : { recoverAt: restrictedUntil }),
          },
          { status: 429 }
        )
      }
      if (upstream.status === 404) {
        return NextResponse.json({ error: "DOWNLOAD_NOT_FOUND", msg: "原图文件不存在（404）" }, { status: 502 })
      }
      if (!upstream.ok) {
        return NextResponse.json({ error: `原图下载失败（HTTP ${upstream.status}）` }, { status: 502 })
      }
      const buffer = Buffer.from(await upstream.arrayBuffer())
      if (buffer.length === 0) {
        return NextResponse.json({ error: "原图内容为空（连接被中断）" }, { status: 502 })
      }

      // ⑦ 质量硬闸门：期望宽高逐一硬比对 + 字节级校验
      const check = validateOriginalImage(buffer, expect)
      if (!check.ok) {
        console.error(
          `DOWNLOAD GATE [${check.code}]: expected ` +
            `${expect ? `${expect.width}x${expect.height}` : "(meta unavailable)"}, ` +
            `actual ${check.width ?? "?"}x${check.height ?? "?"} / ${(check.bytes ?? 0) / 1024}KB`
        )
        return NextResponse.json(
          {
            error: check.code ?? "DOWNLOAD_QUALITY_MISMATCH",
            msg: check.msg,
            actual: { width: check.width, height: check.height, bytes: check.bytes },
            expected: expect ? { width: expect.width, height: expect.height } : null,
          },
          { status: 502 }
        )
      }

      // ⑧ 扩展名按真实内容格式（杜绝 preview.webp 改名 .png）
      const filename = `${safeFilename(name)}.${check.ext}`
      const contentTypeByFormat: Record<string, string> = {
        png: "image/png",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
      }
      const contentType =
        contentTypeByFormat[check.format ?? ""] ??
        (upstream.headers.get("content-type") ?? "").split(";")[0].trim() ??
        "application/octet-stream"

      // ⑨ 写完整下载记录（只有走到这里 = 校验通过 + 字节完整）
      if (id) {
        try {
          await db.download.upsert({
            where: { id },
            create: {
              id,
              title: safeFilename(name),
              src,
              wtId: wtId || null,
              quality: "original",
              category: cat === "computer" || cat === "phone" ? cat : null,
              width: check.width,
              height: check.height,
              format: check.format,
              bytes: check.bytes,
              sha256: createHash("sha256").update(buffer).digest("hex"),
            },
            update: {
              quality: "original",
              category: cat === "computer" || cat === "phone" ? cat : undefined,
              width: check.width,
              height: check.height,
              format: check.format,
              bytes: check.bytes,
              sha256: createHash("sha256").update(buffer).digest("hex"),
            },
          })
        } catch (e) {
          console.error("record download error:", e)
        }
      }

      const headers = new Headers()
      headers.set("Content-Type", contentType || "application/octet-stream")
      headers.set(
        "Content-Disposition",
        `attachment; filename="wallpaper.${check.ext}"; filename*=UTF-8''${encodeURIComponent(filename)}`
      )
      headers.set("Content-Length", String(buffer.length))
      headers.set("X-Wallpaper-Quality", "original")
      headers.set("X-Image-Dimensions", `${check.width}x${check.height}`)

      return new NextResponse(new Uint8Array(buffer), { status: 200, headers })
    } finally {
      dlSlots.release()
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.startsWith("DOWNLOAD_QUEUE_TIMEOUT")) {
      const secs = msg.split(":")[1] ?? "?"
      return NextResponse.json({ error: `下载排队超过 ${secs} 秒，请稍后重试` }, { status: 503 })
    }
    console.error("GET /api/wallpapers/download error:", e)
    return NextResponse.json({ error: "原图下载失败，请稍后重试" }, { status: 502 })
  }
}
