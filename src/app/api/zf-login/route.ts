import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { buildWxQrUrl, newState, pollStateLogin, probeLoginEndpoints } from "@/lib/zf-login"

/** 令牌脱敏展示：保留前 8 后 4 位 */
function maskToken(token: string) {
  if (token.length <= 12) return `${token.slice(0, 2)}****`
  return `${token.slice(0, 8)}****${token.slice(-4)}`
}

/**
 * POST /api/zf-login —— 发起扫码登录
 * 返回 { state, qrUrl, wxReachable, zfReachable }：
 * - qrUrl 为微信开放平台二维码 iframe 地址（与官网登录参数一致）
 * - wx/zfReachable 为服务端连通性预检结果 —— 不可达时前端立即给出明确错误
 *   与「手动粘贴」兜底入口，而不是停留在「等待扫码」中无限等待。
 */
export async function POST() {
  const state = newState()
  const reach = await probeLoginEndpoints()
  return NextResponse.json({
    state,
    qrUrl: buildWxQrUrl(state),
    wxReachable: reach.wx,
    zfReachable: reach.zf,
  })
}

/**
 * GET /api/zf-login?state=<state> —— 轮询扫码状态
 * - pending：等待扫码确认
 * - ok：登录成功（令牌已自动保存到本地数据库）
 * - expired：二维码已过期/失效
 * - error：网络等异常
 */
export async function GET(req: NextRequest) {
  const state = req.nextUrl.searchParams.get("state") ?? ""
  const result = await pollStateLogin(state)

  if (result.status === "ok" && result.token) {
    try {
      await db.zfToken.deleteMany({})
      const row = await db.zfToken.create({
        data: { token: result.token, note: "qrcode" },
      })
      return NextResponse.json({
        status: "ok",
        token: maskToken(row.token),
        source: "qrcode",
        createdAt: row.createdAt.toISOString(),
      })
    } catch (e) {
      console.error("GET /api/zf-login save token error:", e)
      return NextResponse.json({ status: "error", msg: "令牌保存失败" }, { status: 500 })
    }
  }

  return NextResponse.json(
    { status: result.status, msg: result.msg ?? null },
    { headers: { "Cache-Control": "no-store" } }
  )
}
