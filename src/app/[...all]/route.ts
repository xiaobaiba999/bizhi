import { NextRequest, NextResponse } from "next/server"
import {
  WVS_QUERY,
  WV_SID_COOKIE,
  createWvSession,
  getLastPageNav,
  getWvSession,
  isAllowedWvHost,
  proxyUpstream,
  sessionFromRequest,
} from "@/lib/wv"

/**
 * 根路径兜底代理：
 * 内嵌页（/wv/…）里的脚本若直接 location.href='/xxx' 跳转（location.replace
 * 无法在客户端拦截，如夸克登录成功后 replace('/list')），请求会落到本路由。
 *
 * 会话/主站还原优先级：
 * 1. URL __wvs 参数 / cookie 携带的会话 + Referer 中的 /wv/<host>
 * 2. 最近一次真实页面导航标记 lastPageNav（跨站 Cookie 被封、Referer 只有
 *    origin 时的救命稻草：按最近活跃主站 + 其会话继续代理，登录态不丢）
 * 3. 会话自身的 session.host
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

  // 应用自身路径：保持 404
  if (APP_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return new NextResponse("Not Found", { status: 404 })
  }

  // 1) 请求自带的会话（URL __wvs 优先，其次 cookie）
  const session = sessionFromRequest(
    req.nextUrl.searchParams.get(WVS_QUERY),
    req.cookies.get(WV_SID_COOKIE)?.value
  )

  // 2) Referer 中的内嵌站点（/wv/<host>）
  let host: string | null = null
  const referer = req.headers.get("referer") ?? ""
  const refMatch = /^https?:\/\/[^/]+\/wv\/([^/?#]+)/i.exec(referer)
  if (refMatch && isAllowedWvHost(refMatch[1])) {
    host = refMatch[1].toLowerCase()
  }

  // 3) 最近真实页面导航标记（Referer 只有 origin / 无会话时的兜底）
  const nav = getLastPageNav()
  if (!host && nav && isAllowedWvHost(nav.host)) {
    host = nav.host
  }

  // 4) 会话主站兜底
  if (!host && session && isAllowedWvHost(session.host)) {
    host = session.host
  }

  if (!host) {
    return new NextResponse("Not Found", { status: 404 })
  }

  // 会话选择：请求自带 > 导航标记的会话（登录态在导航标记的会话里）
  let activeSession = session
  if (!activeSession && nav) {
    activeSession = getWvSession(nav.sid)
  }
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
