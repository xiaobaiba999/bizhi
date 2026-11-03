import { NextRequest, NextResponse } from "next/server"
import {
  WV_SID_COOKIE,
  createWvSession,
  getWvSession,
  isAllowedWvHost,
  proxyUpstream,
} from "@/lib/wv"

/**
 * 根路径兜底代理：
 * 内嵌页（/wv/…）里的脚本若直接 location.href='/xxx' 跳转（无法在客户端拦截），
 * 请求会落到本路由。存在活跃 wv 会话时转发到会话主站，否则按普通 404 处理。
 * 注意：Next.js 中真实存在的路由（/、/api/**、/wv/** 等）优先于此 catch-all。
 */

/** 明确属于本应用自身的路径前缀，绝不代理 */
const APP_PREFIXES = [
  "/_next",
  "/__nextjs",
  "/_rsc",
  "/api",
  "/wv",
  "/gallery",
  "/favicon.ico",
  "/robots.txt",
  "/manifest",
  "/sw.js",
  "/icon",
  "/agent-ctx",
]

async function handle(req: NextRequest): Promise<Response> {
  const pathname = req.nextUrl.pathname

  // 应用自身路径或无内嵌会话：保持 404
  if (APP_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return new NextResponse("Not Found", { status: 404 })
  }

  const session = getWvSession(req.cookies.get(WV_SID_COOKIE)?.value)

  // 优先从 Referer 还原发起请求的内嵌站点（/wv/<host>），
  // 避免多站点共用一个会话时（小红书 + 夸克）路由到错误主站
  let host: string | null = null
  const referer = req.headers.get("referer") ?? ""
  const refMatch = /^https?:\/\/[^/]+\/wv\/([^/?#]+)/i.exec(referer)
  if (refMatch && isAllowedWvHost(refMatch[1])) {
    host = refMatch[1].toLowerCase()
  } else if (session && isAllowedWvHost(session.host)) {
    host = session.host
  }

  if (!host) {
    return new NextResponse("Not Found", { status: 404 })
  }

  let activeSession = session
  if (!activeSession) activeSession = createWvSession(host)

  try {
    return await proxyUpstream(req, activeSession, host, pathname.replace(/^\//, ""))
  } catch (e) {
    console.error(`root wv fallback error (${host}${pathname}):`, e)
    return new NextResponse("Not Found", { status: 404 })
  }
}

export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
export const HEAD = handle
