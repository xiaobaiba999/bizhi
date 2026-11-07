import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { zfCompleteUrl, zfUpstreamHeaders } from "@/lib/zf-login"

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
 * GET /api/token/verify?wtId=<壁纸id> —— 校验已保存令牌是否仍然有效。
 * 用官网 getCompleteUrl 探测（只看能否换出原图直链，不下载文件）：
 * - true：令牌有效（可下载与官网一致的原图）
 * - false：令牌已失效（401 未授权 / 305 错误的请求等）
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
    try {
      const res = await fetch(zfCompleteUrl(wtId), {
        headers: zfUpstreamHeaders({ token: row.token }),
        signal: AbortSignal.timeout(10000),
        cache: "no-store",
      })
      const json = (await res.json().catch(() => null)) as
        | { status?: number | string; msg?: string; data?: unknown }
        | null
      const url = json ? digUrl(json) : null
      if (url) return NextResponse.json({ valid: true })
      // 有响应但换不出直链 → 令牌失效（401 未授权 / 305 错误的请求等）
      const msg = typeof json?.msg === "string" ? json.msg.trim() : ""
      return NextResponse.json({
        valid: false,
        msg: (msg || `HTTP ${res.status}`).slice(0, 80),
      })
    } catch {
      // 上游网络异常：无法判定，不误报失效
      return NextResponse.json({ valid: null, msg: "官网连接异常，未能验证" })
    }
  } catch (e) {
    console.error("GET /api/token/verify error:", e)
    return NextResponse.json({ error: "读取令牌失败" }, { status: 500 })
  }
}
