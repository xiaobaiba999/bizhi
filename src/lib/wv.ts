/**
 * 内嵌网页反向代理（夸克网盘 / 小红书创作者中心）
 *
 * 路径约定：/wv/<host>/<path…>
 * - 会话：wv_sid cookie（HttpOnly）→ 服务端内存 cookie jar（按源站域名隔离）
 * - HTML：剥离 XFO/CSP、注入 <base> 与运行时补丁（fetch/XHR/sendBeacon/pushState/
 *   document.cookie/链接点击 全部改道走 /wv 前缀）
 * - JSON：接口返回的源站绝对 URL（含登录后跳转地址）改写为 /wv 前缀，
 *   避免扫码确认后页面直连源站被 X-Frame-Options 拦下「没反应」
 * - 3xx：Location 重写回 /wv 前缀
 *
 * 登录态保存在服务端 jar 中：浏览器第三方 Cookie 限制对内嵌页面完全无感，
 * 扫码二维码接口（小红书 406 等）也不再因跨站 Cookie 缺失而失败。
 */

import { NextResponse, type NextRequest } from "next/server"

export const WV_SID_COOKIE = "wv_sid"

/* ------------------------------ 域名白名单 ------------------------------ */

/** 允许代理的主机：夸克网盘 + 小红书（含全部子域名） */
const ALLOWED_HOST_PATTERNS = [
  /^([a-z0-9-]+\.)*quark\.cn$/i,
  /^([a-z0-9-]+\.)*xiaohongshu\.com$/i,
]

export function isAllowedWvHost(host: string): boolean {
  const h = host.toLowerCase()
  return ALLOWED_HOST_PATTERNS.some((re) => re.test(h))
}

/* ------------------------------ 会话与 Cookie ------------------------------ */

export interface WvSession {
  sid: string
  /** 首次进入时锁定的主站（root 兜底代理的目标） */
  host: string
  /** 按源站域名隔离的 cookie jar：域名 → (name → value)，跨站互不污染 */
  jars: Map<string, Map<string, string>>
  updatedAt: number
}

const SESSION_TTL = 24 * 60 * 60 * 1000
const sessions = new Map<string, WvSession>()

function pruneSessions() {
  if (sessions.size < 128) return
  const now = Date.now()
  for (const [sid, s] of sessions) {
    if (now - s.updatedAt > SESSION_TTL) sessions.delete(sid)
  }
}

export function getWvSession(sid: string | undefined | null): WvSession | null {
  if (!sid) return null
  const s = sessions.get(sid)
  if (!s) return null
  if (Date.now() - s.updatedAt > SESSION_TTL) {
    sessions.delete(sid)
    return null
  }
  return s
}

export function createWvSession(host: string): WvSession {
  pruneSessions()
  const sid = crypto.randomUUID()
  const s: WvSession = { sid, host, jars: new Map(), updatedAt: Date.now() }
  sessions.set(sid, s)
  return s
}

export function touchSession(s: WvSession) {
  s.updatedAt = Date.now()
}

/** host 及其祖先域名序列（不含 TLD）：a.b.quark.cn → [a.b.quark.cn, b.quark.cn, quark.cn] */
function hostChain(host: string): string[] {
  const labels = host.split(".")
  const out: string[] = []
  for (let i = 0; i < labels.length - 1; i++) {
    out.push(labels.slice(i).join("."))
  }
  return out
}

/** 汇总 host 可见的全部 cookie（自身域名 + 祖先域名的 Domain cookie） */
function hostCookies(s: WvSession, host: string): Map<string, string> {
  const merged = new Map<string, string>()
  for (const domain of hostChain(host.toLowerCase())) {
    const jar = s.jars.get(domain)
    if (jar) for (const [k, v] of jar) merged.set(k, v)
  }
  return merged
}

/** 序列化 host 的 Cookie 请求头 */
export function cookieHeaderFor(s: WvSession, host: string): string {
  return Array.from(hostCookies(s, host).entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ")
}

/** 页面 document.cookie 展示用的键值（仅该页面域名可见） */
export function pageCookieRecord(s: WvSession, host: string): Record<string, string> {
  return Object.fromEntries(hostCookies(s, host))
}

/** 从上游 Set-Cookie 更新 jar（按 Domain 属性归域；删除时清理对应 jar） */
export function absorbSetCookies(s: WvSession, host: string, setCookies: string[]) {
  for (const sc of setCookies) {
    const parts = sc.split(";")
    const first = parts[0] ?? ""
    const eq = first.indexOf("=")
    if (eq <= 0) continue
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    if (!name) continue

    // Domain 属性（缺省仅当前 host 可见）
    let domain = host.toLowerCase()
    for (const attr of parts.slice(1)) {
      const m = /^\s*domain\s*=\s*\.?([^\s;]+)/i.exec(attr)
      if (m) {
        const d = m[1].toLowerCase()
        if (isAllowedWvHost(d) && hostChain(host).includes(d)) domain = d
      }
    }

    const deleting = value === "" || /expires=thu, 01 jan 1970/i.test(sc)
    let jar = s.jars.get(domain)
    if (!jar) {
      if (deleting) continue
      jar = new Map()
      s.jars.set(domain, jar)
    }
    if (deleting) jar.delete(name)
    else jar.set(name, value)
  }
}

/* ------------------------------ 请求头构造 ------------------------------ */

const HOP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "cookie",
  "referer",
  "origin",
  "accept-encoding",
  "content-length",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "x-nextjs-data",
])

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

/**
 * 构造上游请求头：
 * - Referer 重构：浏览器发来的 /wv/<host><path> 引用还原成源站 https 地址
 * - 接口类调用（sec-fetch-dest: empty）补 Origin，模仿浏览器同源 XHR
 * - 带上会话中该域名的全部 Cookie（绕开第三方 Cookie 限制）
 */
export function buildUpstreamHeaders(
  req: Request,
  s: WvSession,
  host: string
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of req.headers.entries()) {
    const lower = key.toLowerCase()
    if (HOP_HEADERS.has(lower)) continue
    headers[key] = value
  }
  headers["User-Agent"] = UA

  const referer = req.headers.get("referer")
  let refererOut = `https://${host}/`
  if (referer) {
    const m = /^https?:\/\/[^/]+\/wv\/([^/?#]+)([^?#]*)/i.exec(referer)
    if (m && isAllowedWvHost(m[1])) {
      refererOut = `https://${m[1].toLowerCase()}${m[2] || "/"}`
    }
  }
  headers["Referer"] = refererOut

  if (req.headers.get("sec-fetch-dest") === "empty") {
    headers["Origin"] = `https://${host}`
  }

  const cookie = cookieHeaderFor(s, host)
  if (cookie) headers["Cookie"] = cookie
  if (!headers["Accept-Language"]) headers["Accept-Language"] = "zh-CN,zh;q=0.9"
  return headers
}

/* ------------------------------ 响应头清洗 ------------------------------ */

/** 透传安全的响应头（剥离 XFO/CSP/COOP 等，按内容类型控制缓存） */
export function cleanResponseHeaders(
  upstream: Response,
  contentType: string
): Record<string, string> {
  const headers: Record<string, string> = {}

  const passthrough = [
    "content-type",
    "content-disposition",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "vary",
    "location",
    "retry-after",
    "x-request-id",
  ]
  for (const key of passthrough) {
    const v = upstream.headers.get(key)
    if (v) headers[key] = v
  }

  const isHtml = contentType.includes("text/html")
  const isStatic =
    /^(text\/css|application\/javascript|text\/javascript|image\/|font\/|application\/font|audio\/|video\/)/.test(
      contentType
    )
  if (isHtml) {
    delete headers["content-type"]
    headers["Cache-Control"] = "no-store"
    headers["Content-Type"] = "text/html; charset=utf-8"
  } else if (isStatic) {
    headers["Cache-Control"] = "public, max-age=3600"
  } else {
    headers["Cache-Control"] = "no-store"
  }
  return headers
}

/* ------------------------------ URL 重写 ------------------------------ */

const ALLOWED_HOST_SRC = String.raw`(?:[a-z0-9-]+\.)*(?:quark\.cn|xiaohongshu\.com)`
const ALLOWED_DOMAIN_SRC = String.raw`quark\.cn|xiaohongshu\.com`

/** 把绝对 URL 改写为 /wv 前缀路径（仅白名单域名；其余返回 null） */
export function rewriteAbsoluteUrl(url: string): string | null {
  const m = /^https?:\/\/([^/?#]+)([\/?#][^\s]*)?$/i.exec(url)
  if (!m) return null
  const host = m[1].toLowerCase().split(":")[0]
  if (!isAllowedWvHost(host)) return null
  return `/wv/${host}${m[2] ?? "/"}`
}

/**
 * JSON 响应体改写：接口返回的源站绝对 URL（含登录二维码确认后的跳转地址）
 * 改写为 /wv 前缀，页面 location.href 跳转后仍走代理（登录态不丢、不被 XFO 拦截）。
 * 兼容普通斜杠与 JSON 转义斜杠（\/）两种形态。
 */
export function rewriteJsonUrls(text: string): string {
  if (!/(quark\.cn|xiaohongshu\.com)/i.test(text)) return text
  // 带路径：https://host/... 或 https:\/\/host\/...
  text = text.replace(
    new RegExp(String.raw`(https?:)?\\?/\\?/(${ALLOWED_HOST_SRC})\\?/`, "gi"),
    (_m, _proto: string, host: string) => `/wv/${host.toLowerCase()}/`
  )
  // 裸域名结尾："https://host"（无路径）
  text = text.replace(
    new RegExp(String.raw`(https?:)?\\?/\\?/(${ALLOWED_HOST_SRC})(?=["'\s,)\]}]|$)`, "gi"),
    (_m, _proto: string, host: string) => `/wv/${host.toLowerCase()}`
  )
  return text
}

/** 把上游 Location 重写为 /wv 前缀路径 */
export function rewriteLocation(location: string, host: string): string {
  try {
    if (/^https?:\/\//i.test(location)) {
      const u = new URL(location)
      if (isAllowedWvHost(u.hostname)) {
        return `/wv/${u.hostname}${u.pathname}${u.search}${u.hash}`
      }
      return location
    }
    if (location.startsWith("//")) return location
    if (location.startsWith("/")) return `/wv/${host}${location}`
    return location
  } catch {
    return location
  }
}

/* ---------------------- 本地 origin URL 重写（CAS service 等） ---------------------- */

/**
 * 页面的真实源站 origin（优先从 Referer 的 /wv/<host> 前缀还原）。
 * 登录 SDK 会把 location.origin 作为 service 参数传给 CAS，
 * 内嵌代理后变成 http://localhost:3000 —— 必须还原成真实源站地址，
 * 否则 CAS 报「服务不存在」。
 */
export function pageRealOrigin(req: NextRequest, host: string): string {
  const referer = req.headers.get("referer") ?? ""
  const m = /^https?:\/\/[^/]+\/wv\/([^/?#]+)/i.exec(referer)
  if (m && isAllowedWvHost(m[1])) return `https://${m[1].toLowerCase()}`
  return `https://${host}`
}

/**
 * 把指向本应用 origin 的绝对 URL（查询参数值）改写为源站真实地址：
 * - http://localhost:3000 → https://<页面源站>
 * - http://localhost:3000/wv/<host>/path → https://<host>/path
 * - 应用自身路径（/api 等）不重写
 */
function rewriteLocalUrlValue(v: string, reqHost: string, realOrigin: string): string {
  if (!/^https?:\/\//i.test(v)) return v
  const rest = v.replace(/^https?:\/\//i, "")
  const m = /^([^/?#]*)([/?#].*)?$/i.exec(rest)
  if (!m) return v
  const urlHost = m[1].toLowerCase()
  const tail = m[2] ?? ""
  const reqHostNoPort = reqHost.split(":")[0].toLowerCase()
  if (urlHost !== reqHost.toLowerCase() && urlHost !== reqHostNoPort) return v
  if (tail === "") return realOrigin
  if (tail === "/") return `${realOrigin}/`
  const wm = /^\/wv\/([^/?#]+)([/?#].*)?$/.exec(tail)
  if (wm && isAllowedWvHost(wm[1])) {
    return `https://${wm[1].toLowerCase()}${wm[2] ?? "/"}`
  }
  return v
}

/**
 * 文本（JSON 请求体等）中的本地 origin URL 批量改写为源站真实地址。
 */
function rewriteLocalUrlsInText(text: string, reqHost: string, realOrigin: string): string {
  const hostPat = reqHost
    .split(":")[0]
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(
    `https?://${hostPat}(?::\\d+)?((?:/[^"\\s,;})\\]]*)?)`,
    "gi"
  )
  return text.replace(re, (full: string, tail: string) => {
    if (tail === "") return realOrigin
    if (tail === "/") return `${realOrigin}/`
    const wm = /^\/wv\/([^/?#]+)([/?#].*)?$/.exec(tail)
    if (wm && isAllowedWvHost(wm[1])) {
      return `https://${wm[1].toLowerCase()}${wm[2] ?? "/"}`
    }
    return full
  })
}

/* ------------------------------ HTML 重写 ------------------------------ */

/** 注入到内嵌页面的运行时补丁：改道 fetch/XHR/beacon/路由/cookie/链接点击 */
function buildPatchScript(host: string, cookies: Record<string, string>): string {
  return `(function(){
'use strict';
var HOST=${JSON.stringify(host)};
var COOKIES=${JSON.stringify(cookies)};
var ALLOWED=/(^|\\.)(${ALLOWED_DOMAIN_SRC})$/i;
var HOST_ROOT=HOST.split('.').slice(-2).join('.');
var PAGE_HOST=(function(){try{return location.hostname.toLowerCase()}catch(e){return ''}})();
function okHost(h){try{h=String(h).toLowerCase().split(':')[0];return ALLOWED.test(h)}catch(e){return false}}
function rw(u){
  try{
    if(typeof u!=='string'||!u)return u;
    if(u.indexOf('/wv/')===0)return u;
    if(/^https?:\\/\\//i.test(u)){
      var m=/^https?:\\/\\/([^\\/?#:]+)([\\/?#].*)?$/i.exec(u);
      if(!m)return u;
      var h=m[1].toLowerCase();
      if(h.indexOf(':')>=0)h=h.split(':')[0];
      if(!okHost(h)){
        // 域名推导兜底：页面被代理在本地域名上时，登录 SDK 会把子域名
        // 推导到 *.localhost（如 customer.localhost）。把「子域名 + 页面根域名」
        // 映射回源站（customer.xiaohongshu.com）再改道走 /wv。
        if(PAGE_HOST&&h!==PAGE_HOST&&h.indexOf('.'+PAGE_HOST)===h.length-PAGE_HOST.length-1){
          var sub=h.slice(0,h.length-PAGE_HOST.length-1);
          var mapped=sub+'.'+HOST_ROOT;
          if(okHost(mapped))return '/wv/'+mapped+(m[2]||'/');
        }
        return u;
      }
      return '/wv/'+h+(m[2]||'/');
    }
    if(u.charAt(0)==='/'&&u.charAt(1)!=='/')return '/wv/'+HOST+u;
    return u;
  }catch(e){return u}
}
try{
  var of=window.fetch;
  window.fetch=function(i,o){
    try{
      if(typeof i==='string')i=rw(i);
      else if(i&&typeof i.url==='string')i=new Request(rw(i.url),i);
    }catch(e){}
    return of.call(this,i,o);
  };
}catch(e){}
try{
  var oo=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    var a=Array.prototype.slice.call(arguments);
    try{a[1]=rw(String(u))}catch(e){}
    return oo.apply(this,a);
  };
}catch(e){}
try{
  if(navigator.sendBeacon){
    var ob=navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon=function(u,d){try{u=rw(String(u))}catch(e){};return ob(u,d)};
  }
}catch(e){}
try{
  var ops=history.pushState,ors=history.replaceState;
  history.pushState=function(s,t,u){try{if(u!=null)u=rw(String(u))}catch(e){};return ops.call(history,s,t,u)};
  history.replaceState=function(s,t,u){try{if(u!=null)u=rw(String(u))}catch(e){};return ors.call(history,s,t,u)};
}catch(e){}
try{
  var ow=window.open;
  window.open=function(u,n,f){try{if(u)u=rw(String(u))}catch(e){};return ow.call(window,u,n,f)};
}catch(e){}
try{
  document.addEventListener('click',function(ev){
    try{
      var t=ev.target;
      var a=t&&t.closest?t.closest('a[href]'):null;
      if(!a)return;
      if(a.target&&a.target!=='_self')return;
      var href=a.getAttribute('href');
      if(!href)return;
      var r=rw(href);
      if(r!==href){ev.preventDefault();location.href=r}
    }catch(e){}
  },true);
}catch(e){}
function ser(){var r=[];for(var k in COOKIES)r.push(k+'='+COOKIES[k]);return r.join('; ')}
function sync(nv){
  try{navigator.sendBeacon('/wv/__sync?h='+encodeURIComponent(HOST)+'&c='+encodeURIComponent(nv))}catch(e){
    try{of.call(window,'/wv/__sync?h='+encodeURIComponent(HOST)+'&c='+encodeURIComponent(nv),{method:'POST',keepalive:true})}catch(e2){}
  }
}
try{
  Object.defineProperty(document,'cookie',{
    get:function(){return ser()},
    set:function(v){
      try{
        var nv=String(v).split(';')[0];
        var eq=nv.indexOf('=');
        if(eq>0){
          var n=nv.slice(0,eq).trim(),val=nv.slice(eq+1).trim();
          if(val==='')delete COOKIES[n];else COOKIES[n]=val;
          sync(nv);
        }
      }catch(e){}
    },
    configurable:true
  });
}catch(e){}
})();`
}

/**
 * 重写内嵌 HTML：
 * 1. <head> 前注入 <base>（相对资源改道）与运行时补丁
 * 2. 资源属性补上 /wv 前缀：根路径相对地址 + 白名单域名的绝对地址 + srcset
 */
export function rewriteHtml(
  html: string,
  host: string,
  pathname: string,
  cookies: Record<string, string>
): string {
  const prefix = `/wv/${host}`
  const inject =
    `<base href="${prefix}${pathname}">` +
    `<script>${buildPatchScript(host, cookies)}</script>`

  let out = html
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (m) => `${m}${inject}`)
  } else if (/<html[^>]*>/i.test(out)) {
    out = out.replace(/<html[^>]*>/i, (m) => `${m}<head>${inject}</head>`)
  } else {
    out = `${inject}${out}`
  }

  // 资源属性：根路径相对 → 前缀化；白名单绝对地址 → 前缀化
  out = out.replace(
    /(\s(?:src|href|action|poster|data-src)\s*=\s*)(["'])([^"']*)\2/gi,
    (m, attr: string, quote: string, value: string) => {
      let next: string
      if (/^https?:\/\//i.test(value)) {
        const r = rewriteAbsoluteUrl(value)
        if (!r) return m
        next = r
      } else if (
        value.startsWith("/") &&
        !value.startsWith("//") &&
        !value.startsWith("/wv/")
      ) {
        next = `${prefix}${value}`
      } else {
        return m
      }
      return `${attr}${quote}${next}${quote}`
    }
  )

  // srcset：逐个 URL 前缀化（含根路径相对与白名单绝对地址）
  out = out.replace(
    /(\ssrcset\s*=\s*)(["'])([^"']+)\2/gi,
    (m, attr: string, quote: string, value: string) => {
      const parts = value.split(",").map((c) => {
        const t = c.trim()
        if (!t) return ""
        const sp = t.search(/\s/)
        const url = sp === -1 ? t : t.slice(0, sp)
        const desc = sp === -1 ? "" : t.slice(sp)
        let u = url
        if (/^https?:\/\//i.test(u)) {
          u = rewriteAbsoluteUrl(u) ?? u
        } else if (
          u.startsWith("/") &&
          !u.startsWith("//") &&
          !u.startsWith("/wv/")
        ) {
          u = `${prefix}${u}`
        }
        return `${u}${desc}`.trim()
      })
      if (parts.some((p) => !p)) return m
      return `${attr}${quote}${parts.join(", ")}${quote}`
    }
  )

  return out
}

/* ------------------------------ 共享代理执行 ------------------------------ */

function sidCookieValue(sid: string) {
  return `${WV_SID_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`
}

/** 上游是否存在允许代理的跳转目标（用于跨域 3xx 也走代理） */
function redirectIntoProxy(location: string): boolean {
  if (!location) return false
  if (/^https?:\/\//i.test(location)) {
    try {
      return isAllowedWvHost(new URL(location).hostname)
    } catch {
      return false
    }
  }
  return !location.startsWith("//")
}

/**
 * 执行一次上游代理（/wv/<host>/… 与根路径兜底共用）。
 * - 3xx：Location 重写为 /wv 前缀（白名单外跳转原样透传）
 * - HTML：注入补丁并重写资源 URL
 * - JSON：改写返回体中的源站绝对 URL（登录跳转地址改道）
 */
export async function proxyUpstream(
  req: NextRequest,
  session: WvSession,
  host: string,
  path: string
): Promise<NextResponse> {
  touchSession(session)

  // 查询串中的本地 origin URL（CAS service 等）还原为源站真实地址
  const realOrigin = pageRealOrigin(req, host)
  const reqHost = req.headers.get("host") ?? "localhost"
  let search = req.nextUrl.search
  {
    const sp = req.nextUrl.searchParams
    const pairs: string[] = []
    let changed = false
    for (const [k, v] of sp.entries()) {
      const nv = rewriteLocalUrlValue(v, reqHost, realOrigin)
      if (nv !== v) changed = true
      pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(nv)}`)
    }
    if (changed && pairs.length > 0) search = `?${pairs.join("&")}`
  }

  const upstreamUrl = `https://${host}/${path}${search}`

  const hasBody = req.method !== "GET" && req.method !== "HEAD"
  const init: RequestInit = {
    method: req.method,
    headers: buildUpstreamHeaders(req, session, host),
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
    cache: "no-store",
  }
  if (hasBody) {
    const contentType = req.headers.get("content-type") ?? ""
    if (contentType.includes("json") || contentType.includes("text/plain")) {
      // JSON 请求体中的本地 origin URL（service / redirect 等字段）还原
      const raw = await req.text()
      init.body = rewriteLocalUrlsInText(raw, reqHost, realOrigin)
    } else if (req.body) {
      init.body = req.body
      // 流式请求体需要 half duplex
      ;(init as RequestInit & { duplex?: "half" }).duplex = "half"
    }
  }

  const upstream = await fetch(upstreamUrl, init)

  // 收下上游 Set-Cookie 到按域名隔离的 jar
  absorbSetCookies(session, host, upstream.headers.getSetCookie?.() ?? [])

  // 3xx：重写 Location 让 iframe 继续走代理
  const location = upstream.headers.get("location") ?? ""
  if ([301, 302, 303, 307, 308].includes(upstream.status) && redirectIntoProxy(location)) {
    const headers: Record<string, string> = {}
    headers["Location"] = rewriteLocation(location, host)
    headers["Cache-Control"] = "no-store"
    headers["Set-Cookie"] = sidCookieValue(session.sid)
    return new NextResponse(null, { status: upstream.status, headers })
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream"
  const headers = cleanResponseHeaders(upstream, contentType)
  headers["Set-Cookie"] = sidCookieValue(session.sid)

  // HTML：读出来重写（注入 base + 运行时补丁，改道资源地址）
  if (contentType.includes("text/html")) {
    const html = await upstream.text()
    const pathname = new URL(upstreamUrl).pathname
    const rewritten = rewriteHtml(html, host, pathname, pageCookieRecord(session, host))
    return new NextResponse(rewritten, { status: upstream.status, headers })
  }

  // JSON：改写返回体中的源站绝对 URL（扫码确认后的跳转地址等）
  if (contentType.includes("json")) {
    const text = await upstream.text()
    const rewritten = rewriteJsonUrls(text)
    return new NextResponse(rewritten, { status: upstream.status, headers })
  }

  // 其他内容：流式透传
  const body = upstream.body ?? null
  return new NextResponse(body, { status: upstream.status, headers })
}

/** 代理失败时的兜底 HTML */
export function proxyErrorHtml(msg: string): string {
  return `<!DOCTYPE html><html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#666;font-size:14px">${msg}，请稍后重试或在新窗口打开。</body></html>`
}
