/**
 * 内嵌网页反向代理（夸克网盘等 X-Frame-Options: SAMEORIGIN 站点）
 *
 * 路径约定：/wv/<host>/<path…>
 * - 会话：wv_sid cookie（HttpOnly）→ 服务端内存 cookie jar
 * - HTML：剥离 XFO/CSP、注入 <base> 与运行时补丁（fetch/XHR/sendBeacon/pushState/
 *   document.cookie 全部改道走 /wv 前缀）
 * - 3xx：Location 重写回 /wv 前缀，避免 iframe 直连源站被 XFO 拦截
 */

export const WV_SID_COOKIE = "wv_sid"

/** 允许代理的主机（当前仅夸克网盘相关域名） */
export function isAllowedWvHost(host: string): boolean {
  return /^([a-z0-9-]+\.)*quark\.cn$/i.test(host)
}

export interface WvSession {
  sid: string
  /** 首次进入时锁定的主站（root 兜底代理的目标） */
  host: string
  cookies: Map<string, string>
  updatedAt: number
}

const SESSION_TTL = 12 * 60 * 60 * 1000
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
  const s: WvSession = { sid, host, cookies: new Map(), updatedAt: Date.now() }
  sessions.set(sid, s)
  return s
}

export function touchSession(s: WvSession) {
  s.updatedAt = Date.now()
}

/** 序列化 cookie jar 为请求头值 */
export function cookieHeader(s: WvSession): string {
  return Array.from(s.cookies.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ")
}

/** 从上游 Set-Cookie 更新 jar（忽略 Domain/Expires 等属性，仅存键值） */
export function absorbSetCookies(s: WvSession, setCookies: string[]) {
  for (const sc of setCookies) {
    const first = sc.split(";")[0] ?? ""
    const eq = first.indexOf("=")
    if (eq <= 0) continue
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    if (!name) continue
    if (value === "" || /expires=thu, 01 jan 1970/i.test(sc)) s.cookies.delete(name)
    else s.cookies.set(name, value)
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

/** 从浏览器请求复制安全头，并带上会话 cookie 与源站 Referer */
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
  headers["Referer"] = `https://${host}/`
  const cookie = cookieHeader(s)
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
    headers["Cache-Control"] = "no-store"
    headers["Content-Type"] = "text/html; charset=utf-8"
  } else if (isStatic) {
    headers["Cache-Control"] = "public, max-age=3600"
  } else {
    headers["Cache-Control"] = "no-store"
  }
  return headers
}

/* ------------------------------ HTML 重写 ------------------------------ */

/** 注入到内嵌页面的运行时补丁：改道 fetch/XHR/beacon/路由/cookie */
function buildPatchScript(host: string, cookies: Record<string, string>): string {
  return `(function(){
'use strict';
var HOST=${JSON.stringify(host)};
var COOKIES=${JSON.stringify(cookies)};
function okHost(h){return /(^|\\.)quark\\.cn$/i.test(h)}
function rw(u){
  try{
    if(typeof u!=='string'||!u)return u;
    if(u.indexOf('/wv/')===0)return u;
    if(/^https?:\\/\\//i.test(u)){
      var m=/^https?:\\/\\/([^\\/?#:]+)([\\/?#].*)?$/i.exec(u);
      if(!m)return u;
      var h=m[1].toLowerCase();
      if(h.indexOf(':')>=0)h=h.split(':')[0];
      if(!okHost(h))return u;
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
function ser(){var r=[];for(var k in COOKIES)r.push(k+'='+COOKIES[k]);return r.join('; ')}
function sync(nv){
  try{navigator.sendBeacon('/wv/__sync?c='+encodeURIComponent(nv))}catch(e){
    try{of.call(window,'/wv/__sync?c='+encodeURIComponent(nv),{method:'POST',keepalive:true})}catch(e2){}
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
 * 2. 根路径 src/href 属性补上 /wv/<host> 前缀
 */
export function rewriteHtml(html: string, host: string, pathname: string, cookies: Record<string, string>): string {
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

  // 根路径资源属性：src="/x" / href="/x" → 前缀化（跳过 //、/wv 已处理的）
  out = out.replace(
    /(\s(?:src|href|action|poster|data-src)\s*=\s*)(["'])\/(?!\/|wv\/)([^"']*)\2/gi,
    (_m, attr: string, quote: string, rest: string) => `${attr}${quote}${prefix}/${rest}${quote}`
  )
  return out
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
