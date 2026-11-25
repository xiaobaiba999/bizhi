import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { zfCompleteUrl, zfUpstreamHeaders } from "@/lib/zf-login"
import { ensureCertified, invalidateCertification } from "@/lib/zf-certify"

/** getCompleteUrl 响应里深挖原图直链（与下载路由一致的键名） */
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
 * GET /api/token/verify?wtId=<壁纸详情id> —— 校验已保存令牌是否仍然有效。
 *
 * 官网 getCompleteUrl 在返回原图直链前要求：
 * 1. 先通过 ALTCHA 人机验证（certify/challenge → PoW → certify/verify）
 * 2. 请求带 __media=1&__responseCodec=aeg-v2 查询参数
 * 3. 回放验证会话的 server_session Cookie
 * 未满足时一律返回 305 [错误的请求 -> 3004]，与令牌是否有效无关 ——
 * 旧版实现漏了这三点，把「验证流程缺失」误报成了「令牌已失效」。
 *
 * 判定（只看能否换出原图直链，不下载文件）：
 * - true：令牌有效（可下载与官网一致的原图）
 * - false：令牌已失效（401 未授权等）
 * - null：网络异常等无法判定（不误报失效）
 */
export async function GET(req: NextRequest) {
  const wtId = req.nextUrl.searchParams.get("wtId") ?? ""
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(wtId)) {
    return NextResponse.json({ error: "缺少有效的壁纸 id，无法验证令牌" }, { status: 400 })
  }
  try {
    const row = await db.zfToken.findFirst({ orderBy: { createdAt: "desc" } })
    if (!row) return NextResponse.json({ valid: null, reason: "no-token" })

    /** 单次探测：返回 {valid, msg} */
    const probe = async (): Promise<{ valid: boolean | null; msg?: string }> => {
      try {
        const cookie = await ensureCertified()
        const res = await fetch(zfCompleteUrl(wtId), {
          headers: zfUpstreamHeaders({
            token: row.token,
            ...(cookie ? { Cookie: cookie } : {}),
          }),
          signal: AbortSignal.timeout(10000),
          cache: "no-store",
        })
        const json = (await res.json().catch(() => null)) as
          | { status?: number | string; msg?: string; data?: unknown }
          | null
        const url = json ? digUrl(json) : null
        if (url) return { valid: true }
        const status = Number(json?.status ?? -1)
        const msg = typeof json?.msg === "string" ? json.msg.trim() : ""
        // 401 / 「未授权」→ 令牌确实失效；其余（3004/3005/网络）→ 无法判定，
        // 避免「人机验证过期」再次被误报成「令牌已失效」
        if (status === 401 || /未授权/.test(msg)) {
          return { valid: false, msg: (msg || `HTTP ${res.status}`).slice(0, 80) }
        }
        return { valid: null, msg: (msg || `HTTP ${res.status}`).slice(0, 80) }
      } catch {
        return { valid: null, msg: "官网连接异常，未能验证" }
      }
    }

    // 第一次探测；若疑似人机验证过期（3004），强制重验后再探一次
    let result = await probe()
    if (result.valid !== true && typeof result.msg === "string" && result.msg.includes("3004")) {
      invalidateCertification()
      result = await probe()
    }

    return NextResponse.json(result)
  } catch (e) {
    console.error("GET /api/token/verify error:", e)
    return NextResponse.json({ error: "读取令牌失败" }, { status: 500 })
  }
}
