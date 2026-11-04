import { NextRequest, NextResponse } from "next/server"
import {
  WVS_QUERY,
  WV_SID_COOKIE,
  createWvSession,
  isAllowedWvHost,
  proxyErrorHtml,
  proxyUpstream,
  sessionFromRequest,
  touchSession,
} from "@/lib/wv"

const DEFAULT_HOST = "pan.quark.cn"

async function handle(req: NextRequest): Promise<Response> {
  const segments: string[] = req.nextUrl.pathname.split("/").filter(Boolean)
  // /wv 或 /wv/ → 默认站点
  if (segments.length <= 1) {
    return NextResponse.redirect(new URL(`/wv/${DEFAULT_HOST}/`, req.nextUrl.origin))
  }

  const [, first, ...rest] = segments

  // cookie 同步信标（页面 document.cookie 写入转发到服务端 jar，按页面域名归域）
  // 会话优先读 URL __wvs 参数（跨站 Cookie 受限时 beacon 由补丁带上）
  if (first === "__sync") {
    const session = sessionFromRequest(
      req.nextUrl.searchParams.get(WVS_QUERY),
      req.cookies.get(WV_SID_COOKIE)?.value
    )
    const c = req.nextUrl.searchParams.get("c") ?? ""
    let syncHost = req.nextUrl.searchParams.get("h") ?? ""
    // 无 h 参数时从 Referer 还原页面域名
    if (!syncHost) {
      const referer = req.headers.get("referer") ?? ""
      const m = /\/wv\/([^/?#]+)/.exec(referer)
      if (m) syncHost = m[1]
    }
    syncHost = syncHost.toLowerCase()
    if (session && c && isAllowedWvHost(syncHost)) {
      const eq = c.indexOf("=")
      if (eq > 0) {
        const name = c.slice(0, eq).trim()
        const value = c.slice(eq + 1).trim()
        // 与 absorbSetCookies 一致：写入页面自身域名
        let jar = session.jars.get(syncHost)
        if (!jar) {
          jar = new Map()
          session.jars.set(syncHost, jar)
        }
        if (value === "") jar.delete(name)
        else jar.set(name, value)
        touchSession(session)
      }
    }
    return new NextResponse(null, { status: 204 })
  }

  const host = first.toLowerCase()
  if (!isAllowedWvHost(host)) {
    return NextResponse.json({ error: "该站点不在内嵌白名单内" }, { status: 403 })
  }

  // 会话（URL __wvs 参数优先，其次 cookie；没有则新建）
  let session = sessionFromRequest(
    req.nextUrl.searchParams.get(WVS_QUERY),
    req.cookies.get(WV_SID_COOKIE)?.value
  )
  if (!session) session = createWvSession(host)

  const path = rest.join("/")
  try {
    return await proxyUpstream(req, session, host, path)
  } catch (e) {
    console.error(`wv proxy error (${host}/${path}):`, e)
    const msg = e instanceof Error && e.name === "TimeoutError" ? "源站响应超时" : "源站暂时无法访问"
    return new NextResponse(proxyErrorHtml(msg), {
      status: 502,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  }
}

export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
export const HEAD = handle
