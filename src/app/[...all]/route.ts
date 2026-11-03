import { NextRequest, NextResponse } from "next/server"
import {
  WV_SID_COOKIE,
  absorbSetCookies,
  buildUpstreamHeaders,
  cleanResponseHeaders,
  getWvSession,
  isAllowedWvHost,
  rewriteHtml,
  rewriteLocation,
  touchSession,
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

function sidCookieValue(sid: string) {
  return `${WV_SID_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`
}

async function handle(req: NextRequest): Promise<Response> {
  const pathname = req.nextUrl.pathname

  // 应用自身路径或无内嵌会话：保持 404
  if (APP_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return new NextResponse("Not Found", { status: 404 })
  }

  const session = getWvSession(req.cookies.get(WV_SID_COOKIE)?.value)
  if (!session || !isAllowedWvHost(session.host)) {
    return new NextResponse("Not Found", { status: 404 })
  }

  const host = session.host
  touchSession(session)
  const upstreamUrl = `https://${host}${pathname}${req.nextUrl.search}`

  try {
    const hasBody = req.method !== "GET" && req.method !== "HEAD"
    const init: RequestInit = {
      method: req.method,
      headers: buildUpstreamHeaders(req, session, host),
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
      cache: "no-store",
    }
    if (hasBody && req.body) {
      init.body = req.body
      ;(init as RequestInit & { duplex?: "half" }).duplex = "half"
    }

    const upstream = await fetch(upstreamUrl, init)
    absorbSetCookies(session, upstream.headers.getSetCookie?.() ?? [])

    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      const location = upstream.headers.get("location")
      const headers: Record<string, string> = { "Cache-Control": "no-store" }
      if (location) headers["Location"] = rewriteLocation(location, host)
      headers["Set-Cookie"] = sidCookieValue(session.sid)
      return new NextResponse(null, { status: upstream.status, headers })
    }

    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream"
    const headers = cleanResponseHeaders(upstream, contentType)
    headers["Set-Cookie"] = sidCookieValue(session.sid)

    if (contentType.includes("text/html")) {
      const html = await upstream.text()
      const rewritten = rewriteHtml(
        html,
        host,
        pathname,
        Object.fromEntries(session.cookies.entries())
      )
      return new NextResponse(rewritten, { status: upstream.status, headers })
    }

    return new NextResponse(upstream.body ?? null, { status: upstream.status, headers })
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
