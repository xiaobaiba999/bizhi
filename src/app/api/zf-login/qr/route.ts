import { NextRequest, NextResponse } from "next/server"
import { qrImageUrl, qrRefererUrl } from "@/lib/zf-login"

/**
 * GET /api/zf-login/qr?state=<state> —— 二维码图片代理
 * 直接透传微信开放平台的二维码 JPEG（避免浏览器端 referer / 热链限制）。
 * Referer 使用发起会话时的完整 qrconnect 页面 URL（与真实微信页面行为一致）。
 */
export async function GET(req: NextRequest) {
  const state = req.nextUrl.searchParams.get("state") ?? ""
  const url = qrImageUrl(state)
  if (!url) return new NextResponse("Not Found", { status: 404 })
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Referer: qrRefererUrl(state) ?? "https://open.weixin.qq.com/connect/qrconnect",
      },
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    })
    if (!res.ok || !res.body) return new NextResponse("QR Unavailable", { status: 502 })
    const headers = new Headers()
    headers.set("Content-Type", res.headers.get("content-type") ?? "image/jpeg")
    headers.set("Cache-Control", "private, no-store")
    return new NextResponse(res.body, { status: 200, headers })
  } catch {
    return new NextResponse("QR Unavailable", { status: 502 })
  }
}
