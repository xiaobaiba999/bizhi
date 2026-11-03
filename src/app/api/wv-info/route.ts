import { NextRequest, NextResponse } from "next/server"
import { WV_SID_COOKIE, getWvSession } from "@/lib/wv"

/**
 * GET /api/wv-info —— 查询当前内嵌网页会话的主站。
 * 登录回调落回应用根路径（iframe 内 ?ticket=…）时，
 * 根页面据此把请求转回 /wv/<主站>/ 完成票据交换。
 */
export async function GET(req: NextRequest) {
  const session = getWvSession(req.cookies.get(WV_SID_COOKIE)?.value)
  return NextResponse.json(
    { host: session?.host ?? null },
    { headers: { "Cache-Control": "no-store" } }
  )
}
