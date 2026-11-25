import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import {
  markTokenSaved,
  newState,
  pollStateLogin,
  probeLoginEndpoints,
  startQrSession,
} from "@/lib/zf-login"

/** 令牌脱敏展示：保留前 8 后 4 位 */
function maskToken(token: string) {
  if (token.length <= 12) return `${token.slice(0, 2)}****`
  return `${token.slice(0, 8)}****${token.slice(-4)}`
}

/**
 * POST /api/zf-login —— 发起扫码登录（服务端全托管）
 * 返回 { state, qrImg, wxReachable, zfReachable }：
 * - qrImg 为微信开放平台二维码「图片直链」（服务端从 qrconnect 页面提取），
 *   浏览器直接 <img> 渲染 —— 不再内嵌 iframe，天然规避
 *   「微信授权请求与发起浏览器不匹配」的跨域拦截
 * - 扫码确认由服务端后台长轮询微信 lp 端点接管，前端只需每 2 秒 GET 本接口查状态
 */
export async function POST() {
  const state = newState()
  const reach = await probeLoginEndpoints()
  if (!reach.wx || !reach.zf) {
    return NextResponse.json({
      state,
      qrImg: null,
      wxReachable: reach.wx,
      zfReachable: reach.zf,
    })
  }
  try {
    const qrImg = await startQrSession(state)
    return NextResponse.json({ state, qrImg, wxReachable: true, zfReachable: true })
  } catch (e) {
    return NextResponse.json({
      state,
      qrImg: null,
      wxReachable: true,
      zfReachable: true,
      startError: e instanceof Error ? e.message : "二维码会话创建失败",
    })
  }
}

/**
 * GET /api/zf-login?state=<state> —— 轮询扫码状态
 * - pending：等待扫码
 * - scanned：已扫码，等待手机上确认
 * - ok：登录成功（令牌已自动保存到本地数据库）
 * - expired：二维码已过期/失效
 * - error：网络等异常
 */
export async function GET(req: NextRequest) {
  const state = req.nextUrl.searchParams.get("state") ?? ""
  const result = pollStateLogin(state)

  if (result.status === "ok" && result.token && result.tokenFresh) {
    try {
      await db.zfToken.deleteMany({})
      const row = await db.zfToken.create({
        data: { token: result.token, note: "qrcode" },
      })
      markTokenSaved(state)
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

  if (result.status === "ok" && result.token) {
    // 已入库的旧会话（刷新页面后再次轮询）：只报状态
    return NextResponse.json({ status: "ok", token: maskToken(result.token), source: "qrcode" })
  }

  return NextResponse.json(
    { status: result.status, msg: result.msg ?? null, diag: result.diag ?? null },
    { headers: { "Cache-Control": "no-store" } }
  )
}
