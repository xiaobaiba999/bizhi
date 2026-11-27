import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { isZhefengImageUrl } from "@/lib/zhefeng"
import { zfCompleteUrl, zfUpstreamHeaders } from "@/lib/zf-login"
import { ensureCertified, invalidateCertification } from "@/lib/zf-certify"
import { createSemaphore } from "@/lib/semaphore"
import { validateOriginalImage, type OriginalExpect } from "@/lib/image-quality"
import { fetchOfficialOriginalMeta, type OfficialOriginalMeta } from "@/lib/zf-meta"

/**
 * GET /api/wallpapers/download?src=<img-url>&name=<title>&id=<file-id>&wtId=<详情id>
 *
 * v1.4.14 原图完整性硬保证（对齐用户验收标准）：
 * - 只交付「与官网一致」的原图：官网详情页 JSON-LD 官方元数据（期望宽高/
 *   体积下限，不硬编码任何固定尺寸）→ 本地令牌 → ALTCHA 人机验证 →
 *   getCompleteUrl 签名直链 → 代理下载 → 字节级质量校验
 *   （src/lib/image-quality.ts）：期望宽高逐一硬比对（任一不符即拒：
 *   裁切/缩放/拉伸/改比例全拒）+ 魔数识别真实格式 + 体积下限。
 * - 禁止静默降级：无令牌 → 401 NEED_LOGIN（前端引导扫码，登录后自动续传）；
 *   令牌失效 → 401 + X-Auth-Expired；官网接口异常 → 502。任何情况下都不
 *   把 CDN 预览图（890px/25KB webp）当原图保存。
 * - 校验不过 → 502 DOWNLOAD_RESOLUTION_MISMATCH / DOWNLOAD_QUALITY_MISMATCH
 *   等（响应带 expected/actual），不写下载记录、不返回字节。
 * - 扩展名按字节真实格式（png/jpg/webp），杜绝 preview.webp 改名 .png。
 * - 链路全程原始字节直传（Buffer → Response），无任何 resize/crop/重编码。
 *
 * 成功响应头：X-Wallpaper-Quality: original + X-Image-Dimensions: WxH。
 */
const dlSlots = createSemaphore(3, 8 * 60_000)

/* ---------------- v1.4.15 官网风控受限熔断 ---------------- */

/**
 * 实测（2026-11 用户报告）：高频调用 getCompleteUrl 会触发官网风控，业务
 * 响应 msg 形如「下载功能暂时受限，预计恢复时间：2027-11-16 22:19:08。
 * 若有疑问请联系客服。」——继续撞击只会加重。检测到后进入短时熔断：
 * 期间快速失败 429 DOWNLOAD_RESTRICTED（零官网请求），每 1 分钟放行一次
 * 真实探测（服务器版多为单张下载场景，探测频率比桌面版更保守）。
 */
const RESTRICTED_RE = /受限|恢复时间|禁止下载|封禁|联系客服/
const RESTRICTED_PROBE_MS = 60_000
let restrictedUntil = 0
let restrictedMsg = ""
let restrictedProbeAt = 0

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

/** 标记受限并写运行日志（审计轨迹） */
function markRestricted(msg: string, fallbackMs = 10 * 60_000) {
  restrictedMsg = msg
  const until = parseRestrictedUntil(msg)
  restrictedUntil = until > Date.now() ? until : Date.now() + fallbackMs
  restrictedProbeAt = Date.now()
  console.warn(
    `[DOWNLOAD_RESTRICTED] 官网风控受限熔断至 ${new Date(restrictedUntil).toLocaleString()}：${msg || "429 限流"}`
  )
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

/** 官网 getCompleteUrl 的 JSON 响应（识别 3004/3005 业务错误码） */
interface CompleteUrlResponse {
  status?: number | string
  msg?: string
  data?: unknown
}

/**
 * 调用官网 getCompleteUrl（已带 __media=1&__responseCodec=aeg-v2 必需参数）。
 * 前置条件：先通过 ALTCHA 人机验证（ensureCertified），并把验证会话的
 * server_session Cookie 回放到请求头 —— 官网验证状态绑定在该 Cookie 上。
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
  if (res.status === 429) {
    throw new Error("__RATE_LIMITED__")
  }
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
  // v1.4.15：官网风控「下载功能暂时受限」→ 熔断（内层抛出，外层统一回 429）
  if (RESTRICTED_RE.test(msg)) {
    markRestricted(msg)
    throw new Error("__RESTRICTED__")
  }
  throw new Error(msg || `官网接口异常（HTTP ${res.status}）`)
}

export async function GET(req: NextRequest) {
  const src = req.nextUrl.searchParams.get("src") ?? ""
  const name = req.nextUrl.searchParams.get("name") ?? ""
  const id = req.nextUrl.searchParams.get("id") ?? ""
  /** 壁纸详情 id（getCompleteUrl 用；缺省回退文件 id） */
  const wtId = req.nextUrl.searchParams.get("wtId") ?? ""

  if (!isZhefengImageUrl(src)) {
    return NextResponse.json({ error: "仅支持哲风壁纸图片直链" }, { status: 400 })
  }

  try {
    // ① 占用回源槽位（最多 3 张并发，其余 FIFO 排队；排队超时抛 DOWNLOAD_QUEUE_TIMEOUT）
    await dlSlots.acquire()

    try {
      // ② 令牌检查：无令牌直接 401 引导登录（绝不回退 CDN 预览）
      const tokenRow = await db.zfToken.findFirst({ orderBy: { createdAt: "desc" } })
      if (!tokenRow) {
        return NextResponse.json(
          { error: "NEED_LOGIN", msg: "下载高清原图需先扫码登录（官网原图仅对登录用户开放）" },
          { status: 401, headers: { "X-Auth-Required": "1" } }
        )
      }

      // ②' v1.4.15 风控熔断：受限期内快速失败（零官网请求），探测窗口放行一次
      if (restrictedUntil > Date.now()) {
        if (Date.now() - restrictedProbeAt < RESTRICTED_PROBE_MS) {
          return NextResponse.json(
            {
              error: "DOWNLOAD_RESTRICTED",
              msg: restrictedMsg || "官网下载功能暂时受限",
              recoverAt: restrictedUntil,
            },
            { status: 429 }
          )
        }
        restrictedProbeAt = Date.now()
      }

      // ③ 官网人机验证 + getCompleteUrl 换签名直链（305 时重验一次）
      let target: string
      try {
        let cookie = await ensureCertified()
        try {
          target = await fetchCompleteUrl(wtId || id, tokenRow.token, cookie)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg === "AUTH_EXPIRED") throw e
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
          // 令牌确实失效：401 提示重新扫码（前端登录成功后自动续传）
          return NextResponse.json(
            { error: "AUTH_EXPIRED", msg: "登录令牌已失效，请重新扫码" },
            { status: 401, headers: { "X-Auth-Expired": "1" } }
          )
        }
        // v1.4.15：官网风控受限 / 429 限流 → 429 DOWNLOAD_RESTRICTED（前端中止批量）
        if (msg === "__RESTRICTED__" || msg === "__RATE_LIMITED__") {
          if (msg === "__RATE_LIMITED__" && restrictedUntil < Date.now()) {
            markRestricted("官网限流：操作太快了", 60_000)
          }
          return NextResponse.json(
            {
              error: "DOWNLOAD_RESTRICTED",
              msg: restrictedMsg || "官网下载功能暂时受限，请稍后重试",
              recoverAt: restrictedUntil,
            },
            { status: 429 }
          )
        }
        console.error("getCompleteUrl error:", e)
        return NextResponse.json({ error: msg || "原图获取失败，请稍后重试" }, { status: 502 })
      }

      // ④ 官网详情页 JSON-LD 官方元数据（期望宽高的唯一权威来源；非致命
      //    —— 取不到时退回 v1.4.13 预览兜底闸门，绝不因元数据抖动阻断下载）
      let meta: OfficialOriginalMeta | null = null
      try {
        meta = await fetchOfficialOriginalMeta(wtId || id)
      } catch {
        meta = null
      }
      const expect: OriginalExpect | undefined = meta
        ? {
            width: meta.width,
            height: meta.height,
            // 体积下限：官方 contentSize 的 50%（辅助线，仅拦「同尺寸重压缩缩水」）
            ...(meta.contentSizeBytes ? { minBytes: Math.floor(meta.contentSizeBytes * 0.5) } : {}),
          }
        : undefined

      // ⑤ 回源下载原图：整段读入内存（拿到完整字节即释放槽位）
      const upstream = await fetch(target, {
        headers: zfUpstreamHeaders({ token: tokenRow.token }),
        signal: AbortSignal.timeout(120000),
        cache: "no-store",
      })
      if (!upstream.ok) {
        return NextResponse.json(
          { error: `原图下载失败（HTTP ${upstream.status}）` },
          { status: 502 }
        )
      }
      const buffer = Buffer.from(await upstream.arrayBuffer())
      if (buffer.length === 0) {
        return NextResponse.json({ error: "原图内容为空" }, { status: 502 })
      }

      // ⑥ 质量硬闸门：期望宽高逐一硬比对 + 字节级校验，预览图/裁切/缩放/
      //    改比例/重压缩一律拒绝交付
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

      // ⑦ 扩展名按真实内容格式（杜绝 preview.webp 改名 .png）
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

      // ⑧ 全部通过才写下载记录（键 = 文件 id，与列表过滤一致）
      if (id) {
        try {
          await db.download.upsert({
            where: { id },
            create: { id, title: safeFilename(name), src, wtId: wtId || null, quality: "original" },
            update: { quality: "original", wtId: wtId || undefined },
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
