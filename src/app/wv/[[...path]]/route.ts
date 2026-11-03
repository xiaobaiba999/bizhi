import { NextRequest, NextResponse } from "next/server"
import {
  WV_SID_COOKIE,
  absorbSetCookies,
  buildUpstreamHeaders,
  cleanResponseHeaders,
  createWvSession,
  getWvSession,
  isAllowedWvHost,
  rewriteHtml,
  rewriteLocation,
  touchSession,
} from "@/lib/wv"


const DEFAULT_HOST = "pan.quark.cn"

function sidCookieValue(sid: string) {
  return `${WV_SID_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`
}

async function proxy(req: NextRequest, host: string, path: string): Promise<Response> {
  // 会话（没有则新建）
  let session = getWvSession(req.cookies.get(WV_SID_COOKIE)?.value)
  if (!session) session = createWvSession(host)
  touchSession(session)

  // 上游 URL：透传查询串
  const upstreamUrl = `https://${host}/${path}${req.nextUrl.search}`

  // 请求体（GET/HEAD 无 body）
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
    // 流式请求体需要 half duplex
    ;(init as RequestInit & { duplex?: "half" }).duplex = "half"
  }

  const upstream = await fetch(upstreamUrl, init)

  // 收下上游 Set-Cookie 到 jar
  absorbSetCookies(session, upstream.headers.getSetCookie?.() ?? [])

  // 3xx：重写 Location 让 iframe 继续走代理
  if ([301, 302, 303, 307, 308].includes(upstream.status)) {
    const location = upstream.headers.get("location")
    const headers: Record<string, string> = {}
    if (location) headers["Location"] = rewriteLocation(location, host)
    headers["Cache-Control"] = "no-store"
    headers["Set-Cookie"] = sidCookieValue(session.sid)
    return new NextResponse(null, { status: upstream.status, headers })
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream"
  const headers = cleanResponseHeaders(upstream, contentType)
  headers["Set-Cookie"] = sidCookieValue(session.sid)

  // HTML：读出来重写（注入 base + 运行时补丁，改道根路径资源）
  if (contentType.includes("text/html")) {
    const html = await upstream.text()
    const pathname = new URL(upstreamUrl).pathname
    const rewritten = rewriteHtml(
      html,
      host,
      pathname,
      Object.fromEntries(session.cookies.entries())
    )
    return new NextResponse(rewritten, { status: upstream.status, headers })
  }

  // 其他内容：流式透传
  const body = upstream.body ?? null
  return new NextResponse(body, { status: upstream.status, headers })
}

async function handle(req: NextRequest): Promise<Response> {
  const segments: string[] = req.nextUrl.pathname.split("/").filter(Boolean)
  // /wv 或 /wv/ → 默认站点
  if (segments.length <= 1) {
    return NextResponse.redirect(new URL(`/wv/${DEFAULT_HOST}/`, req.nextUrl.origin))
  }

  const [, first, ...rest] = segments

  // cookie 同步信标（document.cookie 写入转发到服务端 jar）
  if (first === "__sync") {
    const session = getWvSession(req.cookies.get(WV_SID_COOKIE)?.value)
    const c = req.nextUrl.searchParams.get("c") ?? ""
    if (session && c) {
      const eq = c.indexOf("=")
      if (eq > 0) {
        const name = c.slice(0, eq).trim()
        const value = c.slice(eq + 1).trim()
        if (value === "") session.cookies.delete(name)
        else session.cookies.set(name, value)
        touchSession(session)
      }
    }
    return new NextResponse(null, { status: 204 })
  }

  const host = first.toLowerCase()
  if (!isAllowedWvHost(host)) {
    return NextResponse.json({ error: "该站点不在内嵌白名单内" }, { status: 403 })
  }

  const path = rest.join("/")
  try {
    return await proxy(req, host, path)
  } catch (e) {
    console.error(`wv proxy error (${host}/${path}):`, e)
    const msg = e instanceof Error && e.name === "TimeoutError" ? "源站响应超时" : "源站暂时无法访问"
    return new NextResponse(
      `<!DOCTYPE html><html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#666;font-size:14px">${msg}，请稍后重试或在新窗口打开。</body></html>`,
      { status: 502, headers: { "Content-Type": "text/html; charset=utf-8" } }
    )
  }
}

export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
export const HEAD = handle
